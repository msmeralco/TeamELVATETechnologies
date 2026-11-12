"""Baseline prediction model for Meralco Go.

This is the lightweight stand-in described in the architecture doc
("a seasonal average or a simple regression"), not a trained ML model:

* expected usage per 15-minute slot = mean of the same slot over the previous
  7 days (seasonal-naive profile)
* a linear regression of daily kWh on daily mean temperature (public-data
  feature) scales the profile for the forecast window
* anomaly score = how far the trailing-24h residual sits from its own history
* transformer energy balance = trailing-window unbilled-energy ratio vs. its
  own baseline

Every function is pure and works on plain lists so it can be unit tested
without the HTTP layer and swapped for a trained model later.
"""
from __future__ import annotations

import math
from statistics import mean, median, pstdev
from typing import Optional, Sequence

MODEL_VERSION = "baseline-seasonal-v1"
STEP_MIN = 15
SLOTS_PER_DAY = 24 * 60 // STEP_MIN  # 96
PROFILE_DAYS = 7

# Thresholds are demo choices; they are stated in the README, not hidden.
SPIKE_Z = 3.0
FLATLINE_SLOTS = 8          # 2 hours of zero readings
FLATLINE_MIN_EXPECTED = 0.3  # kWh expected over that window before we call it a flatline
BALANCE_WINDOW = 16          # 4 hours
BALANCE_Z = 4.0
MIN_BALANCE_DELTA = 0.015    # ignore gap increases under 1.5 percentage points

Num = Optional[float]


def _clean(xs: Sequence[Num]) -> list[float]:
    return [x for x in xs if x is not None and not math.isnan(x)]


def z_to_score(z: float) -> float:
    """Map |z| to a 0..1 confidence-style score. z=3 -> ~0.63, z=5 -> ~0.86."""
    a = abs(z)
    if a <= 1:
        return 0.0
    return round(min(0.99, 1 - math.exp(-(a - 1) / 2)), 3)


def expected_at(kwh: Sequence[Num], i: int, days: int = PROFILE_DAYS) -> Optional[float]:
    """Seasonal-naive expectation for index i: mean of the same slot on prior days."""
    prior = _clean([kwh[i - SLOTS_PER_DAY * k] for k in range(1, days + 1) if i - SLOTS_PER_DAY * k >= 0])
    if len(prior) < 3:
        return None
    return mean(prior)


def expected_nonzero(kwh: Sequence[Num], i: int, days: int = PROFILE_DAYS) -> Optional[float]:
    """Same-slot mean over the most recent prior days that recorded any use."""
    vals: list[float] = []
    k = 1
    while i - SLOTS_PER_DAY * k >= 0 and len(vals) < days:
        v = kwh[i - SLOTS_PER_DAY * k]
        if v is not None and v >= 0.002:
            vals.append(v)
        k += 1
    return mean(vals) if len(vals) >= 3 else None


def score_meter(kwh: Sequence[Num], anomaly_signature: bool = False) -> dict:
    """Score the latest reading of one meter.

    kwh: contiguous 15-minute interval readings, oldest first, latest last.
    """
    n = len(kwh)
    last = n - 1
    latest = kwh[last] if n else None
    expected = expected_at(kwh, last) if n else None
    residual = None if (latest is None or expected is None) else latest - expected

    result = {
        "expected_kwh": None if expected is None else round(expected, 4),
        "residual_kwh": None if residual is None else round(residual, 4),
        "z": None,
        "anomaly_score": 0.0,
        "anomaly_type": None,
        "deviation_pct": None,
        "model_version": MODEL_VERSION,
    }

    # Per-slot residuals where an expectation exists
    resid: list[Num] = []
    exp_list: list[Num] = []
    for i in range(n):
        e = expected_at(kwh, i)
        v = kwh[i]
        exp_list.append(e)
        resid.append(None if (e is None or v is None) else v - e)

    # 1. Flatline: meter reports ~0 while the home normally draws power.
    # Compared against the meter's most recent *non-zero* readings for the same
    # slots, so a meter that stays dead for days keeps being flagged instead of
    # "learning" that zero is normal.
    if n >= FLATLINE_SLOTS:
        window = kwh[-FLATLINE_SLOTS:]
        exp_window = _clean([expected_nonzero(kwh, i) for i in range(n - FLATLINE_SLOTS, n)])
        if all(v is not None and v < 0.002 for v in window) and len(exp_window) == FLATLINE_SLOTS:
            if sum(exp_window) >= FLATLINE_MIN_EXPECTED:
                result.update(anomaly_type="flatline", anomaly_score=0.95, deviation_pct=-100.0)
                return result

    # 2. Trailing-24h residual vs. its own history
    if n >= SLOTS_PER_DAY * (PROFILE_DAYS + 2):
        def window_sum(end: int) -> Optional[tuple[float, float]]:
            r = resid[end - SLOTS_PER_DAY + 1: end + 1]
            e = exp_list[end - SLOTS_PER_DAY + 1: end + 1]
            if any(x is None for x in r) or any(x is None for x in e):
                return None
            return sum(r), sum(e)  # type: ignore[arg-type]

        current = window_sum(last)
        history = []
        for end in range(SLOTS_PER_DAY * (PROFILE_DAYS + 1), last - SLOTS_PER_DAY, 4):
            w = window_sum(end)
            if w is not None:
                history.append(w[0])
        if current is not None and len(history) >= 12:
            mu, sd = mean(history), pstdev(history)
            sd = max(sd, 0.05 * max(current[1], 1e-6), 1e-6)
            z = (current[0] - mu) / sd
            result["z"] = round(z, 2)
            result["deviation_pct"] = round(100 * current[0] / current[1], 1) if current[1] > 0 else None
            if z >= SPIKE_Z:
                result.update(anomaly_type="consumption_spike", anomaly_score=z_to_score(z))
            elif z <= -SPIKE_Z:
                result.update(anomaly_type="consumption_drop", anomaly_score=z_to_score(z))

    # 3. Tampering-signature flag from the meter itself
    if anomaly_signature:
        result["anomaly_type"] = "tamper_signature"
        result["anomaly_score"] = max(result["anomaly_score"], 0.9)

    return result


def _daily_totals(kwh: Sequence[Num], temps: Sequence[Num]) -> list[tuple[float, float]]:
    """(daily kWh, daily mean temp) for complete trailing days, newest last."""
    out = []
    n = len(kwh)
    for end in range(n, SLOTS_PER_DAY - 1, -SLOTS_PER_DAY):
        start = end - SLOTS_PER_DAY
        day_k = kwh[start:end]
        day_t = _clean(temps[start:end]) if temps else []
        if any(v is None for v in day_k):
            continue
        out.append((sum(day_k), mean(day_t) if day_t else float("nan")))  # type: ignore[arg-type]
    out.reverse()
    return out


def temp_sensitivity(daily: list[tuple[float, float]]) -> tuple[float, float]:
    """Least-squares slope of daily kWh on daily mean temp. Returns (beta, mean_temp)."""
    pts = [(t, k) for k, t in daily if not math.isnan(t)]
    if len(pts) < 5:
        return 0.0, (mean(t for t, _ in pts) if pts else 0.0)
    mt = mean(t for t, _ in pts)
    mk = mean(k for _, k in pts)
    var = sum((t - mt) ** 2 for t, _ in pts)
    if var < 1e-6:
        return 0.0, mt
    beta = sum((t - mt) * (k - mk) for t, k in pts) / var
    return max(beta, 0.0), mt  # hotter days never *reduce* expected use in this baseline


def forecast_cycle(
    kwh: Sequence[Num],
    temps: Sequence[Num],
    last_slot_of_day: int,
    used_kwh: float,
    remaining_slots: int,
    extra_kwh_per_day: float = 0.0,
    temp_outlook_c: Optional[float] = None,
) -> dict:
    """Project end-of-cycle consumption as a low/base/high range.

    last_slot_of_day: slot index (0..95) of the latest reading, local time.
    remaining_slots: 15-minute slots left until the cycle closes.
    """
    profile = []
    for s in range(SLOTS_PER_DAY):
        # index of the most recent reading in slot s
        offset = (last_slot_of_day - s) % SLOTS_PER_DAY
        idx = len(kwh) - 1 - offset
        vals = _clean([kwh[idx - SLOTS_PER_DAY * k] for k in range(PROFILE_DAYS) if idx - SLOTS_PER_DAY * k >= 0])
        profile.append(mean(vals) if vals else 0.0)
    daily_profile = sum(profile)

    daily = _daily_totals(kwh, temps)
    beta, mean_temp = temp_sensitivity(daily[-14:])
    recent_temps = [t for _, t in daily[-3:] if not math.isnan(t)]
    outlook = temp_outlook_c if temp_outlook_c is not None else (mean(recent_temps) if recent_temps else mean_temp)
    temp_adj_per_day = beta * (outlook - mean_temp)

    remaining_days = remaining_slots / SLOTS_PER_DAY
    base_remaining = 0.0
    for j in range(1, remaining_slots + 1):
        base_remaining += profile[(last_slot_of_day + j) % SLOTS_PER_DAY]
    base_remaining += (temp_adj_per_day + extra_kwh_per_day) * remaining_days
    base_remaining = max(base_remaining, 0.0)

    totals = [k for k, _ in daily[-14:]]
    sd_day = pstdev(totals) if len(totals) >= 3 else 0.15 * daily_profile
    # 80% interval assuming independent daily errors, plus a 3% model-error floor
    half = 1.28 * sd_day * math.sqrt(max(remaining_days, 0)) + 0.03 * base_remaining

    base_total = used_kwh + base_remaining
    return {
        "used_kwh": round(used_kwh, 2),
        "remaining_days": round(remaining_days, 2),
        "expected_daily_kwh": round(daily_profile + temp_adj_per_day + extra_kwh_per_day, 2),
        "total_kwh": {
            "low": round(max(used_kwh, base_total - half), 1),
            "base": round(base_total, 1),
            "high": round(base_total + half, 1),
        },
        "features": {
            "temp_sensitivity_kwh_per_c_day": round(beta, 3),
            "temp_outlook_c": round(outlook, 1),
            "temp_reference_c": round(mean_temp, 1),
            "extra_kwh_per_day": round(extra_kwh_per_day, 2),
        },
        "model_version": MODEL_VERSION,
    }


def transformer_balance(dt_kwh: Sequence[Num], meters_kwh: Sequence[Num]) -> dict:
    """Compare the transformer's delivered energy with the sum of its meters.

    gap_ratio = (DT - sum(meters)) / DT over a trailing 4h window. Normal gap is
    technical loss (a few percent). A jump well above its own baseline means
    unbilled energy somewhere on this transformer.
    """
    n = min(len(dt_kwh), len(meters_kwh))
    dt, mt = list(dt_kwh[-n:]), list(meters_kwh[-n:])

    def ratio(end: int) -> Optional[float]:
        d = dt[end - BALANCE_WINDOW + 1: end + 1]
        m = mt[end - BALANCE_WINDOW + 1: end + 1]
        if any(x is None for x in d) or any(x is None for x in m):
            return None
        sd = sum(d)  # type: ignore[arg-type]
        return None if sd <= 0 else (sd - sum(m)) / sd  # type: ignore[arg-type]

    if n < SLOTS_PER_DAY + BALANCE_WINDOW:
        return {"gap_ratio": ratio(n - 1) if n >= BALANCE_WINDOW else None, "baseline": None, "z": None,
                "flag": False, "score": 0.0, "series": []}

    current = ratio(n - 1)
    hist = [r for r in (ratio(e) for e in range(BALANCE_WINDOW - 1, n - SLOTS_PER_DAY, 2)) if r is not None]
    base = median(hist) if hist else None
    mad = median([abs(r - base) for r in hist]) if hist and base is not None else 0.0
    spread = max(1.4826 * mad, 0.002)
    z = None if (current is None or base is None) else (current - base) / spread
    flag = bool(z is not None and z >= BALANCE_Z and current - base >= MIN_BALANCE_DELTA)

    # Hourly series for the last 3 days, for the admin chart
    series = []
    for end in range(max(BALANCE_WINDOW - 1, n - 3 * SLOTS_PER_DAY), n, 4):
        r = ratio(end)
        series.append({"i": end - (n - 1), "gap_ratio": None if r is None else round(r, 4)})

    return {
        "gap_ratio": None if current is None else round(current, 4),
        "baseline": None if base is None else round(base, 4),
        "z": None if z is None else round(z, 2),
        "flag": flag,
        "score": z_to_score(z) if flag and z is not None else 0.0,
        "series": series,
        "model_version": MODEL_VERSION,
    }

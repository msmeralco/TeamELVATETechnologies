"""Unit tests for the baseline model. Run: python -m unittest -v (from prediction-engine/)."""
import math
import random
import unittest

import model

S = model.SLOTS_PER_DAY


def household(days, base=0.8, seed=1):
    rng = random.Random(seed)
    out = []
    for i in range(days * S):
        h = (i % S) / 4
        shape = 0.4 + 0.5 * math.exp(-((h - 7) ** 2) / 4) + 1.0 * math.exp(-((h - 20) ** 2) / 6)
        out.append(max(0.0, base * shape * rng.gauss(1, 0.15)) * 0.25)
    return out


class ScoreTests(unittest.TestCase):
    def test_normal_meter_is_not_flagged(self):
        r = model.score_meter(household(14))
        self.assertIsNone(r["anomaly_type"])
        self.assertLess(r["anomaly_score"], 0.6)

    def test_spike_is_flagged(self):
        k = household(14)
        for i in range(len(k) - 40, len(k)):
            k[i] *= 1.8
        r = model.score_meter(k)
        self.assertEqual(r["anomaly_type"], "consumption_spike")
        self.assertGreaterEqual(r["anomaly_score"], 0.6)

    def test_flatline_is_flagged(self):
        k = household(14)
        for i in range(len(k) - model.FLATLINE_SLOTS, len(k)):
            k[i] = 0.0
        r = model.score_meter(k)
        self.assertEqual(r["anomaly_type"], "flatline")

    def test_long_flatline_stays_flagged(self):
        k = household(14)
        for i in range(len(k) - 9 * S, len(k)):  # dead for 9 days
            k[i] = 0.0
        self.assertEqual(model.score_meter(k)["anomaly_type"], "flatline")

    def test_tamper_signature_flag(self):
        r = model.score_meter(household(14), anomaly_signature=True)
        self.assertEqual(r["anomaly_type"], "tamper_signature")
        self.assertGreaterEqual(r["anomaly_score"], 0.9)

    def test_short_history_does_not_crash(self):
        r = model.score_meter(household(1)[:10])
        self.assertIsNone(r["anomaly_type"])


class ForecastTests(unittest.TestCase):
    def test_range_is_ordered_and_includes_usage(self):
        k = household(14)
        r = model.forecast_cycle(k, [30.0] * len(k), S - 1, used_kwh=100.0, remaining_slots=10 * S)
        t = r["total_kwh"]
        self.assertLessEqual(t["low"], t["base"])
        self.assertLessEqual(t["base"], t["high"])
        self.assertGreaterEqual(t["low"], 100.0)

    def test_what_if_increases_projection(self):
        k = household(14)
        a = model.forecast_cycle(k, [], S - 1, 100.0, 10 * S)
        b = model.forecast_cycle(k, [], S - 1, 100.0, 10 * S, extra_kwh_per_day=2.0)
        self.assertAlmostEqual(b["total_kwh"]["base"] - a["total_kwh"]["base"], 20.0, delta=0.2)

    def test_temperature_sensitivity_detected(self):
        days = [(10 + 0.5 * (t - 28), t) for t in range(24, 36)]
        beta, _ = model.temp_sensitivity(days)
        self.assertAlmostEqual(beta, 0.5, places=3)


class BalanceTests(unittest.TestCase):
    def _feed(self, tap_from=None):
        rng = random.Random(3)
        meters = household(9, base=12)
        dt = []
        for i, m in enumerate(meters):
            v = m * (1 + rng.gauss(0.04, 0.005))
            if tap_from is not None and i >= tap_from:
                v += 0.25
            dt.append(v)
        return dt, meters

    def test_normal_loss_not_flagged(self):
        dt, m = self._feed()
        self.assertFalse(model.transformer_balance(dt, m)["flag"])

    def test_tap_is_flagged(self):
        dt, m = self._feed(tap_from=9 * S - 20)
        r = model.transformer_balance(dt, m)
        self.assertTrue(r["flag"])
        self.assertGreater(r["gap_ratio"], r["baseline"])


if __name__ == "__main__":
    unittest.main()

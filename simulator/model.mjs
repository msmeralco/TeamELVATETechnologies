// Meralco Go simulation model: pure, stateless generation of smart-meter readings.
//
// Every value is a pure function of (seed, meter_id, ts, active events), so any
// 15-minute tick can be generated on its own, on any machine, without replaying
// history. That is what lets the backend (a stateless Vercel function) and the
// local simulator process share this file. See ADR-006.
//
// Randomness: noise is drawn from a tiny PRNG seeded by hash(seed, key, ts), not
// from one global sequential stream.
export const STEP = 15 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;
export const TZ_OFFSET = 8 * 3600e3; // Asia/Manila
export const DT_ID = 'DT-001';
export const EVENT_TYPES = ['spike', 'flatline', 'tamper', 'tap'];

export const DEFAULTS = {
  seed: 42,
  meters: 20,
  backfillDays: 12,
  start: Date.parse('2026-10-01T00:00:00+08:00'),
};

// ---------------------------------------------------------------- hashing / noise
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the joined parts, then a murmur3 finalizer so near-identical keys diverge. */
function hash(...parts) {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const uniform = (seed, key, ts, salt) => mulberry32(hash(seed, key, ts, salt))();
const gauss = (seed, key, ts, salt) => {
  const r = mulberry32(hash(seed, key, ts, salt));
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
};

// ---------------------------------------------------------------- model
const localHour = (ts) => (((ts + TZ_OFFSET) % DAY) / 3600e3);
const dayIndex = (ts) => Math.floor((ts + TZ_OFFSET) / DAY);

export function temperature(ts, seed = DEFAULTS.seed) {
  const d = dayIndex(ts);
  const dayNoise = uniform(seed, 'temp', d, 'day') * 2 - 1; // deterministic per day
  const dailyMean = 29 + 1.8 * Math.sin(d / 5) + 1.2 * dayNoise;
  return dailyMean + 3.5 * Math.cos(((localHour(ts) - 14) / 24) * 2 * Math.PI);
}

/** Meter parameters are derived from the seed, so they never need to be stored. */
export function makeMeters(seed = DEFAULTS.seed, n = DEFAULTS.meters) {
  return Array.from({ length: n }, (_, i) => {
    const id = `m${String(i).padStart(2, '0')}`;
    return {
      id,
      baseKw: 0.3 + 0.9 * uniform(seed, id, 0, 'baseKw'),
      heatSens: 0.02 + 0.04 * uniform(seed, id, 0, 'heatSens'),
      cum0: 5000 + 15000 * uniform(seed, id, 0, 'cum0'),
    };
  });
}

/** `key` names the noise stream (meter id, or 'tap'); `m` carries baseKw / heatSens. */
export function householdKwh(m, ts, temp, seed = DEFAULTS.seed, key = m.id) {
  const h = localHour(ts);
  const morning = 0.5 * Math.exp(-((h - 7) ** 2) / 4);
  const evening = 1.0 * Math.exp(-((h - 20) ** 2) / 6) * (1 + m.heatSens * 10 * Math.max(0, (temp - 29) / 3));
  const shape = 0.4 + morning + evening;
  return Math.max(0, m.baseKw * shape * (1 + 0.15 * gauss(seed, key, ts, 'use'))) * (STEP / 3600e3);
}

// ---------------------------------------------------------------- events
const EMPTY_EVENTS = { spike: [], flatline: [], tamper: [], tap: false };

/**
 * Events active at `ts`, from rows { type, meter_id, started_at, ends_at } (ends_at null = until cleared).
 * Returns { spike: [ids], flatline: [ids], tamper: [ids], tap: bool }.
 */
export function eventsAt(rows, ts) {
  const out = { spike: [], flatline: [], tamper: [], tap: false };
  for (const e of rows ?? []) {
    if (e.started_at > ts || (e.ends_at !== null && e.ends_at !== undefined && ts >= e.ends_at)) continue;
    if (e.type === 'tap') out.tap = true;
    else if (out[e.type] && !out[e.type].includes(e.meter_id)) out[e.type].push(e.meter_id);
  }
  return out;
}

/**
 * createSim({ seed, meters, start }) -> { meters, buildTick(ts, events?), mergeTicks(ticks) }
 * `start` anchors the cumulative registers only; it does not constrain which ts can be generated.
 */
export function createSim({ seed = DEFAULTS.seed, meters = DEFAULTS.meters, start = DEFAULTS.start } = {}) {
  const list = makeMeters(seed, meters);

  function buildTick(ts, events = EMPTY_EVENTS) {
    const temp = temperature(ts, seed);
    const iso = new Date(ts).toISOString();
    let trueSum = 0;
    const readings = list.map((m) => {
      let use = householdKwh(m, ts, temp, seed);
      if (events.spike?.includes(m.id)) use *= 1.6;          // legit new load (aircon / EV)
      trueSum += use;
      let reported = use;
      let signature = false;
      if (events.flatline?.includes(m.id)) reported = 0;      // faulty meter: house still draws power
      if (events.tamper?.includes(m.id)) { reported = use * 0.45; signature = true; }
      // Closed-form register (no running sum): rises ~linearly with the meter's average draw.
      const cumulative = m.cum0 + m.baseKw * 0.8 * (Math.max(0, ts - start) / 3600e3);
      return {
        meter_id: m.id,
        timestamp: iso,
        interval_kwh: Number(reported.toFixed(4)),
        cumulative_kwh: Number(cumulative.toFixed(3)),
        signal_quality: Math.round(Math.min(100, Math.max(40, 86 + 6 * gauss(seed, m.id, ts, 'sig')))),
        anomaly_signature: signature,
      };
    });
    const technicalLoss = trueSum * (0.04 + 0.004 * gauss(seed, DT_ID, ts, 'loss'));
    // A tap draws before the meters, so it appears only on the transformer reading.
    const tap = events.tap ? householdKwh({ baseKw: 1.4, heatSens: 0.04 }, ts, temp, seed, 'tap') : 0;
    return {
      meter_readings: readings,
      transformer_readings: [{ transformer_id: DT_ID, timestamp: iso, interval_kwh: Number((trueSum + technicalLoss + tap).toFixed(4)) }],
      public_features: [{ timestamp: iso, temp_c: Number(temp.toFixed(1)) }],
    };
  }

  return { seed, start, meters: list, buildTick, mergeTicks };
}

/** Merge several buildTick() results into one reading-format batch (README "Reading format"). */
export function mergeTicks(ticks) {
  return ticks.reduce((acc, b) => ({
    ...acc,
    meter_readings: acc.meter_readings.concat(b.meter_readings),
    transformer_readings: acc.transformer_readings.concat(b.transformer_readings),
    public_features: acc.public_features.concat(b.public_features),
  }), { source: 'simulator', meter_readings: [], transformer_readings: [], public_features: [] });
}

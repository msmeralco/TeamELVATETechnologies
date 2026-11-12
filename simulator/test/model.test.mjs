import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, eventsAt, makeMeters, mergeTicks, STEP, DEFAULTS } from '../model.mjs';

const T0 = DEFAULTS.start + 5 * 86400e3 + 20 * 3600e3; // evening, day 6
const NONE = { spike: [], flatline: [], tamper: [], tap: false };

test('same (seed, ts) gives the same tick, regardless of instance or call order', () => {
  const a = createSim({ seed: 42 });
  const b = createSim({ seed: 42 });
  a.buildTick(T0 - STEP); a.buildTick(T0 + 99 * STEP); // generating other ticks first must not matter
  assert.deepEqual(a.buildTick(T0), b.buildTick(T0));
  assert.deepEqual(a.buildTick(T0), a.buildTick(T0));
});

test('a different seed gives different meters and readings', () => {
  const a = createSim({ seed: 42 }).buildTick(T0);
  const c = createSim({ seed: 7 }).buildTick(T0);
  assert.notDeepEqual(a.meter_readings.map((r) => r.interval_kwh), c.meter_readings.map((r) => r.interval_kwh));
  assert.notDeepEqual(makeMeters(42, 3).map((m) => m.baseKw), makeMeters(7, 3).map((m) => m.baseKw));
});

test('meter parameters are derived from the seed and ids are m00..', () => {
  const ms = makeMeters(42, 20);
  assert.equal(ms.length, 20);
  assert.equal(ms[3].id, 'm03');
  assert.deepEqual(ms, makeMeters(42, 20));
  assert.ok(ms.every((m) => m.baseKw >= 0.3 && m.baseKw <= 1.2));
});

test('noise differs between meters and between timestamps', () => {
  const t = createSim().buildTick(T0);
  const t2 = createSim().buildTick(T0 + STEP);
  assert.ok(new Set(t.meter_readings.map((r) => r.interval_kwh)).size > 15);
  assert.notDeepEqual(t.meter_readings.map((r) => r.interval_kwh), t2.meter_readings.map((r) => r.interval_kwh));
});

test('an injected spike changes only the target meter', () => {
  const sim = createSim();
  const base = sim.buildTick(T0, NONE);
  const spiked = sim.buildTick(T0, { ...NONE, spike: ['m03'] });
  base.meter_readings.forEach((r, i) => {
    const s = spiked.meter_readings[i];
    if (r.meter_id === 'm03') {
      assert.ok(Math.abs(s.interval_kwh / r.interval_kwh - 1.6) < 0.01, 'm03 draws 1.6x');
      assert.equal(s.anomaly_signature, false);
    } else {
      assert.deepEqual(s, r, `${r.meter_id} must be untouched`);
    }
  });
  assert.deepEqual(spiked.public_features, base.public_features);
});

test('flatline, tamper and tap affect only what they should', () => {
  const sim = createSim();
  const base = sim.buildTick(T0, NONE);
  const flat = sim.buildTick(T0, { ...NONE, flatline: ['m05'] });
  const tamper = sim.buildTick(T0, { ...NONE, tamper: ['m07'] });
  const tap = sim.buildTick(T0, { ...NONE, tap: true });
  assert.equal(flat.meter_readings[5].interval_kwh, 0);
  assert.equal(flat.meter_readings.filter((r, i) => i !== 5 && r.interval_kwh !== base.meter_readings[i].interval_kwh).length, 0);
  assert.equal(tamper.meter_readings[7].anomaly_signature, true);
  assert.ok(Math.abs(tamper.meter_readings[7].interval_kwh / base.meter_readings[7].interval_kwh - 0.45) < 0.01);
  assert.deepEqual(tap.meter_readings, base.meter_readings, 'a tap is invisible to the meters');
  assert.ok(tap.transformer_readings[0].interval_kwh > base.transformer_readings[0].interval_kwh);
});

test('eventsAt honours started_at / ends_at', () => {
  const rows = [
    { type: 'spike', meter_id: 'm03', started_at: T0, ends_at: null },
    { type: 'flatline', meter_id: 'm04', started_at: T0, ends_at: T0 + 2 * STEP },
    { type: 'tap', meter_id: null, started_at: T0 + STEP, ends_at: null },
  ];
  assert.deepEqual(eventsAt(rows, T0 - STEP), NONE);
  assert.deepEqual(eventsAt(rows, T0), { ...NONE, spike: ['m03'], flatline: ['m04'] });
  assert.deepEqual(eventsAt(rows, T0 + STEP), { spike: ['m03'], flatline: ['m04'], tamper: [], tap: true });
  assert.deepEqual(eventsAt(rows, T0 + 2 * STEP), { ...NONE, spike: ['m03'], tap: true });
});

test('ticks match the reading-format contract and merge cleanly', () => {
  const sim = createSim();
  const batch = mergeTicks([sim.buildTick(T0), sim.buildTick(T0 + STEP)]);
  assert.equal(batch.meter_readings.length, 40);
  assert.equal(batch.transformer_readings.length, 2);
  const r = batch.meter_readings[0];
  assert.deepEqual(Object.keys(r).sort(), ['anomaly_signature', 'cumulative_kwh', 'interval_kwh', 'meter_id', 'signal_quality', 'timestamp']);
  assert.ok(r.signal_quality >= 40 && r.signal_quality <= 100);
  // cumulative register never goes backwards
  const early = sim.buildTick(DEFAULTS.start).meter_readings[0].cumulative_kwh;
  assert.ok(sim.buildTick(T0).meter_readings[0].cumulative_kwh > early);
});

// Simulation service: the stateless simulator (simulator/model.mjs) driven from Postgres.
// No process holds the clock. State lives in `simulation_state` / `simulation_events`;
// any function instance can seed history or advance the clock (ADR-006).
import { config, STEP_MS, DAY_MS } from './config.js';
import { db, tx, bulkUpsert } from './db.js';
import { HttpError, storeBatch, tryScore } from './pipeline.js';
import { createSim, eventsAt, mergeTicks, DT_ID } from '../../simulator/model.mjs';

const MAX_STEPS = 16;          // ticks one request may advance (catch-up after a stalled tab)
const PACING_SLACK = 0.25;     // a driver may be this fraction of a tick early
const SEED_BUDGET_MS = 40_000; // stay well inside the 60 s function limit

const sim = createSim({ seed: config.sim.seed, meters: config.sim.meters, start: config.sim.start });
const backfillEnd = config.sim.start + config.sim.backfillDays * DAY_MS - STEP_MS;

const getState = () => db.get('SELECT * FROM simulation_state WHERE id = 1');
const ensureState = () => db.run('INSERT INTO simulation_state (id, tick_ms) VALUES (1, ?) ON CONFLICT (id) DO NOTHING', [config.sim.tickMs]);

/** Response shape the admin demo bar expects (+ `seeded` and `backfill_end`). */
export async function status() {
  const st = await getState();
  const active = await db.all('SELECT type, meter_id, started_at, ends_at FROM simulation_events WHERE ends_at IS NULL');
  return {
    sim_ts: st?.sim_ts ?? null,
    tick_ms: st?.tick_ms ?? config.sim.tickMs,
    paused: st?.paused ?? false,
    meters: sim.meters.map((m) => m.id),
    transformer_id: DT_ID,
    events: eventsAt(active, Infinity),
    seeded: st?.sim_ts != null && st.sim_ts >= backfillEnd,
    backfill_end: backfillEnd,
  };
}

export async function patch({ tick_ms: tickMs, paused }) {
  if (tickMs !== undefined && (!Number.isFinite(tickMs) || tickMs < 100 || tickMs > 60000)) throw new HttpError(422, 'VALIDATION_FAILED', 'tick_ms must be 100-60000');
  await ensureState();
  if (tickMs !== undefined) await db.run('UPDATE simulation_state SET tick_ms = ? WHERE id = 1', [tickMs]);
  if (typeof paused === 'boolean') {
    // Resuming restarts the pacing clock so a long pause does not release a burst of ticks.
    await db.run('UPDATE simulation_state SET paused = ?, last_advance_at = ? WHERE id = 1', [paused, Date.now()]);
  }
  return status();
}

export async function addEvent({ type, meter_id: id }) {
  const needsMeter = ['spike', 'flatline', 'tamper'].includes(type);
  if (needsMeter && !sim.meters.some((m) => m.id === id)) throw new HttpError(422, 'VALIDATION_FAILED', 'unknown meter_id');
  if (!needsMeter && type !== 'tap' && type !== 'clear') throw new HttpError(422, 'VALIDATION_FAILED', 'type must be spike, flatline, tamper, tap or clear');
  const st = await getState();
  const next = (st?.sim_ts ?? config.sim.start - STEP_MS) + STEP_MS; // first tick not yet generated
  if (type === 'clear') {
    await db.run('UPDATE simulation_events SET ends_at = ? WHERE ends_at IS NULL', [next]);
  } else {
    const meterId = needsMeter ? id : null;
    const dup = await db.get('SELECT id FROM simulation_events WHERE ends_at IS NULL AND type = ? AND COALESCE(meter_id, \'\') = ?', [type, meterId ?? '']);
    if (!dup) await db.run('INSERT INTO simulation_events (type, meter_id, started_at) VALUES (?, ?, ?)', [type, meterId, next]);
  }
  return status();
}

/**
 * Idempotent. Registers DT-001 and the meters, then backfills history one day per
 * transaction, saving progress in simulation_state.sim_ts. Stops at `SEED_BUDGET_MS`;
 * the caller repeats while `done` is false.
 */
export async function seed() {
  const t0 = Date.now();
  await tx(async (t) => {
    await bulkUpsert(t.raw, 'transformers', ['id', 'label'], [[DT_ID, `Distribution transformer ${DT_ID}`]], ['id']);
    await bulkUpsert(t.raw, 'meters', ['id', 'transformer_id', 'customer_type', 'label', 'registered_at'],
      sim.meters.map((m) => [m.id, DT_ID, 'residential', `Household ${m.id.toUpperCase()}`, t0]), ['id']);
    await bulkUpsert(t.raw, 'users', ['id', 'role', 'name', 'meter_id'],
      sim.meters.map((m) => [`u-${m.id}`, 'customer', `Household ${m.id.toUpperCase()}`, m.id]), ['id']);
  });
  await ensureState();

  let cur = (await getState()).sim_ts ?? config.sim.start - STEP_MS;
  while (cur < backfillEnd && Date.now() - t0 < SEED_BUDGET_MS) {
    const ticks = [];
    for (let i = 0; i < 96 && cur + STEP_MS * (i + 1) <= backfillEnd; i++) ticks.push(sim.buildTick(cur + STEP_MS * (i + 1)));
    await storeBatch(mergeTicks(ticks), 'simulator');
    cur += STEP_MS * ticks.length;
    await db.run('UPDATE simulation_state SET sim_ts = ?, last_advance_at = ? WHERE id = 1 AND (sim_ts IS NULL OR sim_ts < ?)', [cur, Date.now(), cur]);
  }
  return { done: cur >= backfillEnd, sim_ts: cur, backfill_end: backfillEnd };
}

/**
 * Advances the clock by up to `requested` ticks, stores them, and scores the newest.
 * Safe to call from several drivers at once: pacing is server-side (at most one tick
 * per `tick_ms` of wall time, so two drivers do not double the speed) and the
 * conditional UPDATE below lets only one caller claim a given step.
 */
export async function advance(requested = 1) {
  const n0 = Math.max(1, Math.min(MAX_STEPS, Math.floor(Number(requested)) || 1));
  const st = await getState();
  if (!st || st.sim_ts == null || st.sim_ts < backfillEnd) throw new HttpError(409, 'NOT_SEEDED', 'Demo data is not seeded yet. POST /simulation/seed first.');
  const idle = { advanced: 0, sim_ts: st.sim_ts, paused: st.paused, scored: false };
  if (st.paused) return idle;

  const now = Date.now();
  const due = Math.floor((now - st.last_advance_at) / st.tick_ms + PACING_SLACK);
  const n = Math.min(n0, due);
  if (n < 1) return idle;
  const newTs = st.sim_ts + n * STEP_MS;
  const nextAdvanceAt = due > n ? now : st.last_advance_at + n * st.tick_ms;

  const claim = await db.run('UPDATE simulation_state SET sim_ts = ?, last_advance_at = ? WHERE id = 1 AND sim_ts = ?', [newTs, nextAdvanceAt, st.sim_ts]);
  if (!claim.rowCount) return { ...idle, conflict: true }; // another driver advanced first

  try {
    const evRows = await db.all('SELECT type, meter_id, started_at, ends_at FROM simulation_events WHERE ends_at IS NULL OR ends_at > ?', [st.sim_ts]);
    const ticks = [];
    for (let i = 1; i <= n; i++) {
      const ts = st.sim_ts + i * STEP_MS;
      ticks.push(sim.buildTick(ts, eventsAt(evRows, ts)));
    }
    await storeBatch(mergeTicks(ticks), 'simulator');
  } catch (e) {
    await db.run('UPDATE simulation_state SET sim_ts = ?, last_advance_at = ? WHERE id = 1 AND sim_ts = ?', [st.sim_ts, st.last_advance_at, newTs]);
    throw e;
  }
  const scored = await tryScore(newTs);
  return { advanced: n, sim_ts: newTs, paused: false, scored };
}

/** Wipes all demo data (demo mode only; the route enforces that). Re-seed afterwards. */
export async function reset() {
  await db.run(`TRUNCATE readings, transformer_readings, public_features, forecasts, bills, alerts, reports, ledger_entries,
    users, meters, transformers, simulation_events, simulation_state, transformer_balances RESTART IDENTITY CASCADE`);
  return status();
}

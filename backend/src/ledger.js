// Cycle snapshots for EGovChain. The full snapshot is rebuilt from the database
// on demand; only its SHA-256 hash goes on the chain. Verification rebuilds the
// snapshot and compares hashes: "tamper-evident after recording", it cannot
// prove a reading was correct when it was written.
import { db } from './db.js';
import { rates } from './billing/engine.js';
import { canonical, sha256 } from './hash.js';

export { canonical, sha256 };

export async function buildSnapshot(cycleId, periodStart, asOf) {
  const meterIds = await db.all('SELECT id FROM meters ORDER BY id');
  const meters = [];
  for (const { id } of meterIds) {
    const rows = await db.all('SELECT ts, interval_kwh FROM readings WHERE meter_id = ? AND ts >= ? AND ts <= ? ORDER BY ts', [id, periodStart, asOf]);
    const readingsDigest = sha256(rows.map((r) => `${r.ts}:${r.interval_kwh.toFixed(4)}`).join('|'));
    const kwh = rows.reduce((s, r) => s + r.interval_kwh, 0);
    meters.push({ meter_id: id, readings: rows.length, kwh: Number(kwh.toFixed(3)), readings_digest: readingsDigest });
  }
  const shown = await db.all(`SELECT id, meter_id, kwh_low, kwh_base, kwh_high, php_low, php_base, php_high
      FROM bills WHERE cycle_id = ? AND sim_ts <= ? ORDER BY id`, [cycleId, asOf]);
  return {
    cycle_id: cycleId,
    period_start: periodStart,
    as_of: asOf,
    rate_version: rates.version,
    meters,
    projections_shown: { count: shown.length, digest: sha256(canonical(shown)) },
  };
}

export const snapshotHash = (snap) => sha256(canonical(snap));

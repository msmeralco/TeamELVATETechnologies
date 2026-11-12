// Ingestion -> prediction engine -> alert routing -> real-time delivery.
import { config, STEP_MS, DAY_MS } from './config.js';
import { db, tx, bulkUpsert } from './db.js';
import { scoreMeters, balanceTransformer } from './prediction.js';
import { sendEMessage } from './integrations/egov.js';
import { broadcast } from './sse.js';


// ---------------------------------------------------------------- validation
export class HttpError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}

const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v);
const isTs = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function validateBatch(b) {
  const errs = [];
  if (!b || typeof b !== 'object') throw new HttpError(422, 'VALIDATION_FAILED', 'Body must be a JSON object');
  if (!Array.isArray(b.meter_readings) || b.meter_readings.length === 0 || b.meter_readings.length > 5000) errs.push('meter_readings must be a non-empty array (max 5000)');
  (b.meter_readings ?? []).slice(0, 5000).forEach((r, i) => {
    if (!isId(r?.meter_id)) errs.push(`meter_readings[${i}].meter_id invalid`);
    if (!isTs(r?.timestamp)) errs.push(`meter_readings[${i}].timestamp invalid`);
    if (!isNum(r?.interval_kwh, 0, 1000)) errs.push(`meter_readings[${i}].interval_kwh out of range`);
    if (!isNum(r?.cumulative_kwh, 0, 1e9)) errs.push(`meter_readings[${i}].cumulative_kwh out of range`);
    if (!isNum(r?.signal_quality, 0, 100)) errs.push(`meter_readings[${i}].signal_quality must be 0-100`);
    if (typeof r?.anomaly_signature !== 'boolean') errs.push(`meter_readings[${i}].anomaly_signature must be boolean`);
  });
  (b.transformer_readings ?? []).forEach((r, i) => {
    if (!isId(r?.transformer_id)) errs.push(`transformer_readings[${i}].transformer_id invalid`);
    if (!isTs(r?.timestamp)) errs.push(`transformer_readings[${i}].timestamp invalid`);
    if (!isNum(r?.interval_kwh, 0, 1e6)) errs.push(`transformer_readings[${i}].interval_kwh out of range`);
  });
  (b.public_features ?? []).forEach((f, i) => {
    if (!isTs(f?.timestamp) || !isNum(f?.temp_c, -10, 60)) errs.push(`public_features[${i}] invalid`);
  });
  if (errs.length) throw new HttpError(422, 'VALIDATION_FAILED', 'Invalid reading batch', errs.slice(0, 20));
}

// ---------------------------------------------------------------- storage
const r4 = (n) => Math.round(n * 10000) / 10000;

export async function storeBatch(b, source) {
  const unknown = new Set();
  let maxTs = 0;

  const out = await tx(async (t) => {
    const meterIds = [...new Set(b.meter_readings.map((r) => r.meter_id))];
    const dtIds = [...new Set((b.transformer_readings ?? []).map((r) => r.transformer_id))];
    const knownMeters = new Set(meterIds.length ? (await t.all('SELECT id FROM meters WHERE id = ANY(?)', [meterIds])).map((r) => r.id) : []);
    const knownDts = new Set(dtIds.length ? (await t.all('SELECT id FROM transformers WHERE id = ANY(?)', [dtIds])).map((r) => r.id) : []);

    const readingRows = [];
    for (const r of b.meter_readings) {
      if (!knownMeters.has(r.meter_id)) { unknown.add(r.meter_id); continue; }
      const ts = Date.parse(r.timestamp);
      maxTs = Math.max(maxTs, ts);
      readingRows.push([r.meter_id, ts, r4(r.interval_kwh), r4(r.cumulative_kwh), Math.round(r.signal_quality), r.anomaly_signature ? 1 : 0, source]);
    }
    if (readingRows.length) {
      await bulkUpsert(t.raw, 'readings', ['meter_id', 'ts', 'interval_kwh', 'cumulative_kwh', 'signal_quality', 'anomaly_signature', 'source'], readingRows, ['meter_id', 'ts']);
    }

    const dtRows = [];
    for (const r of b.transformer_readings ?? []) {
      if (!knownDts.has(r.transformer_id)) { unknown.add(r.transformer_id); continue; }
      dtRows.push([r.transformer_id, Date.parse(r.timestamp), r4(r.interval_kwh)]);
    }
    if (dtRows.length) await bulkUpsert(t.raw, 'transformer_readings', ['transformer_id', 'ts', 'interval_kwh'], dtRows, ['transformer_id', 'ts']);

    const featureRows = (b.public_features ?? []).map((f) => [Date.parse(f.timestamp), f.temp_c]);
    if (featureRows.length) await bulkUpsert(t.raw, 'public_features', ['ts', 'temp_c'], featureRows, ['ts']);

    return { stored: b.meter_readings.length - unknown.size, unknown: [...unknown], maxTs };
  });

  return out;
}

// ---------------------------------------------------------------- series
/** Dense 15-minute arrays (oldest first) ending at endTs, null where missing. */
export async function loadSeries(endTs, days) {
  const n = days * 96;
  const start = endTs - (n - 1) * STEP_MS;
  const meters = await db.all('SELECT id, transformer_id FROM meters ORDER BY id');
  const byMeter = new Map(meters.map((m) => [m.id, new Array(n).fill(null)]));
  const sig = new Map();
  const readingRows = await db.all('SELECT meter_id, ts, interval_kwh, anomaly_signature FROM readings WHERE ts >= ? AND ts <= ?', [start, endTs]);
  for (const r of readingRows) {
    const arr = byMeter.get(r.meter_id);
    const i = (r.ts - start) / STEP_MS;
    if (arr && Number.isInteger(i)) arr[i] = r.interval_kwh;
    if (r.ts === endTs) sig.set(r.meter_id, r.anomaly_signature === 1);
  }
  const temps = new Array(n).fill(null);
  const featureRows = await db.all('SELECT ts, temp_c FROM public_features WHERE ts >= ? AND ts <= ?', [start, endTs]);
  for (const f of featureRows) {
    const i = (f.ts - start) / STEP_MS;
    if (Number.isInteger(i)) temps[i] = f.temp_c;
  }
  return { meters, byMeter, sig, temps, start, n };
}

async function transformerSeries(id, meters, byMeter, start, n, endTs) {
  const dt = new Array(n).fill(null);
  const rows = await db.all('SELECT ts, interval_kwh FROM transformer_readings WHERE transformer_id = ? AND ts >= ? AND ts <= ?', [id, start, endTs]);
  for (const r of rows) {
    const i = (r.ts - start) / STEP_MS;
    if (Number.isInteger(i)) dt[i] = r.interval_kwh;
  }
  const own = meters.filter((m) => m.transformer_id === id).map((m) => byMeter.get(m.id));
  const sum = new Array(n).fill(null).map((_, i) => (own.every((a) => a[i] !== null) ? own.reduce((s, a) => s + a[i], 0) : null));
  return { dt, sum };
}

// ---------------------------------------------------------------- alerts
const pctText = (p) => (p === null || p === undefined ? '' : `${Math.abs(Math.round(p))}%`);

function meterAlertSpec(type, s, meterId) {
  const pct = pctText(s.deviation_pct);
  switch (type) {
    case 'consumption_spike':
      return {
        audience: 'both',
        title: 'Usage higher than expected',
        customer_text: `Your usage over the past 24 hours is about ${pct} higher than expected for this time of week. If you recently added an appliance (for example an aircon unit or EV charging), this is expected. If not, check for appliances left running. Your projected bill in the app has been updated.`,
        // SMS copy: one 160-char GSM-7 segment = one credit. The long text stays in the app.
        sms_text: `Meralco Go: Your usage in the last 24h is about ${pct} above expected. If you added no new appliance, check for devices left on. Details in the app.`,
        ops_text: `${meterId}: trailing-24h usage ${pct} above forecast (z = ${s.z}). Customer notified. Most often a new load; no field action unless it persists.`,
      };
    case 'flatline':
      return {
        audience: 'both',
        title: 'Your meter may not be recording',
        customer_text: 'Your meter has not recorded any usage for the past 2 hours, although your home normally uses power at this time. This may be a meter or communication fault. You do not need to do anything; Meralco has been notified and may schedule a check.',
        sms_text: 'Meralco Go: Your meter has not recorded usage for 2 hours. This may be a meter fault. No action needed; Meralco has been notified.',
        ops_text: `${meterId}: zero readings for 2 hours while the forecast expects use. Possible meter fault, communication issue or bypass. Schedule a meter check.`,
      };
    case 'consumption_drop':
      return {
        audience: 'ops',
        title: 'Usage well below expected',
        customer_text: null,
        ops_text: `${meterId}: trailing-24h usage ${pct} below forecast (z = ${s.z}). Could be vacancy, a fault or a bypass. Review before any customer contact.`,
      };
    case 'tamper_signature':
      return {
        audience: 'ops',
        title: 'Tampering-signature event from meter',
        customer_text: null,
        ops_text: `${meterId}: the meter reported a tampering-signature event${Math.abs(s.deviation_pct ?? 0) >= 10 ? `; usage is ${pct} off forecast` : ''}. Possible tampering, bypass or sensor fault. Verify in the field. This is a device/model signal, not a finding.`,
      };
    default:
      return null;
  }
}

const RECENT_ALERT_SQL = `SELECT id FROM alerts WHERE type = ? AND COALESCE(meter_id, '') = ? AND COALESCE(transformer_id, '') = ?
  AND (status = 'open' OR detected_at > ?) LIMIT 1`;
const INS_ALERT_SQL = `INSERT INTO alerts (meter_id, transformer_id, type, audience, score, title, customer_text, ops_text, context, detected_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;
const SET_MSG_SQL = 'UPDATE alerts SET emessage_id = ?, emessage_source = ? WHERE id = ?';

export const parseAlert = (a) => (a ? { ...a, context: JSON.parse(a.context) } : a);

async function raiseAlert({ meterId = null, transformerId = null, type, score, spec, context, ts }) {
  const cooldown = ts - 6 * 60 * 60 * 1000;
  if (await db.get(RECENT_ALERT_SQL, [type, meterId ?? '', transformerId ?? '', cooldown])) return null;
  const row = await db.get(INS_ALERT_SQL, [meterId, transformerId, type, spec.audience, score, spec.title, spec.customer_text, spec.ops_text,
    JSON.stringify(context ?? {}), ts, Date.now()]);
  // Customer-facing text only ever describes the customer's own meter.
  if (spec.audience !== 'ops' && meterId) {
    const res = await sendEMessage(`u-${meterId}`, spec.sms_text ?? spec.customer_text);
    await db.run(SET_MSG_SQL, [res.data.id ?? res.data.message_id ?? 'unknown', res.source, row.id]);
    row.emessage_id = res.data.id; row.emessage_source = res.source;
  }
  const alert = parseAlert(row);
  broadcast('alert', alert);
  return alert;
}

const SUSPECT_TYPES = ['flatline', 'tamper_signature', 'consumption_drop'];

const balanceText = (dtId, gap, base, suspect) =>
  `${dtId} delivered ${gap}% more energy than its meters recorded over the last 4 hours (baseline ${base}%). Consistent with possible pilferage before the meters, an unrecorded meter or a metering fault.${
    suspect
      ? ` Coincides with an open ${suspect.type.replace('_', ' ')} alert on ${suspect.meter_id}: check that meter first.`
      : ' No single meter explains it so far.'}`;

/**
 * A meter-level fault can surface after the transformer gap (a flatline needs
 * 2 hours to confirm). When it does, point the open balance alert at it.
 */
async function attributeBalance(meterId, type) {
  const a = await db.get(`SELECT al.* FROM alerts al JOIN meters m ON m.transformer_id = al.transformer_id
     WHERE m.id = ? AND al.type = 'transformer_balance' AND al.status = 'open'`, [meterId]);
  if (!a) return;
  const ctx = JSON.parse(a.context);
  if (ctx.likely_meter) return;
  ctx.likely_meter = meterId;
  const text = balanceText(a.transformer_id, (ctx.gap_ratio * 100).toFixed(1), (ctx.baseline * 100).toFixed(1), { meter_id: meterId, type });
  const updated = await db.get('UPDATE alerts SET ops_text = ?, context = ? WHERE id = ? RETURNING *', [text, JSON.stringify(ctx), a.id]);
  broadcast('alert', parseAlert(updated));
}

async function raiseBalanceAlert(dtId, bal, ts) {
  const suspects = await db.all(`SELECT a.meter_id, a.type FROM alerts a JOIN meters m ON m.id = a.meter_id
     WHERE m.transformer_id = ? AND a.status = 'open' AND a.type IN (${SUSPECT_TYPES.map(() => '?').join(',')})`, [dtId, ...SUSPECT_TYPES]);
  const reports = (await db.get(`SELECT COUNT(*) AS n FROM reports WHERE transformer_id = ? AND category IN ('suspected_jumper', 'meter_issue') AND status != 'closed'`, [dtId])).n;
  const gap = (bal.gap_ratio * 100).toFixed(1);
  const base = (bal.baseline * 100).toFixed(1);
  const spec = {
    audience: 'ops',
    title: `Unbilled energy gap on ${dtId}`,
    customer_text: null,
    ops_text: balanceText(dtId, gap, base, suspects[0]),
  };
  const score = Math.min(0.99, bal.score + 0.05 * reports);
  return raiseAlert({ transformerId: dtId, type: 'transformer_balance', score, spec, ts,
    context: { gap_ratio: bal.gap_ratio, baseline: bal.baseline, z: bal.z, likely_meter: suspects[0]?.meter_id ?? null, corroborating_reports: reports } });
}

/** A new customer report on a transformer with an open balance alert raises that alert's confidence. */
export async function corroborate(dtId) {
  const a = await db.get(`SELECT * FROM alerts WHERE transformer_id = ? AND type = 'transformer_balance' AND status = 'open'`, [dtId]);
  if (!a) return null;
  const ctx = JSON.parse(a.context);
  ctx.corroborating_reports = (ctx.corroborating_reports ?? 0) + 1;
  const updated = await db.get('UPDATE alerts SET score = ?, context = ? WHERE id = ? RETURNING *',
    [Math.min(0.99, a.score + 0.05), JSON.stringify(ctx), a.id]);
  broadcast('alert', parseAlert(updated));
  return updated;
}

// ---------------------------------------------------------------- scoring tick
const INS_FORECAST_SQL = `INSERT INTO forecasts (meter_id, ts, expected_kwh, residual_kwh, z, deviation_pct, anomaly_score, anomaly_type, model_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Scores the tick at `ts`: forecasts, alerts, transformer balance. Awaited inside the
 * request (a serverless function may be frozen once the response is sent). Skips a tick
 * that already has forecasts, or an older one than the newest scored.
 */
export async function scoreTick(ts) {
  const done = await db.get('SELECT MAX(ts) AS ts FROM forecasts');
  if (done?.ts != null && ts <= done.ts) return false;
  const { meters, byMeter, sig, start, n } = await loadSeries(ts, config.historyDays);
  const scores = await scoreMeters(meters.map((m) => ({ meter_id: m.id, kwh: byMeter.get(m.id), anomaly_signature: sig.get(m.id) ?? false })));
  await tx(async (t) => {
    for (const s of scores) {
      await t.run(INS_FORECAST_SQL, [s.meter_id, ts, s.expected_kwh, s.residual_kwh, s.z, s.deviation_pct, s.anomaly_score, s.anomaly_type, s.model_version]);
    }
  });
  for (const s of scores) {
    if (s.anomaly_type && s.anomaly_score >= config.anomalyThreshold) {
      const spec = meterAlertSpec(s.anomaly_type, s, s.meter_id);
      const created = spec && await raiseAlert({ meterId: s.meter_id, type: s.anomaly_type, score: s.anomaly_score, spec, ts,
        context: { z: s.z, deviation_pct: s.deviation_pct, model_version: s.model_version } });
      if (created && SUSPECT_TYPES.includes(s.anomaly_type)) await attributeBalance(s.meter_id, s.anomaly_type);
    }
  }
  for (const { id } of await db.all('SELECT id FROM transformers')) {
    const { dt, sum } = await transformerSeries(id, meters, byMeter, start, n, ts);
    const bal = await balanceTransformer({ transformer_id: id, dt_kwh: dt, meters_kwh: sum });
    await db.run(`INSERT INTO transformer_balances (transformer_id, ts, result) VALUES (?, ?, ?)
      ON CONFLICT (transformer_id) DO UPDATE SET ts = excluded.ts, result = excluded.result`, [id, ts, JSON.stringify({ ...bal, ts })]);
    if (bal.flag) await raiseBalanceAlert(id, bal, ts);
  }
  broadcast('tick', { ts, scored: scores.length });
  return true;
}

/** scoreTick that never throws: ingestion must succeed even when the engine is down. */
export async function tryScore(ts) {
  try { return await scoreTick(ts); } catch (e) { console.warn('[pipeline] scoring skipped:', e.message); return false; }
}

export const getBalances = async () => new Map((await db.all('SELECT transformer_id, result FROM transformer_balances'))
  .map((r) => [r.transformer_id, JSON.parse(r.result)]));

export const usedKwh = async (meterId, from, to) =>
  (await db.get('SELECT COALESCE(SUM(interval_kwh), 0) AS kwh FROM readings WHERE meter_id = ? AND ts >= ? AND ts <= ?', [meterId, from, to])).kwh;

export const dailyKwh = async (meterId, from, to) =>
  db.all(`SELECT (ts + 28800000) / ${DAY_MS} AS d, SUM(interval_kwh) AS kwh, COUNT(*) AS n FROM readings
     WHERE meter_id = ? AND ts >= ? AND ts <= ? GROUP BY d ORDER BY d`, [meterId, from, to]);

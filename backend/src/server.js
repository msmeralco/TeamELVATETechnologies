import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { config, cycleFor, localDate, slotOfDay, STEP_MS, DAY_MS } from './config.js';
import { db, latestReadingTs, initSchema } from './db.js';
import { computeBill, billRange, rateInfo } from './billing/engine.js';
import { submitEReport, writeChainRecord, readChainRecord, integrationStatus } from './integrations/egov.js';
import { buildSnapshot, snapshotHash } from './ledger.js';
import { forecastCycle, engineStatus } from './prediction.js';
import { broadcast, sseHandler } from './sse.js';
import {
  HttpError, validateBatch, storeBatch, tryScore, getBalances, parseAlert, corroborate, usedKwh, dailyKwh,
} from './pipeline.js';
import * as simulation from './simulation.js';

await initSchema();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { req.id = crypto.randomUUID().slice(0, 8); res.setHeader('X-Request-Id', req.id); next(); });

const api = express.Router();
app.use('/api/v1', api);

// ------------------------------------------------------------------ guards
const requireIngestKey = (req, _res, next) => {
  const key = req.get('x-ingest-key') ?? '';
  const a = Buffer.from(key); const b = Buffer.from(config.ingestKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid ingest key');
  next();
};

// Staff login is out of scope for the hackathon demo (mocked): the admin site
// sends this header. Replace with real authentication before any pilot.
const requireStaff = (req, _res, next) => {
  if (req.get('x-demo-role') !== 'staff') throw new HttpError(403, 'FORBIDDEN', 'Staff access required');
  next();
};

function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  return (req, _res, next) => {
    const k = key(req); const now = Date.now();
    const arr = (hits.get(k) ?? []).filter((t) => t > now - windowMs);
    if (arr.length >= max) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests, try again shortly');
    arr.push(now); hits.set(k, arr); next();
  };
}

// ?since_id=N: only rows newer than N (the web apps poll with it where SSE is unavailable).
const sinceId = (req) => {
  const n = Number(req.query.since_id);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(422, 'VALIDATION_FAILED', 'since_id must be a non-negative integer');
  return n;
};
const meterOr404 = async (id) => {
  const m = await db.get('SELECT * FROM meters WHERE id = ?', [String(id)]);
  if (!m) throw new HttpError(404, 'NOT_FOUND', `Meter ${id} not found`);
  return m;
};
const simNow = async () => {
  const ts = await latestReadingTs();
  if (ts === null) throw new HttpError(409, 'NO_DATA', 'No readings yet. Seed the demo data (admin console or POST /simulation/seed).');
  return ts;
};
const cycleView = (now) => {
  const c = cycleFor(now);
  return { ...c, day: Math.floor((now - c.start) / DAY_MS) + 1 };
};

// ------------------------------------------------------------------ system
api.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
api.get('/events', sseHandler);

api.get('/system', async (_req, res) => {
  const ts = await latestReadingTs();
  res.json({ data: {
    sim_ts: ts,
    cycle: ts ? cycleView(ts) : null,
    engine: await engineStatus(),
    realtime: config.realtime,
    integrations: integrationStatus(),
    rates: rateInfo(),
    demo_mode: config.demoMode,
    anomaly_threshold: config.anomalyThreshold,
  } });
});

// ------------------------------------------------------------------ ingestion
api.put('/meters/:id', requireIngestKey, async (req, res) => {
  const { transformer_id: dt, label, customer_type: type = 'residential' } = req.body ?? {};
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[A-Za-z0-9_-]{1,32}$/.test(dt ?? '') || typeof label !== 'string' || label.length > 80) {
    throw new HttpError(422, 'VALIDATION_FAILED', 'id, transformer_id and label are required');
  }
  await db.run('INSERT INTO transformers (id, label) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [dt, `Distribution transformer ${dt}`]);
  await db.run(`INSERT INTO meters (id, transformer_id, customer_type, label, registered_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET transformer_id = excluded.transformer_id, label = excluded.label, customer_type = excluded.customer_type`,
    [id, dt, String(type).slice(0, 20), label, Date.now()]);
  await db.run('INSERT INTO users (id, role, name, meter_id) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', [`u-${id}`, 'customer', label, id]);
  res.json({ data: await meterOr404(id) });
});

api.post('/readings', requireIngestKey, async (req, res) => {
  validateBatch(req.body);
  const out = await storeBatch(req.body, String(req.body.source ?? 'unknown').slice(0, 20));
  // Scored inside the request: a serverless function may be frozen once the response is sent.
  const scored = req.query.mode !== 'backfill' && out.maxTs ? await tryScore(out.maxTs) : false;
  res.status(202).json({ data: { stored: out.stored, unknown_ids: out.unknown, scored } });
});

// ------------------------------------------------------------------ meters & consumption
api.get('/meters', async (_req, res) => {
  const now = await latestReadingTs();
  const dayStart = now ? now - ((now + 8 * 3600e3) % DAY_MS) : 0;
  const rows = await db.all(`
    SELECT m.id, m.label, m.transformer_id, m.customer_type,
      r.ts AS last_ts, r.cumulative_kwh, r.signal_quality,
      f.anomaly_score, f.anomaly_type, f.z, f.deviation_pct,
      (SELECT COALESCE(SUM(interval_kwh), 0) FROM readings x WHERE x.meter_id = m.id AND x.ts >= ?) AS today_kwh,
      (SELECT COUNT(*) FROM alerts a WHERE a.meter_id = m.id AND a.status = 'open') AS open_alerts
    FROM meters m
    LEFT JOIN readings r ON r.meter_id = m.id AND r.ts = (SELECT MAX(ts) FROM readings WHERE meter_id = m.id)
    LEFT JOIN forecasts f ON f.id = (SELECT MAX(id) FROM forecasts WHERE meter_id = m.id)
    ORDER BY m.id`, [dayStart]);
  res.json({ data: rows });
});

api.get('/meters/:id/consumption', async (req, res) => {
  const m = await meterOr404(req.params.id);
  const now = await simNow();
  const cyc = cycleView(now);
  const dailyRows = await dailyKwh(m.id, cyc.start, now);
  const daily = dailyRows.map((d) => ({
    date: localDate(d.d * DAY_MS), kwh: Math.round(d.kwh * 100) / 100, complete: d.n >= 96,
  }));
  const latest = await db.get('SELECT * FROM readings WHERE meter_id = ? ORDER BY ts DESC LIMIT 1', [m.id]);
  const used = await usedKwh(m.id, cyc.start, now);
  res.json({ data: { meter: m, cycle: cyc, as_of: now, used_kwh: Math.round(used * 100) / 100, daily, latest } });
});

api.get('/meters/:id/projection',
  rateLimit({ windowMs: 10_000, max: 30, key: (r) => `proj:${r.ip}` }),
  async (req, res) => {
    const m = await meterOr404(req.params.id);
    const hours = Number(req.query.aircon_hours ?? 0);
    if (!Number.isFinite(hours) || hours < 0 || hours > 12) throw new HttpError(422, 'VALIDATION_FAILED', 'aircon_hours must be 0-12');
    const now = await simNow();
    const cyc = cycleView(now);
    const n = config.historyDays * 96;
    const start = now - (n - 1) * STEP_MS;
    const kwh = new Array(n).fill(null); const temp = new Array(n).fill(null);
    const readingRows = await db.all('SELECT ts, interval_kwh FROM readings WHERE meter_id = ? AND ts >= ? AND ts <= ?', [m.id, start, now]);
    for (const r of readingRows) kwh[(r.ts - start) / STEP_MS] = r.interval_kwh;
    const featureRows = await db.all('SELECT ts, temp_c FROM public_features WHERE ts >= ? AND ts <= ?', [start, now]);
    for (const f of featureRows) temp[(f.ts - start) / STEP_MS] = f.temp_c;
    const used = await usedKwh(m.id, cyc.start, now);
    const extra = Math.round(hours * config.airconKw * 100) / 100;
    const f = await forecastCycle({
      meter_id: m.id, kwh, temp_c: temp, last_slot_of_day: slotOfDay(now), used_kwh: used,
      remaining_slots: Math.max(0, Math.round((cyc.end - now) / STEP_MS) - 1), extra_kwh_per_day: extra,
    });
    const bill = billRange(f.total_kwh);
    const breakdown = computeBill(f.total_kwh.base);
    // Record exactly what the customer was shown (feeds the EGovChain snapshot).
    const rec = await db.get(`INSERT INTO bills (meter_id, kind, cycle_id, sim_ts, kwh_low, kwh_base, kwh_high, php_low, php_base, php_high, what_if, rate_version, created_at)
      VALUES (?, 'projection', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
      m.id, cyc.id, now, f.total_kwh.low, f.total_kwh.base, f.total_kwh.high, bill.low, bill.base, bill.high,
      JSON.stringify({ aircon_hours: hours }), breakdown.rateVersion, Date.now()]);
    res.json({ data: {
      meter_id: m.id, cycle: cyc, as_of: now, projection: f, bill, breakdown,
      what_if: { aircon_hours: hours, extra_kwh_per_day: extra, assumption: `${config.airconKw} kW average draw per aircon hour (illustrative)` },
      rate: rateInfo(), recorded_as: rec.id,
    } });
  });

api.post('/bill-estimates', (req, res) => {
  const kwh = Number(req.body?.kwh);
  if (!Number.isFinite(kwh) || kwh < 0 || kwh > 100000) throw new HttpError(422, 'VALIDATION_FAILED', 'kwh must be 0-100000');
  res.status(201).json({ data: { ...computeBill(kwh), rate: rateInfo() } });
});

// ------------------------------------------------------------------ transformers
api.get('/transformers', async (_req, res) => {
  const rows = await db.all('SELECT t.id, t.label, (SELECT COUNT(*) FROM meters m WHERE m.transformer_id = t.id) AS meters FROM transformers t ORDER BY t.id');
  const balances = await getBalances();
  res.json({ data: rows.map((t) => ({ ...t, balance: balances.get(t.id) ?? null })) });
});

// ------------------------------------------------------------------ alerts (EMessage)
api.get('/alerts', async (req, res) => {
  const { audience, meter_id: meterId, status } = req.query;
  const where = []; const args = [];
  if (audience === 'customer') {
    if (!meterId) throw new HttpError(422, 'VALIDATION_FAILED', 'meter_id is required for the customer inbox');
    where.push("audience IN ('customer', 'both')", 'meter_id = ?'); args.push(String(meterId));
  } else if (audience === 'ops') {
    if (req.get('x-demo-role') !== 'staff') throw new HttpError(403, 'FORBIDDEN', 'Staff access required');
    where.push("audience IN ('ops', 'both')");
  } else throw new HttpError(422, 'VALIDATION_FAILED', 'audience must be customer or ops');
  if (status) { where.push('status = ?'); args.push(String(status)); }
  if (req.query.since_id !== undefined) { where.push('id > ?'); args.push(sinceId(req)); }
  const cols = audience === 'customer'
    ? 'id, meter_id, type, title, customer_text, detected_at, created_at, emessage_source'
    : '*';
  const rows = await db.all(`SELECT ${cols} FROM alerts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, args);
  res.json({ data: rows.map((r) => (r.context ? parseAlert(r) : r)) });
});

api.patch('/alerts/:id', requireStaff, async (req, res) => {
  const status = req.body?.status;
  if (!['open', 'resolved', 'escalated'].includes(status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status must be open, resolved or escalated');
  const row = await db.get('UPDATE alerts SET status = ? WHERE id = ? RETURNING *', [status, Number(req.params.id)]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
  const alert = parseAlert(row);
  broadcast('alert', alert);
  res.json({ data: alert });
});

// ------------------------------------------------------------------ reports (EReport)
const CATEGORIES = ['suspected_jumper', 'meter_issue', 'safety_hazard', 'other'];

api.post('/reports',
  rateLimit({ windowMs: 60_000, max: 5, key: (r) => `rep:${r.ip}:${r.body?.meter_id}` }),
  async (req, res) => {
    const { meter_id: meterId, category, note } = req.body ?? {};
    if (!CATEGORIES.includes(category)) throw new HttpError(422, 'VALIDATION_FAILED', `category must be one of ${CATEGORIES.join(', ')}`);
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new HttpError(422, 'VALIDATION_FAILED', 'note must be at most 500 characters');
    const m = await meterOr404(meterId);
    const er = await submitEReport(category, note?.trim() || undefined, m.transformer_id);
    const row = await db.get(`INSERT INTO reports (meter_id, transformer_id, category, note, ereport_ticket, ereport_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, [m.id, m.transformer_id, category, note?.trim() || null, er.data.ticket ?? null, er.source, Date.now()]);
    if (['suspected_jumper', 'meter_issue'].includes(category)) await corroborate(m.transformer_id);
    broadcast('report', row);
    res.status(201).json({ data: row });
  });

api.get('/reports', requireStaff, async (req, res) => {
  const { status } = req.query;
  const where = []; const args = [];
  if (status) { where.push('status = ?'); args.push(String(status)); }
  if (req.query.since_id !== undefined) { where.push('id > ?'); args.push(sinceId(req)); }
  const rows = await db.all(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`, args);
  res.json({ data: rows });
});

api.patch('/reports/:id', requireStaff, async (req, res) => {
  const status = req.body?.status;
  if (!['new', 'triaged', 'dispatched', 'closed'].includes(status)) throw new HttpError(422, 'VALIDATION_FAILED', 'Invalid status');
  const row = await db.get('UPDATE reports SET status = ? WHERE id = ? RETURNING *', [status, Number(req.params.id)]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Report not found');
  broadcast('report', row);
  res.json({ data: row });
});

// ------------------------------------------------------------------ ledger (EGovChain)
api.get('/ledger-entries', async (req, res) => {
  const since = req.query.since_id !== undefined ? sinceId(req) : -1;
  const rows = (await db.all('SELECT * FROM ledger_entries WHERE id > ? ORDER BY id DESC', [since])).map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
  res.json({ data: rows });
});

api.post('/ledger-entries', requireStaff, async (_req, res) => {
  const now = await simNow();
  const cyc = cycleFor(now);
  const snap = await buildSnapshot(cyc.id, cyc.start, now);
  const hash = snapshotHash(snap);
  const chain = await writeChainRecord(hash, `${cyc.id}@${now}`);
  const summary = {
    meters: snap.meters.length,
    readings: snap.meters.reduce((s, m) => s + m.readings, 0),
    kwh: Number(snap.meters.reduce((s, m) => s + m.kwh, 0).toFixed(2)),
    projections_shown: snap.projections_shown.count,
    rate_version: snap.rate_version,
  };
  const row = await db.get(`INSERT INTO ledger_entries (cycle_id, period_start, as_of, hash, summary, chain_tx_id, chain_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, [cyc.id, cyc.start, now, hash, JSON.stringify(summary), chain.data.tx_id, chain.source, Date.now()]);
  const entry = { ...row, summary };
  broadcast('ledger', entry);
  res.status(201).json({ data: entry });
});

api.post('/ledger-entries/:id/verifications', async (req, res) => {
  const e = await db.get('SELECT * FROM ledger_entries WHERE id = ?', [Number(req.params.id)]);
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Ledger entry not found');
  const recomputed = snapshotHash(await buildSnapshot(e.cycle_id, e.period_start, e.as_of));
  const chain = await readChainRecord(e.chain_tx_id);
  const chainHash = chain.data?.hash ?? null;
  res.status(201).json({ data: {
    ledger_entry_id: e.id, match: chainHash !== null && recomputed === chainHash,
    recomputed_hash: recomputed, chain_hash: chainHash, chain_source: chain.source, checked_at: Date.now(),
  } });
});

// Demo only: silently edit one recorded reading so "Verify" turns red on stage.
api.post('/demo/reading-edits', requireStaff, async (req, res) => {
  if (!config.demoMode) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  const e = await db.get('SELECT * FROM ledger_entries WHERE id = ?', [Number(req.body?.ledger_entry_id)]);
  if (!e) throw new HttpError(404, 'NOT_FOUND', 'Ledger entry not found');
  const r = await db.get('SELECT meter_id, ts, interval_kwh FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts, meter_id LIMIT 1', [e.period_start, e.as_of]);
  if (!r) throw new HttpError(409, 'NO_DATA', 'No readings in that period');
  await db.run('UPDATE readings SET interval_kwh = ? WHERE meter_id = ? AND ts = ?', [Math.max(0, r.interval_kwh - 0.25), r.meter_id, r.ts]);
  res.status(201).json({ data: { meter_id: r.meter_id, ts: r.ts, before: r.interval_kwh, after: Math.max(0, r.interval_kwh - 0.25) } });
});

// ------------------------------------------------------------------ simulation (stateless, DB-backed; ADR-006)
api.get('/simulation', requireStaff, async (_req, res) => res.json({ data: await simulation.status() }));
api.patch('/simulation', requireStaff, async (req, res) => res.json({ data: await simulation.patch(req.body ?? {}) }));
api.post('/simulation/events', requireStaff, async (req, res) => res.status(201).json({ data: await simulation.addEvent(req.body ?? {}) }));
// Idempotent; repeat while `done` is false (each call stays under the function time limit).
api.post('/simulation/seed', requireStaff, async (_req, res) => res.json({ data: await simulation.seed() }));
api.post('/simulation/ticks', requireStaff, async (req, res) => res.json({ data: await simulation.advance(req.body?.steps ?? req.query.steps) }));
api.post('/simulation/reset', requireStaff, async (_req, res) => {
  if (!config.demoMode) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  res.json({ data: await simulation.reset() });
});

// ------------------------------------------------------------------ static web build + errors
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
}

api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));

app.use((err, req, res, _next) => {
  const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
  const code = err.code && typeof err.code === 'string' && status < 500 ? err.code : (status === 503 ? err.code : status === 400 ? 'BAD_REQUEST' : 'INTERNAL');
  if (status >= 500 && status !== 503) console.error(`[${req.id}]`, err);
  res.status(status).json({ error: {
    code: code ?? 'INTERNAL',
    message: status >= 500 && status !== 503 ? 'Something went wrong on our side' : err.message,
    details: err.details,
    request_id: req.id,
  } });
});

// Vercel (and other serverless hosts) import this module and call the
// exported `app` directly per-request instead of listening on a port.
export default app;

if (!process.env.VERCEL) {
  app.listen(config.port, (err) => {
    if (err) {
      console.error(`Could not listen on port ${config.port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`Meralco Go backend on http://localhost:${config.port}  (eGov APIs: ${config.useMockApis ? 'simulated' : 'live'})`);
  });
}

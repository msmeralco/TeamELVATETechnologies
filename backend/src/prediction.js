// Client for the Python prediction engine (synchronous internal HTTP API).
// Locally it is a uvicorn process; on Vercel it is the api/engine Python function.
import { config } from './config.js';
import { db } from './db.js';

const TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = 2500;
const FRESH_MS = 90_000; // a success this recent counts as "online" without probing

const headers = () => ({
  'Content-Type': 'application/json',
  ...(config.engineBypassSecret ? { 'x-vercel-protection-bypass': config.engineBypassSecret } : {}),
});

// Persisted (not module memory): another instance may have made the last call.
const recordOk = () => db.run(`INSERT INTO engine_status (id, last_ok) VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET last_ok = excluded.last_ok`, [Date.now()]).catch(() => {});
const recordError = (msg) => db.run(`INSERT INTO engine_status (id, last_error, last_error_at) VALUES (1, ?, ?)
  ON CONFLICT (id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`, [msg.slice(0, 300), Date.now()]).catch(() => {});

async function call(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${config.engineUrl}${path}`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`engine HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    await recordOk();
    return out;
  } catch (e) {
    await recordError(e.message);
    const err = new Error('Prediction engine unavailable');
    err.status = 503;
    err.code = 'ENGINE_UNAVAILABLE';
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export const scoreMeters = (meters) => call('/v1/scores', { meters }).then((r) => r.scores);
export const forecastCycle = (body) => call('/v1/forecasts', body);
export const balanceTransformer = (body) => call('/v1/balances', body);

/**
 * { online, lastOk, lastError }. Uses the persisted last success when it is fresh;
 * otherwise makes one cheap /health probe (short timeout).
 */
export async function engineStatus() {
  const row = (await db.get('SELECT last_ok, last_error, last_error_at FROM engine_status WHERE id = 1').catch(() => null)) ?? {};
  const fresh = row.last_ok && Date.now() - row.last_ok < FRESH_MS && !(row.last_error_at > row.last_ok);
  if (fresh) return { online: true, lastOk: row.last_ok, lastError: null };
  try {
    const r = await fetch(`${config.engineUrl}/health`, {
      headers: config.engineBypassSecret ? { 'x-vercel-protection-bypass': config.engineBypassSecret } : {},
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`engine HTTP ${r.status}`);
    await recordOk();
    return { online: true, lastOk: Date.now(), lastError: null };
  } catch (e) {
    await recordError(e.message);
    return { online: false, lastOk: row.last_ok ?? null, lastError: e.message };
  }
}

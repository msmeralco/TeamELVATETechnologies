import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const STEP_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Manila, no DST

/** On Vercel the Python engine is a function of the same deployment (api/engine). */
function defaultEngineUrl() {
  if (!env.VERCEL) return 'http://127.0.0.1:8000';
  // Production: the public alias (never behind Deployment Protection); previews: the deployment URL.
  const host = env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_URL;
  return `https://${host}/api/engine`;
}

export const config = {
  port: Number(env.PORT) || 4000,
  engineUrl: env.ENGINE_URL || defaultEngineUrl(),
  // Extra header for server-to-server calls to a deployment behind Vercel Deployment
  // Protection (Vercel injects this automatically when "Protection Bypass for Automation" is on).
  engineBypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET || '',
  // Simulation parameters; simulator/model.mjs derives everything from these (ADR-006).
  sim: {
    seed: Number(env.SIM_SEED) || 42,
    meters: Number(env.SIM_METERS) || 20,
    backfillDays: Number(env.SIM_BACKFILL_DAYS) || 12,
    start: Date.parse(env.SIM_START || '2026-10-01T00:00:00+08:00'),
    tickMs: Number(env.SIM_TICK_MS) || 1000,
  },
  // Serverless hosts cannot hold SSE connections open; the web apps poll instead.
  realtime: env.VERCEL ? 'poll' : 'sse',
  // Shared secret for the ingestion endpoint. The default is for local demo only.
  ingestKey: env.INGEST_KEY || 'dev-ingest-key',
  useMockApis: env.USE_MOCK_APIS !== 'false',
  demoMode: env.DEMO_MODE !== 'false',
  // Vercel's filesystem is read-only outside /tmp (and /tmp is wiped between
  // invocations, so this is only ever a scratch area, e.g. for the
  // mock-EGovChain fallback file — never for anything that must persist).
  dataDir: env.DATA_DIR || (env.VERCEL ? '/tmp/meralco-go-data' : path.join(root, 'data')),
  webDist: path.resolve(root, '..', 'web', 'dist'),
  cycleStart: Date.parse(env.CYCLE_START || '2026-10-01T00:00:00+08:00'),
  cycleDays: 30,
  historyDays: 14,
  anomalyThreshold: Number(env.ANOMALY_THRESHOLD) || 0.6,
  // What-if assumption: 1 HP inverter aircon draws ~0.9 kW on average (illustrative).
  airconKw: 0.9,
};

export function slotOfDay(ts) {
  return Math.floor(((ts + TZ_OFFSET_MS) % DAY_MS) / STEP_MS);
}

export function localDate(ts) {
  return new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export function cycleFor(ts) {
  const len = config.cycleDays * DAY_MS;
  const idx = Math.max(0, Math.floor((ts - config.cycleStart) / len));
  const start = config.cycleStart + idx * len;
  return { id: `C${String(idx + 1).padStart(2, '0')}-${localDate(start)}`, start, end: start + len, days: config.cycleDays };
}

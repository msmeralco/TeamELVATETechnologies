// Storage layer. Postgres (Vercel Postgres / Neon) via `pg`, chosen so the
// backend can run as a Vercel serverless function (no local disk to keep a
// SQLite file on). See docs/adr/0002-sqlite-for-demo.md for the history.
//
// Call sites were written against better-sqlite3/node:sqlite's synchronous
// `.prepare(sql).get/all/run(...)` API with `?` placeholders. To keep that
// migration mechanical (not a full rewrite of every query), `db.get/all/run`
// below accept the same `?`-style SQL and params but are async — every call
// site now does `await db.get(...)` etc. instead of `.prepare(...).get(...)`.
//
// IMPORTANT: epoch-millisecond timestamp columns (`ts`, `created_at`, etc.)
// are BIGINT here, not INTEGER — Postgres INTEGER is 32-bit and would
// overflow/corrupt a ~1.7e12 epoch-ms value. SQLite's INTEGER is 64-bit, so
// this schema cannot be copied over verbatim. `pg`'s default BIGINT (and
// COUNT(*)) type parser also returns a *string*, not a number, to avoid
// precision loss above 2^53; since every value we store here is safely
// within Number.MAX_SAFE_INTEGER, we override that parser below so the
// existing ts-arithmetic throughout pipeline.js/server.js keeps working
// unchanged.
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20 /* BIGINT */, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('POSTGRES_URL (or DATABASE_URL) must be set — see .env.example. Provision one with Vercel Postgres (Neon).');
}

export const pool = new Pool({
  connectionString,
  // Vercel Postgres / Neon require TLS; a plain localhost dev DB does not.
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
});

/** `?`-style placeholders (sqlite/better-sqlite3 convention) -> Postgres `$1, $2, ...`. */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeDb(queryable) {
  return {
    async get(sql, params = []) { return (await queryable.query(toPg(sql), params)).rows[0]; },
    async all(sql, params = []) { return (await queryable.query(toPg(sql), params)).rows; },
    async run(sql, params = []) { const r = await queryable.query(toPg(sql), params); return { rowCount: r.rowCount, row: r.rows[0] }; },
    raw: queryable, // escape hatch for hand-written multi-row SQL (see bulkUpsert)
  };
}

export const db = makeDb(pool);

/** Runs fn(txDb) inside a single transaction on one connection; txDb has the same get/all/run shape as db. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(makeDb(client));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Multi-row INSERT ... ON CONFLICT (conflictCols) DO UPDATE SET col = excluded.col
 * for every column not in conflictCols. `rows` is an array of value-arrays in
 * `cols` order. Used for batch ingestion so a reading batch is one round trip
 * instead of one per row.
 */
export async function bulkUpsert(queryable, table, cols, rows, conflictCols) {
  if (rows.length === 0) return;
  const updateCols = cols.filter((c) => !conflictCols.includes(c));
  const valuesSql = rows.map((row, ri) => `(${row.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ')})`).join(', ');
  const conflictAction = updateCols.length
    ? `DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
    : 'DO NOTHING';
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valuesSql}
    ON CONFLICT (${conflictCols.join(', ')}) ${conflictAction}`;
  await queryable.query(sql, rows.flat());
}

export async function initSchema() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS transformers (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meters (
  id             TEXT PRIMARY KEY,
  transformer_id TEXT NOT NULL REFERENCES transformers(id),
  customer_type  TEXT NOT NULL DEFAULT 'residential',
  label          TEXT NOT NULL,
  registered_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  role      TEXT NOT NULL CHECK (role IN ('customer', 'staff')),
  name      TEXT NOT NULL,
  meter_id  TEXT REFERENCES meters(id)
);

CREATE TABLE IF NOT EXISTS readings (
  meter_id          TEXT NOT NULL REFERENCES meters(id),
  ts                BIGINT NOT NULL,            -- interval start, epoch ms
  interval_kwh      DOUBLE PRECISION NOT NULL,
  cumulative_kwh    DOUBLE PRECISION NOT NULL,
  signal_quality    INTEGER NOT NULL,
  anomaly_signature INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL,
  PRIMARY KEY (meter_id, ts)
);
CREATE INDEX IF NOT EXISTS readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS transformer_readings (
  transformer_id TEXT NOT NULL REFERENCES transformers(id),
  ts             BIGINT NOT NULL,
  interval_kwh   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (transformer_id, ts)
);

CREATE TABLE IF NOT EXISTS public_features (
  ts      BIGINT PRIMARY KEY,
  temp_c  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS forecasts (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meter_id       TEXT NOT NULL REFERENCES meters(id),
  ts             BIGINT NOT NULL,
  expected_kwh   DOUBLE PRECISION,
  residual_kwh   DOUBLE PRECISION,
  z              DOUBLE PRECISION,
  deviation_pct  DOUBLE PRECISION,
  anomaly_score  DOUBLE PRECISION NOT NULL,
  anomaly_type   TEXT,
  model_version  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS forecasts_meter_ts ON forecasts(meter_id, ts);

CREATE TABLE IF NOT EXISTS bills (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meter_id      TEXT NOT NULL REFERENCES meters(id),
  kind          TEXT NOT NULL CHECK (kind IN ('projection')),
  cycle_id      TEXT NOT NULL,
  sim_ts        BIGINT NOT NULL,
  kwh_low       DOUBLE PRECISION NOT NULL,
  kwh_base      DOUBLE PRECISION NOT NULL,
  kwh_high      DOUBLE PRECISION NOT NULL,
  php_low       DOUBLE PRECISION NOT NULL,
  php_base      DOUBLE PRECISION NOT NULL,
  php_high      DOUBLE PRECISION NOT NULL,
  what_if       TEXT NOT NULL,
  rate_version  TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bills_meter_cycle ON bills(meter_id, cycle_id);

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meter_id        TEXT REFERENCES meters(id),
  transformer_id  TEXT REFERENCES transformers(id),
  type            TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('customer', 'ops', 'both')),
  score           DOUBLE PRECISION NOT NULL,
  title           TEXT NOT NULL,
  customer_text   TEXT,
  ops_text        TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'escalated')),
  detected_at     BIGINT NOT NULL,             -- simulated time
  created_at      BIGINT NOT NULL,
  emessage_id     TEXT,
  emessage_source TEXT
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, audience);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meter_id        TEXT NOT NULL REFERENCES meters(id),
  transformer_id  TEXT NOT NULL REFERENCES transformers(id),
  category        TEXT NOT NULL CHECK (category IN ('suspected_jumper', 'meter_issue', 'safety_hazard', 'other')),
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'dispatched', 'closed')),
  ereport_ticket  TEXT,
  ereport_source  TEXT,
  created_at      BIGINT NOT NULL
);

-- Stateless-simulator state (ADR-006): one row, plus the injected events.
CREATE TABLE IF NOT EXISTS simulation_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  sim_ts           BIGINT,                     -- last generated tick (interval start), null before seeding
  tick_ms          INTEGER NOT NULL DEFAULT 1000,
  paused           BOOLEAN NOT NULL DEFAULT FALSE,
  last_advance_at  BIGINT NOT NULL DEFAULT 0   -- wall clock of the last advance, paces drivers server-side
);

CREATE TABLE IF NOT EXISTS simulation_events (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('spike', 'flatline', 'tamper', 'tap')),
  meter_id    TEXT,
  started_at  BIGINT NOT NULL,                 -- simulated time of the first affected tick
  ends_at     BIGINT                           -- null = active until cleared
);

-- Latest energy-balance result per transformer (was an in-memory Map).
CREATE TABLE IF NOT EXISTS transformer_balances (
  transformer_id  TEXT PRIMARY KEY REFERENCES transformers(id) ON DELETE CASCADE,
  ts              BIGINT NOT NULL,
  result          TEXT NOT NULL
);

-- Last engine success / failure, so /system does not depend on instance memory.
CREATE TABLE IF NOT EXISTS engine_status (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok        BIGINT,
  last_error     TEXT,
  last_error_at  BIGINT
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_id      TEXT NOT NULL,
  period_start  BIGINT NOT NULL,
  as_of         BIGINT NOT NULL,
  hash          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  chain_tx_id   TEXT NOT NULL,
  chain_source  TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);
`);
}

export const latestReadingTs = async () => (await db.get('SELECT MAX(ts) AS ts FROM readings')).ts ?? null;

# Architecture decisions

Short ADRs for the choices that differ from, or add to, `Meralco Go — System Architecture.md`.

## ADR-001 · Three processes, one reading format (deployment superseded by ADR-006)

**Context.** The architecture asks for a simulator, a Node backend, and a separate prediction engine "so the model can be retrained or swapped without touching the backend".

**Decision.** Three processes: `simulator/` (Node), `backend/` (Node + Express), and `prediction-engine/` (Python + FastAPI). The backend calls the engine synchronously over HTTP. The reading payload (`POST /api/v1/readings`) is the only contract between the simulator and everything downstream.

**Trade-off.** Running three processes costs more than one monolith. In exchange, the engine can be swapped for a trained model, and the simulator for a LoRaWAN gateway, without changing anything else. `npm start` launches all three.

## ADR-002 · SQLite (node:sqlite) for the demo, migrated to Postgres for Vercel (2026-11-12)

**Context.** The target is PostgreSQL. The demo machine originally had neither Postgres nor Docker, and the demo had to run offline — so it started on Node's built-in SQLite (`node:sqlite`), with the schema kept to portable SQL types and constraints for an eventual move.

**Decision.** `backend/src/db.js` now uses Postgres (`pg`, pointed at Vercel Postgres/Neon via `POSTGRES_URL`) so the backend can run as a Vercel serverless function — a serverless function has no persistent local disk for a SQLite file to live on. `INTEGER PRIMARY KEY AUTOINCREMENT` became `INTEGER GENERATED ALWAYS AS IDENTITY`; every epoch-millisecond timestamp column (`ts`, `created_at`, `detected_at`, etc.) became `BIGINT` instead of `INTEGER`, since Postgres's `INTEGER` is 32-bit and would overflow a ~1.7e12 ms timestamp (SQLite's `INTEGER` is 64-bit, so this didn't surface there). Call sites moved from synchronous `.prepare(sql).get/all/run()` to an async `db.get/all/run(sql, params)` wrapper that keeps the same `?`-placeholder SQL strings, to keep the migration mechanical. Batch reading ingestion (`storeBatch`) uses one multi-row `INSERT ... ON CONFLICT` per table instead of one round trip per row.

**Trade-off.** A real network DB round trip per query instead of an in-process file, and every exported DB-touching function is now `async`. In exchange, the backend deploys as a stateless Vercel function with no server to keep running. `pool.query` uses the pooled `POSTGRES_URL` connection (not `POSTGRES_URL_NON_POOLING`) specifically because serverless cold starts can otherwise exhaust Postgres's connection limit.

## ADR-003 · Customer-safe alert routing

**Context.** A single meter can't see a tap made before it. A "suspected jumper" message sent to a customer would be an accusation made by an algorithm.

**Decision.**
- **Customer + ops (EMessage sent):** usage spike and flatline. These describe only the customer's own meter, in plain language.
- **Ops only (no message):** usage drop, tamper signature, and the transformer energy-balance gap.
- The transformer gap is the main pilferage signal. When an open flatline, tamper or drop alert exists on the same transformer, the gap is attributed to that meter first. Customer EReports of a suspected jumper or meter issue raise its confidence.
- One open alert per subject and type, with a 6-hour cooldown, so EMessage credits aren't spent on repeat sends.

## ADR-004 · EGovChain stores one hash per cycle snapshot

**Context.** "Every prediction shown to a customer" would use up limited credits. A chain also proves only that a record hasn't changed since it was written, not that it was correct when written.

**Decision.** Every projection shown to a customer is stored in `bills`. "Seal cycle snapshot" rebuilds a canonical snapshot (per-meter reading digests and kWh, plus a digest of the shown projections) and writes only its SHA-256 hash to EGovChain. Verify rebuilds the snapshot from the database and compares the hashes. The UI wording is "tamper-evident after recording".

## ADR-005 · Every eGov call has a mock fallback

`USE_MOCK_APIS=true` is the default. Live calls have a 4-second timeout and fall back to the mock on any error. The source (`live`, `mock` or `mock-fallback`) is stored on every alert, report and ledger row and shown in both UIs. The live request shapes in `backend/src/integrations/egov.js` are placeholders until the hackathon API documentation is available.

## ADR-006 · Stateless simulator, engine function and polling for Vercel (2026-11-12)

**Context.** ADR-001's three long-running local processes do not exist on Vercel. Only the Express API was ported, so production had no meters, no readings, no simulator for the demo bar and no engine. Several pieces of per-process memory (scoring queue, transformer balances, engine status, SSE client set) were also wrong across function instances.

**Decision.**
- **Stateless simulator.** `simulator/model.mjs` generates any tick as a pure function of `(seed, meter_id, ts, active events)`: noise comes from a PRNG seeded with `hash(seed, key, ts)` instead of one sequential stream, and meter parameters are derived from the seed. The backend imports it (`backend/src/simulation.js`); the local `simulator.mjs` is only a clock driver calling the same API. The clock lives in Postgres (`simulation_state`: `sim_ts`, `tick_ms`, `paused`; `simulation_events`: type, meter, `started_at`, `ends_at`). `POST /simulation/seed` (idempotent, one day per transaction, resumable) and `POST /simulation/ticks` replace the :4100 control server. The reading contract is unchanged: ticks go through `storeBatch`.
- **Clock driver.** Vercel Hobby cron runs only daily, so the open admin console calls `POST /simulation/ticks` every `tick_ms`. The server paces advances (at most one per `tick_ms` of wall time) and claims each step with a conditional `UPDATE ... WHERE sim_ts = ?`, so a second driver (the local `simulator.mjs`, a second tab) cannot double the speed. The customer app never drives ticks.
- **Engine on Vercel.** The unchanged FastAPI app is served by a Vercel Python function (`api/engine/index.py`) in the same project; `fastapi` is the only dependency (the model is pure Python). `config.engineUrl` defaults to the same deployment on Vercel. We kept Python instead of porting `model.py` to JS so the model stays swappable (ADR-001). Fallback if the Python function proves impractical: port `model.py` behind the same three functions and keep the `test_model.py` cases as JS tests.
- **No work after the response.** Scoring is awaited inside `POST /readings` and `/simulation/ticks`. Derived state is persisted (`transformer_balances`, `engine_status`), so any instance answers `/transformers` and `/system` correctly.
- **Realtime.** SSE stays for local runs. On Vercel `/events` answers 204, the `EventSource` closes, and the web apps poll every ~3 s (`?since_id=` on alerts, reports and ledger entries, plus `/system` for the clock).

**Trade-offs.** The clock runs only while an admin tab is open; polling adds about 3 s of latency and extra requests; the engine adds a same-deployment HTTP hop and a Python cold start; a preview behind Deployment Protection needs the automation-bypass secret. In exchange the demo needs no machine of ours running. Cumulative meter registers are now a closed-form approximation rather than a running sum.

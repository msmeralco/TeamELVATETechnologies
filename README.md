# Meralco Go

**Live demo (Vercel):** <https://meralco-go.vercel.app>
- Customer app: <https://meralco-go.vercel.app/customer/> (`?meter=m03`)
- Admin console: <https://meralco-go.vercel.app/admin/> (keep this tab open: it drives the simulated clock)

This is the working demo of the architecture in `../Meralco Go — System Architecture.md`. Simulated smart-meter readings feed a forecasting and anomaly engine. The engine's output becomes a peso bill range. Results reach a customer app and a grid ops console through the backend API, with EMessage, EReport and EGovChain in the loop.

> **Simulated, not live.** All data is synthetic, the eGov APIs run in simulated mode by default, and the **rates in `backend/src/billing/rates.json` are illustrative placeholders** (see "Before you pitch").

## Layers → code

| Architecture layer | Folder | What it does |
| --- | --- | --- |
| Simulation layer | `simulator/` | `model.mjs` is a stateless generator: 20 household meters on one distribution transformer (DT-001) plus a temperature feed, every reading a pure function of `(seed, meter, timestamp, injected events)`. The backend runs it (`backend/src/simulation.js`, clock and events in Postgres); `simulator.mjs` is only a local clock driver. |
| Backend / core | `backend/` | Express API on port 4000 (a Vercel function in production): ingestion and validation, prediction orchestration, bill calculation, alert routing, the EMessage/EReport/EGovChain wrappers, SSE push (polling on Vercel), and the Postgres store. |
| Forecasting (prediction engine) | `prediction-engine/` | FastAPI serving a baseline model (port 8000 locally; the Vercel Python function `api/engine/` in production). Seasonal-naive slot profile, temperature regression, residual z-score anomaly score, flatline rule, and transformer energy balance. |
| Bill calculation | `backend/src/billing/` | JSON rate config plus a deterministic engine: kWh in, peso breakdown out, low/base/high range. |
| Client: customer app | `web/customer/` | Mobile-first. Projected end-of-cycle bill range, what-if aircon slider, daily chart, breakdown, alert inbox, and a "Report a concern" form. |
| Client: admin website | `web/admin/` | Meter field, transformer energy balance, anomaly review queue (resolve/escalate), EReport triage, EGovChain audit (seal/verify), and demo controls. |

The design decisions are in [docs/decisions.md](docs/decisions.md).

## Run it

Requirements: Node 22.13+ (tested on 24), Python 3.10+ (tested on 3.12), and a Postgres database (Neon / Vercel Postgres; there is no local-file fallback). Copy `.env.example` to `.env` and set `POSTGRES_URL`.

```sh
npm run setup     # Python venv + pip, npm installs, web build (one time)
npm start         # engine + backend + simulator clock driver; open the URLs it prints
```

- Customer app: <http://localhost:4000/customer/> (switch households with the picker; `?meter=m03`)
- Admin console: <http://localhost:4000/admin/>
- `npm run dev` runs the same stack with Vite hot reload on <http://localhost:5173/>
- Open the admin console once: on first load it seeds DT-001, 20 meters and 12 days of history (about 5 s). **Reset demo data** in the demo bar wipes the database and re-seeds.
- `npm run reset` only removes the local mock-chain file; use the admin **Reset demo data** button (or `POST /api/v1/simulation/reset`) for the database
- `npm test`: backend unit tests (bill engine, hashing), simulator model tests (deterministic ticks, event effects) and prediction-model unit tests

## Demo script (about 5 minutes)

1. **Customer app, m03.** "Day 13 of 30, you're on track for ₱X, likely between ₱A and ₱B." Drag the aircon slider and the range and the orange projected columns update. This uses the forecast, not just a kWh calculator.
2. **Admin console, demo bar.** Choose m03 and click **Usage spike**. Within about 1–2 minutes (simulated hours at 1 tick/s) a *Usage spike* alert appears. m03's app gets a toast and an Alerts message (EMessage).
3. Choose m11 and click **Flatline**. The meter reads 0 while the house still draws power. Ops sees a *Meter flatline* alert, the customer is told it may be a meter fault, and the DT-001 gap rises and is attributed to m11.
4. Click **Clear events**, wait for the gap to settle, then click **Tap before meters**. The DT-001 gap jumps from about 4% to about 10%. No customer is messaged; the alert says "No single meter explains it so far".
5. In the customer app (any DT-001 household), use **Report → Possible illegal connection nearby**. It arrives in ops triage, and the transformer alert shows "1 customer report on this transformer" with higher confidence.
6. **EGovChain audit → Seal cycle snapshot → Verify** shows ✓ Unchanged since recording. Then **Edit a reading (demo) → Verify** shows ✕ Does not match the chain record.

Speed up with **Speed → 15 min / 0.3 s**. Use **Pause** to freeze the clock while you talk.

On Vercel there is no simulator process: the admin console drives the clock, so **keep the admin tab open** while you present (the customer app only advances while an admin console is open).

## Deploy to Vercel

The whole demo runs in one Vercel project, with no local processes: the static Vite build, the Express API (`api/index.js`) and the prediction engine (Python function `api/engine/index.py`, which serves `prediction-engine/app.py` unchanged). `vercel.json` rewrites `/api/engine/*` to the engine and everything else under `/api/*` to Express (order matters).

1. Create a Postgres database (Neon via the Vercel Marketplace) and link it to the project.
2. Set the environment variables below (Project → Settings → Environment Variables).
3. Deploy (`vercel` for a preview, `vercel --prod`), open `/admin/`. The first load seeds the demo data.

Production is `https://meralco-go.vercel.app`, deployed from `main`. If a merge to `main` does not trigger a deployment, run `vercel deploy --prod` from an up-to-date `main` checkout. Preview deployments need the same environment variables set for the **Preview** environment, not only Production.

| Variable | Needed | Notes |
| --- | --- | --- |
| `POSTGRES_URL` | yes | Pooled connection string (set by the Neon integration). `DATABASE_URL` also works. |
| `INGEST_KEY` | yes | Shared secret for `PUT /meters/:id` and `POST /readings`. Falls back to the public `dev-ingest-key` if unset: set your own. |
| `ENGINE_URL` | no | Only if the engine is hosted elsewhere. Unset = same deployment, `https://$VERCEL_URL/api/engine` (production uses `VERCEL_PROJECT_PRODUCTION_URL`). |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | previews only | Vercel sets this automatically once **Protection Bypass for Automation** is enabled (Settings → Deployment Protection). Lets the API call the engine on a protected preview URL. |
| `DEMO_MODE` | optional | Default `true`; enables **Reset demo data** and the "edit a reading" demo. Set `false` for anything public. |
| `SIM_SEED`, `SIM_METERS`, `SIM_BACKFILL_DAYS`, `SIM_START`, `SIM_TICK_MS` | optional | Simulation parameters (defaults: 42, 20, 12, 2026-10-01 +08:00, 1000). |
| `ANOMALY_THRESHOLD`, `CYCLE_START` | optional | As in `.env.example`. |
| eGov variables | optional | `USE_MOCK_APIS` etc. unchanged; mocks by default. |

Checks after a deploy (replace `$URL`; staff routes use the mocked staff header):

```sh
curl -s -X POST $URL/api/v1/simulation/seed -H 'x-demo-role: staff'          # {"data":{"done":true,...}}; repeat while done=false
curl -s $URL/api/v1/meters | jq '.data | length'                              # 20
curl -s $URL/api/v1/meters/m03/projection | jq '.data.bill'                   # 200 with a low/base/high range
curl -s -X POST $URL/api/v1/simulation/events -H 'x-demo-role: staff' -H 'content-type: application/json' -d '{"type":"spike","meter_id":"m03"}'
# the clock only moves via POST /simulation/ticks (an open admin tab does this); after about 40 s of ticks:
curl -s "$URL/api/v1/alerts?audience=ops" -H 'x-demo-role: staff' | jq '.data[].title'   # "Usage higher than expected"
curl -s $URL/api/v1/transformers | jq '.data[0].balance.gap_ratio'            # DT-001 balance
curl -s $URL/api/v1/system | jq '.data.engine'                                 # online: true
```

## Reading format (the hardware swap contract)

`POST /api/v1/readings` with header `X-Ingest-Key`. Add `?mode=backfill` to store without scoring.

```json
{
  "source": "simulator",
  "meter_readings": [{ "meter_id": "m03", "timestamp": "2026-10-13T02:00:00.000Z", "interval_kwh": 0.21,
                       "cumulative_kwh": 12045.3, "signal_quality": 88, "anomaly_signature": false }],
  "transformer_readings": [{ "transformer_id": "DT-001", "timestamp": "2026-10-13T02:00:00.000Z", "interval_kwh": 4.37 }],
  "public_features": [{ "timestamp": "2026-10-13T02:00:00.000Z", "temp_c": 31.4 }]
}
```

Meters register with `PUT /api/v1/meters/:id` (`transformer_id`, `label`). A LoRaWAN network server webhook only needs to map its uplinks to this shape. Nothing downstream changes.

## API (all under `/api/v1`; errors are `{ error: { code, message, details?, request_id } }`)

| Method & path | Who | Purpose |
| --- | --- | --- |
| `POST /readings`, `PUT /meters/:id` | ingest key | Meter/IoT ingestion |
| `GET /system` | any | Simulated clock, cycle, engine status, integration mode, rate source |
| `GET /meters` | any | Meter list with latest score |
| `GET /meters/:id/consumption` | customer | Cycle usage by day |
| `GET /meters/:id/projection?aircon_hours=` | customer | Forecast, bill range and breakdown (recorded as "shown") |
| `POST /bill-estimates` | any | Breakdown for an arbitrary kWh |
| `GET /transformers` | any | Energy balance per transformer |
| `GET /alerts?audience=customer&meter_id=` / `?audience=ops` | customer / staff | EMessage inbox / review queue |
| `PATCH /alerts/:id` | staff | open / resolved / escalated |
| `POST /reports`, `GET /reports`, `PATCH /reports/:id` | customer / staff | EReport (rate-limited to 5 per minute) |
| `GET /ledger-entries`, `POST /ledger-entries`, `POST /ledger-entries/:id/verifications` | any / staff / any | EGovChain seal and verify |
| `GET /events` | any | SSE stream: `alert`, `report`, `ledger`, `tick` |
| `GET /simulation`, `PATCH /simulation`, `POST /simulation/events` | staff | Demo controls (proxied to the simulator) |
| `POST /demo/reading-edits` | staff, `DEMO_MODE` | Tamper a reading to demo verification |

"Staff" is a mocked `X-Demo-Role: staff` header, because staff login is out of scope for the demo. Replace it with real authentication before any pilot.

## Model and thresholds (stated, not hidden)

- **Expected usage:** same 15-minute slot averaged over the previous 7 days. **Forecast:** that profile for the remaining slots, plus a temperature-sensitivity regression (daily kWh vs. mean °C) and the what-if load (0.9 kW per aircon hour, an illustrative assumption). The range is an 80% interval from day-to-day variance, plus a 3% model-error floor.
- **Anomaly score:** the trailing-24h residual compared with its own history (z). Score = 1 − e^−(|z|−1)/2, so z = 3 gives about 0.63. Alerts fire at **score ≥ 0.6**.
- **Flatline:** 2 hours of zero readings while the meter's recent non-zero history expects at least 0.3 kWh.
- **Transformer balance:** 4-hour gap ratio vs. the median of its own history. A flag needs **robust z ≥ 4** and a gap at least 1.5 percentage points above baseline.
- Baselines adapt. A load that persists for about a week (for example a new aircon) becomes the new normal. Flatlines do not, because they compare against non-zero history.

This is the "lightweight baseline" from the architecture doc, not a trained model. Its interface (`/v1/scores`, `/v1/forecasts`, `/v1/balances`) is what a trained XGBoost or time-series model would replace.

## Before you pitch

- [ ] **Rates:** replace every number in `backend/src/billing/rates.json` with a published Meralco residential schedule for one named month, set `source` and `"verified": true`, then check against one real bill. The UI shows "Rates illustrative" until you do.
- [ ] **eMessage live:** set `EMESSAGE_BASE_URL`, `EMESSAGE_TOKEN`, `EMESSAGE_TEST_TO`, run `npm run smoke:emessage`, then start with `EMESSAGE_LIVE=true`.
- [ ] **Other live APIs:** set `USE_MOCK_APIS=false` (or `EREPORT_LIVE` / `EGOVCHAIN_LIVE`), `EREPORT_URL`, `EGOVCHAIN_URL` and `EGOV_TOKEN`, and adapt the request shapes in `backend/src/integrations/egov.js` to the hackathon docs. Test one live call of each API; the demo itself survives on mocks.
- [ ] Set a real `INGEST_KEY`. Set `DEMO_MODE=false` if anyone else will use the deployment.
- [ ] Say "simulated IoT data" out loud. The badges in both UIs say it too.

## Known limitations

- Synthetic data only. One transformer with 20 meters. Standard residential rates only (no lifeline, net-metering or special schedules).
- The EReport photo attachment from the architecture doc is not implemented (note only).
- Mocked authentication; no multi-tenant isolation; in-memory (per-instance) rate limits. The staff routes, including `simulation/reset`, are guarded only by the mocked staff header: set `DEMO_MODE=false` on a public deployment.
- On Vercel the simulated clock advances only while an admin console is open (Hobby cron runs at most daily). Live updates are polled every ~3 s instead of pushed over SSE.
- `/api/engine/*` is a public, unauthenticated, stateless calculation endpoint (it stores nothing).
- The simulator's cumulative meter register is a closed-form approximation (so any tick can be generated without history); it is not the running sum of the interval readings.

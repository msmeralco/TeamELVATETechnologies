// Meralco Go local simulator driver.
//
// The simulation itself is stateless library code (model.mjs) running inside the
// backend, with its clock in Postgres (ADR-006). This process is only a headless
// clock driver for local `npm start`: it seeds history if needed, then asks the
// backend to advance one 15-minute interval every tick_ms. The admin console does
// the same while it is open; the backend paces both so they never double the speed.
//
// Controls (speed, pause, injected events) are the backend's /api/v1/simulation API,
// so the admin demo bar and `npm run inject` work the same here as on Vercel.
const env = process.env;
const BACKEND = env.BACKEND_URL || 'http://127.0.0.1:4000';
const HEADERS = { 'Content-Type': 'application/json', 'X-Demo-Role': 'staff' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const r = await fetch(`${BACKEND}/api/v1${path}`, { method, headers: HEADERS, body: body && JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

async function waitForBackend() {
  for (let i = 0; ; i++) {
    try { return await call('GET', '/simulation'); } catch (e) {
      if (i % 5 === 0) console.log('[sim] waiting for backend at', BACKEND, `(${e.message})`);
      await sleep(1000);
    }
  }
}

let state = await waitForBackend();
if (!state.seeded) {
  console.log('[sim] seeding history...');
  for (let r = await call('POST', '/simulation/seed'); ; r = await call('POST', '/simulation/seed')) {
    console.log(`[sim] backfilled through ${new Date(r.sim_ts).toISOString()}`);
    if (r.done) break;
  }
  console.log('[sim] backfill done');
} else {
  console.log(`[sim] resuming after ${new Date(state.sim_ts).toISOString()}`);
}

for (;;) {
  const started = Date.now();
  try {
    state = await call('GET', '/simulation');
    if (!state.paused) await call('POST', '/simulation/ticks', { steps: 4 });
  } catch (e) { console.warn('[sim] tick failed:', e.message); }
  await sleep(Math.max(50, (state.tick_ms ?? 1000) - (Date.now() - started)));
}

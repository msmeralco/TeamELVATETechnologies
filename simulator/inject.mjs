// Usage: node inject.mjs <spike|flatline|tamper> <meter_id>
//        node inject.mjs <tap|clear>
const [type, meterId] = process.argv.slice(2);
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:4000';
const r = await fetch(`${backend}/api/v1/simulation/events`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Role': 'staff' }, body: JSON.stringify({ type, meter_id: meterId }),
});
console.log(r.status, JSON.stringify(await r.json(), null, 2));

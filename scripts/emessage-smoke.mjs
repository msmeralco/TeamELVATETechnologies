// One live eMessage SMS through the same code path the backend uses.
// Uses one credit. Usage: npm run smoke:emessage [-- "custom text"]
import fs from 'node:fs';

// Same .env as npm start (shell values win).
const envFile = new URL('../.env', import.meta.url);
if (fs.existsSync(envFile)) { const before = { ...process.env }; process.loadEnvFile(envFile); Object.assign(process.env, before); }
const { pushSms, E164 } = await import('../backend/src/integrations/egov.js');

const { EMESSAGE_BASE_URL, EMESSAGE_TOKEN, EMESSAGE_TEST_TO } = process.env;
const missing = ['EMESSAGE_BASE_URL', 'EMESSAGE_TOKEN', 'EMESSAGE_TEST_TO'].filter((k) => !process.env[k]);
if (missing.length) { console.error(`Set ${missing.join(', ')} first.`); process.exit(1); }
if (!E164.test(EMESSAGE_TEST_TO)) { console.error(`EMESSAGE_TEST_TO must be E.164, e.g. +639090000000 (got ${EMESSAGE_TEST_TO}).`); process.exit(1); }

const text = process.argv[2] ?? `Meralco Go test SMS ${new Date().toISOString().slice(11, 19)}`;
const masked = EMESSAGE_TEST_TO.slice(0, 6) + '****' + EMESSAGE_TEST_TO.slice(-2);
console.log(`POST ${EMESSAGE_BASE_URL.replace(/\/+$/, '')}/messaging/v1/sms/push -> ${masked}`);

// Log the raw response once so the ID field mapping can be confirmed.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const r = await realFetch(...args);
  console.log('HTTP', r.status, '\n' + (await r.clone().text()));
  return r;
};

try {
  const res = await pushSms(EMESSAGE_TEST_TO, text);
  console.log('Mapped by the app as:', res);
  console.log('OK. Check the phone for the SMS.');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

// One live eReport complaint submission through the same code path the
// backend uses: token exchange, then submit_complaint. Uses demo placeholder
// complainant/location values from .env, not real personal data. Spends
// gateway usage credits. Usage: npm run smoke:ereport
import fs from 'node:fs';

// Same .env as npm start (shell values win).
const envFile = new URL('../.env', import.meta.url);
if (fs.existsSync(envFile)) { const before = { ...process.env }; process.loadEnvFile(envFile); Object.assign(process.env, before); }
const { submitEReportLive } = await import('../backend/src/integrations/egov.js');

const required = ['EREPORT_URL', 'EREPORT_ACCESSCODE', 'EREPORT_DEMO_MOBILE', 'EREPORT_DEMO_FIRST_NAME', 'EREPORT_DEMO_LAST_NAME', 'EREPORT_DEMO_GENDER', 'EREPORT_DEMO_EMAIL', 'EREPORT_DEMO_REGION_CODE', 'EREPORT_DEMO_PROVINCE_CODE', 'EREPORT_DEMO_MUNICIPALITY_CODE', 'EREPORT_DEMO_BARANGAY_CODE'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) { console.error(`Set ${missing.join(', ')} first.`); process.exit(1); }

const category = process.argv[2] ?? 'meter_issue';
const note = process.argv[3] ?? `Meralco Go smoke test ${new Date().toISOString()}`;
console.log(`Submitting eReport complaint: category=${category} note="${note}"`);

try {
  const res = await submitEReportLive(category, note, 'DT-001');
  console.log('Mapped by the app as:', res);
  console.log('OK. Check the eGov developer portal usage/credits view, or the Reports List API, to confirm.');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

// One live round-trip against the deployed HashAnchor contract on eGovChain:
// anchor a test hash, read it back through the same code path the backend
// uses, and confirm it matches. Spends gateway usage credits + needs a block
// to actually include the transaction (see blockchain/scripts/anchor-smoke.js
// for a lower-level version of the same check).
// Usage: npm run smoke:egovchain
import fs from 'node:fs';
import crypto from 'node:crypto';

const envFile = new URL('../.env', import.meta.url);
if (fs.existsSync(envFile)) { const before = { ...process.env }; process.loadEnvFile(envFile); Object.assign(process.env, before); }
const { writeChainRecord, readChainRecord } = await import('../backend/src/integrations/egov.js');

const required = ['EGOVCHAIN_URL', 'EGOVCHAIN_TOKEN', 'EGOVCHAIN_DEPLOYER_KEY', 'EGOVCHAIN_CONTRACT_ADDRESS'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) { console.error(`Set ${missing.join(', ')} first.`); process.exit(1); }

const hash = crypto.createHash('sha256').update(`smoke-${Date.now()}`).digest('hex');
const ref = `smoke-${new Date().toISOString()}`;
console.log(`Anchoring hash=${hash} ref="${ref}" ...`);

try {
  const written = await writeChainRecord(hash, ref);
  console.log('write source:', written.source, '\n  ', written.data);
  if (written.source !== 'live') { console.error('FAILED: did not write live (check logs above for the fallback reason).'); process.exit(1); }

  console.log(`\nReading back tx ${written.data.tx_id} ...`);
  const read = await readChainRecord(written.data.tx_id);
  console.log('read source:', read.source, '\n  ', read.data);

  const ok = read.source === 'live' && read.data?.hash === hash && read.data?.ref === ref;
  console.log(ok ? '\nPASS: read-back matches what was written.' : '\nFAIL: mismatch or fell back to mock.');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

// EMessage / EReport / EGovChain wrappers.
// Every call goes through withFallback(): USE_MOCK_APIS=true (default) uses
// the mock; otherwise the live call runs with a timeout and falls back to the
// mock on any error. The `source` field ("live" | "mock" | "mock-fallback")
// is stored and shown in the UI so the demo stays honest.
//
// Auth shapes differ per API (confirmed against the live developer-portal
// docs on 2026-11-12):
//  - EMessage:   header X-EMESSAGE-Auth: <EMESSAGE_TOKEN>.
//  - EReport:    POST {EREPORT_URL}/api/integration/token body
//                {access_code: EREPORT_ACCESSCODE} -> {access_token, expires_at};
//                that access_token is sent as Authorization: Bearer on every
//                subsequent call. The code itself is never a bearer token.
//  - EGovChain:  not a REST hash-anchor API. It's a raw JSON-RPC endpoint for
//                a Hyperledger Besu chain (chainId 13371, zero gas price).
//                EGOVCHAIN_TOKEN is a URL path segment, not a header:
//                {EGOVCHAIN_URL}/{EGOVCHAIN_TOKEN}. Writing a record means
//                sending a signed transaction to our own HashAnchor contract
//                (see ../../../blockchain/), not a simple POST.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { config } from '../config.js';

const TIMEOUT_MS = 4000;
const env = process.env;
const usage = { emessage: { live: 0, mock: 0 }, ereport: { live: 0, mock: 0 }, egovchain: { live: 0, mock: 0 } };

// Per-API switch: USE_MOCK_APIS=false makes all three live; otherwise
// EMESSAGE_LIVE / EREPORT_LIVE / EGOVCHAIN_LIVE = true turns on one at a time.
const liveFlag = { emessage: 'EMESSAGE_LIVE', ereport: 'EREPORT_LIVE', egovchain: 'EGOVCHAIN_LIVE' };
const isLive = (api) => !config.useMockApis || env[liveFlag[api]] === 'true';

async function withFallback(api, live, mock) {
  const count = (src) => { usage[api][src === 'live' ? 'live' : 'mock'] += 1; };
  if (!isLive(api)) { count('mock'); return { data: await mock(), source: 'mock' }; }
  try {
    const data = await Promise.race([
      live(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
    ]);
    count('live');
    return { data, source: 'live' };
  } catch (err) {
    console.warn(`[egov] ${api} live call failed, using mock:`, err.message);
    count('mock');
    return { data: await mock(), source: 'mock-fallback' };
  }
}

async function ok(r) { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
async function postJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}`);
  try { return raw ? JSON.parse(raw) : {}; } catch { return { raw }; }
}

// ---- EMessage (SMS push) ----
// POST {EMESSAGE_BASE_URL}/messaging/v1/sms/push, header X-EMESSAGE-Auth,
// body { number: E.164, message }. Meters have no real contact details, so
// every customer SMS goes to EMESSAGE_TEST_TO (your own phone) in the demo.
export const E164 = /^\+[1-9]\d{7,14}$/;
const smsUrl = () => `${(env.EMESSAGE_BASE_URL ?? '').replace(/\/+$/, '')}/messaging/v1/sms/push`;

export async function pushSms(number, message) {
  if (!env.EMESSAGE_BASE_URL || !env.EMESSAGE_TOKEN) throw new Error('EMESSAGE_BASE_URL / EMESSAGE_TOKEN not set');
  if (!E164.test(number ?? '')) throw new Error(`recipient is not E.164: ${number}`);
  const r = await fetch(smsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EMESSAGE-Auth': env.EMESSAGE_TOKEN },
    body: JSON.stringify({ number, message }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 200)}`);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  // The response shape isn't documented yet: take the first ID-like field.
  const d = body.data ?? body;
  const id = d.message_id ?? d.messageId ?? d.id ?? d.reference ?? d.referenceId ?? `live-${crypto.randomUUID().slice(0, 8)}`;
  return { id: String(id), status: d.status ?? 'sent' };
}

export const sendEMessage = (_to, text) =>
  withFallback('emessage',
    () => pushSms(env.EMESSAGE_TEST_TO, text),
    () => ({ id: `mock-msg-${crypto.randomUUID().slice(0, 8)}`, status: 'queued' }));

// ---- EReport (citizen complaint submission) ----

// The access code mints a short-lived access_token; cache it and refresh a
// minute before it expires rather than minting one per request.
let ereportTokenCache = null; // { access_token, expires_at }
async function ereportAccessToken() {
  if (ereportTokenCache && Date.parse(ereportTokenCache.expires_at) - Date.now() > 60_000) {
    return ereportTokenCache.access_token;
  }
  if (!env.EREPORT_URL || !env.EREPORT_ACCESSCODE) throw new Error('EREPORT_URL / EREPORT_ACCESSCODE not set');
  const base = env.EREPORT_URL.replace(/\/+$/, '');
  const body = await postJson(`${base}/api/integration/token`, { access_code: env.EREPORT_ACCESSCODE });
  if (!body.access_token) throw new Error(`EReport token response missing access_token: ${JSON.stringify(body).slice(0, 200)}`);
  ereportTokenCache = body;
  return body.access_token;
}

// eReport's report_type catalog (crime, red_tape, scam, child_abuse,
// women_abuse, overpricing, fire, accident, gas_station_concerns) has no
// electricity-specific category. Confirmed against the customer app's
// "Report a concern" form (4 options, matching the reports.category CHECK
// constraint exactly); best available mapping, not a perfect fit:
//   - "Possible illegal connection nearby" (suspected_jumper): electricity
//     theft is closer to a crime than to anything else in the catalog.
//   - "Safety hazard" (sparking/exposed wires): fire risk -> fire.
//   - "My meter seems wrong" (meter_issue) and "Something else" (other):
//     no real match; falls back to accident as the generic field-incident
//     bucket.
const EREPORT_TYPE_MAP = {
  suspected_jumper: 'crime',
  meter_issue: 'accident',
  safety_hazard: 'fire',
  other: 'accident',
};

export async function submitEReportLive(category, note, transformerId) {
  if (!env.EREPORT_URL) throw new Error('EREPORT_URL not set');
  const base = env.EREPORT_URL.replace(/\/+$/, '');
  const token = await ereportAccessToken();
  const body = {
    mobile: env.EREPORT_DEMO_MOBILE,
    first_name: env.EREPORT_DEMO_FIRST_NAME,
    last_name: env.EREPORT_DEMO_LAST_NAME,
    gender: env.EREPORT_DEMO_GENDER,
    complainant_email: env.EREPORT_DEMO_EMAIL,
    report_type: EREPORT_TYPE_MAP[category] ?? 'accident',
    subject: `Meralco Go: ${category.replace(/_/g, ' ')} (transformer ${transformerId})`,
    message: note || `Automated report from the Meralco Go demo: ${category} reported on transformer ${transformerId}.`,
    region_code: env.EREPORT_DEMO_REGION_CODE,
    province_code: env.EREPORT_DEMO_PROVINCE_CODE,
    municipality_code: env.EREPORT_DEMO_MUNICIPALITY_CODE,
    barangay_code: env.EREPORT_DEMO_BARANGAY_CODE,
  };
  const res = await postJson(`${base}/api/integration/submit_complaint`, body, { Authorization: `Bearer ${token}` });
  if (!res.case_number) throw new Error(`EReport submit_complaint response missing case_number: ${JSON.stringify(res).slice(0, 200)}`);
  return { ticket: res.case_number, status: res.message ?? 'received' };
}

export const submitEReport = (category, note, transformerId) =>
  withFallback('ereport',
    () => submitEReportLive(category, note, transformerId),
    () => ({ ticket: `MOCK-${crypto.randomInt(100000, 999999)}`, status: 'received' }));

// ---- EGovChain: anchor a hash per cycle snapshot via our own HashAnchor
// contract (see ../../../blockchain/). Only the hash + a short ref are
// written (credit-friendly, and never the underlying bill data). ----

const HASH_ANCHOR_ABI = [
  'function anchor(bytes32 hash, string ref) returns (uint256 id)',
  'function getRecord(uint256 id) view returns (bytes32 hash, string ref, uint256 recordedAt, address submitter)',
  'function count() view returns (uint256)',
  'event Anchored(uint256 indexed id, bytes32 indexed hash, string ref, uint256 recordedAt, address submitter)',
];

let chainContractCache = null;
function chainContract() {
  if (chainContractCache) return chainContractCache;
  const base = (env.EGOVCHAIN_URL ?? '').replace(/\/+$/, '');
  const { EGOVCHAIN_TOKEN, EGOVCHAIN_DEPLOYER_KEY, EGOVCHAIN_CONTRACT_ADDRESS } = env;
  if (!base || !EGOVCHAIN_TOKEN || !EGOVCHAIN_DEPLOYER_KEY || !EGOVCHAIN_CONTRACT_ADDRESS) {
    throw new Error('EGOVCHAIN_URL / EGOVCHAIN_TOKEN / EGOVCHAIN_DEPLOYER_KEY / EGOVCHAIN_CONTRACT_ADDRESS not set');
  }
  // The token is a URL path segment on this gateway, not a header.
  const rpcUrl = `${base}/${EGOVCHAIN_TOKEN}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 13371, name: 'egovchain' }, { staticNetwork: true });
  const wallet = new ethers.Wallet(EGOVCHAIN_DEPLOYER_KEY, provider);
  chainContractCache = new ethers.Contract(EGOVCHAIN_CONTRACT_ADDRESS, HASH_ANCHOR_ABI, wallet);
  return chainContractCache;
}

// The mock chain lives in its own append-only file, separate from the main
// database, so editing the database cannot also edit the "chain" record.
fs.mkdirSync(config.dataDir, { recursive: true }); // db.js used to do this; it no longer touches the filesystem now that it's Postgres
const chainFile = path.join(config.dataDir, 'mock-egovchain.jsonl');
const readChain = () => (fs.existsSync(chainFile)
  ? fs.readFileSync(chainFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

export const writeChainRecord = (hash, ref) =>
  withFallback('egovchain',
    async () => {
      const contract = chainContract();
      // Explicit gasLimit/gasPrice: the gateway's own eth_estimateGas works
      // fine over plain JSON-RPC, but skipping the extra round trip saves a
      // usage credit; 0 gas price is the chain's fixed fee.
      const tx = await contract.anchor(`0x${hash}`, ref, { gasLimit: 300_000n, gasPrice: 0n });
      const receipt = await tx.wait();
      return { tx_id: receipt.hash, hash, ref, recorded_at: new Date().toISOString() };
    },
    () => {
      const rec = { tx_id: `mock-tx-${crypto.randomUUID().slice(0, 12)}`, hash, ref, recorded_at: new Date().toISOString() };
      fs.appendFileSync(chainFile, JSON.stringify(rec) + '\n');
      return rec;
    });

export const readChainRecord = (txId) =>
  withFallback('egovchain',
    async () => {
      const contract = chainContract();
      const receipt = await contract.runner.provider.getTransactionReceipt(txId);
      if (!receipt) throw new Error(`transaction ${txId} not found or not yet mined`);
      const log = receipt.logs
        .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === 'Anchored');
      if (!log) throw new Error(`Anchored event not found in receipt for ${txId}`);
      return {
        tx_id: txId,
        hash: log.args.hash.slice(2), // strip 0x to match the plain hex sha256 string stored in the DB
        ref: log.args.ref,
        recorded_at: new Date(Number(log.args.recordedAt) * 1000).toISOString(),
      };
    },
    () => readChain().find((r) => r.tx_id === txId) ?? null);

export const integrationStatus = () => {
  const apis = Object.fromEntries(Object.keys(usage).map((a) => [a, isLive(a) ? 'live' : 'simulated']));
  const live = Object.values(apis).filter((m) => m === 'live').length;
  return { mode: live === 0 ? 'simulated' : live === 3 ? 'live' : 'partial', apis, usage };
};

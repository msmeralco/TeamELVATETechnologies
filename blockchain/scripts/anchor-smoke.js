// One real round-trip against the deployed HashAnchor contract: anchor a
// test hash, read it back, and confirm it matches. Plain ethers.js against
// the gateway RPC directly — see deploy.js for why Hardhat's own signer
// wrapper is avoided here.
//
//   npm run anchor:smoke
//
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { ethers } = require('ethers');
const art = require('../artifacts/contracts/HashAnchor.sol/HashAnchor.json');

const ABI = art.abi;

async function main() {
  const base = (process.env.EGOVCHAIN_URL || '').replace(/\/+$/, '');
  const token = process.env.EGOVCHAIN_TOKEN;
  const key = process.env.EGOVCHAIN_DEPLOYER_KEY;
  const address = process.env.EGOVCHAIN_CONTRACT_ADDRESS;
  if (!base || !token || !key) throw new Error('Set EGOVCHAIN_URL / EGOVCHAIN_TOKEN / EGOVCHAIN_DEPLOYER_KEY in the repo-root .env first.');
  if (!address) throw new Error('Set EGOVCHAIN_CONTRACT_ADDRESS in the repo-root .env first (run npm run deploy).');

  const provider = new ethers.JsonRpcProvider(`${base}/${token}`, { chainId: 13371, name: 'egovchain' }, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, ABI, wallet);

  const testHash = ethers.keccak256(ethers.toUtf8Bytes(`smoke-test-${Date.now()}`));
  const ref = `smoke-${new Date().toISOString()}`;

  console.log(`Anchoring hash ${testHash} ref="${ref}" ...`);
  const nonce = await provider.getTransactionCount(wallet.address, 'latest');
  const tx = await contract.anchor(testHash, ref, { nonce, gasLimit: 300_000n, gasPrice: 0n });
  console.log(`Sent tx ${tx.hash}, waiting for it to be mined ...`);
  const receipt = await tx.wait();
  console.log(`Confirmed in tx ${receipt.hash}`);

  const id = (await contract.count()) - 1n;
  const record = await contract.getRecord(id);
  const [hash, storedRef] = record;

  const ok = hash === testHash && storedRef === ref;
  console.log(`\nRead back record #${id}: hash=${hash} ref="${storedRef}"`);
  console.log(ok ? 'PASS: matches what was written.' : 'FAIL: mismatch.');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

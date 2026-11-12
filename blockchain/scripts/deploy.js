// Deploys HashAnchor to the eGovChain network and prints the contract
// address to paste into the repo-root .env as EGOVCHAIN_CONTRACT_ADDRESS.
//
// Uses plain ethers.js against the gateway RPC directly rather than
// Hardhat's own ethers-signer wrapper: hardhat-ethers' estimateGas call
// through this gateway reliably comes back "Internal error" (confirmed
// 2026-11-12), while the identical call over plain ethers.js succeeds.
// Compilation still goes through Hardhat (see hardhat.config.js); only the
// network call path is bypassed here.
//
//   npm run deploy
//
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { ethers } = require('ethers');
const art = require('../artifacts/contracts/HashAnchor.sol/HashAnchor.json');

async function main() {
  const base = (process.env.EGOVCHAIN_URL || '').replace(/\/+$/, '');
  const token = process.env.EGOVCHAIN_TOKEN;
  const key = process.env.EGOVCHAIN_DEPLOYER_KEY;
  if (!base || !token) throw new Error('Set EGOVCHAIN_URL / EGOVCHAIN_TOKEN in the repo-root .env first.');
  if (!key) throw new Error('No signer configured. Set EGOVCHAIN_DEPLOYER_KEY in the repo-root .env first (see scripts/generate-wallet.js).');

  const provider = new ethers.JsonRpcProvider(`${base}/${token}`, { chainId: 13371, name: 'egovchain' }, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  console.log(`Deploying HashAnchor from ${wallet.address} ...`);

  const nonce = await provider.getTransactionCount(wallet.address, 'latest');
  const gasEstimate = await provider.estimateGas({ from: wallet.address, data: art.bytecode });

  const tx = await wallet.sendTransaction({
    data: art.bytecode,
    nonce,
    gasLimit: (gasEstimate * 120n) / 100n,
    gasPrice: 0n,
    type: 0,
  });
  console.log(`Sent tx ${tx.hash}, waiting for it to be mined (the chain must actually include it — check with blockNumber-polling if this hangs) ...`);
  const receipt = await tx.wait();

  console.log(`\nHashAnchor deployed.`);
  console.log(`  address: ${receipt.contractAddress}`);
  console.log(`  tx hash: ${receipt.hash}`);
  console.log(`\nAdd to the repo-root .env:\nEGOVCHAIN_CONTRACT_ADDRESS=${receipt.contractAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

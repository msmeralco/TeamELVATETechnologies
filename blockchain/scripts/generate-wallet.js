// Generates a fresh Ethereum keypair locally for signing eGovChain
// transactions. Nothing here is sent anywhere — it only prints the values
// so you can paste them into the repo-root .env yourself.
//
//   node scripts/generate-wallet.js
//
const { ethers } = require('ethers');

const wallet = ethers.Wallet.createRandom();

console.log('New eGovChain deploy/signing wallet generated locally.\n');
console.log('Add these to the repo-root .env (never commit the private key):\n');
console.log(`EGOVCHAIN_DEPLOYER_KEY=${wallet.privateKey}`);
console.log(`EGOVCHAIN_DEPLOYER_ADDRESS=${wallet.address}`);
console.log('\nGas price on eGovChain is 0, so this address needs no funding to send transactions.');
console.log('If the chain is permissioned, you may still need to ask the organizers to allowlist this address before it can transact.');

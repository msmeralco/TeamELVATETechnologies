require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// The eGovChain gateway puts the credential token in the URL path itself:
//   https://platforms-api.e.gov.ph/egovchain/{EGOVCHAIN_TOKEN}
// not in an Authorization header. See docs: Gateway base URL + "/{path}".
const base = (process.env.EGOVCHAIN_URL || '').replace(/\/+$/, '');
const token = process.env.EGOVCHAIN_TOKEN || '';
const rpcUrl = base && token ? `${base}/${token}` : undefined;

const accounts = process.env.EGOVCHAIN_DEPLOYER_KEY ? [process.env.EGOVCHAIN_DEPLOYER_KEY] : [];

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    egovchain: {
      url: rpcUrl ?? 'http://127.0.0.1:0', // placeholder so `hardhat compile` works with no .env
      chainId: 13371,
      gasPrice: 0,
      accounts,
    },
  },
};

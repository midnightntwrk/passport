/**
 * Prints a fresh funder seed and the unshielded address it derives on
 * FUNDER_NETWORK (default preview), so the operator can faucet that address
 * once and then run the service with the seed.
 *
 *   FUNDER_NETWORK=preview npm run generate-seed
 */

import { randomBytes } from 'node:crypto';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { applyEnvFile } from './config.js';
import { unshieldedAddressFromSeed } from './wallet.js';

applyEnvFile();

const FAUCETS: Record<string, string> = {
  preview: 'https://faucet.preview.midnight.network',
  preprod: 'https://faucet.preprod.midnight.network',
};

const networkId = process.env.FUNDER_NETWORK?.trim() || 'preview';
setNetworkId(networkId);

const seedHex = randomBytes(32).toString('hex');
const address = unshieldedAddressFromSeed(seedHex);

console.log(`network  ${networkId}`);
console.log(`seed     ${seedHex}`);
console.log(`address  ${address}\n`);
console.log('1. Keep the seed secret — export it as FUNDER_SEED where the service runs.');
console.log(
  `2. Fund the address once${
    FAUCETS[networkId]
      ? ` from the captcha faucet: ${FAUCETS[networkId]}`
      : networkId === 'undeployed'
        ? ` from the localnet genesis wallet: node fund-localnet.mjs ${address}`
        : ' (no public faucet is known for this network).'
  }`,
);
console.log('3. Start the service: FUNDER_SEED=<seed> npm start');

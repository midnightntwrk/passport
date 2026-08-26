/**
 * Prints a fresh balancer seed and the stagenet unshielded address it derives,
 * so the operator can faucet that address once and then run the service with
 * the seed. Derivation uses the ledger-9 beta wallet SDK — the same one the
 * service itself runs — so the address is exactly the one the wallet opens.
 *
 *   npm run generate-seed
 */
import { randomBytes } from 'node:crypto';

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk/hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk/unshielded';

const NETWORK = process.env.BALANCER_NETWORK?.trim() || 'stagenet';

const seed = randomBytes(32);
const hd = HDWallet.fromSeed(new Uint8Array(seed));
if (hd.type !== 'seedOk') throw new Error('seed rejected');
const derived = hd.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.NightExternal])
  .deriveKeysAt(0);
hd.hdWallet.clear();
if (derived.type !== 'keysDerived') throw new Error('derivation failed');

/* The beta keystore takes a tagged secret — `kind` names the signature scheme
   ledger-9 should verify with. The NightExternal role key is Schnorr, exactly
   as it was on ledger-8; the separate EcdsaUnshielded role exists for the
   other scheme and is not this key. */
const keystore = createKeystore(
  { kind: 'schnorr', secret: derived.keys[Roles.NightExternal] },
  NETWORK,
);
const address = PublicKey.fromKeyStore(keystore).address;

console.log(`network  ${NETWORK}`);
console.log(`seed     ${seed.toString('hex')}`);
console.log(`address  ${address}\n`);
console.log('1. Keep the seed secret — export it as BALANCER_SEED where the service runs.');
console.log(`2. Fund the address once: https://faucet.${NETWORK}.shielded.tools`);
console.log('3. Start the service: BALANCER_SEED=<seed> npm start');

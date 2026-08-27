// Public surface of the account-custody reference implementation.

export { Contract, ledger, pureCircuits } from './wallet/contract.js';
export type { Ledger, JubjubPoint, Secp256k1Point, ShieldedCoin, QualifiedCoin } from './wallet/contract.js';

export {
  JubjubDevice,
  K256Device,
  jubjubChallenges,
  k256Challenges,
  authArgs,
  JUBJUB_R,
  SECP256K1_N,
  randomJubjubScalar,
  randomSecp256k1Scalar,
  scalarToBytesBE,
  bytesToBigIntLE,
} from './wallet/signer.js';
export type {
  Arm,
  AnyDevice,
  Authorisation,
  JubjubAuthorisation,
  K256Authorisation,
  EcdsaSignature,
  ChallengeBuilder,
  CallContext,
} from './wallet/signer.js';

export {
  sealInboxEntry,
  openInboxEntry,
  generateEncKeyPair,
  ENTRY_SIZE,
  ENTRY_VERSION,
  ENTRY_SUITE,
} from './wallet/inbox.js';
export type { EncKeyPair, PlainCoin } from './wallet/inbox.js';

export { CustodyAccount } from './wallet/account.js';
export type { TxResult, SpendOutcome, DirectSpendOutcome } from './wallet/account.js';

export { inboxWalk } from './wallet/discovery.js';
export type { DiscoveredCoin } from './wallet/discovery.js';

export {
  queryTxPosition,
  mtIndexForSingleOutput,
  candidateIndices,
} from './wallet/capture.js';

export {
  emptyCoinStore,
  withCoin,
  withoutCoin,
  makeWitnesses,
} from './wallet/witnesses.js';
export type { CoinStorePrivateState, StoredCoin } from './wallet/witnesses.js';

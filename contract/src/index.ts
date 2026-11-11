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
export type { TxResult, SpendOutcome, DirectSpendOutcome, ShieldedGrantOptions, DurableChangesOptions, ConnectOptions, RecoverHoldingsOptions } from './wallet/account.js';

export { scanHoldings } from './wallet/chain-recovery.js';
export type {
  ChainRecoveryAdapter, ChainRecoverySnapshot, ChainRecoveryScope, ChainRecoveryCursor,
  CoinSearchCursor, ChainCoinInspection, ChainRecoveryCandidate, RecoveryCandidateSource,
  ScanHoldingsOptions, RecoveredHolding, HoldingsRecoveryReport,
} from './wallet/chain-recovery.js';
export { createSdkChainRecoveryAdapter } from './wallet/sdk-chain-recovery.js';
export type { SdkChainRecoveryOptions } from './wallet/sdk-chain-recovery.js';

export { DurableChangeCoordinator, DurableChangePendingError } from './wallet/change-journal.js';
export type {
  ChangeJournal, ChangeJournalEntry, ChangeJournalStore, ChangeIntent,
  DurableTransactionAdapter, PreparedChangeTransaction, TransactionObservation,
} from './wallet/change-journal.js';
export { createSdkChangeAdapter } from './wallet/sdk-change-adapter.js';
export type { SdkChangeAdapterOptions } from './wallet/sdk-change-adapter.js';
export { createFileChangeJournalStore } from './node/change-journal-store.js';
export type { FileChangeJournalOptions } from './node/change-journal-store.js';

export { ViewingRecoveryError, viewingSnapshot, openCurrentViewingKey,
  reconstructRecoverySecret, reconstructCurrentViewingKey } from './wallet/viewing-recovery.js';
export type {
  ViewingKeyScope, PersistedViewingKey, ViewingKeyStore, ViewingRecoveryOptions,
  GuardianRecoveryInput, PublishViewingRecoveryOptions, ViewingRecoverySnapshot,
  ViewingRecoveryStatus, ViewingKeyPersistenceResult, ViewingRecoveryErrorCode,
} from './wallet/viewing-recovery.js';
export { createFileViewingKeyStore } from './node/viewing-key-store.js';
export type { FileViewingKeyStoreOptions } from './node/viewing-key-store.js';

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
  coinId,
  migrateCoinStore,
  coinsForColour,
  selectCoin,
  withSelectedCoin,
  makeWitnesses,
} from './wallet/witnesses.js';
export type { CoinStorePrivateState, MultiCoinStore, StoredCoin, CoinIdentity } from './wallet/witnesses.js';

export interface PassportStateScope {
  /** Stable identifier owned by the integrating application. */
  appId: string;
  /** Passport account, contract, or application-user identifier. */
  accountId: string;
}

export interface PassportStateKeyProvider {
  /**
   * Returns a non-exportable key for one explicit storage operation. Browser
   * implementations may prompt the user here; callers should invoke storage
   * actions from a user gesture.
   */
  getKey(scope: PassportStateScope): Promise<CryptoKey>;
}

/**
 * Yields raw seed material for an on-device Midnight wallet.
 *
 * Kept separate from {@link PassportStateKeyProvider} on purpose: that
 * interface never lets key bytes escape, whereas a wallet seed must, because
 * the Midnight wallet SDK derives its HD tree from bytes. Implementations MUST
 * domain-separate this output from the private-state encryption key.
 */
export interface PassportWalletSeedProvider {
  /** Returns exactly 32 bytes. May prompt the user; call from a user gesture. */
  deriveWalletSeed(scope: PassportStateScope): Promise<Uint8Array>;
}

export interface PassportEncryptedRecordStore {
  get(key: string): Promise<PassportEncryptedEnvelope | null>;
  set(key: string, value: PassportEncryptedEnvelope): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PassportEncryptedEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

export interface PassportPrivateStateStore {
  save<T>(scope: PassportStateScope, state: T): Promise<void>;
  load<T>(scope: PassportStateScope): Promise<T | null>;
  remove(scope: PassportStateScope): Promise<void>;
  clear(): Promise<void>;
}

export interface PassportStateInjectionOptions<T> {
  store: PassportPrivateStateStore;
  scope: PassportStateScope;
  initialPrivateState: T;
}

export interface PassportStateInjectionResult<T> {
  scope: PassportStateScope;
  privateState: T;
  source: 'stored' | 'initial';
}

export interface PassportJoinOptions<T, TResult> extends PassportStateInjectionOptions<T> {
  /** Pass this state straight into the app's `initialPrivateState` join call. */
  join(initialPrivateState: T): Promise<TResult>;
}

export interface PassportJoinResult<T, TResult> {
  injection: PassportStateInjectionResult<T>;
  result: TResult;
}

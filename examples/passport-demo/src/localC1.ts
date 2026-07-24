import type { MidnightWallet } from '@dynamic-labs/midnight';
import { encodeRawTokenType, rawTokenType } from '@midnight-ntwrk/ledger-v8';
import { firstValueFrom } from 'rxjs';

import { PassportAccount } from '../../../experiments/account-custody-prototype/src/wallet/account.js';
import {
  bytesToHex,
  hexToBytes32,
  randomBytes32,
} from '../../../experiments/account-custody-prototype/src/wallet/hex.js';
import { grantCommitment } from '../../../experiments/account-custody-prototype/src/wallet/contract.js';
import {
  getMidnight,
  getOrDeployLocalFaucet,
  registerIdentity,
} from '../../../experiments/account-custody-prototype/app/src/lib/midnight.js';
import {
  coinPublicKeyBytes,
  compiledAccountContract,
  userAddressBytes,
} from '../../../experiments/account-custody-prototype/app/src/lib/providers.js';
import { normalizeAlias } from '../../../experiments/account-custody-prototype/app/src/lib/session.js';

export const LOCAL_C1_ARTIFACT = 'account-custody-prototype-v1' as const;
export const LOCAL_C1_NETWORK = 'undeployed' as const;

export interface LocalPassportDeployment {
  address: string;
  txHash: string;
}

export interface LocalPassportIdentity {
  identityRegistryAddress: string;
  identityTxHash: string;
  alias: string;
}

export interface LocalPassportPermission {
  commitment: string;
  epoch: string;
  color: string;
  cap: string;
  spent: string;
  active: boolean;
}

export interface LocalPassportCustody {
  unshielded: Array<{
    color: string;
    value: string;
  }>;
  shielded: Array<{
    color: string;
    value: string;
    nonce: string;
  }>;
}

export class LocalCustodyPendingError extends Error {
  constructor(
    message: string,
    readonly txHash: string,
    readonly custody?: LocalPassportCustody,
  ) {
    super(message);
    this.name = 'LocalCustodyPendingError';
  }
}

const FAUCET_DOMESTIC_COLOR = hexToBytes32('06');

export function localPassportMode(): boolean {
  return new URLSearchParams(window.location.search).get('demoMode') === 'local';
}

async function connectLocalPassport(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
): Promise<{ account: PassportAccount; nightColor: Uint8Array }> {
  if (!localPassportMode()) {
    throw new Error('Local C1 operations are disabled outside demoMode=local.');
  }
  const midnight = await getMidnight(wallet);
  if (midnight.mode !== 'local') {
    throw new Error('Passport localnet providers were not selected.');
  }
  const account = await PassportAccount.connect(
    midnight.accountProviders,
    compiledAccountContract(),
    contractAddress,
    { deviceSecret },
  );
  return {
    account,
    nightColor: hexToBytes32(midnight.nightColorHex),
  };
}

async function connectLocalPassportPublic(
  wallet: MidnightWallet,
  contractAddress: string,
): Promise<{ account: PassportAccount; nightColor: Uint8Array }> {
  if (!localPassportMode()) {
    throw new Error('Local C1 operations are disabled outside demoMode=local.');
  }
  const midnight = await getMidnight(wallet);
  if (midnight.mode !== 'local') {
    throw new Error('Passport localnet providers were not selected.');
  }
  const account = await PassportAccount.connect(
    midnight.accountProviders,
    compiledAccountContract(),
    contractAddress,
  );
  return {
    account,
    nightColor: hexToBytes32(midnight.nightColorHex),
  };
}

async function readPermissions(account: PassportAccount): Promise<LocalPassportPermission[]> {
  const state = await account.ledgerState();
  return [...state.grants]
    .map(([commitment, grant]) => ({
      commitment: commitment.toString(),
      epoch: grant.epoch.toString(),
      color: bytesToHex(grant.color),
      cap: grant.cap.toString(),
      spent: grant.spent.toString(),
      active: grant.active && grant.epoch === state.device_epoch,
    }))
    .sort((left, right) => Number(right.active) - Number(left.active));
}

async function readCustody(account: PassportAccount): Promise<LocalPassportCustody> {
  const state = await account.ledgerState();
  return {
    unshielded: [...state.night_balances].map(([color, value]) => ({
      color: bytesToHex(color),
      value: value.toString(),
    })),
    shielded: [...state.coins].map(([color, coin]) => ({
      color: bytesToHex(color),
      value: coin.value.toString(),
      nonce: bytesToHex(coin.nonce),
    })),
  };
}

function transactionId(result: any): string {
  const txHash = result?.public?.txId ?? result?.public?.transactionHash;
  if (!txHash) throw new Error('The localnet contract call returned without a transaction hash.');
  return String(txHash);
}

function shieldedWalletBalance(state: any, tokenTypeHex: string): bigint {
  const balances = state?.shielded?.balances as Record<string, bigint> | undefined;
  if (!balances) return 0n;
  const normalized = tokenTypeHex.replace(/^0x/, '').toLowerCase();
  const entry = Object.entries(balances).find(
    ([color]) => color.replace(/^0x/, '').toLowerCase() === normalized,
  );
  return entry ? BigInt(entry[1]) : 0n;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

async function waitForCustody(
  account: PassportAccount,
  predicate: (custody: LocalPassportCustody) => boolean,
  txHash: string,
): Promise<LocalPassportCustody> {
  let latest = await readCustody(account);
  for (let attempt = 0; attempt < 20 && !predicate(latest); attempt += 1) {
    await wait(750);
    latest = await readCustody(account);
  }
  if (!predicate(latest)) {
    throw new LocalCustodyPendingError(
      'The custody transaction was submitted, but its ledger update is still indexing. Read the ledger before retrying.',
      txHash,
      latest,
    );
  }
  return latest;
}

export async function deployLocalPassportContract(
  wallet: MidnightWallet,
  deviceSecret: Uint8Array,
  recoverySecret: Uint8Array,
): Promise<LocalPassportDeployment> {
  if (!localPassportMode()) {
    throw new Error('The local Passport deployment adapter is disabled outside demoMode=local.');
  }
  const midnight = await getMidnight(wallet);
  if (midnight.mode !== 'local') {
    throw new Error('Passport localnet providers were not selected.');
  }

  const account = await PassportAccount.deploy(
    midnight.accountProviders,
    compiledAccountContract(),
    {
      deviceSecret,
      recoverySecret,
    },
  );

  return {
    address: account.address,
    txHash: account.deploymentTxId ?? account.address,
  };
}

export async function registerLocalPassportIdentity(
  wallet: MidnightWallet,
  accountAddress: string,
  requestedAlias: string,
): Promise<LocalPassportIdentity> {
  if (!localPassportMode()) {
    throw new Error('The local Passport identity adapter is disabled outside demoMode=local.');
  }
  const midnight = await getMidnight(wallet);
  if (midnight.mode !== 'local') {
    throw new Error('Passport localnet providers were not selected.');
  }
  const alias = normalizeAlias(requestedAlias);
  const identity = await registerIdentity(midnight, alias, accountAddress);
  return {
    identityRegistryAddress: identity.registryAddress,
    identityTxHash: identity.txId,
    alias,
  };
}

export async function loadLocalPassportPermissions(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
): Promise<LocalPassportPermission[]> {
  const { account } = await connectLocalPassport(wallet, contractAddress, deviceSecret);
  return readPermissions(account);
}

export async function loadLocalPassportCustody(
  wallet: MidnightWallet,
  contractAddress: string,
): Promise<LocalPassportCustody> {
  const { account } = await connectLocalPassportPublic(wallet, contractAddress);
  return readCustody(account);
}

export async function depositLocalPassportNight(
  wallet: MidnightWallet,
  contractAddress: string,
  amount: bigint,
): Promise<{ txHash: string; custody: LocalPassportCustody }> {
  const { account, nightColor } = await connectLocalPassportPublic(wallet, contractAddress);
  const before = await readCustody(account);
  const current = BigInt(
    before.unshielded.find((balance) => balance.color === bytesToHex(nightColor))?.value ?? '0',
  );
  const result = await account.depositNight(nightColor, amount);
  const txHash = result.txId;
  const expected = current + amount;
  return {
    txHash,
    custody: await waitForCustody(
      account,
      (value) =>
        BigInt(
          value.unshielded.find((balance) => balance.color === bytesToHex(nightColor))
            ?.value ?? '0',
        ) >= expected,
      txHash,
    ),
  };
}

export async function withdrawLocalPassportNight(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
  amount: bigint,
): Promise<{ txHash: string; custody: LocalPassportCustody }> {
  const midnight = await getMidnight(wallet);
  if (!midnight.walletCtx) throw new Error('The disposable localnet wallet is unavailable.');
  const { account, nightColor } = await connectLocalPassport(
    wallet,
    contractAddress,
    deviceSecret,
  );
  const before = await readCustody(account);
  const current = BigInt(
    before.unshielded.find((balance) => balance.color === bytesToHex(nightColor))?.value ?? '0',
  );
  if (amount > current) throw new Error('The Passport contract does not hold enough NIGHT.');
  const result = await account.withdrawNight(
    nightColor,
    amount,
    userAddressBytes(midnight.walletCtx),
  );
  const txHash = result.txId;
  const expected = current - amount;
  return {
    txHash,
    custody: await waitForCustody(
      account,
      (value) =>
        BigInt(
          value.unshielded.find((balance) => balance.color === bytesToHex(nightColor))
            ?.value ?? '0',
        ) <= expected,
      txHash,
    ),
  };
}

export async function mintAndDepositLocalPassportShielded(
  wallet: MidnightWallet,
  contractAddress: string,
  amount: bigint,
): Promise<{
  mintTxHash: string;
  depositTxHash: string;
  tokenType: string;
  custody: LocalPassportCustody;
}> {
  const midnight = await getMidnight(wallet);
  if (!midnight.walletCtx) {
    throw new Error('The disposable localnet wallet is unavailable.');
  }
  const faucet = await getOrDeployLocalFaucet(midnight);
  if (!midnight.faucetAddress) throw new Error('The disposable localnet faucet did not return an address.');
  const walletState = await firstValueFrom(midnight.walletCtx.wallet.state());
  const tokenType = encodeRawTokenType(
    rawTokenType(FAUCET_DOMESTIC_COLOR, midnight.faucetAddress),
  );
  const tokenTypeHex = bytesToHex(tokenType);
  const walletBalanceBefore = shieldedWalletBalance(walletState, tokenTypeHex);
  const nonce = randomBytes32();
  const mintResult = await faucet.callTx.mint_shielded(
    FAUCET_DOMESTIC_COLOR,
    amount,
    nonce,
    { bytes: coinPublicKeyBytes(walletState) },
  );
  const mintTxHash = transactionId(mintResult);

  // The local wallet must observe the minted note before it can balance the
  // real deposit transaction. The same indexer delay exists in the lifecycle
  // test; this is never replaced with a simulated completion.
  let walletObservedMint = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await wait(1_000);
    const nextWalletState = await firstValueFrom(midnight.walletCtx.wallet.state());
    if (
      shieldedWalletBalance(nextWalletState, tokenTypeHex) >=
      walletBalanceBefore + amount
    ) {
      walletObservedMint = true;
      break;
    }
  }
  if (!walletObservedMint) {
    throw new LocalCustodyPendingError(
      `Mint ${mintTxHash} was submitted, but the local wallet did not index the note in time.`,
      mintTxHash,
    );
  }
  const { account } = await connectLocalPassportPublic(wallet, contractAddress);
  const before = await readCustody(account);
  const current = BigInt(
    before.shielded.find((balance) => balance.color === tokenTypeHex)?.value ?? '0',
  );
  const depositResult = await account.depositShielded({
    nonce,
    color: tokenType,
    value: amount,
  });
  const depositTxHash = depositResult.txId;
  const expected = current + amount;
  return {
    mintTxHash,
    depositTxHash,
    tokenType: tokenTypeHex,
    custody: await waitForCustody(
      account,
      (value) =>
        BigInt(
          value.shielded.find((balance) => balance.color === tokenTypeHex)?.value ?? '0',
        ) >= expected,
      depositTxHash,
    ),
  };
}

export async function withdrawLocalPassportShielded(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
  colorHex: string,
  amount: bigint,
): Promise<{ txHash: string; custody: LocalPassportCustody }> {
  const midnight = await getMidnight(wallet);
  if (!midnight.walletCtx) throw new Error('The disposable localnet wallet is unavailable.');
  const walletState = await firstValueFrom(midnight.walletCtx.wallet.state());
  const { account } = await connectLocalPassport(wallet, contractAddress, deviceSecret);
  const before = await readCustody(account);
  const current = BigInt(
    before.shielded.find((balance) => balance.color === colorHex)?.value ?? '0',
  );
  if (amount > current) throw new Error('The Passport contract does not hold enough shielded value.');
  const result = await account.withdrawShielded(
    coinPublicKeyBytes(walletState),
    hexToBytes32(colorHex),
    amount,
  );
  const txHash = result.txId;
  const expected = current - amount;
  return {
    txHash,
    custody: await waitForCustody(
      account,
      (value) =>
        BigInt(
          value.shielded.find((balance) => balance.color === colorHex)?.value ?? '0',
        ) <= expected,
      txHash,
    ),
  };
}

export async function addLocalPassportPermission(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
  grantSecret: Uint8Array,
  cap: bigint,
): Promise<{ txHash: string; commitment: string; permissions: LocalPassportPermission[] }> {
  const { account, nightColor } = await connectLocalPassport(wallet, contractAddress, deviceSecret);
  const result = await account.addGrant(grantSecret, nightColor, cap);
  return {
    txHash: result.txId,
    commitment: grantCommitment(grantSecret).toString(),
    permissions: await readPermissions(account),
  };
}

export function localPassportGrantCommitment(grantSecret: Uint8Array): string {
  return grantCommitment(grantSecret).toString();
}

export async function revokeLocalPassportPermission(
  wallet: MidnightWallet,
  contractAddress: string,
  deviceSecret: Uint8Array,
  commitment: string,
): Promise<{ txHash: string; permissions: LocalPassportPermission[] }> {
  const { account } = await connectLocalPassport(wallet, contractAddress, deviceSecret);
  const result = await account.revokeGrantByCommitment(BigInt(commitment));
  return {
    txHash: result.txId,
    permissions: await readPermissions(account),
  };
}

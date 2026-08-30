/**
 * Account-custody contract (ACC) — reads and value flows, browser edition.
 *
 * WHAT THIS IS
 * ------------
 * `./passportContract.ts` DEPLOYS one instance of `account.compact` per
 * Passport. This module is that module's other half: it READS the deployed
 * instance's ledger and CALLS its circuits. Under the ruling that every value
 * flow routes through the ACC, the balances Home shows are the contract's
 * `night_balances` and `coins` maps — not the wallet's — and moving money is a
 * `withdraw_night` / `withdraw_shielded` / `deposit_*` call against the
 * contract. The passkey wallet is the signer and the fee payer; the contract is
 * the account.
 *
 * Every export here either returns something the chain answered with, or
 * throws {@link AccountCustodyError} naming what really went wrong. There is no
 * path that reports a transfer that was not submitted, and no path that reports
 * a balance that was not decoded from ledger state served by the indexer.
 *
 * IT IS A SIBLING OF `./passportContract.ts` AND `./midnames.ts`
 * -------------------------------------------------------------
 * Those two are the proven shapes in this repository for "a browser talks to a
 * real Compact contract on the network the open wallet signs on", so this
 * module copies them deliberately rather than inventing a third way:
 *
 *   - the compiled contract module is loaded through the SAME single literal
 *     specifier both siblings use — `loadContractModule` in
 *     `./contractRuntime.ts` — so the bundler and Node both resolve ONE module
 *     record (see the two-runtime note on {@link loadAccountContract});
 *   - ZK artefacts load over URL through `FetchZkConfigProvider` pointed at
 *     `/zk/account` — the directory `scripts/prepare-zk-assets.mjs` stages and
 *     the Vite middleware serves. Nothing here touches `node:fs`;
 *   - fees are sponsored, and only sponsored. Every write here goes through
 *     the one balancing path both siblings use: when the sponsor has not said
 *     it can pay, the call is refused with the sponsor's own reason and
 *     nothing is built, proved, or signed. No path reads or spends this
 *     wallet's dust.
 *
 * THE PROVIDER PLUMBING IS NOW SHARED, NOT DUPLICATED (2026/08/24)
 * ---------------------------------------------------------------
 * Until the ledger-9 port, each of the three modules carried its own copy of
 * the provider set, the private-state store, and the balancing pair — on the
 * argument that one self-contained module per flow keeps a change to one
 * flow's fee handling from silently moving another's. Three copies of the same
 * six API differences is not a port, it is three ports, and the copies had
 * already drifted. They now share `./contractRuntime.ts`, which is where the
 * differences are documented; the behaviour is unchanged.
 *
 * THE DEVICE SECRET IS NOT OURS TO INVENT
 * ---------------------------------------
 * The contract only accepts the device whose commitment it was DEPLOYED with,
 * and that commitment came from `derivePassportContractSecrets` in
 * `./passportContract.ts`. So the device secret every gated call here needs is
 * that same derivation's `deviceSecret` and nothing else —
 * {@link deriveAccountDeviceSecret} re-exposes it so no caller has to
 * re-derive from memory of how it was done.
 *
 * NETWORK ID: like both siblings, this module never calls `setNetworkId`. The
 * live wallet owns the process-wide network id, and moving it would corrupt
 * every address the wallet then encodes.
 */

import {
  encodeCoinPublicKey,
  encodeShieldedCoinInfo,
  nativeToken,
} from '@midnightntwrk/ledger-v9';
import {
  MidnightBech32m,
  UnshieldedAddress,
  mainnet,
} from '@midnight-ntwrk/wallet-sdk/address-format';
import * as Rx from 'rxjs';

import type { LocalMidnightWallet } from '../lib/localWallet.js';
/* Type-only, and through the SAME specifier {@link loadAccountContract} uses —
   a type has no instance, so this adds no module to either graph. */
import type { Ledger as AccountLedger } from '../../contracts/stagenet/account/index.js';
import { sponsorFeeRefusal, sponsorReadiness } from '../lib/sponsor.js';
import {
  createContractProviders,
  compiledContractFor,
  indexerWsFrom,
  loadContractModule,
} from './contractRuntime.js';
import {
  accountPrivateStateFrom,
  accountWitnesses,
  derivePassportContractSecrets,
  rawContractAddress,
  resolveDeployTxHashOnce,
} from './passportContract.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How long the wallet facade gets to answer with a state snapshot. */
const STATE_TIMEOUT_MS = 15_000;
/** Attempts, at two seconds apart, to map a transaction identifier to a hash. */
const TX_HASH_ATTEMPTS = 5;
const TX_HASH_INTERVAL_MS = 2_000;
/** A Compact `Field` is carried as 32 bytes, so its hex form is 64 characters. */
const FIELD_HEX_LENGTH = 64;

/* -------------------------------------------------------------------------- */
/* Small helpers — deliberately the same shapes as `./passportContract.ts`     */
/* -------------------------------------------------------------------------- */

function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * The transaction identifier a midnight-js call answers with. Identical to
 * `./midnames.ts`'s reader, and held to the same rule: a call that returned no
 * id is a call we cannot report, so it throws rather than inventing one.
 */
function transactionId(result: unknown): string {
  const view = result as { public?: { txId?: unknown; transactionHash?: unknown } };
  const value = view?.public?.txId ?? view?.public?.transactionHash;
  if (!value) throw new Error('The account-custody call returned without a transaction id.');
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A token colour as the contract takes it: `Bytes<32>`, from the 64-character
 * raw token type the wallet and the ledger both quote (`nativeToken().raw`,
 * the keys of `state.unshielded.balances`, `ShieldedHolding.tokenType`).
 *
 * Strict on purpose. The prototype's Node harnesses left-align a short hex
 * string into 32 bytes (`hexToBytes32('06')`) because they mint their own
 * domestic colours; in the demo every colour arrives as a full raw token type,
 * so a short value is a bug rather than an abbreviation, and padding it would
 * silently send funds to a colour nobody asked for.
 */
export function colourHexToBytes(colourHex: string): Uint8Array {
  const normalized = colourHex.trim().toLowerCase().replace(/^0x/, '');
  if (!new RegExp(`^[0-9a-f]{${FIELD_HEX_LENGTH}}$`).test(normalized)) {
    throw new AccountCustodyError(
      'invalid-request',
      `"${colourHex}" is not a Midnight token colour: expected ${FIELD_HEX_LENGTH} hex characters.`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The native NIGHT colour, as the ledger quotes it. */
export function nightColourHex(): string {
  return String(nativeToken().raw);
}

/** The native NIGHT colour as the contract takes it. */
export function nightColourBytes(): Uint8Array {
  return colourHexToBytes(nightColourHex());
}

/**
 * `MidnightBech32m.parse` reports mainnet as the exported `mainnet` symbol (a
 * mainnet address carries no network segment), every other network as its
 * string. This is the SDK's own normalisation — a duplicate of the private
 * `parsedNetworkName` in `../lib/localWallet.ts`, which cannot be imported
 * because it is not exported and this module must not widen that surface.
 */
function parsedNetworkName(value: string | typeof mainnet): string {
  return value === mainnet ? 'mainnet' : value;
}

/**
 * The 32 target bytes of a bech32m `mn_addr…` unshielded address — the
 * `UserAddress` `withdraw_night` sends to.
 *
 * `./midnames.ts` has a sibling of this that takes the open wallet, because a
 * name's owner is always this Passport. A withdrawal's recipient is not: it is
 * whatever address the user scanned or pasted. So this one takes the address
 * itself, and the decode is the same two-step the sibling performs.
 *
 * `expectedNetworkId`, when given, is enforced BEFORE the decode, and it is
 * enforced here because there is nowhere else left to enforce it: a preview
 * address and a preprod address are both well-formed and decode to 32 perfectly
 * good bytes, and paying one from an account on the other is a loss the chain
 * will not undo. {@link withdrawNight} always passes the wallet's own network.
 */
export function unshieldedAddressBytes(address: string, expectedNetworkId?: string): Uint8Array {
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(address.trim());
  } catch (cause) {
    throw new AccountCustodyError(
      'invalid-request',
      'That is not a Midnight address.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const addressNetwork = parsedNetworkName(parsed.network);
  if (expectedNetworkId !== undefined && addressNetwork !== expectedNetworkId) {
    throw new AccountCustodyError(
      'wrong-network',
      `That address belongs to the ${addressNetwork} network; this account is on ${expectedNetworkId}.`,
    );
  }
  let decoded: { data: ArrayLike<number> };
  try {
    decoded = parsed.decode(UnshieldedAddress, parsed.network);
  } catch (cause) {
    throw new AccountCustodyError(
      'invalid-request',
      'That is a Midnight address, but not an unshielded (mn_addr…) one.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const bytes = new Uint8Array(decoded.data);
  if (bytes.length !== 32) {
    throw new AccountCustodyError(
      'invalid-request',
      `Expected a 32-byte unshielded address, got ${bytes.length}.`,
    );
  }
  return bytes;
}

/**
 * The 32-byte Compact form of a Zswap coin public key, from the hex string the
 * wallet facade quotes (`state.shielded.coinPublicKey.toHexString()`, which is
 * what `walletProvider.getCoinPublicKey()` already returns).
 *
 * The encoding is the ledger's own, through the ledger's own encoder: the
 * prototype's Node helper truncates the hex to 32 bytes by hand, which happens
 * to agree today and would stop agreeing the moment the SDK prefixes the key.
 */
export function coinPublicKeyBytes(coinPublicKeyHex: string): Uint8Array {
  try {
    const bytes = encodeCoinPublicKey(coinPublicKeyHex.trim().replace(/^0x/, ''));
    if (bytes.length !== 32) {
      throw new Error(`encoded to ${bytes.length} bytes, expected 32`);
    }
    return bytes;
  } catch (cause) {
    throw new AccountCustodyError(
      'invalid-request',
      'That is not a Midnight shielded coin public key.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/** A shielded coin in the shape `deposit_shielded` takes it. */
export interface AccountShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

/**
 * Turns a coin the wallet holds into the `ShieldedCoinInfo` the contract takes.
 *
 * A shielded deposit is the one flow that cannot be described by a colour and
 * an amount alone: `receiveShielded` needs the coin's own NONCE, because it is
 * that exact note that moves into the contract. The wallet is the only place
 * that nonce exists — `facade.state().shielded.availableCoins[i].coin` is a
 * `QualifiedShieldedCoinInfo` (`{ type, nonce, value, mt_index }`) — and
 * `encodeShieldedCoinInfo` is the ledger's own translation of it into Compact's
 * `{ color, nonce, value }`. `experiments/account-custody-prototype/src/tests/
 * lifecycle-shielded.ts` builds the same argument by hand, because there the
 * nonce came from a mint the test itself performed.
 *
 * The `mt_index` of a qualified coin is deliberately dropped: the Merkle
 * position the CONTRACT will hold the coin at is allocated by
 * `receiveShielded` inside the deposit transaction, and is not the position the
 * wallet held it at.
 */
export function shieldedCoinFromWalletCoin(coin: {
  type: string;
  nonce: string;
  value: bigint;
}): AccountShieldedCoin {
  return encodeShieldedCoinInfo({ type: coin.type, nonce: coin.nonce, value: coin.value });
}

/**
 * A grant commitment, as the counterparty may hand it over: the `Field` the
 * contract stores, or the 32 bytes that Field is carried in.
 */
export type GrantCommitment = bigint | Uint8Array;

/**
 * Normalises a grant commitment to the `Field` (bigint) `add_grant` takes.
 *
 * Bytes are read big-endian, which is the order {@link formatFieldHex} writes
 * them back out in, so a commitment can round-trip through the UI unchanged.
 * The range check is the circuit's: a value at or above the Compact field
 * modulus is refused there, and papering over it here would only move the
 * failure somewhere less informative.
 */
export function grantCommitmentField(commitment: GrantCommitment): bigint {
  if (typeof commitment === 'bigint') {
    if (commitment < 0n) {
      throw new AccountCustodyError(
        'invalid-request',
        'A grant commitment is a field element, so it cannot be negative.',
      );
    }
    return commitment;
  }
  if (commitment.length === 0 || commitment.length > 32) {
    throw new AccountCustodyError(
      'invalid-request',
      `A grant commitment is at most 32 bytes, received ${commitment.length}.`,
    );
  }
  let field = 0n;
  for (const byte of commitment) field = (field << 8n) | BigInt(byte);
  return field;
}

/**
 * A `Field` as 64 lowercase hex characters, big-endian and zero-padded — the
 * form the grant table is keyed by in {@link AccountState}, and the form
 * {@link grantCommitmentField} reads back.
 */
export function formatFieldHex(field: bigint): string {
  return field.toString(16).padStart(FIELD_HEX_LENGTH, '0');
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The device secret this Passport's contract was deployed with.
 *
 * A thin wrapper over `derivePassportContractSecrets`, and deliberately not a
 * second derivation: the contract checks `derive_device_commitment(secret)`
 * against the commitment burned into its constructor, so any other derivation
 * produces an "unknown device" rejection rather than a different-but-valid
 * device. The recovery half is zeroed on the way out because no circuit reached
 * from this module needs it — see {@link accountPrivateState}.
 *
 * `rootSecret` is 32 bytes the caller obtained from the passkey with ONE
 * user-verified WebAuthn assertion. The caller owns those bytes and should zero
 * them afterwards; nothing here retains them.
 */
export async function deriveAccountDeviceSecret(rootSecret: Uint8Array): Promise<Uint8Array> {
  const { deviceSecret, recoverySecret } = await derivePassportContractSecrets(rootSecret);
  recoverySecret.fill(0);
  return deviceSecret;
}

export { derivePassportContractSecrets };

/* -------------------------------------------------------------------------- */
/* The generated account contract module                                      */
/* -------------------------------------------------------------------------- */

/**
 * The compiled account contract, staged from the stagenet build.
 *
 * THE SPECIFIER IS LOAD-BEARING, and both this module and
 * `./passportContract.ts` now reach it through the SAME one —
 * `loadContractModule('account')` in `./contractRuntime.ts`, which holds the
 * single literal `import()`. There are two installed copies of
 * `@midnight-ntwrk/compact-runtime` in this workspace (the ledger-9 one at the
 * root, and the ledger-8 0.16.0 the funder needs), and a module reached by a
 * DIFFERENT specifier can end up bound to the other copy. Even two copies of
 * the SAME version do not interoperate: a `ContractState` minted by one is
 * rejected by the other's `coerceToChargedState` with "has unexpected type"
 * (reproduced 2026/08/24). One literal specifier, in one place, is what keeps
 * ONE module record.
 */
async function loadAccountContract() {
  return loadContractModule('account') as Promise<
    typeof import('../../contracts/stagenet/account/index.js')
  >;
}

/**
 * The grant commitment for a secret, derived through the contract's OWN
 * exported pure circuit — so the client and the circuit can never disagree on
 * the Poseidon parameters or the domain-separation tag.
 *
 * `derive_grant_commitment` is present in the compiled module's `pureCircuits`
 * (checked against `contracts/managed/account/contract/index.d.ts`), so a
 * Passport that ISSUES a grant can compute the commitment itself. A Passport
 * that merely honours somebody else's grant still cannot: only the holder of
 * the grant secret can produce it, and {@link addGrantByCommitment} therefore
 * takes the commitment rather than the secret.
 */
export async function deriveGrantCommitment(grantSecret: Uint8Array): Promise<bigint> {
  const { pureCircuits } = await loadAccountContract();
  return pureCircuits.derive_grant_commitment(grantSecret);
}

/**
 * The device commitment for a secret, derived the same way — the value that has
 * to appear in {@link AccountState}'s ledger for a device to be able to spend.
 */
export async function deriveDeviceCommitment(deviceSecret: Uint8Array): Promise<bigint> {
  const { pureCircuits } = await loadAccountContract();
  return pureCircuits.derive_device_commitment(deviceSecret);
}

/* -------------------------------------------------------------------------- */
/* Errors, progress, results                                                  */
/* -------------------------------------------------------------------------- */

export type AccountCustodyErrorCode =
  /** The request could not be formed: a malformed colour, address, or amount. */
  | 'invalid-request'
  /** A recipient address that belongs to a different Midnight network. */
  | 'wrong-network'
  /** The indexer serves no state at that address — there is no contract there. */
  | 'contract-not-found'
  /** The indexer or the network could not be reached, so we do not know. */
  | 'network-unreachable'
  /** The CONTRACT holds less of that colour than the call would move. */
  | 'insufficient-balance'
  /** The calling WALLET holds less of that colour than the deposit would move. */
  | 'insufficient-funds'
  /**
   * The fee sponsor is not covering this call, so it was refused before
   * anything was built. There is no second payer to fall back to — see
   * {@link checkAccountCustodyFees}.
   */
  | 'fee-unavailable'
  /** The circuit ran and the network refused it, or proving failed. */
  | 'call-rejected';

export class AccountCustodyError extends Error {
  constructor(
    readonly code: AccountCustodyErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AccountCustodyError';
  }
}

export interface AccountCustodyProgress {
  /**
   * `checking` covers the refusals that can be made before the user waits on
   * anything — the contract's own balance and the fee question; `connecting` is
   * `findDeployedContract`, which re-verifies our build's verifier keys against
   * the deployed contract's; `submitting` is the real transaction — build,
   * prove, balance, sign, submit; `confirming` is the indexer mapping the
   * returned identifier to the hash an explorer resolves.
   */
  phase: 'checking' | 'connecting' | 'submitting' | 'confirming';
}

/**
 * Who paid the fee. Mirrors `PassportContractFeePayer`, including its one
 * value: a Passport's fees are covered by the fee sponsor and by nothing else,
 * and `contractRuntime`'s `balanceTx` refuses to build a transaction on any
 * other terms.
 */
export type AccountCustodyFeePayer = 'sponsored';

export interface AccountCustodyTxResult {
  /** Which circuit really ran, in the contract's own spelling. */
  circuit: string;
  /** The contract the call was made against, raw 64-hex. */
  contractAddress: string;
  /**
   * The transaction, resolved to the 32-byte ledger HASH that explorers take
   * where the indexer could answer, and left as the 33-byte identifier where it
   * could not. Never fabricated.
   */
  txId: string;
  /**
   * Whether {@link txId} is the resolved ledger hash. `false` means the
   * transaction is real and submitted but the indexer had not yet mapped it, so
   * a surface must render the id as text rather than as an explorer link — the
   * same rule `passportContractStore.txIdResolved` keeps.
   */
  txIdResolved: boolean;
  /** The network the wallet actually signed on. */
  network: string;
  /**
   * Which side really paid the fee, decided by what the sponsor did — not by
   * what it promised. `sponsored` only when a `/balance-only` response came
   * back and the transaction it returned is the one that was submitted.
   */
  feePaidBy: AccountCustodyFeePayer;
  submittedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Ledger reads                                                               */
/* -------------------------------------------------------------------------- */

/** Enough of a network config to reach an indexer. `wallet.network` satisfies it. */
export interface AccountNetwork {
  readonly indexerHttpUrl: string;
  /** Derived from {@link indexerHttpUrl} when absent, as `localWallet.ts` derives it. */
  readonly indexerWsUrl?: string;
}

/** One row of the contract's grant table, decoded. */
export interface AccountGrant {
  /** The grant commitment as the contract keys it — the `Field` itself. */
  commitment: bigint;
  /** The same value as 64 hex characters, for display and for map keys. */
  commitmentHex: string;
  /** The colour this grant is scoped to. */
  colourHex: string;
  /** The cumulative value ceiling, in atomic units of {@link colourHex}. */
  cap: bigint;
  /** How much of {@link cap} has already been spent through this grant. */
  spent: bigint;
  /**
   * The contract's own `active` flag — what `revoke_grant` clears. It is NOT
   * the whole liveness question: a grant is spendable only if it is also of the
   * CURRENT device epoch, so compare {@link epoch} against
   * {@link AccountState.deviceEpoch}. Reporting `active` alone would show a
   * grant that `recover()` has already invalidated as live.
   */
  active: boolean;
  /** The device epoch this grant was issued in. */
  epoch: number;
}

export interface AccountState {
  /** Contract-held NIGHT (and other unshielded colours), by colour. */
  nightBalances: Map<string, bigint>;
  /** Contract-held shielded value, by colour. */
  shieldedCoins: Map<string, bigint>;
  /** Devices registered in the current epoch. */
  deviceCount: number;
  /** The grant table, in the contract's iteration order. */
  grants: AccountGrant[];
  /** The current device epoch. Every device and grant of an older one is dead. */
  deviceEpoch: number;
  /** The replay counter every authorised circuit bumps. */
  round: bigint;
  /**
   * The device commitments registered in the CURRENT epoch — the devices that
   * can authorise a circuit today. A commitment from an older epoch is still
   * in the contract's map (Compact maps cannot be cleared in-circuit) but is
   * dead, and is not in this set.
   */
  activeDeviceCommitments: Set<bigint>;
}

/**
 * Reads one deployed account contract's public state through the indexer and
 * decodes it with the compiled module's own `ledger()`.
 *
 * This is what Home's balances are: the contract's `night_balances` mirror and
 * its `coins` map, not the wallet's. A read that could not be made throws —
 * `contract-not-found` when the indexer answered and had nothing at that
 * address, `network-unreachable` when it could not be asked — because an empty
 * balance map and a failed read look identical to a UI that is handed `{}`, and
 * only one of them means "this account holds nothing".
 *
 * Deliberately uncached. Every call is one indexer query, and the caller owns
 * how often it asks; a cache here would let a stale balance survive a
 * withdrawal the same session just made.
 *
 * NOTE — the `night_balances` mirror is the contract's own bookkeeping, and the
 * contract header is explicit that NIGHT sent to the contract by any route
 * other than `deposit_night` is invisible to it. So this reports what the
 * contract believes it holds, which is what its withdrawals are checked
 * against. Funds swept in must go through {@link depositNight} to be spendable.
 */
export async function readAccountState(
  network: AccountNetwork,
  contractAddress: string,
): Promise<AccountState> {
  const address = rawContractAddress(contractAddress);
  const [{ indexerPublicDataProvider }, { ledger }] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    loadAccountContract(),
  ]);

  let state: unknown;
  try {
    const provider = indexerPublicDataProvider({
      queryURL: network.indexerHttpUrl,
      subscriptionURL: network.indexerWsUrl ?? indexerWsFrom(network.indexerHttpUrl),
    });
    state = await provider.queryContractState(address);
  } catch (cause) {
    throw new AccountCustodyError(
      'network-unreachable',
      'The indexer could not be reached, so this account’s balances are unknown.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!state) {
    throw new AccountCustodyError(
      'contract-not-found',
      `The indexer serves no contract state at ${address.slice(0, 10)}….`,
    );
  }

  /* The decode and the PROJECTION are one try block, not two. `ledger()`
     builds an accessor lazily, so a state that is not an account contract does
     not fail here — it fails on the first field {@link decodeAccountState}
     reads, as a raw `TypeError: Cannot read properties of undefined (reading
     'keys')`. That escaped `readAccountState`'s taxonomy entirely and reached
     a user, on Home's balances card, in those words (2026/08/30). */
  try {
    return decodeAccountState(ledger((state as { data: unknown }).data as never));
  } catch (cause) {
    if (cause instanceof AccountCustodyError) throw cause;
    throw new AccountCustodyError(
      'contract-not-found',
      'The state at that address is not a Passport account-custody contract.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Projects a decoded contract ledger onto the shape the surfaces read.
 *
 * Split out from {@link readAccountState} because this half — which ledger map
 * feeds which balance, and how a `Field` key becomes a string — is the half
 * that can silently be wrong, and it is the only half testable without a
 * network. `src/identity/accountCustody.test.ts` runs it against a ledger built
 * by executing the real contract's constructor and circuits.
 */
export function decodeAccountState(decoded: AccountLedger): AccountState {
  try {
    return projectAccountState(decoded);
  } catch (cause) {
    /* A ledger accessor built over state that is not an account contract does
       not fail when it is built — it fails when a field is read, and it fails
       as a `TypeError` about a property nobody has heard of. Reported as what
       it means instead: the address does not hold one of our accounts. */
    throw new AccountCustodyError(
      'contract-not-found',
      'The state at that address is not a Passport account-custody contract.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function projectAccountState(decoded: AccountLedger): AccountState {
  const nightBalances = new Map<string, bigint>();
  for (const [colour, amount] of decoded.night_balances) {
    nightBalances.set(bytesToHex(colour), amount);
  }
  const shieldedCoins = new Map<string, bigint>();
  for (const [colour, coin] of decoded.coins) {
    shieldedCoins.set(bytesToHex(colour), coin.value);
  }
  const grants: AccountGrant[] = [];
  for (const [commitment, info] of decoded.grants) {
    grants.push({
      commitment,
      commitmentHex: formatFieldHex(commitment),
      colourHex: bytesToHex(info.color),
      cap: info.cap,
      spent: info.spent,
      active: info.active,
      epoch: Number(info.epoch),
    });
  }

  const activeDeviceCommitments = new Set<bigint>();
  for (const [commitment, epoch] of decoded.devices) {
    if (epoch === decoded.device_epoch) activeDeviceCommitments.add(commitment);
  }

  return {
    nightBalances,
    shieldedCoins,
    deviceCount: Number(decoded.device_count),
    grants,
    deviceEpoch: Number(decoded.device_epoch),
    round: decoded.round,
    activeDeviceCommitments,
  };
}

/**
 * Whether the account contract at `address` holds THIS device — the one whose
 * secret is given — as an active device.
 *
 * This is what ownership of an account means in the contract's own terms: a
 * device that can authorise its circuits. It is the one proof a restored
 * contract record can offer. A backup file can name any address; a real
 * contract at that address exists whether or not it is ours; a transaction id
 * proves a deployment happened, not who holds it. Only the device set inside
 * the contract answers "can this Passport spend from it", and it answers on
 * chain, for the current epoch, with nothing taken from the file.
 *
 * `false` for a contract that does not hold the device; throws for a read
 * that could not be made, because "not ours" and "could not ask" must never
 * look alike to the caller deciding whether to trust an address.
 */
export async function accountHoldsDevice(
  network: AccountNetwork,
  address: string,
  deviceSecret: Uint8Array,
): Promise<boolean> {
  const [state, commitment] = await Promise.all([
    readAccountState(network, address),
    deriveDeviceCommitment(deviceSecret),
  ]);
  return state.activeDeviceCommitments.has(commitment);
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

interface WalletFacadeState {
  shielded: {
    coinPublicKey: { toHexString(): string };
    encryptionPublicKey: { toHexString(): string };
  };
  unshielded: { balances: Record<string, bigint> };
  dust: { balance(now: Date): bigint };
}

async function currentWalletState(wallet: LocalMidnightWallet): Promise<WalletFacadeState> {
  const state = await Rx.firstValueFrom(
    (wallet.facade.state() as Rx.Observable<unknown>).pipe(
      Rx.timeout({ first: STATE_TIMEOUT_MS }),
    ),
  );
  return state as WalletFacadeState;
}

/**
 * Providers for the account-custody circuits.
 *
 * All of it — the sponsored wallet provider, the ZK config provider, the
 * indexer, and where a circuit actually gets proved — is
 * `./contractRuntime.ts`'s, shared with `./passportContract.ts` and
 * `./midnames.ts`. Three copies of the same provider set is how they drifted
 * before; the behaviour is unchanged.
 *
 * The NIGHT or shielded value a circuit itself moves is untouched by
 * sponsorship: only the fee input changes hands, and it never comes from this
 * wallet.
 */
async function createAccountProviders(
  wallet: LocalMidnightWallet,
  privateStateId: string,
  initialPrivateState: unknown,
) {
  return createContractProviders(wallet, {
    contract: 'account',
    privateStateId,
    initialPrivateState,
  });
}

async function compiledAccountContract(witnesses: unknown) {
  return compiledContractFor('account', 'passport-account', witnesses);
}

/* -------------------------------------------------------------------------- */
/* Transaction-id resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Swaps a 33-byte transaction identifier for the 32-byte ledger HASH explorers
 * resolve, through `./passportContract.ts`'s exported single-shot lookup. The
 * loop around it is that module's own private `resolveTransactionHash`,
 * duplicated here rather than exported from there so this module's retry
 * budget is visible where its calls are.
 *
 * The transaction is already finalised when this runs, so the retries only
 * cover indexer lag. Where every attempt fails the identifier is returned
 * unchanged and `resolved` is false — the caller records that it is
 * UNRESOLVED rather than linking it.
 */
async function resolveTransactionHash(
  indexerHttpUrl: string,
  identifier: string,
): Promise<{ txId: string; resolved: boolean }> {
  for (let attempt = 0; attempt < TX_HASH_ATTEMPTS; attempt += 1) {
    const hash = await resolveDeployTxHashOnce(indexerHttpUrl, identifier);
    if (hash) return { txId: hash, resolved: true };
    await wait(TX_HASH_INTERVAL_MS);
  }
  return { txId: identifier, resolved: false };
}

/* -------------------------------------------------------------------------- */
/* Fees                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Re-checks, WITHOUT any passkey prompt, whether an account-custody call's fee
 * can be covered right now.
 *
 * The same rule both siblings keep, and it is a question about the SPONSOR
 * alone: a Passport holder has one fee payer and it is never themselves, so no
 * balance is read and no refusal here names a token. Exposed so a surface can
 * fail closed with the honest reason before asking the user to touch their
 * authenticator.
 */
export async function checkAccountCustodyFees(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const readiness = await sponsorReadiness();
  if (readiness.state === 'ready') return { ok: true };
  return { ok: false, reason: sponsorFeeRefusal(readiness) };
}

/* -------------------------------------------------------------------------- */
/* The call path                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The circuit surface `findDeployedContract` hands back, read the way
 * `./midnames.ts` reads the TLD's: by name, because the circuit is chosen at
 * the call site rather than at compile time.
 */
type AccountCallTx = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Connects to the deployed contract and runs one circuit against it.
 *
 * The private-state id is fresh per call, which is `PassportAccount.connect`'s
 * own rule and its own reason: the secrets this call was handed must win over
 * anything a previous connection left behind, and a shared id would let a
 * stale private state decide who signed.
 *
 * `findDeployedContract` is not a formality — it re-reads the deployed
 * contract's verifier keys and refuses our compiled build if they differ, which
 * is the check that turns an artefact-drift bug into a `call-rejected` with the
 * mismatch attached instead of a proof nobody can verify.
 */
async function callAccountCircuit(
  wallet: LocalMidnightWallet,
  options: {
    contractAddress: string;
    circuit: string;
    args: readonly unknown[];
    secrets: { deviceSecret?: Uint8Array; grantSecret?: Uint8Array };
    /**
     * Coin-pk-hex → encryption-pk-hex, required by midnight-js to build a
     * shielded output's note ciphertext for a third-party recipient. Presence
     * switches the call onto `withContractScopedTransaction`, the only form
     * that carries the mapping to the output builder.
     */
    coinEncPublicKeyMappings?: ReadonlyMap<string, string>;
  },
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  const address = rawContractAddress(options.contractAddress);
  const nonce = new Uint8Array(8);
  globalThis.crypto.getRandomValues(nonce);
  const privateStateId = `passport-account-${address.slice(0, 8)}-${bytesToHex(nonce)}`;

  onPhase?.({ phase: 'connecting' });
  /* The witness factory and private-state builder from `./passportContract.ts`
     — the module that DEPLOYED this contract, so the two cannot disagree about
     what the private state looks like. They used to be imported from
     `experiments/account-custody-prototype/src/wallet/witnesses.js`, which
     binds that tree's own ledger-8 midnight-js and compact-runtime; the
     behaviour is unchanged, the resolution is not.

     `accountWitnesses()` THROWS when a requested secret is absent ("witness …
     requested but the secret is not in the private state") rather than
     substituting zeros, which is exactly the behaviour this module wants.

     The RECOVERY secret is deliberately absent from every call reached from
     here. `recover()` is the only circuit that asks for it, no export in this
     module reaches that circuit, and a demo flow that carried total-loss
     authority into a routine withdrawal would be holding it in memory for no
     reason. If `recover()` is ever wired up it must build its own private
     state, with the recovery secret re-derived from the passkey at that moment.

     The GRANT secret is carried when the caller has one, so the grant-authorised
     circuits (`grant_withdraw_night` / `grant_withdraw_shielded`) can be reached
     through this same plumbing later without changing it. */
  const initialPrivateState = accountPrivateStateFrom(options.secrets);
  const [providers, compiledContract, { findDeployedContract }] = await Promise.all([
    createAccountProviders(wallet, privateStateId, initialPrivateState),
    compiledAccountContract(accountWitnesses()),
    import('@midnight-ntwrk/midnight-js-contracts'),
  ]);

  /* Two try blocks, not one, because the two failures are different things to
     say: nothing has been submitted when the CONNECT fails, and something may
     have been proved and refused when the CALL fails. A single catch would
     report "the contract rejected withdraw_night" for a contract that was
     never reached. */
  let callTx: AccountCallTx;
  try {
    const deployed = await findDeployedContract(providers as never, {
      compiledContract,
      contractAddress: address,
      privateStateId,
      initialPrivateState,
    } as never);
    callTx = (deployed as { callTx: AccountCallTx }).callTx;
  } catch (cause) {
    throw new AccountCustodyError(
      'call-rejected',
      `The account contract at ${address.slice(0, 10)}… could not be opened, so nothing was submitted.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  onPhase?.({ phase: 'submitting' });
  let identifier: string;
  try {
    if (options.coinEncPublicKeyMappings) {
      /* The scoped form is the only one that carries the coin-pk → enc-pk
         mapping down to the output builder; without it midnight-js refuses a
         third-party shielded output at construction time ("Provide a mapping
         via the encryptionPublicKeyResolver", hit live 2026/08/24). */
      const { withContractScopedTransaction } = await import(
        '@midnight-ntwrk/midnight-js-contracts'
      );
      const finalized = (await (withContractScopedTransaction as (
        providers: unknown,
        fn: (txCtx: unknown) => Promise<void>,
        scopeOptions?: unknown,
      ) => Promise<unknown>)(
        providers,
        async (txCtx: unknown) => {
          await (callTx[options.circuit] as (...a: unknown[]) => Promise<unknown>)(
            txCtx,
            ...options.args,
          );
        },
        {
          scopeName: `passport-${options.circuit}`,
          additionalCoinEncPublicKeyMappings: new Map(options.coinEncPublicKeyMappings),
        },
      )) as { public?: { txId?: unknown; transactionHash?: unknown } };
      identifier = transactionId(finalized);
    } else {
      identifier = transactionId(await callTx[options.circuit](...options.args));
    }
  } catch (cause) {
    throw new AccountCustodyError(
      'call-rejected',
      `The account contract rejected ${options.circuit}.`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  onPhase?.({ phase: 'confirming' });
  const { txId, resolved } = await resolveTransactionHash(
    wallet.network.indexerHttpUrl,
    identifier,
  );
  return {
    circuit: options.circuit,
    contractAddress: address,
    txId,
    txIdResolved: resolved,
    network: wallet.network.networkId,
    /* Constant because there is one fee payer, and true because `balanceTx`
       refused to produce this transaction any other way. */
    feePaidBy: 'sponsored',
    submittedAt: new Date().toISOString(),
  };
}

/** Refuses a non-positive or non-integral amount before anything else happens. */
function requirePositiveAmount(amount: bigint, what: string): void {
  if (typeof amount !== 'bigint') {
    throw new AccountCustodyError('invalid-request', `${what} must be an amount in atomic units.`);
  }
  if (amount <= 0n) {
    throw new AccountCustodyError('invalid-request', `${what} must be greater than zero.`);
  }
}

/**
 * The fee gate every write shares, run before the user waits on a prover.
 * Throws `fee-unavailable` with the sponsor's own reason rather than letting
 * the SDK's funds error surface halfway through a proof.
 */
async function requireFees(): Promise<void> {
  const fees = await checkAccountCustodyFees();
  if (!fees.ok) throw new AccountCustodyError('fee-unavailable', fees.reason);
}

/* -------------------------------------------------------------------------- */
/* Withdrawals — device-authorised                                            */
/* -------------------------------------------------------------------------- */

export interface WithdrawNightRequest {
  /** The account-custody contract to withdraw from. */
  contractAddress: string;
  /** The colour to move, as a 64-character raw token type. */
  colourHex: string;
  /** Atomic units of {@link colourHex}. */
  amount: bigint;
  /** A bech32m `mn_addr…` unshielded address. */
  recipientAddress: string;
}

/**
 * Moves unshielded value out of the account contract to a `mn_addr…` address.
 *
 * `withdraw_night` is device-authorised: the circuit derives
 * `derive_device_commitment(device_secret())` and asserts the contract knows
 * that commitment IN THE CURRENT EPOCH. So `deviceSecret` must be the one this
 * Passport's contract was deployed with — {@link deriveAccountDeviceSecret}
 * produces it from the passkey root secret, and nothing else will pass.
 *
 * The contract's own balance is checked first, because `debit_night` asserts
 * `balance >= amount` inside the circuit and a user should be told they are
 * short before they wait for a proof, not after. The check is a real read of
 * ledger state, not a cached number.
 *
 * `deviceSecret` belongs to the caller; it is copied into session-lifetime
 * private state for the duration of the call and is not zeroed here.
 */
export async function withdrawNight(
  handle: LocalMidnightWallet,
  deviceSecret: Uint8Array,
  request: WithdrawNightRequest,
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  onPhase?.({ phase: 'checking' });
  const colour = colourHexToBytes(request.colourHex);
  const recipient = unshieldedAddressBytes(request.recipientAddress, handle.network.networkId);
  requirePositiveAmount(request.amount, 'A withdrawal');
  await requireFees();

  const state = await readAccountState(handle.network, request.contractAddress);
  const held = state.nightBalances.get(bytesToHex(colour)) ?? 0n;
  if (held < request.amount) {
    throw new AccountCustodyError(
      'insufficient-balance',
      `This account holds ${held} of that colour, and the withdrawal would move ${request.amount}.`,
    );
  }

  return callAccountCircuit(
    handle,
    {
      contractAddress: request.contractAddress,
      circuit: 'withdraw_night',
      args: [colour, request.amount, { bytes: recipient }],
      secrets: { deviceSecret },
    },
    onPhase,
  );
}

export interface WithdrawShieldedRequest {
  contractAddress: string;
  colourHex: string;
  amount: bigint;
  /**
   * The recipient's full `mn_shield-addr…` string — the WHOLE address, not
   * just the coin public key it contains. The circuit itself takes only the
   * coin key, but midnight-js builds the note's ciphertext client-side and
   * refuses at construction time without the recipient's ENCRYPTION key
   * ("Provide a mapping via the encryptionPublicKeyResolver" — hit live,
   * preview 2026/08/24). Both keys travel inside the bech32m address and
   * cannot be derived from one another, so the honest API takes the address
   * and refuses anything less.
   */
  recipientShieldedAddress: string;
}

/**
 * Moves shielded value out of the account contract to a shielded address.
 *
 * Device-authorised, exactly as {@link withdrawNight} is. The contract holds at
 * most one qualified coin per colour, so a partial withdrawal takes the change
 * path — `sendShielded` splits, `sendImmediateShielded` returns the change to
 * the contract, and `insertCoin` re-registers it — and a full one removes the
 * entry. Both are the circuit's business; what this function owes the caller is
 * a refusal, before proving, when the contract does not hold that much.
 */
export async function withdrawShielded(
  handle: LocalMidnightWallet,
  deviceSecret: Uint8Array,
  request: WithdrawShieldedRequest,
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  onPhase?.({ phase: 'checking' });
  const colour = colourHexToBytes(request.colourHex);
  requirePositiveAmount(request.amount, 'A withdrawal');
  const recipient = await decodeShieldedRecipient(
    request.recipientShieldedAddress,
    handle.network.networkId,
  );
  await requireFees();

  const state = await readAccountState(handle.network, request.contractAddress);
  const held = state.shieldedCoins.get(bytesToHex(colour)) ?? 0n;
  if (held < request.amount) {
    throw new AccountCustodyError(
      'insufficient-balance',
      `This account holds ${held} shielded of that colour, and the withdrawal would move ${request.amount}.`,
    );
  }

  return callAccountCircuit(
    handle,
    {
      contractAddress: request.contractAddress,
      circuit: 'withdraw_shielded',
      args: [{ bytes: recipient.coinPublicKey }, colour, request.amount],
      secrets: { deviceSecret },
      /* The coin-pk → encryption-pk mapping that lets midnight-js build the
         recipient's note ciphertext — see {@link WithdrawShieldedRequest}. */
      coinEncPublicKeyMappings: new Map([
        [bytesToHex(recipient.coinPublicKey), bytesToHex(recipient.encryptionPublicKey)],
      ]),
    },
    onPhase,
  );
}

/**
 * Decodes an `mn_shield-addr…` into its two keys, refusing wrong networks the
 * same way {@link unshieldedAddressBytes} does — a shielded withdrawal to an
 * address from another network would be unrecoverable.
 */
async function decodeShieldedRecipient(
  address: string,
  networkId: string,
): Promise<{ coinPublicKey: Uint8Array; encryptionPublicKey: Uint8Array }> {
  const { MidnightBech32m, ShieldedAddress } = await import(
    '@midnight-ntwrk/wallet-sdk/address-format'
  );
  let parsed;
  try {
    parsed = MidnightBech32m.parse(address.trim());
  } catch (cause) {
    throw new AccountCustodyError(
      'invalid-request',
      'That is not a Midnight address.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const recipientNetwork = parsedNetworkName(parsed.network);
  if (recipientNetwork !== networkId) {
    throw new AccountCustodyError(
      'wrong-network',
      `That address belongs to the ${recipientNetwork} network; this account is on ${networkId}.`,
    );
  }
  let decoded;
  try {
    decoded = parsed.decode(ShieldedAddress, networkId) as {
      coinPublicKey: { data: ArrayLike<number> };
      encryptionPublicKey: { data: ArrayLike<number> };
    };
  } catch (cause) {
    throw new AccountCustodyError(
      'invalid-request',
      'That is a Midnight address, but not a shielded (mn_shield-addr…) one.',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return {
    coinPublicKey: new Uint8Array(decoded.coinPublicKey.data),
    encryptionPublicKey: new Uint8Array(decoded.encryptionPublicKey.data),
  };
}

/* -------------------------------------------------------------------------- */
/* Deposits — permissionless                                                  */
/* -------------------------------------------------------------------------- */

export interface DepositNightRequest {
  contractAddress: string;
  colourHex: string;
  amount: bigint;
}

/**
 * Funds the account contract with unshielded value from the CALLING wallet.
 *
 * `deposit_night` is permissionless — anyone may fund an account — so no device
 * secret is involved and none is passed. What makes the money move is the
 * balancing: `receiveUnshielded` leaves the transaction short by `amount` of
 * `colour`, and the wallet provider covers it from this wallet's own funds when
 * it balances. That is why this is the sweep-in path for a Passport whose NIGHT
 * arrived at its wallet address (a faucet drip, a transfer made before the
 * account contract existed) and now has to live in the account.
 *
 * The wallet's own holding is checked first, for the same reason the withdrawal
 * checks the contract's: the failure would otherwise arrive as an SDK balancing
 * error after a proof.
 */
export async function depositNight(
  handle: LocalMidnightWallet,
  request: DepositNightRequest,
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  onPhase?.({ phase: 'checking' });
  const colour = colourHexToBytes(request.colourHex);
  requirePositiveAmount(request.amount, 'A deposit');
  await requireFees();

  const walletState = await currentWalletState(handle);
  const held = walletState.unshielded.balances[bytesToHex(colour)] ?? 0n;
  if (held < request.amount) {
    throw new AccountCustodyError(
      'insufficient-funds',
      `This wallet holds ${held} of that colour, and the deposit would move ${request.amount}.`,
    );
  }

  return callAccountCircuit(
    handle,
    {
      contractAddress: request.contractAddress,
      circuit: 'deposit_night',
      args: [colour, request.amount],
      secrets: {},
    },
    onPhase,
  );
}

export interface DepositShieldedRequest {
  contractAddress: string;
  /**
   * The exact note to move in, nonce and all. Built from a coin the wallet
   * holds with {@link shieldedCoinFromWalletCoin} — a colour and an amount are
   * not enough, because `receiveShielded` consumes that specific coin.
   */
  coin: AccountShieldedCoin;
}

/**
 * Moves one shielded note the calling wallet holds into the account contract.
 *
 * Permissionless, like {@link depositNight}. The contract merges the note into
 * whatever it already holds of that colour (`mergeCoinImmediate`) or registers
 * it fresh, and `receiveShielded` allocates the Merkle position inside this
 * transaction — which is why the coin's own `mt_index` from the wallet is
 * neither passed nor useful (see {@link shieldedCoinFromWalletCoin}).
 *
 * No contract-side balance check is possible or needed here: the constraint is
 * that the wallet really holds the note, and the wallet is the one that said so.
 */
export async function depositShielded(
  handle: LocalMidnightWallet,
  request: DepositShieldedRequest,
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  onPhase?.({ phase: 'checking' });
  const { coin } = request;
  if (coin.nonce.length !== 32) {
    throw new AccountCustodyError(
      'invalid-request',
      `A shielded coin nonce is 32 bytes, received ${coin.nonce.length}.`,
    );
  }
  if (coin.color.length !== 32) {
    throw new AccountCustodyError(
      'invalid-request',
      `A shielded coin colour is 32 bytes, received ${coin.color.length}.`,
    );
  }
  requirePositiveAmount(coin.value, 'A deposit');
  await requireFees();

  return callAccountCircuit(
    handle,
    {
      contractAddress: request.contractAddress,
      circuit: 'deposit_shielded',
      args: [{ nonce: coin.nonce, color: coin.color, value: coin.value }],
      secrets: {},
    },
    onPhase,
  );
}

/* -------------------------------------------------------------------------- */
/* Grants                                                                     */
/* -------------------------------------------------------------------------- */

export interface AddGrantRequest {
  contractAddress: string;
  /**
   * The grant commitment, from the counterparty. Their secret is theirs; only
   * the commitment crosses, which is the whole point of the scheme — see
   * {@link deriveGrantCommitment} for the case where THIS Passport holds the
   * secret and can derive it itself.
   */
  grantCommitment: GrantCommitment;
  /** The single colour this grant may spend. */
  colourHex: string;
  /** The cumulative ceiling, in atomic units of {@link colourHex}. */
  cap: bigint;
}

/**
 * Registers a spending grant against this account — the confirmation half of a
 * Midnight City-style flow, where a counterparty asks for a bounded allowance
 * and the Passport holder grants it.
 *
 * Device-authorised: `add_grant` calls `require_device()` first, so this is the
 * account owner's decision and nobody else's. The grant is scoped exactly three
 * ways, all enforced in `require_grant` at spend time: one colour, a cumulative
 * value cap, and the current device epoch — a `recover()` invalidates every
 * outstanding grant along with every device.
 *
 * Re-granting an ALREADY ACTIVE commitment in the same epoch is refused by the
 * circuit ("grant already active"), which surfaces here as `call-rejected` with
 * that message. That is deliberate: raising a cap is a revoke-then-grant, not a
 * silent overwrite.
 */
export async function addGrantByCommitment(
  handle: LocalMidnightWallet,
  deviceSecret: Uint8Array,
  request: AddGrantRequest,
  onPhase?: (progress: AccountCustodyProgress) => void,
): Promise<AccountCustodyTxResult> {
  onPhase?.({ phase: 'checking' });
  const colour = colourHexToBytes(request.colourHex);
  const commitment = grantCommitmentField(request.grantCommitment);
  requirePositiveAmount(request.cap, 'A grant cap');
  await requireFees();

  return callAccountCircuit(
    handle,
    {
      contractAddress: request.contractAddress,
      circuit: 'add_grant',
      args: [commitment, colour, request.cap],
      secrets: { deviceSecret },
    },
    onPhase,
  );
}

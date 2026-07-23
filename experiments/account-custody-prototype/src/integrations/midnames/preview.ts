import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { nativeToken } from '@midnight-ntwrk/ledger-v8';

import {
  PassportAccount,
  type ShieldedCoin,
  type TxResult,
} from '../../wallet/account.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const MIDNAMES_CONTRACT_ENTRY = resolve(
  PROJECT_ROOT,
  'contracts',
  'managed',
  'midnames',
  'contract',
  'index.js',
);
const MIDNAMES_MANAGED_PATH = resolve(
  PROJECT_ROOT,
  'contracts',
  'managed',
  'midnames',
);

const EMPTY_BYTES = new Uint8Array(32);
const TLD = 'night';
const DEFAULT_PRIVATE_STATE_ID = 'passport-midnames-owner';

interface MidnamesModules {
  contract: any;
}

export interface MidnamesDeployment {
  address: string;
  txId: string;
  handle: any;
}

export interface PassportAliasClaim {
  alias: string;
  domain: string;
  tldAddress: string;
  resolverAddress: string;
  passportAddress: string;
  resolverDeployTxId: string;
  registerTxId: string;
}

export interface ResolvedPassportAlias {
  alias: string;
  domain: string;
  resolverAddress: string;
  type: 'contract';
  address: string;
}

export interface AliasShieldedDeposit {
  resolved: ResolvedPassportAlias;
  deposit: TxResult;
}

let modulesPromise: Promise<MidnamesModules> | undefined;

const midnamesWitnesses = {
  secretKey: ({ privateState }: { privateState: { secretKey: string } }) => [
    privateState,
    new Uint8Array(Buffer.from(privateState.secretKey, 'hex')),
  ],
};

function domainToKey(name: string): { key: Uint8Array; len: bigint } {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(`Domain name must be 1-32 bytes, got ${bytes.length}.`);
  }
  const key = new Uint8Array(32).fill(255);
  key.set(bytes);
  return { key, len: BigInt(bytes.length) };
}

function assertPreviewReady(): void {
  if (!existsSync(MIDNAMES_CONTRACT_ENTRY)) {
    throw new Error(
      'Midnames preview is not built. Run `npm run midnames:prepare` from the prototype directory.',
    );
  }
}

async function loadMidnames(): Promise<MidnamesModules> {
  assertPreviewReady();
  modulesPromise ??= import(pathToFileURL(MIDNAMES_CONTRACT_ENTRY).href).then(
    (contract) => ({ contract }),
  );
  return modulesPromise;
}

export function midnamesZkConfigPath(): string {
  assertPreviewReady();
  return MIDNAMES_MANAGED_PATH;
}

export function normalizePassportAlias(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  const alias = normalized.endsWith(`.${TLD}`)
    ? normalized.slice(0, -(TLD.length + 1))
    : normalized;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(alias)) {
    throw new Error('Alias must be 1-32 lowercase letters, numbers, or interior hyphens.');
  }
  return alias;
}

export function rawContractAddress(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Midnight contract address: ${value}`);
  }
  return normalized;
}

export function contractAddressBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(rawContractAddress(value), 'hex'));
}

export function deriveMidnamesOwnerKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) {
    throw new Error(`Midnames owner secret must be 32 bytes, received ${secret.length}.`);
  }
  const tag = new Uint8Array(32);
  tag.set(new TextEncoder().encode('midnight.domains'));
  const payload = new Uint8Array(64);
  payload.set(tag);
  payload.set(secret, 32);
  return new Uint8Array(createHash('sha256').update(payload).digest());
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function txId(result: any): string {
  const value = result?.public?.txId ?? result?.public?.transactionHash;
  if (!value) throw new Error('Midnames contract call returned without a transaction id.');
  return String(value);
}

function maybeBytes(value?: Uint8Array): { is_some: boolean; value: Uint8Array } {
  return value
    ? { is_some: true, value }
    : { is_some: false, value: new Uint8Array(32) };
}

function maybeString(value?: string): { is_some: boolean; value: string } {
  return value ? { is_some: true, value } : { is_some: false, value: '' };
}

function buildKvs(fields: Array<[string, string]> = []) {
  return Array.from({ length: 10 }, (_, index) => ({
    is_some: index < fields.length,
    value: index < fields.length ? fields[index] : ['', ''],
  }));
}

function unshieldedAddressBytes(walletCtx: any): Uint8Array {
  const address: any = walletCtx.unshieldedKeystore.getAddress();
  const candidate = address?.raw ?? address?.data ?? address?.bytes;
  if (candidate instanceof Uint8Array || Buffer.isBuffer(candidate)) {
    const bytes = new Uint8Array(candidate);
    if (bytes.length < 32) throw new Error('Unshielded address is shorter than 32 bytes.');
    return bytes.subarray(bytes.length - 32);
  }

  const text = String(address).replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return new Uint8Array(Buffer.from(text, 'hex'));
  }
  throw new Error('Unable to extract the 32-byte unshielded address from the wallet.');
}

function nativeColor(): Uint8Array {
  return new Uint8Array(Buffer.from(nativeToken().raw.toString().replace(/^0x/, ''), 'hex'));
}

async function deployLeaf(
  providers: any,
  walletCtx: any,
  options: {
    secret: Uint8Array;
    ownerKey: Uint8Array;
    parentDomain?: string;
    parentResolver?: string;
    domain: string;
    targetAddress: string;
    targetType: number;
    privateStateId?: string;
  },
): Promise<MidnamesDeployment> {
  const { contract } = await loadMidnames();
  const compiledContract = CompiledContract.make(
    'passport-midnames-leaf',
    contract.Contract,
  ).pipe(
    CompiledContract.withWitnesses(midnamesWitnesses as any),
    CompiledContract.withCompiledFileAssets(MIDNAMES_MANAGED_PATH),
  );
  const domainKey = domainToKey(options.domain).key;
  const parentKey = options.parentDomain
    ? domainToKey(options.parentDomain).key
    : undefined;
  const deployed = await deployContract(providers, {
    compiledContract,
    privateStateId: options.privateStateId ?? DEFAULT_PRIVATE_STATE_ID,
    initialPrivateState: { secretKey: bytesToHex(options.secret) },
    args: [
      maybeBytes(parentKey),
      { bytes: options.parentResolver ? contractAddressBytes(options.parentResolver) : EMPTY_BYTES },
      [contractAddressBytes(options.targetAddress), options.targetType],
      maybeBytes(domainKey),
      nativeColor(),
      0n,
      0n,
      0n,
      maybeString(),
      false,
      options.ownerKey,
      { bytes: unshieldedAddressBytes(walletCtx) },
      buildKvs(),
    ],
  } as any);

  return {
    address: rawContractAddress(deployed.deployTxData.public.contractAddress),
    txId: txId(deployed.deployTxData),
    handle: deployed,
  };
}

/**
 * Resolves a .night name through Midnames and uses its contract target as the
 * destination of the permissionless AAC shielded-deposit circuit.
 */
export async function depositShieldedByAlias(
  depositorProviders: any,
  compiledAccountContract: any,
  tldAddress: string,
  domain: string,
  coin: ShieldedCoin,
): Promise<AliasShieldedDeposit> {
  const resolved = await resolvePassportAlias(
    depositorProviders.publicDataProvider,
    tldAddress,
    domain,
  );
  if (resolved.type !== 'contract') {
    throw new Error(`Midnames domain ${domain} does not target a contract.`);
  }

  const account = await PassportAccount.connect(
    depositorProviders,
    compiledAccountContract,
    resolved.address,
    {},
    `passport-alias-deposit-${resolved.alias}`,
  );
  const deposit = await account.depositShielded(coin);
  return { resolved, deposit };
}

export async function deployMidnamesTld(
  providers: any,
  walletCtx: any,
  ownerSecret: Uint8Array,
): Promise<MidnamesDeployment> {
  const { contract } = await loadMidnames();
  const ownerKey = deriveMidnamesOwnerKey(ownerSecret);
  return deployLeaf(providers, walletCtx, {
    secret: ownerSecret,
    ownerKey,
    domain: TLD,
    targetAddress: '0'.repeat(64),
    targetType: contract.AddressType.ContractAddr,
    privateStateId: 'passport-midnames-tld-owner',
  });
}

export async function claimPassportAlias(
  providers: any,
  walletCtx: any,
  tld: MidnamesDeployment,
  ownerSecret: Uint8Array,
  aliasValue: string,
  passportAddressValue: string,
): Promise<PassportAliasClaim> {
  const { contract } = await loadMidnames();
  const alias = normalizePassportAlias(aliasValue);
  const passportAddress = rawContractAddress(passportAddressValue);
  const ownerKey = deriveMidnamesOwnerKey(ownerSecret);

  await waitForContract(providers.publicDataProvider, tld.address);
  const resolver = await deployLeaf(providers, walletCtx, {
    secret: ownerSecret,
    ownerKey,
    parentDomain: TLD,
    parentResolver: tld.address,
    domain: alias,
    targetAddress: passportAddress,
    targetType: contract.AddressType.ContractAddr,
    privateStateId: `passport-midnames-${alias}-owner`,
  });

  await waitForContract(providers.publicDataProvider, resolver.address);
  const { key, len } = domainToKey(alias);
  const registration = await tld.handle.callTx.register_domain_for(
    ownerKey,
    key,
    len,
    { bytes: contractAddressBytes(resolver.address) },
  );

  await waitForAlias(providers.publicDataProvider, tld.address, `${alias}.${TLD}`);
  return {
    alias,
    domain: `${alias}.${TLD}`,
    tldAddress: tld.address,
    resolverAddress: resolver.address,
    passportAddress,
    resolverDeployTxId: resolver.txId,
    registerTxId: txId(registration),
  };
}

export async function resolvePassportAlias(
  publicDataProvider: any,
  tldAddressValue: string,
  domainValue: string,
): Promise<ResolvedPassportAlias> {
  const { contract } = await loadMidnames();
  const normalized = domainValue.trim().toLowerCase().replace(/\.+$/, '');
  if (!normalized.endsWith(`.${TLD}`)) {
    throw new Error(`Midnames domain must end with .${TLD}.`);
  }

  const labels = normalized.split('.');
  if (labels.length < 2 || labels.at(-1) !== TLD) {
    throw new Error(`Invalid Midnames domain: ${domainValue}`);
  }

  let resolverAddress = rawContractAddress(tldAddressValue);
  for (const label of labels.slice(0, -1).reverse()) {
    const state = await publicDataProvider.queryContractState(resolverAddress);
    if (!state) throw new Error(`Midnames resolver not found at ${resolverAddress}.`);
    const namespace = contract.ledger(state.data);
    const key = domainToKey(label).key;
    if (!namespace.domains.member(key)) {
      throw new Error(`Midnames domain not found: ${normalized}.`);
    }
    resolverAddress = rawContractAddress(
      bytesToHex(namespace.domains.lookup(key).resolver.bytes),
    );
  }

  const state = await publicDataProvider.queryContractState(resolverAddress);
  if (!state) throw new Error(`Midnames resolver not found at ${resolverAddress}.`);
  const namespace = contract.ledger(state.data);
  if (!namespace.DOMAIN_TARGET.is_left) {
    throw new Error(`Midnames domain ${normalized} does not target a contract.`);
  }

  return {
    alias: labels[0],
    domain: normalized,
    resolverAddress,
    type: 'contract',
    address: rawContractAddress(bytesToHex(namespace.DOMAIN_TARGET.left.bytes)),
  };
}

export async function waitForContract(
  publicDataProvider: any,
  addressValue: string,
  timeoutMs = 120_000,
): Promise<void> {
  const address = rawContractAddress(addressValue);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await publicDataProvider.queryContractState(address)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for Midnames contract ${address}.`);
}

async function waitForAlias(
  publicDataProvider: any,
  tldAddress: string,
  domain: string,
  timeoutMs = 120_000,
): Promise<ResolvedPassportAlias> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await resolvePassportAlias(publicDataProvider, tldAddress, domain);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
  }
  throw new Error(`Timed out waiting for ${domain} to resolve.`, { cause: lastError });
}

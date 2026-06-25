// LocalStorage persistence of the user's session. Secrets are NOT stored:
// the device secret is re-derived from the passkey (PRF) on each use; the
// recovery secret only ever exists transiently (and as on-chain shares —
// TODO(PVSS)).

import type { PasskeyRef } from './passkey.js';

export interface Session {
  accountAddress: string;
  alias?: string;
  identityRegistryAddress?: string;
  identityRegistrationTxId?: string;
  passkey?: PasskeyRef;
  devMode?: boolean;
}

const KEY = 'passport-demo-session';
const ALIAS_KEY = 'passport-demo-aliases';

export interface AliasRecord {
  alias: string;
  accountAddress: string;
  identityRegistryAddress?: string;
  identityRegistrationTxId?: string;
  claimedAt: string;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}

export function loadAliases(): AliasRecord[] {
  try {
    const raw = localStorage.getItem(ALIAS_KEY);
    return raw ? (JSON.parse(raw) as AliasRecord[]) : [];
  } catch {
    return [];
  }
}

export function loadAliasForAccount(accountAddress: string): AliasRecord | null {
  return loadAliases().find((r) => r.accountAddress === accountAddress) ?? null;
}

export function saveAlias(
  alias: string,
  accountAddress: string,
  identity?: {
    identityRegistryAddress?: string;
    identityRegistrationTxId?: string;
  },
): AliasRecord {
  const normalized = normalizeAlias(alias);
  const records = loadAliases().filter(
    (r) => r.alias !== normalized && r.accountAddress !== accountAddress,
  );
  const record = {
    alias: normalized,
    accountAddress,
    identityRegistryAddress: identity?.identityRegistryAddress,
    identityRegistrationTxId: identity?.identityRegistrationTxId,
    claimedAt: new Date().toISOString(),
  };
  localStorage.setItem(ALIAS_KEY, JSON.stringify([...records, record]));
  return record;
}

export function normalizeAlias(alias: string): string {
  const cleaned = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'mn-passport-user';
}

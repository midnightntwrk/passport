// LocalStorage persistence of the user's session. Secrets are NOT stored:
// the device secret is re-derived from the passkey (PRF) on each use; the
// recovery secret only ever exists transiently — it is reconstructable from
// a guardian quorum plus the public BUSS points on-chain.

import type { PasskeyRef } from './passkey.js';

export interface Session {
  accountAddress: string;
  passkey?: PasskeyRef;
  devMode?: boolean;
}

const KEY = 'passport-demo-session';

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

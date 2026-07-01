// Minimal scenario runner for the localnet integration tests.

import { PassportAccount } from '../wallet/account.js';
import type { Ledger } from '../wallet/contract.js';

export async function runScenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n━━━ ${name} ━━━`);
  let code = 0;
  try {
    await fn();
    console.log(`\n◆ ${name}: PASS`);
  } catch (e: any) {
    console.error(e);
    console.log(`\n◆ ${name}: FAIL — ${e?.message ?? e}`);
    code = 1;
  }
  // Wallet/indexer subscriptions keep the event loop alive; force exit the
  // same way contract-custody-feasibility's runner does.
  setTimeout(() => process.exit(code), 100).unref();
}

export function step(label: string): void {
  console.log(`\n── ${label}`);
}

/** Collect messages along the error cause chain for robust matching. */
function errorText(e: any): string {
  const parts: string[] = [];
  let cur: any = e;
  let guard = 0;
  while (cur && guard++ < 8) {
    parts.push(String(cur?.message ?? cur));
    cur = cur?.cause;
  }
  return parts.join(' | ');
}

/** Await a call that MUST fail, with a message matching `pattern`. */
export async function expectFailure(
  label: string,
  p: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await p;
  } catch (e: any) {
    const text = errorText(e);
    if (pattern.test(text)) {
      console.log(`  ✓ ${label}: rejected as expected (${pattern})`);
      return;
    }
    throw new Error(`${label}: failed with unexpected error: ${text}`);
  }
  throw new Error(`${label}: expected failure but the call succeeded`);
}

/** Poll the account's ledger until `predicate` holds. */
export async function waitForLedger(
  account: PassportAccount,
  label: string,
  predicate: (l: Ledger) => boolean,
  timeoutMs = 120_000,
): Promise<Ledger> {
  const start = Date.now();
  for (;;) {
    try {
      const l = await account.ledgerState();
      if (predicate(l)) {
        console.log(`  ✓ ledger: ${label}`);
        return l;
      }
    } catch {
      // contract state may not be indexed yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ledger condition: ${label}`);
    }
    await sleep(3_000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

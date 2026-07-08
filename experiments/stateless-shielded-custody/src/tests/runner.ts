// Minimal scenario runner for the localnet probes.

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
  // same way the sibling experiments' runners do.
  setTimeout(() => process.exit(code), 100).unref();
}

export function step(label: string): void {
  console.log(`\n── ${label}`);
}

/** Poll a ledger-read until `predicate` holds. */
export async function waitForLedger<L>(
  read: () => Promise<L>,
  label: string,
  predicate: (l: L) => boolean,
  timeoutMs = 120_000,
): Promise<L> {
  const start = Date.now();
  for (;;) {
    try {
      const l = await read();
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

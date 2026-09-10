// P1 — is the executor-attached ciphertext a sanctioned mechanism or a hack?
//
// No chain required. This probe reads the installed toolchain's own type
// declarations and records, verbatim, what the platform says about who may
// attach a recipient ciphertext and when it may be omitted. The point is to
// establish that the mechanism P2 exercises is documented public API, so a
// PASS in P2 is a statement about the platform rather than about a trick.
//
// Four surfaces are inventoried:
//   1. ZswapOutput.new         — the only user-targeted output constructor,
//                                and what it says about omitting the ciphertext.
//   2. ZswapOutput.newContractOwned — the contract-targeted constructor,
//                                which takes no encryption key at all.
//   3. ZswapLocalState.watchFor — the recipient-side counterpart for coins
//                                that arrive without a ciphertext.
//   4. additionalCoinEncPublicKeyMappings — the midnight-js call option by
//                                which an executor supplies a recipient's
//                                encryption key.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario, step } from './runner.js';
import { writeEvidence } from './evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = path.resolve(__dirname, '..', '..', 'node_modules');

// Read the installed packages straight from node_modules: several of them
// do not export './package.json', so require.resolve cannot reach them.
function packageDir(spec: string): string {
  const dir = path.join(NODE_MODULES, ...spec.split('/'));
  if (!fs.existsSync(dir)) throw new Error(`package not installed: ${spec}`);
  return dir;
}

function packageVersion(spec: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageDir(spec), 'package.json'), 'utf8')).version;
}

/** Read a declaration file, returning its lines. */
function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n');
}

/**
 * Extract the doc comment immediately preceding the first line matching
 * `needle`, plus that line. Verbatim: this is evidence, not paraphrase.
 */
function declarationAt(file: string, needle: string): { found: boolean; text: string; line: number } {
  const src = lines(file);
  const idx = src.findIndex((l) => l.includes(needle));
  if (idx < 0) return { found: false, text: '', line: -1 };
  let start = idx;
  // Walk back over a contiguous block comment, if there is one.
  for (let i = idx - 1; i >= 0 && i > idx - 20; i--) {
    const t = src[i].trim();
    if (t.endsWith('*/') || t.startsWith('*') || t.startsWith('/**')) {
      start = i;
      if (t.startsWith('/**')) break;
    } else if (start !== idx) {
      break;
    } else {
      break;
    }
  }
  return { found: true, text: src.slice(start, idx + 1).join('\n').trim(), line: idx + 1 };
}

/** Find the first declaration file under `dir` that mentions `needle`. */
function findDeclaring(dir: string, needle: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') stack.push(full);
      } else if (e.name.endsWith('.d.ts')) {
        try {
          if (fs.readFileSync(full, 'utf8').includes(needle)) return full;
        } catch { /* unreadable */ }
      }
    }
  }
  return null;
}

await runScenario('P1 — the ciphertext API surface', async () => {
  const details: Record<string, unknown> = {};
  const findings: Array<{ surface: string; found: boolean; note: string }> = [];

  const ledgerDir = packageDir('@midnight-ntwrk/ledger-v8');
  const contractsDir = packageDir('@midnight-ntwrk/midnight-js-contracts');
  details.versions = {
    'ledger-v8': packageVersion('@midnight-ntwrk/ledger-v8'),
    'midnight-js-contracts': packageVersion('@midnight-ntwrk/midnight-js-contracts'),
    'compact-runtime': packageVersion('@midnight-ntwrk/compact-runtime'),
  };
  console.log(`  ledger-v8 ${(details.versions as any)['ledger-v8']}, midnight-js-contracts ${(details.versions as any)['midnight-js-contracts']}`);

  // ── 1 & 2: the two output constructors ──────────────────────────────────

  step('the output constructors: who may omit the ciphertext, and when');
  const ledgerDecl = findDeclaring(ledgerDir, 'static new(coin: ShieldedCoinInfo');
  if (!ledgerDecl) throw new Error('ZswapOutput declarations not found in the installed ledger package');
  details.ledgerDeclarationFile = path.relative(process.cwd(), ledgerDecl);

  const userOutput = declarationAt(ledgerDecl, 'static new(coin: ShieldedCoinInfo');
  const contractOutput = declarationAt(ledgerDecl, 'static newContractOwned(coin: ShieldedCoinInfo');
  details.zswapOutputNew = userOutput.text;
  details.zswapOutputNewContractOwned = contractOutput.text;
  console.log(`\n${userOutput.text}\n`);

  const omissionRule = /may be omitted \*?only\*? if/i.test(userOutput.text);
  const takesEpk = /target_epk: EncPublicKey/.test(userOutput.text);
  findings.push({
    surface: 'ZswapOutput.new',
    found: userOutput.found && takesEpk,
    note: takesEpk
      ? 'The only user-targeted output constructor takes the recipient encryption key as a REQUIRED parameter.'
      : 'Signature does not take an encryption key — the model assumed here does not hold.',
  });
  findings.push({
    surface: 'ZswapOutput.new (omission rule)',
    found: omissionRule,
    note: omissionRule
      ? 'The ciphertext may be omitted ONLY if the ShieldedCoinInfo reaches the recipient another way — out-of-band delivery is sanctioned, not accidental.'
      : 'No documented omission rule found.',
  });
  findings.push({
    surface: 'ZswapOutput.newContractOwned',
    found: /contract: ContractAddress\)/.test(contractOutput.text),
    note: 'The contract-targeted constructor takes no encryption key at all — a contract recipient has no encryption key to seal to.',
  });

  // ── 3: the recipient-side counterpart ────────────────────────────────────

  step('the recipient-side counterpart for ciphertext-less coins');
  const watchFor = declarationAt(ledgerDecl, 'watchFor(coinPublicKey: CoinPublicKey');
  details.watchFor = watchFor.text;
  console.log(`\n${watchFor.text}\n`);
  findings.push({
    surface: 'ZswapLocalState.watchFor',
    found: watchFor.found,
    note: watchFor.found
      ? 'A recipient told the coin out of band can pre-register it by commitment; this is the manual path an attached ciphertext removes the need for.'
      : 'watchFor not found.',
  });

  // ── 4: the executor's hook ───────────────────────────────────────────────

  step('the executor’s hook: supplying a recipient’s encryption key');
  const optionDecl = findDeclaring(contractsDir, 'additionalCoinEncPublicKeyMappings?:');
  details.callOptionFile = optionDecl ? path.relative(process.cwd(), optionDecl) : null;
  const option = optionDecl
    ? declarationAt(optionDecl, 'additionalCoinEncPublicKeyMappings?:')
    : { found: false, text: '', line: -1 };
  details.additionalCoinEncPublicKeyMappings = option.text;
  if (option.found) console.log(`\n${option.text}\n`);
  findings.push({
    surface: 'CallOptions.additionalCoinEncPublicKeyMappings',
    found: option.found,
    note: option.found
      ? 'A documented public call option mapping CoinPublicKey → EncPublicKey for coins created during circuit execution. This is the executor’s supported route.'
      : 'No such option in the installed midnight-js — the mechanism P2 tests would not be available.',
  });

  // What does the SDK do when it cannot resolve a key? Read the resolver.
  const bundle = path.join(contractsDir, 'dist', 'index.mjs');
  let refusalText = '';
  if (fs.existsSync(bundle)) {
    const src = lines(bundle);
    const i = src.findIndex((l) => l.includes('Unable to resolve encryption public key'));
    if (i >= 0) refusalText = src.slice(Math.max(0, i - 6), i + 3).join('\n').trim();
  }
  details.resolverRefusal = refusalText;
  if (refusalText) console.log(`\n${refusalText}\n`);
  findings.push({
    surface: 'encryptionPublicKeyResolver (refusal path)',
    found: Boolean(refusalText),
    note: refusalText
      ? 'With no resolvable key the SDK THROWS rather than building a ciphertext-less user output: the undiscoverable coin is not silently produced.'
      : 'Refusal path not located in the shipped bundle.',
  });

  details.findings = findings;
  const missing = findings.filter((f) => !f.found);
  step('VERDICT');
  for (const f of findings) console.log(`  ${f.found ? '✓' : '✗'} ${f.surface} — ${f.note}`);

  writeEvidence({
    testId: 'P1',
    name: 'api-surface',
    description: 'The platform’s own account of who attaches a recipient ciphertext',
    verdict: missing.length === 0 ? 'PASS' : 'PARTIAL',
    note:
      missing.length === 0
        ? 'The mechanism is documented public API on both sides. A user-targeted output REQUIRES a recipient encryption key; omitting the ciphertext is sanctioned only when the coin description reaches the recipient another way; a contract-targeted output has no key to seal to; and midnight-js exposes additionalCoinEncPublicKeyMappings so the party executing the circuit can supply the recipient’s key. Where it cannot be resolved the SDK refuses to build the output rather than emitting an undiscoverable coin.'
        : `Surfaces not located: ${missing.map((m) => m.surface).join(', ')}.`,
    details,
  });
});

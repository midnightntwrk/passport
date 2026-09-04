// P5 — the passport account contract as a cross-contract CALLEE.
//
// The k1-arm account custody contract (MIP-0012 + MIP-0013 reference,
// vendored at commit 2b0b55d) is deployed and activated with the vendored
// signer slice, then driven THROUGH a counterparty contract: AccountGate's
// compose_gated forwards an owner-signed bundle to the account's
// rotate_enc_key_with_jubjub — seam-gated, coinless, witness-free — and
// increments its own counter in the same transaction. Success shows a
// third-party contract composing an owner-authorised account operation
// atomically with its own bookkeeping.
//
// Sequence:
//   1. keyed artefacts (compile Account with --feature-zkir-v3 + AccountGate
//      if missing or keyless);
//   2. deploy the account (jubjub wave — the 18-key full deploy exceeds
//      block limits) and activate the initial device;
//   3. CONTROL: a direct rotate_enc_key_with_jubjub proves the vendored
//      signer pipeline against this stack, outside any call boundary;
//   4. deploy AccountGate holding the account reference;
//   5. COMPOSED: gate.compose_gated with a valid bundle — expects
//      account.enc_key rotated AND gate.composed advanced in ONE tx. This
//      leg also answers the open kernel.self() question: the challenge the
//      owner signed binds the ACCOUNT's address, so the seam only verifies
//      if kernel.self() inside a CALLEE still names the callee itself.
//   6. NEGATIVE: the same composed call with a corrupted sig_s must fail
//      through the call boundary, with neither contract's state changed;
//      the evidence records WHERE it failed (construction, prover, node).
//
// Best-effort probe: a published-stack gap is recorded as BLOCKED evidence
// with the exact failure — that is itself the answer. A clean seam
// rejection of the composed call is not BLOCKED but a semantic finding
// (PARTIAL): the machinery works and the account refuses the call shape.

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError, classifyCallError, type Verdict } from './evidence.js';
import {
  setupWallet,
  deployWitnessFree,
  contractRefArg,
  type ContractHandle,
} from '../node/setup.js';
import {
  CONFIG,
  createProviders,
  accountZkConfigPath,
  accountGateZkConfigPath,
} from '../node/wallet.js';
import { hexToBytes, bytesToHex, randomBytes32 } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const TOOLCHAIN = '+0.34.0';
const CALL_TIMEOUT_MS = 240_000;

const DESCRIPTION =
  'The k1-arm passport account contract as a cross-contract callee: a counterparty contract drives an owner-authorised, seam-gated, coinless operation atomically with its own state';

function keyed(artefactDir: string): boolean {
  const indexJs = path.join(artefactDir, 'contract', 'index.js');
  if (!fs.existsSync(indexJs)) return false;
  const m = fs.readFileSync(indexJs, 'utf-8').match(/export const expectedVk = \{([^}]*)\}/);
  return !!m && /'[^']+':/.test(m[1]);
}

/** Compile the account pair with real keys where missing (idempotent). */
function ensureKeyedArtefacts(): Record<string, unknown> {
  const report: Record<string, unknown> = {};
  if (!keyed(accountZkConfigPath)) {
    const t0 = performance.now();
    execSync(
      `compact compile ${TOOLCHAIN} --feature-zkir-v3 contracts/account.compact contracts/managed/Account`,
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    report.accountCompileMs = Math.round(performance.now() - t0);
  } else {
    report.accountCompileMs = 'already keyed';
  }
  if (!keyed(accountGateZkConfigPath)) {
    const t0 = performance.now();
    execSync(
      `compact compile ${TOOLCHAIN} --compact-path contracts/managed contracts/account-gate.compact contracts/managed/AccountGate`,
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    report.gateCompileMs = Math.round(performance.now() - t0);
  } else {
    report.gateCompileMs = 'already keyed';
  }
  const accountZkir = JSON.parse(
    fs.readFileSync(path.join(accountZkConfigPath, 'zkir', 'rotate_enc_key_with_jubjub.zkir'), 'utf-8'),
  );
  const gateZkir = JSON.parse(
    fs.readFileSync(path.join(accountGateZkConfigPath, 'zkir', 'compose_gated.zkir'), 'utf-8'),
  );
  report.zkirVersions = {
    account_rotate_enc_key_with_jubjub: `${accountZkir.version?.major}.${accountZkir.version?.minor}`,
    gate_compose_gated: `${gateZkir.version?.major}.${gateZkir.version?.minor}`,
  };
  report.provenance = 'account.compact vendored from arc-passport nicolasdp/ecdsa-k1-arm commit 2b0b55d';
  return report;
}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: no finalisation within ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS).unref(),
    ),
  ]);
}

async function fetchObserverView(txId: string): Promise<any> {
  const query = `query Tx($offset: TransactionOffset!) {
    transactions(offset: $offset) {
      hash
      ... on RegularTransaction {
        contractActions { __typename address ... on ContractCall { entryPoint } }
        transactionResult { status }
      }
    }
  }`;
  const attempt = async (offset: Record<string, string>) => {
    const res = await fetch(CONFIG.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { offset } }),
    });
    return res.json() as Promise<any>;
  };
  const clean = txId.replace(/^0x/, '');
  let body = await attempt({ identifier: clean });
  if (body?.errors?.length || !(body?.data?.transactions ?? []).length) {
    const retry = await attempt({ hash: clean });
    if (!retry?.errors?.length && (retry?.data?.transactions ?? []).length) body = retry;
  }
  if (body?.errors?.length) return { schemaErrors: body.errors };
  return (body?.data?.transactions ?? [])[0] ?? null;
}

await runScenario('p5-passport-callee', async () => {
  const details: Record<string, unknown> = {};
  let evidenceWritten = false;
  const finish = (verdict: Verdict, note: string, extra: Partial<{ txHash: string; errorCode: string }> = {}) => {
    evidenceWritten = true;
    writeEvidence({
      testId: 'P5',
      name: 'passport-callee',
      description: DESCRIPTION,
      verdict,
      note,
      ...extra,
      details,
    });
  };

  try {
    step('keyed artefacts: Account (zkir v3) + AccountGate');
    details.artefacts = ensureKeyedArtefacts();
    console.log(`  ${JSON.stringify(details.artefacts)}`);

    // The generated modules are imported only after the artefacts exist.
    const { JubjubDevice, rotateEncKeyChallenge, authArgs, JUBJUB_R } = await import('./account-client/signer.js');
    const { compiledAccount, deployAccountJubjubArm, accountLedger, callAccount } =
      await import('./account-client/deploy.js');
    const GateModule: any = await import('../../contracts/managed/AccountGate/contract/index.js');

    step('wallet + providers (leaf: the account bundle; proving: the registry over managed/)');
    const walletCtx = await setupWallet();
    const providers = await createProviders(walletCtx, accountZkConfigPath);

    step('deploy the account (jubjub wave) and activate the initial device');
    const device = JubjubDevice.generate();
    const salt = randomBytes32();
    const encKey0 = randomBytes32();
    const compiled = compiledAccount();
    const accountAddress: string = await deployAccountJubjubArm(providers, compiled, [
      device.bootCommitment(salt),
      encKey0,
    ]);
    details.accountAddress = accountAddress;
    console.log(`  account @ ${accountAddress}`);
    const accountAddressBytes = hexToBytes(accountAddress.replace(/^0x/, ''));

    await withTimeout(
      callAccount(providers, compiled, accountAddress, 'activate_initial_device_with_jubjub', [device.pk, salt]),
      'activate_initial_device_with_jubjub',
    );
    const booted = await waitForLedger(
      () => accountLedger(providers, accountAddress),
      'account activated (booted, device_count = 1)',
      (l: any) => l.booted === true && l.device_count === 1n,
    );
    if (!booted.devices.member(device.entryAt(accountAddressBytes, booted.device_epoch, 0n))) {
      throw new Error('activation did not install the device entry at epoch 0, counter 0');
    }
    let useCounter = 0n;

    step('CONTROL: direct rotate_enc_key_with_jubjub (signer pipeline, no call boundary)');
    const key1 = randomBytes32();
    {
      const l = await accountLedger(providers, accountAddress);
      const auth = device.sign(
        rotateEncKeyChallenge({ contractAddress: accountAddressBytes, authNonce: l.auth_nonce }, device.pk, key1),
        useCounter,
      );
      const r = await withTimeout(
        callAccount(providers, compiled, accountAddress, 'rotate_enc_key_with_jubjub', [key1, ...authArgs(auth)]),
        'direct rotate_enc_key_with_jubjub',
      );
      details.controlTx = r?.public?.txId ?? null;
      useCounter += 1n;
    }
    await waitForLedger(
      () => accountLedger(providers, accountAddress),
      'enc_key rotated directly',
      (l: any) => bytesToHex(l.enc_key) === bytesToHex(key1),
    );
    console.log('  the vendored signer pipeline authorises against this stack');

    step('deploy AccountGate with the account reference as constructor argument');
    const gate: ContractHandle = await deployWitnessFree(walletCtx, {
      name: 'account-gate',
      module: GateModule,
      zkPath: accountGateZkConfigPath,
      args: [contractRefArg(accountAddress)],
    });
    details.gateAddress = gate.address;
    console.log(`  gate @ ${gate.address}`);

    step('COMPOSED: gate.compose_gated forwards an owner-authorised rotation');
    const key2 = randomBytes32();
    const beforeComposed = await accountLedger(providers, accountAddress);
    const authNonceBefore: bigint = beforeComposed.auth_nonce;
    const auth2 = device.sign(
      rotateEncKeyChallenge(
        { contractAddress: accountAddressBytes, authNonce: authNonceBefore },
        device.pk,
        key2,
      ),
      useCounter,
    );
    let composedOutcome: any;
    try {
      composedOutcome = await withTimeout(
        gate.call('compose_gated', key2, ...authArgs(auth2)),
        'compose_gated',
      );
    } catch (e: any) {
      const cls = classifyCallError(e);
      details.composedFailure = { stage: cls.outcome, errorCode: cls.errorCode, error: serialiseError(e) };
      console.log(`  composed call FAILED at ${cls.outcome} (${cls.errorCode})`);

      // Diagnostic: is the bundle itself sound? A construction failure that
      // vanishes when the SAME bundle is sent directly isolates the call
      // boundary as the refusing layer.
      step('diagnostic: the same bundle sent DIRECTLY to the account');
      try {
        const r = await withTimeout(
          callAccount(providers, compiled, accountAddress, 'rotate_enc_key_with_jubjub', [key2, ...authArgs(auth2)]),
          'diagnostic direct rotate',
        );
        details.diagnosticDirect = { succeeded: true, txId: r?.public?.txId ?? null };
        console.log('  the SAME bundle authorises directly — the call boundary is the refusing layer');
      } catch (e2: any) {
        const cls2 = classifyCallError(e2);
        details.diagnosticDirect = { succeeded: false, stage: cls2.outcome, errorCode: cls2.errorCode, error: serialiseError(e2) };
        console.log(`  the same bundle ALSO fails directly (${cls2.outcome}) — the bundle or stack, not the boundary`);
      }

      const boundaryIsolated = (details.diagnosticDirect as any).succeeded === true;
      const semantic = cls.outcome === 'construction-rejected' && boundaryIsolated;
      finish(
        semantic ? 'PARTIAL' : 'BLOCKED',
        semantic
          ? `The account REFUSES the composed call at the seam while accepting the identical bundle directly: the ` +
            `call boundary changes what the seam recomputes (kernel.self() or ledger context inside a callee). ` +
            `Machinery verdict: calls work (P3); the account contract cannot be a callee for seam-gated operations ` +
            `as-is. Stage: ${cls.outcome}, ${cls.errorCode}.`
          : `A published-stack gap stopped the composed call at ${cls.outcome} (${cls.errorCode}); the direct-path ` +
            `diagnostic ${boundaryIsolated ? 'succeeded' : 'also failed'} — see details for the exact failure. ` +
            `${cls.note}`,
        { errorCode: cls.errorCode },
      );
      return;
    }
    details.composedTx = composedOutcome.txId;
    console.log(`  composed tx ${composedOutcome.txId}`);

    const accountAfter = await waitForLedger(
      () => accountLedger(providers, accountAddress),
      'account enc_key rotated THROUGH the gate',
      (l: any) => bytesToHex(l.enc_key) === bytesToHex(key2),
    );
    const gateAfter = await waitForLedger(
      () => gate.ledgerState(),
      'gate.composed advanced in the same transaction',
      (l: any) => l.composed === 1n,
    );
    if (accountAfter.auth_nonce !== authNonceBefore + 1n) {
      throw new Error('auth_nonce did not advance by exactly 1 through the composed call');
    }
    useCounter += 1n;
    details.composedResult = {
      encKeyRotated: true,
      gateComposed: gateAfter.composed,
      authNonce: `${authNonceBefore} -> ${accountAfter.auth_nonce}`,
    };

    details.composedObserver = await fetchObserverView(composedOutcome.txId);
    const actions: any[] = (details.composedObserver as any)?.contractActions ?? [];
    const callActions = actions.filter((a) => a.__typename === 'ContractCall');
    details.composedObserverSummary = {
      contractCalls: callActions.length,
      entryPoints: callActions.map((c) => c.entryPoint ?? null),
    };

    step('NEGATIVE: the composed call with a corrupted signature must fail through the boundary');
    const key3 = randomBytes32();
    const l3 = await accountLedger(providers, accountAddress);
    const auth3 = device.sign(
      rotateEncKeyChallenge({ contractAddress: accountAddressBytes, authNonce: l3.auth_nonce }, device.pk, key3),
      useCounter,
    );
    const corrupted = { ...auth3, sig_s: (auth3.sig_s + 1n) % JUBJUB_R };
    let negative: Record<string, unknown>;
    try {
      const r = await withTimeout(
        gate.call('compose_gated', key3, ...authArgs(corrupted)),
        'compose_gated (corrupted)',
      );
      negative = { rejected: false, txId: r.txId };
    } catch (e: any) {
      const cls = classifyCallError(e);
      negative = { rejected: true, stage: cls.outcome, errorCode: cls.errorCode, error: serialiseError(e) };
      console.log(`  corrupted bundle rejected at ${cls.outcome} (${cls.errorCode})`);
    }
    details.negative = negative;

    await sleep(5_000);
    const accountFinal = await accountLedger(providers, accountAddress);
    const gateFinal = await gate.ledgerState();
    const untouched =
      bytesToHex(accountFinal.enc_key) === bytesToHex(key2) &&
      accountFinal.auth_nonce === accountAfter.auth_nonce &&
      gateFinal.composed === gateAfter.composed;
    details.negativeStateCheck = {
      encKeyUnchanged: bytesToHex(accountFinal.enc_key) === bytesToHex(key2),
      authNonceUnchanged: accountFinal.auth_nonce === accountAfter.auth_nonce,
      gateComposedUnchanged: gateFinal.composed === gateAfter.composed,
    };

    if (!(negative as any).rejected) {
      finish(
        'FAIL',
        'A composed call with a CORRUPTED signature was accepted — the seam did not hold through the call boundary. Investigate immediately.',
        { errorCode: 'forged-composed-call-accepted', txHash: (negative as any).txId },
      );
      throw new Error('corrupted composed call accepted');
    }
    if (!untouched) {
      finish(
        'PARTIAL',
        'The corrupted composed call was rejected, but state moved — see details.negativeStateCheck.',
        { errorCode: 'negative-state-drift' },
      );
      throw new Error('state moved after the rejected negative call');
    }

    finish(
      'PASS',
      `The passport account contract participates as a cross-contract callee: gate.compose_gated forwarded the ` +
      `owner's bundle, the seam verified it inside the callee (kernel.self() and auth_nonce bind as on the direct ` +
      `path — the challenge was signed over the ACCOUNT's address), enc_key rotated and gate.composed advanced in ` +
      `ONE transaction (${composedOutcome.txId}), and a corrupted bundle failed at ` +
      `${(negative as any).stage} with neither contract's state changed. Observer: ` +
      `${(details.composedObserverSummary as any).contractCalls} contract calls, entry points ` +
      `[${(details.composedObserverSummary as any).entryPoints?.join(', ')}].`,
      { txHash: composedOutcome.txId },
    );
  } catch (e: any) {
    if (!evidenceWritten) {
      const cls = classifyCallError(e);
      details.error = serialiseError(e);
      finish(
        'BLOCKED',
        `Stopped before the composed-call question was answered: ${cls.outcome} (${cls.errorCode}) — ` +
        `${String(e?.message ?? e).slice(0, 200)}. The recorded failure is the evidence.`,
        { errorCode: cls.errorCode },
      );
    }
    throw e;
  }
});

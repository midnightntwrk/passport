// W4 — manual offer assembly (fallback, run only if W3 crashes in glue).
//
// If W3's witness spend dies OFF-CHAIN (the S5 wasm-glue signature), the
// protocol question is still open. This probe drops below midnight-js: it
// binds the captured QSCI directly with the ledger-level primitive
// `ZswapInput.newContractOwned(coin, segment, contract, state)` and
// attempts manual offer assembly and submission. Node accept ⇒ the wall is
// purely SDK glue; node reject ⇒ protocol wall.
//
// This runner is deliberately exploratory: the ledger-v8 manual-assembly
// surface is undocumented, so each step probes what exists, records it as
// evidence, and stops at the first missing piece with an exact description
// of the gap. Iterate from there.

import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';

import { runScenario, step } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { standardSetup, mintToUser, depositAndCapture } from './flow.js';

const COLOR_SEED = '0'.repeat(62) + '41';

await runScenario('w4-manual-offer', async () => {
  const details: Record<string, unknown> = {};

  step('inventory: ledger-v8 exports relevant to manual assembly');
  const relevant = Object.keys(ledgerV8).filter((k) =>
    /zswap|offer|transaction|input|output|chainstate/i.test(k),
  );
  details.ledgerV8Surface = relevant;
  console.log(`  ${relevant.length} relevant export(s): ${relevant.join(', ')}`);

  const ZswapInput: any = (ledgerV8 as any).ZswapInput;
  const hasPrimitive = typeof ZswapInput?.newContractOwned === 'function';
  details.hasNewContractOwned = hasPrimitive;
  if (!hasPrimitive) {
    writeEvidence({
      testId: 'W4',
      name: 'manual-offer',
      description: 'ledger-level witness spend via ZswapInput.newContractOwned + manual offer',
      verdict: 'FAIL',
      errorCode: 'primitive-missing',
      note: 'ZswapInput.newContractOwned is not exported by this ledger-v8 build — manual assembly cannot start.',
      details,
    });
    throw new Error('ZswapInput.newContractOwned missing');
  }
  console.log('  ✓ ZswapInput.newContractOwned present');

  step('setup + deposit (same capture path as W3)');
  const s = await standardSetup();
  const coin = await mintToUser(s.ctx, s.faucet, COLOR_SEED, 300n);
  const cap = await depositAndCapture(s, coin);
  details.depositTx = cap.depositTx;
  details.mtIndex = cap.mtIndex;

  step('bind the captured QSCI against the live Zswap chain state');
  // The primitive needs the current ZswapChainState. Probe the plausible
  // sources; record which (if any) answers.
  const stateProbes: Array<{ surface: string; outcome: string }> = [];
  let chainState: any = null;
  const walletState: any = await (await import('rxjs')).firstValueFrom(s.ctx.walletCtx.wallet.state());
  const candidates: Array<[string, () => any]> = [
    ['wallet.state().shielded.zswapChainState', () => walletState?.shielded?.zswapChainState],
    ['wallet.state().shielded.chainState', () => walletState?.shielded?.chainState],
    ['providers.publicDataProvider.queryZSwapChainState', () => s.ctx.providers.publicDataProvider?.queryZSwapChainState?.()],
  ];
  for (const [surface, get] of candidates) {
    try {
      const v = await get();
      stateProbes.push({ surface, outcome: v ? `present (${v.constructor?.name ?? typeof v})` : 'undefined' });
      if (v && !chainState) chainState = v;
    } catch (e: any) {
      stateProbes.push({ surface, outcome: `threw: ${e?.message}` });
    }
  }
  details.chainStateProbes = stateProbes;
  if (!chainState) {
    writeEvidence({
      testId: 'W4',
      name: 'manual-offer',
      description: 'ledger-level witness spend via ZswapInput.newContractOwned + manual offer',
      verdict: 'PARTIAL',
      errorCode: 'chain-state-source-missing',
      note:
        'The primitive exists but no probed surface yields a live ZswapChainState to bind ' +
        'against. Next iteration: reconstruct the state from the indexer or the node RPC ' +
        '(see details.chainStateProbes for what was tried).',
      details,
    });
    await s.ctx.walletCtx.wallet.stop();
    return;
  }

  step('construct the contract-owned input');
  try {
    const qualified = { nonce: coin.nonce, color: coin.color, value: coin.value, mt_index: cap.mtIndex };
    const input = ZswapInput.newContractOwned(qualified, 0, s.custody.address, chainState);
    details.inputConstructed = true;
    details.inputDescription = String(input);
    console.log(`  ✓ input constructed: ${String(input).slice(0, 120)}`);
  } catch (e: any) {
    details.inputError = serialiseError(e);
    writeEvidence({
      testId: 'W4',
      name: 'manual-offer',
      description: 'ledger-level witness spend via ZswapInput.newContractOwned + manual offer',
      verdict: 'PARTIAL',
      errorCode: 'input-construction-failed',
      note: `ZswapInput.newContractOwned threw: ${e?.message} — see details for the exact shape it expects.`,
      details,
    });
    await s.ctx.walletCtx.wallet.stop();
    return;
  }

  // Beyond this point a full manual offer (input + output to the user +
  // balancing + the paired contract-call transcript claiming the nullifier)
  // must be assembled and submitted. That composition is the next iteration
  // of this probe — by design it is only reached when W3 proves the
  // high-level path is glue-blocked.
  writeEvidence({
    testId: 'W4',
    name: 'manual-offer',
    description: 'ledger-level witness spend via ZswapInput.newContractOwned + manual offer',
    verdict: 'PARTIAL',
    errorCode: 'assembly-not-implemented',
    note:
      'Primitive present, QSCI binds against the live chain state. Full offer assembly + ' +
      'submission is the next iteration (only needed if W3 is glue-blocked).',
    details,
  });
  await s.ctx.walletCtx.wallet.stop();
});

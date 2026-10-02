// Render observed measurements only. Never turn a partial run into a PASS.
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVELOPE_SIZE } from './codec.js';

const directory = 'evidence/inbox-view-envelope';
const offline = JSON.parse(readFileSync(`${directory}/offline.json`, 'utf8'));
const source = JSON.parse(readFileSync(`${directory}/localnet.json`, 'utf8'));
const run = { ...source, verdict: source.verdict === 'RUNNING' ? 'PARTIAL' : source.verdict,
  capturedAt: new Date().toISOString() };
if (run.error) run.error = { name: run.error.name, message: run.error.message };
// A run that stops early may lack any of these; render what was observed.
for (const key of ['measurements', 'proofs', 'submissions', 'restores', 'transactions']) run[key] ??= [];
assert.equal(offline.verdict, 'PASS'); assert.equal(run.payloadBytes, ENVELOPE_SIZE);
const complete = run.verdict === 'PASS';
if (complete) {
  assert.equal(run.measurements.length, 5); assert.equal(run.restores.length, 2);
  assert.ok(run.account && run.final && run.environment, 'a PASS run records its account, final state and environment');
}
for (const restore of run.restores) {
  assert.ok(restore.initiallyEmpty && restore.aUnavailable && restore.sameEnrolledP256Key);
  assert.equal(restore.account, run.account);
  assert.ok(run.transactions.some(t => t.txId === restore.acceptedTx && t.status === 'SUCCESS'));
}
function observed(label: string) {
  const submissions = run.submissions.filter(s => s.label === label);
  const proofs = run.proofs.filter(p => p.label === label && p.keyLocation.startsWith('contract:'));
  assert.equal(submissions.length, 1, `${label}: expected one submission`);
  assert.equal(proofs.length, 1, `${label}: expected one contract proof`);
  const submission = submissions[0], proof = proofs[0];
  assert.ok(submission.modelledFeeSpecks && !submission.feeMeasurementError);
  assert.ok(run.transactions.some(t => t.txId === submission.txId && t.status === 'SUCCESS'));
  return { submission, proof };
}
const envelopeRows = run.measurements.map(m => {
  assert.equal(BigInt(m.after.inboxCount) - BigInt(m.before.inboxCount), 1n);
  assert.equal(BigInt(m.after.authNonce) - BigInt(m.before.authNonce), 1n);
  const { submission: s, proof: p } = observed(m.name);
  assert.equal(m.serializedInboxFrameDelta, m.after.inboxFrameBytes - m.before.inboxFrameBytes);
  return `| ${m.name} | ${m.payloadBytes} | ${m.serializedInboxFrameDelta} | ${m.serializedStateDelta} | ${s.bytes} | ${p.proofBytes} | ${(p.milliseconds / 1000).toFixed(3)} | ${s.modelledFeeSpecks} |`;
});
const otherLabels = ['enrol B', 'activate generation 1', 'backfill live coin under generation 1',
  ...run.restores.map(r => r.name), 'activate generation 2'].filter(label =>
    run.transactions.some(t => t.name === label && t.status === 'SUCCESS'));
const otherRows = otherLabels.map(label => {
  const { submission: s, proof: p } = observed(label);
  return `| ${label} | ${s.bytes} | ${p.proofBytes} | ${(p.milliseconds / 1000).toFixed(3)} | ${s.modelledFeeSpecks} |`;
});
const provenancePaths = ['src/tests/inbox-view-envelope/codec.ts', 'src/tests/inbox-view-envelope/offline.ts',
  'src/tests/inbox-view-envelope/localnet.ts', 'src/tests/inbox-view-envelope/private-state.ts',
  'src/tests/instrumentation.ts', 'package-lock.json',
  'contracts/account.compact', 'contracts/account-p256.compact', 'contracts/managed/account/contract/index.js',
  ...['append_inbox_with_p256', 'withdraw_shielded_with_p256', 'rotate_enc_key_with_p256'].flatMap(n => [
    `contracts/managed/account/keys/${n}.verifier`, `contracts/managed/account/zkir/${n}.bzkir`])];
const provenance = { capturedAt: new Date().toISOString(),
  note: 'Local files hashed when this report was rendered. The run\'s recorded commit may predate these sources; compare these hashes with the committed files.',
  files: Object.fromEntries(provenancePaths.map(path => [path, {
    bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }])) };
writeFileSync(`${directory}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
// Freeze the publication snapshot; the live runner may still be writing its
// ignored localnet.json. Readers always see the evidence behind this report.
writeFileSync(`${directory}/published-localnet.json`, JSON.stringify(run, null, 2) + '\n');
const proverBytes = statSync('contracts/managed/account/keys/append_inbox_with_p256.prover').size;
const yesNo = (b: boolean) => b ? 'yes' : 'no';
function environmentLine(env: any): string {
  if (!env) return 'Environment: not recorded in this snapshot.';
  const parts = [env.docker ?? 'Docker host not recorded'];
  if (env.gitHead) {
    parts.push(`source commit \`${env.gitHead}\`, working tree dirty: ${yesNo(!!env.gitDirty)}`);
    parts.push(env.gitBase ? `merge-base with the P-256 branch \`${env.gitBase}\`` : 'merge-base with the P-256 branch not recorded');
  } else if (env.gitBase) parts.push(`commit recorded by the run \`${env.gitBase}\``);
  return `Environment: ${parts.join('; ')}.`;
}
function deploymentLine(d: any): string {
  if (!d) return 'Deployment circuit count and verifier-byte wave budget: not recorded in this snapshot.';
  return `The ${d.circuitCount}-circuit deployment used a ${Number(d.verifierByteBudget).toLocaleString('en-GB')}-verifier-byte wave budget.`;
}
function finalLine(f: any): string[] {
  if (!f) return ['Final inbox: not recorded in this snapshot.'];
  if (f.inboxRecords !== undefined) return [
    `Final inbox: ${f.inboxRecords} records (${f.inboxRecordBytes} payload bytes), of which ${f.envelopeCount} are viewing envelopes (${f.envelopeBytes} bytes).`];
  // Older snapshots recorded payloadBytes over all inbox records, not envelopes only.
  return [`Final inbox: ${f.inboxCount} records (${f.payloadBytes} payload bytes across all records), of which ${f.envelopeCount} are viewing envelopes (${f.envelopeCount * ENVELOPE_SIZE} bytes).`];
}
const retries = run.restores.map((r: any) => r.attemptsBeyondFirst ?? Math.max(0, (r.attempts?.length ?? 1) - 1));
const retryLine = !run.restores.length ? 'Candidate retry: no restore completed in this snapshot.'
  : retries.every((n: number) => n === 0) ? 'Candidate retry was not exercised: every restore accepted its first candidate.'
  : `Candidate retry was exercised: ${retries.reduce((a: number, n: number) => a + n, 0)} additional candidate attempts across ${run.restores.length} restores before acceptance.`;
const lines = [
  '# Inbox viewing-key envelope: observed localnet results', '',
  `**${run.verdict}.** Run started ${run.startedAt}; ${complete ? `completed ${run.completedAt}` : `snapshot ${run.capturedAt}`}.`,
  ...(complete ? [] : ['The full scenario has not passed in this snapshot. Only completed, accepted observations below are reported.',
    ...(run.error ? [`Run error: ${run.error.message}`] : [])]), '',
  '**192 bytes per reader per viewing-key generation** (384 bytes for two readers; 1,920 for ten).',
  'This fits a 32-byte account viewing secret and 64 bytes of public P-256 registration metadata.', '',
  '## Envelope appends', '',
  '| Observation | Payload B | Inbox-only serialisation delta B | Whole-state delta B | Full transaction B | Contract proof B | Proving s | Modelled fee SPECKs |',
  '|---|---:|---:|---:|---:|---:|---:|---:|', ...envelopeRows, '',
  'Each row is one P-256-authorised append. The inbox map is serialised in a constant blank ContractState frame.',
  'Both inbox-only and whole-state snapshot deltas can be negative in these observations; they are not a stable per-record storage-allocation metric.',
  'Whole-state deltas additionally include rolling authentication-state changes and storage-usage annotations. The fixed logical payload remains 192 bytes per record.',
  'Serialisation is not physical database allocation; the full transaction includes funding-wallet DUST overhead.',
  'Proving includes local HTTP/key loading; these are single observations, not cold-cache or repeated benchmark means.',
  'Fees use the indexed ledger parameters, not an independently measured amount burnt or a currency conversion.', '',
  '## Other required calls', '',
  '| Call | Full transaction B | Contract proof B | Contract proving s | Modelled fee SPECKs |',
  '|---|---:|---:|---:|---:|', ...otherRows, '',
  'Shielded spends also generate Zswap proofs; their separate observations are retained in the JSON. This column times only the contract proof.',
  'Enrolling B adds one device call and one envelope append. Rotating for N retained readers takes N appends plus one rotation call.',
  'The pre-rotation live coin also needed one 192-byte encrypted-description backfill under the new viewing key.', '',
  '## Restore outcomes', '',
  run.account ? `Account throughout: \`${run.account}\`.` : 'Account: not deployed in this snapshot.', '',
  ...run.restores.map(r => `- **${r.name}: PASS.** Empty private store, A signing disabled, public history scan, recovered B registration key, accepted spend \`${r.acceptedTx}\`.`),
  ...(complete ? ['- B could not decrypt the final fresh viewing generation after being excluded from its envelopes; A could.',
    '- The account address and B signing credential persisted across both restores.'] :
    ['- Remaining lifecycle checks are pending; see the published snapshot for completed restores.']), '',
  retryLine, '',
  'The suite uses software ES256 authenticators and synthetic PRF outputs. It exercises real node proofs and spends,',
  'but fresh clients are isolated private-state providers in one process, sharing the public network, prover, and fee payer.',
  'Browser PRF support and cross-machine passkey synchronisation require separate evidence.', '',
  ...finalLine(run.final),
  `Existing append prover artefact: ${proverBytes} bytes (${(proverBytes / 1024 ** 2).toFixed(2)} MiB). It is local proving infrastructure, not per-reader chain storage.`, '',
  '## Reproduction and boundaries', '',
  'See [experiment guide](../../../experiments/inbox-view-envelope/README.md) for the wire layout, required bootstrap inputs,',
  'trusted recipient-roster assumption, historical-epoch limits, and commands.',
  `Recovery: ${run.recovery ?? 'No usable recovery wrap configured; guardian recovery is untested.'}`, '',
  environmentLine(run.environment),
  run.ledgerParametersSha256 ? `Ledger-parameter SHA-256: \`${run.ledgerParametersSha256}\`.` : 'Ledger-parameter SHA-256: not recorded in this snapshot.',
  deploymentLine(run.deployment),
  'Sources: [offline](offline.json), [localnet snapshot](published-localnet.json), [source and artefact hashes](provenance.json).', '',
];
writeFileSync(`${directory}/RESULTS.md`, lines.join('\n'));
console.log(`${directory}/RESULTS.md`);

// Render the slide/report comparison from the committed raw measurements.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sizes = JSON.parse(readFileSync(path.join(root, 'evidence/p256-webauthn/circuit-sizes.json'), 'utf8'));
const run = JSON.parse(readFileSync(path.join(root, 'evidence/p256-webauthn/conformance-and-proving.json'), 'utf8'));
assert.equal(run.verdict, 'PASS');
const labels = [
  ['Native P-256 verifier', 'probe-p256', 'verify_ecdsa'],
  ['Profiled WebAuthn verifier', 'probe-p256', 'verify_webauthn'],
  ['Account rotation — JubJub', 'account', 'rotate_enc_key_with_jubjub'],
  ['Account rotation — k256', 'account', 'rotate_enc_key_with_k256'],
  ['Account rotation — P-256/WebAuthn', 'account', 'rotate_enc_key_with_p256'],
];
const lines = [
  '# P-256 / WebAuthn measurements', '',
  `Measured ${run.ranAt}. Compact ${sizes.compiler}, ${sizes.zkirVersion}; runtime 0.20.0, ledger 9.`, '',
  '## Comparable circuits', '',
  '| Circuit | k | Rows | Prover key (MiB) | First (s) | Repeat 1 / 2 (s) | Repeat mean (s) |',
  '|---|---:|---:|---:|---:|---:|---:|',
];
for (const [label, contract, circuit] of labels) {
  const shape = sizes.circuits.find(r => r.contract === contract && r.circuit === circuit);
  assert.ok(shape);
  const times = [0, 1, 2].map(i => {
    const samples = run.details.samples.filter(r => r.label === `${circuit}/${i}`);
    assert.equal(samples.length, 1, `expected one contract proof: ${circuit}/${i}`);
    return samples[0].milliseconds / 1000;
  });
  lines.push(`| ${label} | ${shape.k} | ${shape.rows.toLocaleString('en-US')} | ${(shape.assets.prover.bytes / 2 ** 20).toFixed(2)} | ${times[0].toFixed(3)} | ${times[1].toFixed(3)} / ${times[2].toFixed(3)} | ${((times[1] + times[2]) / 2).toFixed(3)} |`);
}
lines.push('',
  '**Scope.** The first two rows are standalone verifier-cost probes with a public digest/challenge output. The account rows measure the same `rotate_enc_key` operation with enrolment, rolling entry and nonce checks. The WebAuthn rows use profile `wa-json134` (134-byte JSON, 21-byte origin, 37-byte authenticator data, UP+UV). They are not general variable-length WebAuthn measurements.', '',
  '**Timing.** Sequential `ProvingProvider.prove` wall time, including artifact lookup/load and local HTTP transfer; excluding signing, circuit execution/check, wallet balancing and inclusion. The first observation and two repeats are reported separately. No claim of OS/server cold-cache behaviour; key generation is excluded. These are three observations, not a latency distribution.', '',
  `**Hardware.** ${sizes.hardware.cpu}, ${sizes.hardware.logicalCpus} logical CPUs, ${sizes.hardware.memoryBytes / 2 ** 30} GiB host RAM (${sizes.hardware.platform}/${sizes.hardware.arch}). Native compiler/key generation on the host; proving in Docker: ${run.details.proverEnvironment.dockerVM}.`, '',
  `**Memory.** The first full-account proof OOM-killed the proof server in the approximately 8 GiB Docker VM ([failure evidence](evidence/p256-webauthn/prover-8gib-oom.json)). The measured run uses a 24 GiB VM. Container lifetime memory peak: ${run.details.containerPeakMemoryBytes ? (run.details.containerPeakMemoryBytes / 2 ** 30).toFixed(2) + ' GiB (cgroup memory.peak, includes caches)' : 'not available'}. This is not an exact minimum-memory requirement.`, '',
  '**Evidence.** [Circuit sizes and exact key/ZKIR hashes](evidence/p256-webauthn/circuit-sizes.json); [proving samples, image identity and accepted transactions](evidence/p256-webauthn/conformance-and-proving.json). Account calls use an OpenSSL software authenticator; the two verifier probes prove the captured real high-S WebAuthn assertion. Negative assertions abort during local building. These results are separate from the earlier custom Rust proof-stack experiment.', '',
  '## Full account inventory', '',
  'All 52 circuits are compiled on the same stack. Sizes below are exact uncompressed bytes. A dash in other reports must not be interpreted as a measured proving time: only the comparison above has repeated timings.', '',
  '| Circuit | k | Rows | Prover bytes | Verifier bytes |',
  '|---|---:|---:|---:|---:|',
);
for (const r of sizes.circuits.filter(r => r.contract === 'account')) {
  lines.push(`| \`${r.circuit}\` | ${r.k} | ${r.rows} | ${r.assets.prover.bytes} | ${r.assets.verifier.bytes} |`);
}
lines.push('', '## Reproduce', '', '```sh', 'npm run compile', 'npm run measure:p256',
  'EVIDENCE_DIR=evidence/p256-webauthn MIDNIGHT_PROOF_CONTAINER=<container> npm run test:p256',
  'npm run report:p256', '```', '',
  'Configure `WALLET_SEED` and the standalone stack as in [README.md](README.md). See [WEBAUTHN.md](WEBAUTHN.md) for the profile, enrolment and specification deltas.', '');
writeFileSync(path.join(root, 'P256-MEASUREMENTS.md'), lines.join('\n'));
console.log(lines.slice(0, 12).join('\n'));

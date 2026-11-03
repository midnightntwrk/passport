import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const reference = '../contracts/reference/account.compact';
const source = readFileSync(new URL(reference, import.meta.url), 'utf8');
const sha = createHash('sha256').update(source).digest('hex');
const pinned = '1064b1998a71b5ade418f136428d82721e6021d6d939ff2f12797383bb3f8d50';
if (sha !== pinned) throw new Error('ACC source changed: review the instrumentation and update its pinned SHA explicitly');
mkdirSync('contracts/generated', { recursive: true });
mkdirSync('evidence', { recursive: true });
const manifest = { reference: 'contracts/reference/account.compact', sha256: sha,
  upstream: { path: 'contract/contracts/account.compact', revision: 'f519ff078ad461783baaacd513c1ad7eb6b4555a' },
  compiler: '0.35.0', runtime: '0.20.0', variants: {}, contracts: {} };
const compilerIdentity = execFileSync('compact', ['compile', '+0.35.0', '--version'], { encoding: 'utf8' }).trim();
const runtimeVersion = execFileSync('compact', ['compile', '+0.35.0', '--runtime-version'], { encoding: 'utf8' }).trim();
if (!compilerIdentity.startsWith('0.35.0 ') || runtimeVersion !== '0.20.0') {
  throw new Error(`unexpected toolchain identity: ${compilerIdentity}, runtime ${runtimeVersion}`);
}
manifest.compilerIdentity = compilerIdentity;

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`expected exactly one patch anchor: ${from}`);
  return text.replace(from, to);
}
function compile(sourcePath, name, keyed = false) {
  const args = ['compile', '+0.35.0', '--feature-zkir-v3',
    ...(keyed ? [] : ['--skip-zk']), sourcePath, `contracts/managed/${name}`];
  const start = performance.now();
  const output = execFileSync('compact', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(`evidence/compile-${name}.txt`, `compact ${args.join(' ')}\nCompleted successfully.\n${output}`);
  manifest.contracts[name] = { source: sourcePath,
    sha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), keyed };
  console.log(`${name}: compiled in ${Math.round(performance.now() - start)} ms (${keyed ? 'real keys' : 'ZKIR, no keys'})`);
}

// Real policy keys make the callee implementation-binding probe non-vacuous.
compile('contracts/policy.compact', 'Policy', true);
compile('contracts/policy-alternate.compact', 'PolicyAlternate', true);
compile('contracts/registry.compact', 'Registry', true);
compile('contracts/policy-dispatch.compact', 'Dispatch', true);

for (const variant of ['Baseline', 'Inline', 'ExternalRaw', 'ExternalTagged']) {
  const external = variant.startsWith('External');
  const tagged = variant === 'ExternalTagged';
  let text = source.replace('pragma language_version >= 0.17.0;', 'pragma language_version 0.27;');
  if (variant !== 'Baseline') {
    const declarations = `
// EXPERIMENT INSTRUMENTATION. Rules are fixed at ACC deployment, not caller-selected.
// true = must pass policy; false = explicitly unrestricted; absent = configured default.
export ledger experiment_rules: Map<Bytes<32>, Boolean>;
export ledger experiment_allow_unknown: Boolean;
${external ? 'contract Policy { circuit check(key: Bytes<32>): []; }\nexport ledger experiment_policy: Policy;' : 'export ledger experiment_frozen: Boolean;'}
${tagged ? 'export ledger experiment_salt_commit: Bytes<32>;\nwitness experiment_policy_salt(): Bytes<32>;' : ''}

circuit experiment_check_asset(actual_color: Bytes<32>): [] {
  ${tagged ? `const salt = experiment_policy_salt();
  assert(persistentHash<Bytes<32>>(salt) == experiment_salt_commit, "policy salt commitment mismatch");
  const key = persistentHash<[Bytes<32>, Bytes<32>, Bytes<32>]>([pad(32, "passport:policy-tag:v1"), salt, actual_color]);` : 'const key = actual_color;'}
  if (experiment_rules.member(disclose(key))) {
    if (experiment_rules.lookup(disclose(key))) {
      ${external ? 'experiment_policy.check(disclose(key));' : 'assert(!experiment_frozen, "asset frozen locally");'}
    }
  } else {
    assert(experiment_allow_unknown, "unregistered asset denied by ACC");
  }
}
`;
    text = replaceOnce(text, '// ── Constructor', `${declarations}\n// ── Constructor`);
    text = replaceOnce(text,
      'constructor(initial_device_boot: Bytes<32>, encryption_key: Bytes<32>) {',
      `constructor(initial_device_boot: Bytes<32>, encryption_key: Bytes<32>,
        required_key: Bytes<32>, unrestricted_key: Bytes<32>, allow_unknown: Boolean,
        ${external ? 'policy: Policy' : 'initially_frozen: Boolean'}${tagged ? ', salt_commitment: Bytes<32>' : ''}) {
      assert(required_key != unrestricted_key, "policy keys must differ");
      experiment_rules.insert(disclose(required_key), true);
      experiment_rules.insert(disclose(unrestricted_key), false);
      experiment_allow_unknown = disclose(allow_unknown);
      ${external ? 'experiment_policy = disclose(policy);' : 'experiment_frozen = disclose(initially_frozen);'}
      ${tagged ? 'experiment_salt_commit = disclose(salt_commitment);' : ''}`);
    // Gate the shared release chips, not one selected authentication entry point.
    // This covers both device arms, both grant arms, user and contract recipients.
    text = replaceOnce(text, '  debit_unshielded(c, a);', '  experiment_check_asset(c);\n  debit_unshielded(c, a);');
    const marker = '  const result = sendShielded(';
    if (text.split(marker).length !== 3) throw new Error('shielded release sites changed');
    text = text.replaceAll(marker, '  experiment_check_asset(coin.color);\n' + marker);
  }
  const filename = `contracts/generated/${variant}.compact`;
  const generated = '// GENERATED EXPERIMENT ONLY. See scripts/compile.mjs for the complete patch.\n' + text;
  writeFileSync(filename, generated);
  manifest.variants[variant] = { sha256: createHash('sha256').update(generated).digest('hex'),
    source: filename, releaseGuards: variant === 'Baseline' ? 0 : 3 };
  compile(filename, variant);
}
writeFileSync('evidence/provenance.json', JSON.stringify(manifest, null, 2) + '\n');

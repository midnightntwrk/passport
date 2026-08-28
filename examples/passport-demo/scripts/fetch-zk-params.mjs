// Stage the proving key material the in-browser prover needs (`?prover=browser`
// or VITE_BROWSER_PROVER=1) into examples/passport-demo/public/zk-params/.
//
// These are the same files the proof server downloads and verifies at startup
// (base-crypto data_provider: bls_midnight_2p<k> KZG SRS slices, plus the
// system/balancing circuit keys). Copied from
// experiments/account-custody-prototype/app/scripts/fetch-zk-params.mjs.
//
// The output directory is gitignored — do not commit downloaded parameters.
//
// Usage: node scripts/fetch-zk-params.mjs [kLo] [kHi]

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/';
const kLo = Number(process.argv[2] ?? '9');
const kHi = Number(process.argv[3] ?? '16');

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/zk-params');
mkdirSync(outDir, { recursive: true });

// The staged parameters are hundreds of megabytes of upstream binaries and must
// never enter git. The repository .gitignore is owned elsewhere, so the output
// directory ignores itself.
writeFileSync(resolve(outDir, '.gitignore'), '# Staged upstream proving parameters — never commit.\n*\n');

const fetchOne = async (name) => {
  const out = `${outDir}/${name}`;
  if (existsSync(out)) {
    console.log(`✓ ${name} (cached)`);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  const resp = await fetch(`${HOST}${name}`);
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  writeFileSync(out, Buffer.from(await resp.arrayBuffer()));
  console.log(`↓ ${name}`);
};

for (let k = kLo; k <= kHi; k++) await fetchOne(`bls_midnight_2p${k}`);

// System (balancing) circuits — zswap and dust, proof-server cache layout.
for (const circuit of ['zswap/9/spend', 'zswap/9/output', 'zswap/9/sign', 'dust/9/spend']) {
  for (const ext of ['prover', 'verifier', 'bzkir']) await fetchOne(`${circuit}.${ext}`);
}
console.log(`zk params staged in ${outDir}`);

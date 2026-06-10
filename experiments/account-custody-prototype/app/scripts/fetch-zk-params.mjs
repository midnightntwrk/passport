// Stage the KZG SRS slices the browser prover needs (?prover=browser) into
// app/public/zk-params/. These are the same files the proof server downloads
// and verifies at startup (base-crypto data_provider, bls_midnight_2p<k>).
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

for (let k = kLo; k <= kHi; k++) {
  const name = `bls_midnight_2p${k}`;
  const out = `${outDir}/${name}`;
  if (existsSync(out)) {
    console.log(`✓ ${name} (cached)`);
    continue;
  }
  const resp = await fetch(`${HOST}${name}`);
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  writeFileSync(out, Buffer.from(await resp.arrayBuffer()));
  console.log(`↓ ${name}`);
}
console.log(`SRS slices staged in ${outDir}`);

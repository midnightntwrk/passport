// Capture after the proof run, before stopping the dedicated container. The
// cgroup high-water mark includes all server work/cache since container start.
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const container = process.env.PROOF_CONTAINER ?? 'passport-webauthn-variable-prover';
const details = JSON.parse(docker('inspect', container))[0];
const image = JSON.parse(docker('image', 'inspect', details.Image))[0];
// This image's normal entry point is bash -c. Reuse its exact discovered path;
// the lean Nix image does not put coreutils (cat) on PATH.
const shell = image.Config.Entrypoint;
if (!Array.isArray(shell) || shell.at(-1) !== '-c') throw new Error('Expected image bash -c entry point');
const memory = JSON.parse(docker('exec', container, ...shell,
  String.raw`printf '{"peakBytes":%s,"currentBytes":%s}\n' "$(< /sys/fs/cgroup/memory.peak)" "$(< /sys/fs/cgroup/memory.current)"`));
const output = new URL('../../../evidence/webauthn-variable-json/', import.meta.url);
mkdirSync(output, { recursive: true });
const result = {
  recordedAt: new Date().toISOString(), hostCpu: cpus()[0].model, hostMemoryBytes: totalmem(),
  docker: JSON.parse(docker('info', '--format', '{{json .}}')),
  container: { name: container, startedAt: details.State.StartedAt, image: details.Config.Image,
    imageId: details.Image, oomKilled: details.State.OOMKilled, state: details.State.Status },
  cgroupMemory: memory,
  interpretation: 'Server-container high-water memory including cache since container start, across checks and proofs; not per-proof process RSS. Host compiler/runtime are outside this cgroup.',
};
// Retain just resource-relevant Docker fields, not machine/service configuration.
result.docker = { architecture: result.docker.Architecture, cpus: result.docker.NCPU, memoryBytes: result.docker.MemTotal,
  serverVersion: result.docker.ServerVersion };
writeFileSync(new URL('proof-resources.json', output), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

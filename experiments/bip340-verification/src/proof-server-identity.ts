import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const proofServerDigest = 'sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf';
export const proofServerImage = `midnightntwrk/proof-server:9.0.0-rc.8@${proofServerDigest}`;
const repositoryDigest = `midnightntwrk/proof-server@${proofServerDigest}`;

export type ContainerIdentity = {
  id: string; running: boolean; imageId: string; configuredImage: string;
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
};
export type ImageIdentity = { id: string; repositoryDigests: string[] };

export function validateProofServerIdentity(container: ContainerIdentity, image: ImageIdentity, endpoint: string) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(container.running, true, 'proof-server container must be running');
  assert.ok(image.repositoryDigests.includes(repositoryDigest), 'local image lacks the pinned repository digest');
  assert.equal(container.imageId, image.id, 'running proof-server image differs from the pinned image');
  const bindings = container.ports['6300/tcp'] ?? [];
  assert.ok(bindings.some(binding => binding.HostIp === url.hostname && binding.HostPort === (url.port || '80')),
    'proof-server container does not publish the requested loopback endpoint');
  return {
    requestedImage: proofServerImage,
    repositoryDigest,
    observedAt: new Date().toISOString(),
    containerId: container.id,
    configuredImage: container.configuredImage,
    observedImageId: container.imageId,
    observedRepositoryDigests: image.repositoryDigests,
    endpoint,
    verification: 'Local Docker inspection: running container image ID matches the pinned repository digest and publishes the loopback endpoint. This is local daemon evidence, not remote attestation.',
  };
}

export function inspectProofServerIdentity(endpoint: string) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const docker = (args: string[]) => execFileSync('docker', args,
    { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
  const containerId = process.env.PROOF_SERVER_CONTAINER ?? docker(['compose', 'ps', '-q', 'proof-server']);
  assert.ok(containerId.length > 0 && !/\s/.test(containerId),
    'start the compose proof-server service or set PROOF_SERVER_CONTAINER to one running container');
  const container = JSON.parse(docker(['container', 'inspect', containerId, '--format',
    '{"id":{{json .Id}},"running":{{json .State.Running}},"imageId":{{json .Image}},"configuredImage":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}'])) as ContainerIdentity;
  const image = JSON.parse(docker(['image', 'inspect', proofServerImage, '--format',
    '{"id":{{json .Id}},"repositoryDigests":{{json .RepoDigests}}}'])) as ImageIdentity;
  return validateProofServerIdentity(container, image, endpoint);
}

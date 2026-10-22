import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  proofServerDigest, proofServerImage, validateProofServerIdentity,
  type ContainerIdentity, type ImageIdentity,
} from './proof-server-identity.js';

const container: ContainerIdentity = { id: 'fixture-container', running: true,
  imageId: 'sha256:fixture-image', configuredImage: 'midnightntwrk/proof-server:9.0.0-rc.8',
  ports: { '6300/tcp': [{ HostIp: '127.0.0.1', HostPort: '6391' }] } };
const image: ImageIdentity = { id: container.imageId,
  repositoryDigests: [`midnightntwrk/proof-server@${proofServerDigest}`] };
const endpoint = 'http://127.0.0.1:6391';

test('records requested pin separately from the observed runtime image', () => {
  const result = validateProofServerIdentity(container, image, endpoint);
  assert.equal(result.requestedImage, proofServerImage);
  assert.equal(result.observedImageId, container.imageId);
  assert.equal(result.configuredImage, container.configuredImage);
});

test('rejects stopped, mismatched, unpinned or incorrectly published servers', () => {
  assert.throws(() => validateProofServerIdentity({ ...container, running: false }, image, endpoint), /must be running/);
  assert.throws(() => validateProofServerIdentity({ ...container, imageId: 'other' }, image, endpoint), /differs/);
  assert.throws(() => validateProofServerIdentity(container, { ...image, repositoryDigests: [] }, endpoint), /lacks the pinned/);
  assert.throws(() => validateProofServerIdentity({ ...container, ports: {} }, image, endpoint), /loopback endpoint/);
  assert.throws(() => validateProofServerIdentity({ ...container,
    ports: { '6300/tcp': [{ HostIp: '0.0.0.0', HostPort: '6391' }] } }, image, endpoint), /loopback endpoint/);
});

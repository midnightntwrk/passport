/**
 * A throwaway static server over the demo's staged ZK artefacts.
 *
 * `contractAssetBase` in the app serves prover keys, verifier keys, ZKIR, and
 * the integrity manifest from `window.location.origin` in a browser, and from
 * `PASSPORT_ZK_ORIGIN` when there is no window. A Node harness must NOT fake a
 * window: a partial stub flips the wasm runtime's environment sniffing into
 * browser paths and circuit execution dies in an `unreachable` trap. So the
 * bench names a static server instead, exactly as the `.live-drill` harnesses
 * do.
 *
 * ONE server for the whole run rather than one per worker. Ten workers each
 * standing up their own copy of a file server over the same directory would be
 * ten times the file descriptors to measure nothing extra; the artefacts are
 * identical for every virtual user and the fetch is local, sub-millisecond, and
 * not part of anything this bench is trying to time.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, normalize } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.bzkir': 'application/octet-stream',
  '.prover': 'application/octet-stream',
  '.verifier': 'application/octet-stream',
};

export interface ArtefactServer {
  origin: string;
  close(): Promise<void>;
}

export async function serveArtefacts(publicDirectory: string): Promise<ArtefactServer> {
  const server: Server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0] as string));
    const file = join(publicDirectory, path);
    /* Path traversal out of the served directory is a 403 rather than a read.
       Nothing here is reachable from off the machine, but a harness that will
       happily serve `../../.env` is a harness nobody should copy. */
    if (!file.startsWith(publicDirectory)) {
      response.writeHead(403).end();
      return;
    }
    stat(file)
      .then((stats) => {
        if (!stats.isFile()) throw new Error('not a file');
        const extension = path.slice(path.lastIndexOf('.'));
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'content-length': String(stats.size),
        });
        createReadStream(file).pipe(response);
      })
      .catch(() => {
        response.writeHead(404).end();
      });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the artefact server took no port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

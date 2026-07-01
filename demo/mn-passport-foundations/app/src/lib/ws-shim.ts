// Browser shim for isomorphic-ws: its browser build only has a default
// export, but @midnight-ntwrk/midnight-js-indexer-public-data-provider does
// a named `import { WebSocket }`. Alias resolves here instead (vite.config).

export const WebSocket = globalThis.WebSocket;
export default globalThis.WebSocket;

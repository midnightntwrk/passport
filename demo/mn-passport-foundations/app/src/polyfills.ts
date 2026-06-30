// Node-global shims for the wallet SDK in the browser. Must be the first
// import of main.tsx.

import { Buffer } from 'buffer';

const g = globalThis as any;
g.Buffer = g.Buffer ?? Buffer;
g.global = g.global ?? globalThis;
g.process = g.process ?? { env: {} };

/**
 * Defines the `Buffer` global before anything that expects it evaluates.
 *
 * Several Midnight SDK modules reference the bare `Buffer` global (not the
 * `buffer` import), which exists in Node and not in browsers. The Vite config
 * aliases the `buffer` MODULE to the workspace ponyfill, but an alias cannot
 * conjure a global — so any chunk that touches `Buffer` at evaluation time
 * crashes with "Can't find variable: Buffer" (seen live 2026/08/24, the first
 * deploy after SendSheet's shielded mode pulled the address codec into an
 * eagerly evaluated chunk).
 *
 * This module MUST be the first import in main.tsx: ES modules evaluate
 * depth-first in import order, so being first here is what makes the global
 * exist for everything after it, including every lazily loaded chunk.
 */
import { Buffer } from 'buffer';

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

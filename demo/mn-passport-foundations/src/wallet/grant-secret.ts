import { hexToBytes } from './hex.js';

/** Parse a pasted grant credential before creating a wallet connection. */
export function parseGrantSecret(input: string): Uint8Array {
  const secret = hexToBytes(input.trim());
  if (secret.length !== 32) throw new Error('grant secret must be exactly 32 bytes');
  return secret;
}

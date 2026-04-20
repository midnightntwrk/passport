/**
 * Witness provider for the fungible-token contract.
 *
 * The single witness `get_user_shielded_address` supplies the caller's
 * Zswap coin public key to the ZK proof server without ever disclosing
 * it in the public transaction payload.
 *
 * Usage (mn-tui Deploy screen):
 *   Witnesses JS path: contracts/witness-provider/fungible-token.js
 *
 * @param {object} walletProvider  Wallet provider supplied by useWalletSync.
 *   getCoinPublicKey(): string    Hex-encoded 32-byte Zswap coin public key.
 * @returns {object}  Witnesses object consumed by CompiledContract.withWitnesses().
 */
export default function makeWitnesses(walletProvider) {
  return {
    /**
     * Returns the caller's shielded coin public key as a ZswapCoinPublicKey
     * value understood by the Compact runtime ({ bytes: Uint8Array<32> }).
     *
     * Signature required by the compiled contract:
     *   get_user_shielded_address(context): [privateState, { bytes: Uint8Array }]
     */
    get_user_shielded_address(context) {
      const hex = walletProvider.getCoinPublicKey().replace(/^0x/, '');
      const buf = Buffer.from(hex, 'hex');
      const bytes = new Uint8Array(32);
      bytes.set(buf.subarray(0, Math.min(32, buf.length)));
      return [context.privateState, { bytes }];
    },
  };
}

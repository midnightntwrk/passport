import { describe, expect, it } from 'vitest';

import { BlockedSigNetworkAdapter } from '../src/index.js';

describe('Sig.Network boundary', () => {
  it('reports missing external dependencies without presenting a fake route', async () => {
    const adapter = new BlockedSigNetworkAdapter();

    expect(adapter.readiness).toBe('blocked');
    expect(adapter.explainBlocker()).toContain('deployed Midnight vault');
    await expect(
      adapter.settle({
        sourceChain: 'sepolia',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        amount: 1n,
        recipient: 'mn_test_recipient',
      }),
    ).rejects.toThrow('Sig.Network is not configured');
  });
});

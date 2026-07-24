import { describe, expect, it, vi } from 'vitest';

import {
  BlockedSigNetworkAdapter,
  SigNetworkProtocolAdapter,
  type SigNetworkDepositDriver,
  type SigNetworkRequirements,
} from '../src/index.js';

const requirements: SigNetworkRequirements = {
  vaultAddress: '0200vault',
  signetContractAddress: '0200signet',
  mpcRootPublicKey: '03abc',
  midnightIndexerUrl: 'http://localhost:8088/api/v1/graphql',
  evmRpcUrl: 'http://localhost:8545',
  erc20Address: '0x0000000000000000000000000000000000000001',
  integrationVersion: '@sig-net/midnight@0.10.0',
  runtime: 'ledger-9',
};

describe('Sig.Network boundary', () => {
  it('reports missing external dependencies without presenting a fake route', async () => {
    const adapter = new BlockedSigNetworkAdapter();

    expect(adapter.readiness).toBe('blocked');
    expect(adapter.explainBlocker()).toContain('ledger-9 ERC20 vault');
    await expect(
      adapter.settle({
        sourceChain: 'sepolia',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        amount: 1n,
        recipient: 'mn_test_recipient',
      }),
    ).rejects.toThrow('Sig.Network is not configured');
  });

  it('drives all five protocol stages and returns transaction evidence', async () => {
    const calls: string[] = [];
    const driver: SigNetworkDepositDriver<{ signature: string }> = {
      requestDeposit: vi.fn(async () => {
        calls.push('request');
        return { requestId: 'ab'.repeat(32), midnightTransactionHash: 'mn-request-tx' };
      }),
      waitForVerifiedSignature: vi.fn(async () => {
        calls.push('signature');
        return { serialized: '0x02signed' };
      }),
      broadcastForeignTransaction: vi.fn(async () => {
        calls.push('broadcast');
        return { externalTransactionHash: '0xevm' };
      }),
      waitForExecutionAttestation: vi.fn(async () => {
        calls.push('attestation');
        return { signature: '0xattested' };
      }),
      claimShieldedAsset: vi.fn(async () => {
        calls.push('claim');
        return { midnightTransactionHash: 'mn-claim-tx' };
      }),
    };
    const adapter = new SigNetworkProtocolAdapter(requirements, driver);

    const result = await adapter.settle({
      sourceChain: 'anvil',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      amount: 100_000n,
      recipient: 'mn_shielded_recipient',
    });

    expect(calls).toEqual(['request', 'signature', 'broadcast', 'attestation', 'claim']);
    expect(result.status).toBe('confirmed');
    expect(result.externalTransactionHash).toBe('0xevm');
    expect(result.midnightTransactionHash).toBe('mn-claim-tx');
    expect(result.evidence.map((entry) => entry.stage)).toEqual(calls);
  });

  it('stops immediately when a protocol stage fails', async () => {
    const driver: SigNetworkDepositDriver = {
      requestDeposit: async () => {
        throw new Error('vault unavailable');
      },
      waitForVerifiedSignature: vi.fn(),
      broadcastForeignTransaction: vi.fn(),
      waitForExecutionAttestation: vi.fn(),
      claimShieldedAsset: vi.fn(),
    };
    const adapter = new SigNetworkProtocolAdapter(requirements, driver);

    await expect(
      adapter.settle({
        sourceChain: 'anvil',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        amount: 1n,
        recipient: 'mn_shielded_recipient',
      }),
    ).rejects.toThrow('vault unavailable');
    expect(driver.waitForVerifiedSignature).not.toHaveBeenCalled();
  });
});

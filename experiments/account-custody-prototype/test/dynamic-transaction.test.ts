import { describe, expect, it, vi } from 'vitest';

import {
  submitDynamicTransaction,
  type DynamicTransactionSigner,
} from '../src/wallet/dynamic-transaction.js';

const serializedTransaction = btoa('real proved unbound C1 transaction bytes');
const finalizedTransaction = btoa('real finalized C1 transaction bytes');

function signer(overrides: Partial<DynamicTransactionSigner> = {}): DynamicTransactionSigner {
  return {
    address: 'mn_addr_test',
    signMessage: vi.fn(async () => 'approval-signature'),
    signTransaction: vi.fn(async () => finalizedTransaction),
    submitTransaction: vi.fn(async () => ({ txHash: 'tx-123' })),
    ...overrides,
  };
}

const intent = {
  network: 'preview',
  contractAddress: 'ab'.repeat(32),
  circuit: 'deposit_night',
  summary: 'Deposit 25 NIGHT into MN Passport',
  arguments: {
    amount: '25',
    tokenType: '00'.repeat(32),
  },
};

describe('Dynamic C1 transaction submission', () => {
  it('binds the approval to the transaction and submits Dynamic finalization', async () => {
    const calls: string[] = [];
    const wallet = signer({
      signMessage: vi.fn(async (message) => {
        calls.push('approval');
        expect(message).toContain('Circuit: deposit_night');
        expect(message).toContain('Wallet: mn_addr_test');
        expect(message).toMatch(/Unbound transaction SHA-256: [0-9a-f]{64}/);
        expect(message).toMatch(/Finalized transaction SHA-256: [0-9a-f]{64}/);
        return 'approval-signature';
      }),
      signTransaction: vi.fn(async (transaction) => {
        calls.push('transaction');
        expect(transaction).toBe(serializedTransaction);
        return finalizedTransaction;
      }),
      submitTransaction: vi.fn(async (transaction) => {
        calls.push('submit');
        expect(transaction).toBe(finalizedTransaction);
        return { txHash: 'tx-123' };
      }),
    });

    const receipt = await submitDynamicTransaction({
      wallet,
      serializedTransaction,
      intent,
      now: new Date('2026-07-23T12:00:00.000Z'),
      currentTime: () => new Date('2026-07-23T12:01:00.000Z'),
      nonce: 'nonce-1',
    });

    expect(calls).toEqual(['transaction', 'approval', 'submit']);
    expect(receipt.txHash).toBe('tx-123');
    expect(receipt.approvalSignature).toBe('approval-signature');
    expect(receipt.approvalSignatureFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.unboundTransactionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.finalizedTransactionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.finalizedTransactionDigest).not.toBe(receipt.unboundTransactionDigest);
  });

  it('releases the unsubmitted finalization when Dynamic omits the approval signature', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const wallet = signer({
      signMessage: vi.fn(async () => undefined),
      revertTransaction,
    });

    await expect(
      submitDynamicTransaction({ wallet, serializedTransaction, intent }),
    ).rejects.toThrow(/approval signature/);
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });

  it('does not submit when Dynamic cannot finalize the actual transaction', async () => {
    const wallet = signer({ signTransaction: vi.fn(async () => '') });

    await expect(
      submitDynamicTransaction({ wallet, serializedTransaction, intent }),
    ).rejects.toThrow(/finalized Midnight transaction/);
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects and releases data that is not a valid finalized Midnight transaction', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const wallet = signer({ revertTransaction });

    await expect(
      submitDynamicTransaction({
        wallet,
        serializedTransaction,
        intent,
        validateFinalizedTransaction: () => {
          throw new Error('not a FinalizedTransaction');
        },
      }),
    ).rejects.toThrow(/not a FinalizedTransaction/);
    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });

  it('does not release a finalized reservation until an uncertain broadcast is reconciled', async () => {
    const broadcastError = new Error('preview node rejected transaction');
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const wallet = signer({
      submitTransaction: vi.fn(async () => {
        throw broadcastError;
      }),
      revertTransaction,
    });

    await expect(
      submitDynamicTransaction({ wallet, serializedTransaction, intent }),
    ).rejects.toBe(broadcastError);
    expect(revertTransaction).not.toHaveBeenCalled();
  });

  it('releases the finalization when the readable approval window has expired', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const wallet = signer({ revertTransaction });

    await expect(
      submitDynamicTransaction({
        wallet,
        serializedTransaction,
        intent,
        now: new Date('2026-07-23T12:00:00.000Z'),
        currentTime: () => new Date('2026-07-23T12:06:00.000Z'),
      }),
    ).rejects.toThrow(/expired before review/);
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(wallet.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });
});

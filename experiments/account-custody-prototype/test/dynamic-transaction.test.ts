import { describe, expect, it, vi } from 'vitest';

import {
  createDynamicMidnightProofProvider,
  DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
  DynamicMidnightProofCapabilityError,
  submitDynamicTransaction,
  type DynamicMidnightProofRequest,
  type DynamicTransactionAuthorizer,
  type DynamicTransactionBroadcaster,
} from '../src/wallet/dynamic-transaction.js';

const serializedTransaction = btoa('real call-proved unbound C1 transaction bytes');
const finalizedTransaction = btoa('real balanced and finalized C1 transaction bytes');
const metadata = {
  packageName: '@dynamic-labs/midnight',
  packageVersion: '4.96.0',
};

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

function proofApi(overrides: Record<string, unknown> = {}) {
  return {
    getMidnightProofCapabilities: vi.fn(async () => ({
      protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
      operations: ['balance-and-finalize'],
      inputTransaction: 'unbound',
      outputTransaction: 'finalized',
      callerBroadcasts: true,
    })),
    proveMidnightTransaction: vi.fn(
      async (request: DynamicMidnightProofRequest) => ({
        protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
        operation: request.operation,
        inputTransactionDigest: request.inputTransactionDigest,
        finalizedTransaction,
      }),
    ),
    ...overrides,
  };
}

function authorizer(
  overrides: Partial<DynamicTransactionAuthorizer> = {},
): DynamicTransactionAuthorizer {
  return {
    address: 'mn_addr_test',
    signMessage: vi.fn(async () => 'approval-signature'),
    ...overrides,
  };
}

function broadcaster(
  overrides: Partial<DynamicTransactionBroadcaster> = {},
): DynamicTransactionBroadcaster {
  return {
    submitTransaction: vi.fn(async () => ({ txHash: 'tx-123' })),
    ...overrides,
  };
}

describe('Dynamic C1 proof capability', () => {
  it('reports a transfer-only surface as externally blocked even when its transfer signer exists', async () => {
    const transferOnlyApi = {
      createTransferTransaction: vi.fn(),
      signTransaction: vi.fn(),
      submitTransaction: vi.fn(),
    };
    const provider = createDynamicMidnightProofProvider(
      transferOnlyApi,
      metadata,
    );

    await expect(provider.probe()).resolves.toEqual({
      ...metadata,
      status: 'externally_blocked',
      code: 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_UNAVAILABLE',
      missingMethods: [
        'getMidnightProofCapabilities',
        'proveMidnightTransaction',
      ],
      reason: expect.stringContaining('UnboundTransaction balance-proof contract'),
    });
  });

  it('rejects an API that cannot advertise the exact caller-broadcast contract', async () => {
    const provider = createDynamicMidnightProofProvider(
      proofApi({
        getMidnightProofCapabilities: vi.fn(async () => ({
          protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
          operations: ['balance-and-finalize'],
          inputTransaction: 'unproven',
          outputTransaction: 'finalized',
          callerBroadcasts: true,
        })),
      }),
      metadata,
    );

    await expect(provider.probe()).resolves.toMatchObject({
      status: 'externally_blocked',
      code: 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_INCOMPATIBLE',
    });
  });

  it('turns capability transport failures into an explicit blocked result', async () => {
    const provider = createDynamicMidnightProofProvider(
      proofApi({
        getMidnightProofCapabilities: vi.fn(async () => {
          throw new Error('iframe method unavailable');
        }),
      }),
      metadata,
    );

    await expect(provider.probe()).resolves.toMatchObject({
      status: 'externally_blocked',
      code: 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_CAPABILITY_PROBE_FAILED',
      reason: expect.stringContaining('iframe method unavailable'),
    });
  });
});

describe('Dynamic C1 transaction submission', () => {
  it('gets proof material, binds approval to exact bytes, and broadcasts that result', async () => {
    const calls: string[] = [];
    const api = proofApi({
      getMidnightProofCapabilities: vi.fn(async () => {
        calls.push('capability');
        return {
          protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
          operations: ['balance-and-finalize'],
          inputTransaction: 'unbound',
          outputTransaction: 'finalized',
          callerBroadcasts: true,
        };
      }),
      proveMidnightTransaction: vi.fn(
        async (request: DynamicMidnightProofRequest) => {
          calls.push('proof');
          expect(request.serializedTransaction).toBe(serializedTransaction);
          expect(request.walletAddress).toBe('mn_addr_test');
          expect(request.network).toBe('preview');
          expect(request.operation).toBe('balance-and-finalize');
          expect(request.inputTransactionDigest).toMatch(/^[0-9a-f]{64}$/);
          expect(JSON.stringify(request)).not.toMatch(
            /secret|private.?key|key.?material/i,
          );
          return {
            protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
            operation: request.operation,
            inputTransactionDigest: request.inputTransactionDigest,
            finalizedTransaction,
          };
        },
      ),
    });
    const approval = authorizer({
      signMessage: vi.fn(async (message) => {
        calls.push('approval');
        expect(message).toContain('Circuit: deposit_night');
        expect(message).toContain('Wallet: mn_addr_test');
        expect(message).toContain(
          `Proof protocol: ${DYNAMIC_MIDNIGHT_PROOF_PROTOCOL}`,
        );
        expect(message).toContain('Proof operation: balance-and-finalize');
        expect(message).toMatch(/Unbound transaction SHA-256: [0-9a-f]{64}/);
        expect(message).toMatch(/Finalized transaction SHA-256: [0-9a-f]{64}/);
        return 'approval-signature';
      }),
    });
    const backend = broadcaster({
      submitTransaction: vi.fn(async (transaction) => {
        calls.push('broadcast');
        expect(transaction).toBe(finalizedTransaction);
        return { txHash: 'tx-123' };
      }),
    });

    const receipt = await submitDynamicTransaction({
      authorizer: approval,
      proofProvider: createDynamicMidnightProofProvider(api, metadata),
      broadcaster: backend,
      serializedTransaction,
      intent,
      now: new Date('2026-07-23T12:00:00.000Z'),
      currentTime: () => new Date('2026-07-23T12:01:00.000Z'),
      nonce: 'nonce-1',
    });

    expect(calls).toEqual(['capability', 'proof', 'approval', 'broadcast']);
    expect(receipt.txHash).toBe('tx-123');
    expect(receipt.approvalSignature).toBe('approval-signature');
    expect(receipt.approvalSignatureFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.unboundTransactionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.finalizedTransactionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.finalizedTransactionDigest).not.toBe(
      receipt.unboundTransactionDigest,
    );
    expect(receipt.proofProtocol).toBe(DYNAMIC_MIDNIGHT_PROOF_PROTOCOL);
    expect(receipt.proofOperation).toBe('balance-and-finalize');
  });

  it('fails closed before approval or broadcast when the Compact proof API is absent', async () => {
    const transferSignTransaction = vi.fn();
    const approval = authorizer();
    const backend = broadcaster();
    const provider = createDynamicMidnightProofProvider(
      {
        createTransferTransaction: vi.fn(),
        signTransaction: transferSignTransaction,
        submitTransaction: vi.fn(),
      },
      metadata,
    );

    const result = submitDynamicTransaction({
      authorizer: approval,
      proofProvider: provider,
      broadcaster: backend,
      serializedTransaction,
      intent,
    });

    await expect(result).rejects.toBeInstanceOf(
      DynamicMidnightProofCapabilityError,
    );
    await expect(result).rejects.toMatchObject({
      result: {
        status: 'externally_blocked',
        code: 'DYNAMIC_MIDNIGHT_COMPACT_PROOF_API_UNAVAILABLE',
      },
    });
    expect(transferSignTransaction).not.toHaveBeenCalled();
    expect(approval.signMessage).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects proof material that is not bound to the requested transaction', async () => {
    const approval = authorizer();
    const backend = broadcaster();
    const provider = createDynamicMidnightProofProvider(
      proofApi({
        proveMidnightTransaction: vi.fn(
          async (request: DynamicMidnightProofRequest) => ({
            protocol: DYNAMIC_MIDNIGHT_PROOF_PROTOCOL,
            operation: request.operation,
            inputTransactionDigest: 'ff'.repeat(32),
            finalizedTransaction,
          }),
        ),
      }),
      metadata,
    );

    await expect(
      submitDynamicTransaction({
        authorizer: approval,
        proofProvider: provider,
        broadcaster: backend,
        serializedTransaction,
        intent,
      }),
    ).rejects.toThrow(/invalid Compact proof response/);
    expect(approval.signMessage).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
  });

  it('releases the unsubmitted finalization when Dynamic omits the approval signature', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const approval = authorizer({
      signMessage: vi.fn(async () => undefined),
    });
    const backend = broadcaster({ revertTransaction });

    await expect(
      submitDynamicTransaction({
        authorizer: approval,
        proofProvider: createDynamicMidnightProofProvider(proofApi(), metadata),
        broadcaster: backend,
        serializedTransaction,
        intent,
      }),
    ).rejects.toThrow(/approval signature/);
    expect(backend.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });

  it('rejects and releases data that is not a valid finalized Midnight transaction', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const approval = authorizer();
    const backend = broadcaster({ revertTransaction });

    await expect(
      submitDynamicTransaction({
        authorizer: approval,
        proofProvider: createDynamicMidnightProofProvider(proofApi(), metadata),
        broadcaster: backend,
        serializedTransaction,
        intent,
        validateFinalizedTransaction: () => {
          throw new Error('not a FinalizedTransaction');
        },
      }),
    ).rejects.toThrow(/not a FinalizedTransaction/);
    expect(approval.signMessage).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });

  it('does not release a finalized reservation until an uncertain broadcast is reconciled', async () => {
    const broadcastError = new Error('preview node rejected transaction');
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const backend = broadcaster({
      submitTransaction: vi.fn(async () => {
        throw broadcastError;
      }),
      revertTransaction,
    });

    await expect(
      submitDynamicTransaction({
        authorizer: authorizer(),
        proofProvider: createDynamicMidnightProofProvider(proofApi(), metadata),
        broadcaster: backend,
        serializedTransaction,
        intent,
      }),
    ).rejects.toBe(broadcastError);
    expect(revertTransaction).not.toHaveBeenCalled();
  });

  it('releases the finalization when the readable approval window has expired', async () => {
    const revertTransaction = vi.fn(async () => ({ success: true }));
    const approval = authorizer();
    const backend = broadcaster({ revertTransaction });

    await expect(
      submitDynamicTransaction({
        authorizer: approval,
        proofProvider: createDynamicMidnightProofProvider(proofApi(), metadata),
        broadcaster: backend,
        serializedTransaction,
        intent,
        now: new Date('2026-07-23T12:00:00.000Z'),
        currentTime: () => new Date('2026-07-23T12:06:00.000Z'),
      }),
    ).rejects.toThrow(/expired before review/);
    expect(approval.signMessage).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
    expect(revertTransaction).toHaveBeenCalledWith(finalizedTransaction);
  });
});

// Unit tests for the Dynamic approval receipt. These pin the property the
// deposit flow depends on: an approval only exists if the wallet actually
// signed the exact intent, and the caller can always show what was signed.

import { describe, it, expect } from 'vitest';

import {
  buildDynamicApprovalMessage,
  createDynamicApproval,
  fingerprintDynamicSignature,
  isDynamicApprovalLive,
  type DynamicApprovalIntent,
} from '../src/wallet/dynamic-approval.js';

const INTENT: DynamicApprovalIntent = {
  network: 'preview',
  walletAddress: 'mn_addr_test1wallet',
  contractAddress: '0200deadbeef',
  circuit: 'deposit_night',
  summary: 'Deposit 1000 NIGHT into the MN Passport custody account',
  arguments: { tokenType: '00ff', amount: '1000' },
};

const NOW = new Date('2026-07-27T12:00:00.000Z');

describe('dynamic approval message', () => {
  it('names the contract, the circuit, and every argument', () => {
    const message = buildDynamicApprovalMessage(INTENT, {
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: 'nonce-1',
    });

    expect(message).toContain('Contract: 0200deadbeef');
    expect(message).toContain('Circuit: deposit_night');
    expect(message).toContain('amount: 1000');
    expect(message).toContain('tokenType: 00ff');
    expect(message).toContain('Nonce: nonce-1');
  });

  it('orders arguments deterministically so the same intent signs identically', () => {
    const stamps = {
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: 'nonce-1',
    };
    const reordered: DynamicApprovalIntent = {
      ...INTENT,
      arguments: { amount: '1000', tokenType: '00ff' },
    };

    expect(buildDynamicApprovalMessage(reordered, stamps)).toBe(
      buildDynamicApprovalMessage(INTENT, stamps),
    );
  });

  it('changes when any argument changes', () => {
    const stamps = {
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: 'nonce-1',
    };

    expect(
      buildDynamicApprovalMessage(
        { ...INTENT, arguments: { ...INTENT.arguments, amount: '1001' } },
        stamps,
      ),
    ).not.toBe(buildDynamicApprovalMessage(INTENT, stamps));
  });
});

describe('createDynamicApproval', () => {
  it('returns the signature the wallet produced, with a fingerprint over it', async () => {
    let signed = '';
    const approval = await createDynamicApproval({
      intent: INTENT,
      now: NOW,
      nonce: 'nonce-1',
      signMessage: async (message) => {
        signed = message;
        return 'signature-bytes';
      },
    });

    expect(approval.signature).toBe('signature-bytes');
    expect(approval.message).toBe(signed);
    expect(approval.fingerprint).toBe(await fingerprintDynamicSignature('signature-bytes'));
    expect(approval.circuit).toBe('deposit_night');
    expect(approval.walletAddress).toBe(INTENT.walletAddress);
  });

  it('fails when the wallet returns nothing, so nothing can be broadcast on it', async () => {
    await expect(
      createDynamicApproval({
        intent: INTENT,
        now: NOW,
        signMessage: async () => undefined,
      }),
    ).rejects.toThrow(/no signature/i);

    await expect(
      createDynamicApproval({
        intent: INTENT,
        now: NOW,
        signMessage: async () => '',
      }),
    ).rejects.toThrow(/no signature/i);
  });

  it('propagates a rejected signature request instead of continuing unsigned', async () => {
    await expect(
      createDynamicApproval({
        intent: INTENT,
        now: NOW,
        signMessage: async () => {
          throw new Error('user rejected the request');
        },
      }),
    ).rejects.toThrow(/user rejected/);
  });

  it('expires', async () => {
    const approval = await createDynamicApproval({
      intent: INTENT,
      now: NOW,
      ttlMs: 60_000,
      signMessage: async () => 'signature-bytes',
    });

    expect(isDynamicApprovalLive(approval, new Date(NOW.getTime() + 59_000))).toBe(true);
    expect(isDynamicApprovalLive(approval, new Date(NOW.getTime() + 61_000))).toBe(false);
  });
});

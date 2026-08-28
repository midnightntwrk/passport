/**
 * Drills for the per-network endpoint tables and the guards over them.
 *
 * This module exists because the demo used to be pinned to Preview in a dozen
 * places, and pointing the deployment elsewhere left the UI saying "preview
 * only" and linking at the Preview faucet. So the things drilled here are the
 * ones that produce a LIE on screen when they are wrong: a link that resolves
 * to nothing, a faucet for a network that has none, a claim path offered on a
 * network this build's ledger cannot speak.
 *
 * Every environment-reading function is drilled through the optional `env`
 * parameter each of them carries, not by rewriting the ambient one. Both
 * alternatives were measured here on 2026/08/25 and neither reaches the module:
 * `vi.stubEnv` writes `process.env` and leaves vitest's `import.meta.env`
 * untouched, and writing `import.meta.env` from a test writes the TEST file's
 * `import.meta`, which the SSR transform gives each module separately. A test
 * built on either would pass against a value `networks.ts` never sees.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAIMABLE_NETWORKS,
  DEFAULT_NETWORK_ID,
  EXPLORER_URLS,
  FAUCET_URLS,
  TRANSACTABLE_NETWORKS,
  aliasRegistrationSupported,
  asPassportNetwork,
  configuredNetworkId,
  defaultSelectedNetwork,
  explorerTxUrl,
  txReceiptLink,
  verifierNameUrl,
  VERIFIER_URL,
  explorerUrlFor,
  faucetAvailable,
  faucetUrlFor,
  isLedgerTxHash,
  networkIsTransactable,
  networkUnavailableReason,
  walletNetwork,
} from './networks.js';

/** A real 32-byte ledger transaction hash: 64 hex characters. */
const TX_HASH = 'ea39f2c1b47d80a95e6f3c2d1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e';
/** What `submitTransaction` answers with: a 33-byte IDENTIFIER, 66 characters. */
const TX_IDENTIFIER = `00${TX_HASH}`;

describe('what this build can actually do', () => {
  it('transacts on stagenet and on nothing else', () => {
    expect(TRANSACTABLE_NETWORKS).toEqual(['stagenet']);
    expect(DEFAULT_NETWORK_ID).toBe('stagenet');
    expect(networkIsTransactable('stagenet')).toBe(true);
    for (const network of ['preview', 'preprod', 'mainnet', 'undeployed', null, undefined]) {
      expect(networkIsTransactable(network)).toBe(false);
    }
  });

  it('registers a name on stagenet and on nothing else', () => {
    expect(CLAIMABLE_NETWORKS).toEqual(['stagenet']);
    expect(aliasRegistrationSupported('stagenet')).toBe(true);
    // Mainnet was always absent: a wallet seeded from a browser passkey has no
    // business spending real NIGHT.
    for (const network of ['preview', 'preprod', 'mainnet', 'undeployed', null, undefined]) {
      expect(aliasRegistrationSupported(network)).toBe(false);
    }
  });
});

describe('networkUnavailableReason', () => {
  it('says nothing about a network that works', () => {
    expect(networkUnavailableReason('stagenet')).toBeNull();
  });

  it('names the ledger-9 protocol gap for the two ledger-8 networks', () => {
    for (const network of ['preview', 'preprod']) {
      const reason = networkUnavailableReason(network);
      expect(reason).toContain('ledger-9 protocol');
      expect(reason).toContain(network);
      // Already-registered names still resolve there; the sentence says so.
      expect(reason).toContain('still resolve');
    }
  });

  it('gives mainnet its own, different reason', () => {
    expect(networkUnavailableReason('mainnet')).toContain('no business spending real NIGHT');
  });

  it('has nothing to say about a network it does not know', () => {
    // A devnet id is not a KNOWN network, so there is no honest sentence to
    // show — and inventing one would be worse than the switcher's silence.
    expect(networkUnavailableReason('undeployed')).toBeNull();
    expect(networkUnavailableReason(null)).toBeNull();
    expect(networkUnavailableReason(undefined)).toBeNull();
  });
});

describe('asPassportNetwork', () => {
  it('narrows the four public networks and refuses everything else', () => {
    for (const network of ['stagenet', 'preview', 'preprod', 'mainnet']) {
      expect(asPassportNetwork(network)).toBe(network);
    }
    expect(asPassportNetwork('undeployed')).toBeNull();
    expect(asPassportNetwork('')).toBeNull();
    expect(asPassportNetwork(null)).toBeNull();
    expect(asPassportNetwork(undefined)).toBeNull();
  });
});

describe('configuredNetworkId', () => {
  it('reads the build’s own id, trimming it, and defaults to stagenet', () => {
    expect(configuredNetworkId({ VITE_MIDNIGHT_NETWORK_ID: '  preview  ' })).toBe('preview');
    expect(configuredNetworkId({ VITE_MIDNIGHT_NETWORK_ID: '   ' })).toBe('stagenet');
    expect(configuredNetworkId({})).toBe('stagenet');
  });

  it('reads the build’s own environment when nothing is passed', () => {
    /* The zero-argument form is what every caller in the app uses. It cannot
       be told what to read, so what is asserted is the invariant that holds
       for any build: an id, never an empty string. */
    expect(configuredNetworkId()).toMatch(/^\S+$/);
  });
});

describe('walletNetwork and defaultSelectedNetwork', () => {
  it('answers with the configured public network', () => {
    const env = { VITE_MIDNIGHT_NETWORK_ID: 'preview' };
    expect(walletNetwork(env)).toBe('preview');
    expect(defaultSelectedNetwork(env)).toBe('preview');
  });

  it('reads the build’s own environment when nothing is passed', () => {
    // Whatever this build is, the switcher always opens on a known network.
    expect(asPassportNetwork(defaultSelectedNetwork())).not.toBeNull();
  });

  it('is null on a devnet build, and the switcher falls back to the default', () => {
    const env = { VITE_MIDNIGHT_NETWORK_ID: 'undeployed' };
    expect(walletNetwork(env)).toBeNull();
    // The switcher still has to show SOMETHING, so it shows the documented
    // default — while the wallet keeps signing on its real configured network.
    expect(defaultSelectedNetwork(env)).toBe('stagenet');
    // An override present but blank is not an override.
    expect(walletNetwork({ ...env, VITE_MIDNAMES_TLD_ADDRESS: '   ' })).toBeNull();
  });

  it('lets a devnet build carrying a local TLD present as the default network', () => {
    /* The env-gated demo masquerade. Public builds never set this, so the
       branch is dead there and behaviour is byte-identical. */
    const env = {
      VITE_MIDNIGHT_NETWORK_ID: 'undeployed',
      VITE_MIDNAMES_TLD_ADDRESS: 'be'.repeat(32),
    };
    expect(walletNetwork(env)).toBe('stagenet');
    expect(defaultSelectedNetwork(env)).toBe('stagenet');
  });
});

describe('faucets', () => {
  it('names one only where a public faucet really exists', () => {
    expect(faucetUrlFor('stagenet')).toBe(FAUCET_URLS.stagenet);
    expect(faucetUrlFor('preview')).toBe('https://faucet.preview.midnight.network');
    expect(faucetUrlFor('preprod')).toBe('https://faucet.preprod.midnight.network');
    expect(faucetAvailable('stagenet')).toBe(true);
  });

  it('has no faucet for mainnet, and none for an unknown network', () => {
    // Mainnet has no faucet and never will — its absence here is the point.
    expect(faucetUrlFor('mainnet')).toBeNull();
    expect(faucetAvailable('mainnet')).toBe(false);
    expect(faucetUrlFor('undeployed')).toBeNull();
    expect(faucetUrlFor(null)).toBeNull();
    expect(faucetAvailable(undefined)).toBe(false);
  });
});

describe('explorer links', () => {
  it('has an explorer only where a real transaction has been seen to render', () => {
    expect(explorerUrlFor('preview')).toBe('https://explorer.1am.xyz');
    expect(explorerUrlFor('preprod')).toBe(EXPLORER_URLS.preprod);
    // Stagenet went in on 2026/08/25, once a real stagenet transaction was
    // seen to render there; mainnet still has not been.
    expect(explorerUrlFor('stagenet')).toBe('https://explorer.1am.xyz');
    expect(explorerUrlFor('mainnet')).toBeNull();
    expect(explorerUrlFor('undeployed')).toBeNull();
    expect(explorerUrlFor(null)).toBeNull();
  });

  it('accepts a 64-hex ledger hash and refuses the 66-hex identifier', () => {
    expect(isLedgerTxHash(TX_HASH)).toBe(true);
    expect(isLedgerTxHash(TX_HASH.toUpperCase())).toBe(true);
    // The identifier midnight-js answers a submit with. Linking it produced an
    // explorer page saying the transaction does not exist.
    expect(isLedgerTxHash(TX_IDENTIFIER)).toBe(false);
    expect(isLedgerTxHash(`${TX_HASH.slice(0, 63)}g`)).toBe(false);
    expect(isLedgerTxHash(null)).toBe(false);
    expect(isLedgerTxHash(undefined)).toBe(false);
    expect(isLedgerTxHash(42 as unknown as string)).toBe(false);
  });

  it('builds a link only when the explorer AND the hash are both real', () => {
    expect(explorerTxUrl('preview', TX_HASH)).toBe(
      `https://explorer.1am.xyz/tx/${TX_HASH}?network=preview`,
    );
    expect(explorerTxUrl('stagenet', TX_HASH)).toBe(
      `https://explorer.1am.xyz/tx/${TX_HASH}?network=stagenet`,
    );
    // Every way this can fail lands on null, and the caller renders text.
    expect(explorerTxUrl('mainnet', TX_HASH)).toBeNull();
    expect(explorerTxUrl('undeployed', TX_HASH)).toBeNull();
    expect(explorerTxUrl(null, TX_HASH)).toBeNull();
    expect(explorerTxUrl('preview', TX_IDENTIFIER)).toBeNull();
    expect(explorerTxUrl('preview', null)).toBeNull();
    expect(explorerTxUrl('preview', undefined)).toBeNull();
  });
});

describe('the link a submitted transaction gets', () => {
  /* What a success toast is FOR: the moment the user can go and look at the
     thing that just happened. The rule is that there is either a link that
     resolves or no link at all — never one that lands on "does not exist". */

  it('sends a real ledger hash to the explorer', () => {
    expect(txReceiptLink('stagenet', TX_HASH)).toEqual({
      label: 'View on explorer',
      href: `https://explorer.1am.xyz/tx/${TX_HASH}?network=stagenet`,
    });
    // A fallback name is ignored while the explorer can answer.
    expect(txReceiptLink('stagenet', TX_HASH, 'alice.night')?.href).toBe(
      `https://explorer.1am.xyz/tx/${TX_HASH}?network=stagenet`,
    );
  });

  it('sends an unmapped 66-hex identifier to the verifier instead', () => {
    /* The account-contract deploy hits this every time: it is the first thing
       a Passport submits, and the toast fires before the indexer has mapped the
       identifier to a ledger hash. The verifier is asked for the NAME and finds
       the deploy itself. */
    expect(txReceiptLink('stagenet', TX_IDENTIFIER, 'alice.night')).toEqual({
      label: 'View on the verifier',
      href: 'https://midnightpassport.com/verify/?q=alice.night',
    });
    // The same fallback carries a network with no explorer at all.
    expect(txReceiptLink('mainnet', TX_HASH, 'alice.night')?.href).toBe(
      'https://midnightpassport.com/verify/?q=alice.night',
    );
  });

  it('gives no link when there is genuinely nowhere to send anyone', () => {
    expect(txReceiptLink('stagenet', TX_IDENTIFIER)).toBeNull();
    expect(txReceiptLink('stagenet', TX_IDENTIFIER, null)).toBeNull();
    expect(txReceiptLink('stagenet', TX_IDENTIFIER, '   ')).toBeNull();
    expect(txReceiptLink('mainnet', TX_HASH)).toBeNull();
    expect(txReceiptLink(null, null)).toBeNull();
  });

  it('escapes what it puts in the verifier query', () => {
    expect(verifierNameUrl('a name/with?stuff')).toBe(
      'https://midnightpassport.com/verify/?q=a%20name%2Fwith%3Fstuff',
    );
    // `q` is the parameter `src/verify/main.ts` reads on load.
    expect(verifierNameUrl('alice.night')).toBe(`${VERIFIER_URL}?q=alice.night`);
    expect(verifierNameUrl(null)).toBeNull();
    expect(verifierNameUrl(undefined)).toBeNull();
    expect(verifierNameUrl(7 as unknown as string)).toBeNull();
  });
});

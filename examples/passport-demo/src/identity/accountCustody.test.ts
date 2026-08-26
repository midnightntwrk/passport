/**
 * Drills for the account-custody client module's decision-free parts.
 *
 * WHAT IS DRILLED, AND WHY THESE
 * ------------------------------
 * Everything in `./accountCustody.ts` that moves money needs a wallet, a proof
 * server, and a chain, and is drilled against a real network rather than mocked
 * here — a mocked withdrawal proves nothing about a withdrawal. What IS drilled
 * here is the part that is wrong silently:
 *
 *   1. the byte helpers, because a colour, a recipient address, or a coin
 *      public key that is off by a byte produces a transaction that succeeds
 *      and sends the money somewhere else; and
 *   2. `decodeAccountState`, because a balance read from the wrong ledger map,
 *      or a `Field` key rendered the wrong way round, is a number on the Home
 *      screen that nobody can tell is false.
 *
 * The decoder is drilled against a REAL ledger, not a hand-written fixture: the
 * test executes the compiled contract's own constructor and two of its circuits
 * and decodes the state that comes out, so what passes here is what the indexer
 * would serve. No ZK artefacts are involved — circuit EXECUTION is separate
 * from proving, and only proving needs the keys.
 *
 * THE TWO-RUNTIME SEAM, AND WHY THE FIXTURE BYPASSES VITE
 * -------------------------------------------------------
 * There are two installed copies of `@midnight-ntwrk/compact-runtime` in this
 * workspace: the root one, and `experiments/account-custody-prototype`'s own.
 * They are the same version and structurally identical, and objects still do
 * not cross between them — a `ContractState` minted by one is refused by the
 * other's `coerceToChargedState` with "has unexpected type".
 *
 * Which copy a module gets depends on WHO resolved the specifier, and under
 * vitest that is not one answer:
 *
 *   - the compiled contract lives outside `node_modules`, so vitest INLINES it
 *     and Vite resolves its `@midnight-ntwrk/compact-runtime` import. Run from
 *     `examples/passport-demo`, `vite.config.ts` is picked up and its
 *     `resolve.dedupe` list collapses that to the ROOT copy; run from the
 *     workspace root there is no config, no dedupe, and it resolves to the
 *     PROTOTYPE copy;
 *   - anything inside `node_modules` is externalised and resolved by NODE,
 *     which always walks up from the importer and is indifferent to both.
 *
 * So a fixture that resolves the runtime itself matches the contract in one
 * working directory and mismatches it in the other — which is exactly the
 * flake this file used to have (measured 2026/08/24: green from the workspace
 * root, `CompactError … has unexpected type` from `examples/passport-demo`).
 *
 * The fix is to take Vite out of the fixture entirely. Both halves are loaded
 * through NODE's own resolver, anchored at the contract module's own resolved
 * path: `require(contractPath)` makes Node resolve that module's runtime import
 * from the prototype's directory, and `createRequire(contractPath)` asks Node
 * the identical question. One resolver, one importer directory, one answer —
 * in any working directory, under any Vite config.
 *
 * This is sound because {@link decodeAccountState} is a pure projection: it
 * iterates a decoded ledger and reads fields, and never touches a runtime. The
 * fixture has to be internally consistent with ITSELF; it does not have to
 * share an instance with the module under test. (The module under test does
 * have to be internally consistent, and is: `vite.config.ts`'s `dedupe` gives
 * the browser bundle one copy, which is the case that ships.)
 *
 * The fixture anchors on `contracts/managed/account/contract/index.js` rather
 * than on the `src/wallet/contract.js` specifier `./accountCustody.ts` imports,
 * for the plain reason that the latter is TypeScript and Node cannot load it.
 * It is a re-export of this exact module, so it is the same compiled contract.
 *
 * Runs identically from the workspace root and from `examples/passport-demo`:
 * `npx vitest run src/identity/accountCustody.test.ts`.
 */

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import type { Ledger as AccountLedger } from '../../../../experiments/account-custody-prototype/src/wallet/contract.js';

import {
  AccountCustodyError,
  coinPublicKeyBytes,
  colourHexToBytes,
  decodeAccountState,
  deriveAccountDeviceSecret,
  derivePassportContractSecrets,
  deriveDeviceCommitment,
  deriveGrantCommitment,
  formatFieldHex,
  grantCommitmentField,
  nightColourBytes,
  nightColourHex,
  shieldedCoinFromWalletCoin,
  unshieldedAddressBytes,
} from './accountCustody.js';

/* A real preview unshielded address, as the drills produce them — the same one
   `../lib/qrScan.test.ts` uses, so both tests fail together if the address
   format ever moves. */
const RECIPIENT = 'mn_addr_preview1x5wntqr8xxgmpj09n3f38rjegx70apzrqzeldefvzmzuga3k9xqqdqu8vk';

/* -------------------------------------------------------------------------- */
/* Byte helpers                                                               */
/* -------------------------------------------------------------------------- */

describe('colourHexToBytes', () => {
  it('takes the native NIGHT colour the ledger quotes', () => {
    const bytes = colourHexToBytes(nightColourHex());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    expect(nightColourBytes()).toEqual(bytes);
  });

  it('accepts a 0x prefix and upper case, and normalises both', () => {
    const plain = colourHexToBytes('ab'.repeat(32));
    expect(colourHexToBytes(`0x${'AB'.repeat(32)}`)).toEqual(plain);
    expect(colourHexToBytes(`  ${'Ab'.repeat(32)}\n`)).toEqual(plain);
  });

  it('reads the hex big-endian, byte for byte', () => {
    const bytes = colourHexToBytes(`0001${'00'.repeat(29)}ff`);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x01);
    expect(bytes[31]).toBe(0xff);
  });

  it('refuses a short colour rather than padding it', () => {
    // The prototype's Node harnesses left-align a short colour into 32 bytes.
    // In the demo every colour is a full raw token type, so padding would
    // silently address a colour nobody asked for.
    expect(() => colourHexToBytes('06')).toThrow(AccountCustodyError);
    try {
      colourHexToBytes('06');
    } catch (error) {
      expect((error as AccountCustodyError).code).toBe('invalid-request');
    }
  });

  it('refuses an over-long, odd-length, or non-hex colour', () => {
    expect(() => colourHexToBytes('ab'.repeat(33))).toThrow(AccountCustodyError);
    expect(() => colourHexToBytes('a'.repeat(63))).toThrow(AccountCustodyError);
    expect(() => colourHexToBytes(`${'zz'}${'00'.repeat(31)}`)).toThrow(AccountCustodyError);
    expect(() => colourHexToBytes('')).toThrow(AccountCustodyError);
  });
});

describe('unshieldedAddressBytes', () => {
  it('decodes a bech32m mn_addr… to its 32 target bytes', () => {
    const bytes = unshieldedAddressBytes(RECIPIENT);
    expect(bytes.length).toBe(32);
  });

  it('tolerates surrounding whitespace, as a paste does', () => {
    expect(unshieldedAddressBytes(`  ${RECIPIENT} `)).toEqual(unshieldedAddressBytes(RECIPIENT));
  });

  it('refuses anything that is not an unshielded address', () => {
    for (const value of ['', 'not-an-address', RECIPIENT.replace('mn_addr', 'mn_shield-addr')]) {
      expect(() => unshieldedAddressBytes(value)).toThrow(AccountCustodyError);
    }
    try {
      unshieldedAddressBytes('not-an-address');
    } catch (error) {
      expect((error as AccountCustodyError).code).toBe('invalid-request');
      // The refusal says what went wrong underneath, never a bare code.
      expect((error as AccountCustodyError).detail).toBeTruthy();
    }
  });

  it('accepts the address when the expected network matches', () => {
    expect(unshieldedAddressBytes(RECIPIENT, 'preview').length).toBe(32);
  });

  it('refuses a well-formed address from another network', () => {
    // The loss this gate prevents: a preprod address decodes to 32 perfectly
    // good bytes, and paying it from a preview account is unrecoverable.
    try {
      unshieldedAddressBytes(RECIPIENT, 'preprod');
      expect.unreachable('a preview address must not pass a preprod gate');
    } catch (error) {
      expect(error).toBeInstanceOf(AccountCustodyError);
      expect((error as AccountCustodyError).code).toBe('wrong-network');
      expect((error as AccountCustodyError).message).toContain('preview');
      expect((error as AccountCustodyError).message).toContain('preprod');
    }
  });
});

describe('coinPublicKeyBytes', () => {
  it('encodes the hex the wallet facade quotes into 32 Compact bytes', () => {
    const hex = '55'.repeat(32);
    const bytes = coinPublicKeyBytes(hex);
    expect(bytes.length).toBe(32);
    expect(coinPublicKeyBytes(`0x${hex}`)).toEqual(bytes);
  });

  it('refuses a key it cannot encode', () => {
    expect(() => coinPublicKeyBytes('nonsense')).toThrow(AccountCustodyError);
  });
});

describe('shieldedCoinFromWalletCoin', () => {
  it('maps a wallet-held coin onto the contract’s ShieldedCoinInfo', () => {
    const coin = shieldedCoinFromWalletCoin({
      type: nightColourHex(),
      nonce: '11'.repeat(32),
      value: 500n,
    });
    expect(coin.color).toEqual(nightColourBytes());
    expect(coin.nonce.length).toBe(32);
    expect(coin.value).toBe(500n);
    // `mt_index` is deliberately absent: the contract's Merkle position is
    // allocated by `receiveShielded` inside the deposit transaction.
    expect(Object.keys(coin).sort()).toEqual(['color', 'nonce', 'value']);
  });
});

describe('grantCommitmentField and formatFieldHex', () => {
  it('reads commitment bytes big-endian', () => {
    expect(grantCommitmentField(new Uint8Array([0x01, 0x02]))).toBe(0x0102n);
    expect(grantCommitmentField(new Uint8Array([0xff]))).toBe(255n);
  });

  it('passes a Field through unchanged', () => {
    expect(grantCommitmentField(123_456_789n)).toBe(123_456_789n);
  });

  it('round-trips a commitment through its hex form', () => {
    const field = 0xdeadbeefn;
    const hex = formatFieldHex(field);
    expect(hex).toHaveLength(64);
    expect(hex).toBe(`${'0'.repeat(56)}deadbeef`);
    expect(grantCommitmentField(colourHexToBytes(hex))).toBe(field);
  });

  it('refuses a negative Field and an over-long byte string', () => {
    expect(() => grantCommitmentField(-1n)).toThrow(AccountCustodyError);
    expect(() => grantCommitmentField(new Uint8Array(33))).toThrow(AccountCustodyError);
    expect(() => grantCommitmentField(new Uint8Array(0))).toThrow(AccountCustodyError);
  });
});

/* -------------------------------------------------------------------------- */
/* Commitment derivation — the contract's own pure circuits                   */
/* -------------------------------------------------------------------------- */

describe('commitment derivation', () => {
  it('derives through the contract’s pure circuits, deterministically and distinctly', async () => {
    const secret = new Uint8Array(32).fill(7);
    const device = await deriveDeviceCommitment(secret);
    const grant = await deriveGrantCommitment(secret);
    expect(typeof device).toBe('bigint');
    expect(await deriveDeviceCommitment(secret)).toBe(device);
    // The tags are domain-separated in the contract, so the same secret must
    // NOT produce the same commitment in two different roles.
    expect(grant).not.toBe(device);
  });
});

/* -------------------------------------------------------------------------- */
/* The ledger decoder, against a real contract execution                      */
/* -------------------------------------------------------------------------- */

/** Just enough of a circuit context to hand back into the next circuit. */
interface FixtureCircuitContext {
  currentQueryContext: { state: unknown };
}

interface FixtureContractModule {
  Contract: new (witnesses: unknown) => {
    initialState(...args: unknown[]): { currentContractState: unknown };
    impureCircuits: Record<string, (...args: unknown[]) => { context: FixtureCircuitContext }>;
  };
  ledger(state: unknown): AccountLedger;
  pureCircuits: {
    derive_device_commitment(secret: Uint8Array): bigint;
    derive_grant_commitment(secret: Uint8Array): bigint;
    derive_recovery_commitment(secret: Uint8Array): bigint;
  };
}

interface FixtureRuntime {
  createConstructorContext(privateState: unknown, coinPublicKey: string): unknown;
  createCircuitContext(
    address: string,
    coinPublicKey: string,
    contractState: unknown,
    privateState: unknown,
  ): FixtureCircuitContext;
}

/**
 * The compiled contract and the compact-runtime instance it is bound to — both
 * resolved and loaded by NODE, never by Vite. See the header for why that is
 * the only formulation that holds in every working directory.
 *
 * `requireFromTest(contractPath)` makes Node load the contract module, so
 * Node resolves ITS `@midnight-ntwrk/compact-runtime` import by walking up from
 * `contracts/managed/account/contract/`. `createRequire(contractPath)` asks
 * Node the same question from the same directory, so it cannot answer
 * differently. If that ever stops being true the fixture fails loudly with the
 * runtime's own "has unexpected type" rather than decoding something wrong.
 */
function fixtureModules(): { contract: FixtureContractModule; runtime: FixtureRuntime } {
  const requireFromTest = createRequire(import.meta.url);
  const contractPath = requireFromTest.resolve(
    '../../../../experiments/account-custody-prototype/contracts/managed/account/contract/index.js',
  );
  return {
    contract: requireFromTest(contractPath) as FixtureContractModule,
    runtime: createRequire(contractPath)('@midnight-ntwrk/compact-runtime') as FixtureRuntime,
  };
}

const DEVICE_SECRET = new Uint8Array(32).fill(1);
const GRANT_SECRET = new Uint8Array(32).fill(2);
const RECOVERY_SECRET = new Uint8Array(32).fill(3);
const CAP = 250n;
const DEPOSIT = 1_000n;

/**
 * Runs the real contract: construct with one device, register one grant, and
 * deposit NIGHT. Returns the ledger the indexer would end up serving.
 */
function executedLedger(): { grantCommitment: bigint; ledger: AccountLedger } {
  const { contract: module_, runtime } = fixtureModules();
  const contract = new module_.Contract({
    device_secret: (ctx: { privateState: unknown }) => [ctx.privateState, DEVICE_SECRET],
    grant_secret: (ctx: { privateState: unknown }) => [ctx.privateState, GRANT_SECRET],
    recovery_secret: (ctx: { privateState: unknown }) => [ctx.privateState, RECOVERY_SECRET],
  });

  const initial = contract.initialState(
    runtime.createConstructorContext({}, '0'.repeat(64)),
    module_.pureCircuits.derive_device_commitment(DEVICE_SECRET),
    module_.pureCircuits.derive_recovery_commitment(RECOVERY_SECRET),
    new Uint8Array(32).fill(9),
    new Uint8Array(32).fill(8),
    new Uint8Array(32).fill(7),
  );

  const grantCommitment = module_.pureCircuits.derive_grant_commitment(GRANT_SECRET);
  const colour = nightColourBytes();
  let context = runtime.createCircuitContext(
    '02'.padEnd(64, '0'),
    '0'.repeat(64),
    initial.currentContractState,
    {},
  );
  context = contract.impureCircuits.add_grant(context, grantCommitment, colour, CAP).context;
  context = contract.impureCircuits.deposit_night(context, colour, DEPOSIT).context;

  return {
    grantCommitment,
    ledger: module_.ledger(context.currentQueryContext.state),
  };
}

describe('decodeAccountState', () => {
  it('projects a real executed ledger onto the shape the surfaces read', () => {
    const { grantCommitment, ledger } = executedLedger();
    const state = decodeAccountState(ledger);

    // `deposit_night` credits the mirror the contract keeps of its own NIGHT.
    expect(state.nightBalances.get(nightColourHex())).toBe(DEPOSIT);
    expect(state.nightBalances.size).toBe(1);

    // Nothing shielded was deposited, so the coins map is genuinely empty —
    // which is a real answer, not a failed read (that throws in
    // `readAccountState` instead).
    expect(state.shieldedCoins.size).toBe(0);

    // The constructor registers exactly one device, in epoch 0 — and that is
    // the device set a restored record is judged against: the one this
    // secret derives is active, an unrelated commitment is not.
    expect(state.deviceCount).toBe(1);
    const { contract: module_ } = fixtureModules();
    expect(
      state.activeDeviceCommitments.has(module_.pureCircuits.derive_device_commitment(DEVICE_SECRET)),
    ).toBe(true);
    expect(
      state.activeDeviceCommitments.has(module_.pureCircuits.derive_device_commitment(GRANT_SECRET)),
    ).toBe(false);
    expect(state.activeDeviceCommitments.size).toBe(1);
    expect(state.deviceEpoch).toBe(0);

    // `add_grant` is device-authorised, so `require_device` bumped `round`
    // once; the permissionless `deposit_night` did not.
    expect(state.round).toBe(1n);

    expect(state.grants).toHaveLength(1);
    const [grant] = state.grants;
    expect(grant.commitment).toBe(grantCommitment);
    expect(grant.commitmentHex).toBe(formatFieldHex(grantCommitment));
    expect(grant.commitmentHex).toHaveLength(64);
    expect(grant.colourHex).toBe(nightColourHex());
    expect(grant.cap).toBe(CAP);
    expect(grant.spent).toBe(0n);
    expect(grant.active).toBe(true);
    expect(grant.epoch).toBe(0);
    // Liveness is `active` AND the current epoch — the pair the UI must check.
    expect(grant.epoch).toBe(state.deviceEpoch);
  });

  it('keys balances by the same colour hex `colourHexToBytes` accepts', () => {
    const { ledger } = executedLedger();
    const [colourHex] = [...decodeAccountState(ledger).nightBalances.keys()];
    // The round trip a caller makes when it withdraws what it just read.
    expect(colourHexToBytes(colourHex)).toEqual(nightColourBytes());
  });
});

/* -------------------------------------------------------------------------- */
/* The device secret, and the one address shape a recipient field must refuse  */
/* -------------------------------------------------------------------------- */

describe('deriveAccountDeviceSecret', () => {
  it('is the contract’s own derivation, and nothing beside it', async () => {
    /* The contract checks `derive_device_commitment(secret)` against the
       commitment burned into its constructor, so a second derivation here
       would produce an "unknown device" rejection rather than a
       different-but-valid device. This asserts they are the same bytes. */
    const rootSecret = Uint8Array.from({ length: 32 }, (_unused, index) => index * 3);
    const { deviceSecret } = await derivePassportContractSecrets(rootSecret);
    expect(await deriveAccountDeviceSecret(rootSecret)).toEqual(deviceSecret);
    expect(deviceSecret).toHaveLength(32);
  });

  it('is deterministic, and different for a different root', async () => {
    const first = await deriveAccountDeviceSecret(new Uint8Array(32).fill(1));
    const again = await deriveAccountDeviceSecret(new Uint8Array(32).fill(1));
    const other = await deriveAccountDeviceSecret(new Uint8Array(32).fill(2));
    expect(first).toEqual(again);
    expect(first).not.toEqual(other);
  });

  it('commits to that secret the way the contract does', async () => {
    const deviceSecret = await deriveAccountDeviceSecret(new Uint8Array(32).fill(7));
    const commitment = await deriveDeviceCommitment(deviceSecret);
    expect(typeof commitment).toBe('bigint');
    expect(formatFieldHex(commitment)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('unshieldedAddressBytes, on the address kinds a recipient field sees', () => {
  it('refuses a well-formed SHIELDED address with its own sentence', () => {
    /* A `mn_shield-addr…` parses as a Midnight address and then fails the
       unshielded decode. Both refusals are 'invalid-request', and the
       difference between them is the sentence the user reads. */
    const shielded =
      'mn_shield-addr_preview1eqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const refusal = (() => {
      try {
        unshieldedAddressBytes(shielded);
        return null;
      } catch (cause) {
        return cause as AccountCustodyError;
      }
    })();
    expect(refusal).toBeInstanceOf(AccountCustodyError);
    expect(refusal?.code).toBe('invalid-request');
    expect(refusal?.message).toMatch(/not a Midnight address|not an unshielded/);
  });
});

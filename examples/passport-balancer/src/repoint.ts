/**
 * `POST /repoint-alias` — moving a name onto the account a Passport upgraded to.
 *
 * WHY THIS ENDPOINT EXISTS
 * ------------------------
 * The account-custody contract gained `transfer_shielded_to_account` on
 * 2026/09/10, and a circuit is part of a deployed contract's code. A Passport
 * set up before that date can be PAID in one transaction but cannot SEND in
 * one, for ever, so the client migrates it: drain, deploy a new account with
 * the same commitments, re-point the name, refund
 * (`passport-demo/src/identity/accountUpgrade.ts`).
 *
 * The client can do every step of that itself EXCEPT one. A sponsored
 * registration deploys the resolver leaf under this service's own key, points
 * it at the account, registers the name for the user, and hands the leaf over
 * with `change_owner` afterwards — as a queued job, behind everything, not
 * awaited and allowed to fail. So a leaf may still be this service's, and
 * `update_domain_target` asserts `derive_public_key(secretKey()) ==
 * DOMAIN_OWNER[0]`: on such a leaf the holder's own key cannot satisfy it and
 * only this service's can. That is the whole of what this endpoint does.
 *
 * WHAT PROOF OF CONTROL IS HERE, AND WHY IT IS NOT A SIGNATURE
 * ------------------------------------------------------------
 * `/register-alias` and `/fund-account` authenticate nobody. They gate on real
 * reads of real ledger state — the target must BE an account contract, the name
 * must be free, one sponsored name per Passport, one grant per account — plus
 * rate limits, and the cost of getting past them is a real deployment. There is
 * no bearer token in this service and this endpoint does not invent one.
 *
 * What it asks instead is a question only the holder's passkey can make the
 * chain answer yes to: **does the new account carry, as an ACTIVE device, a
 * device commitment the old account also carries as an active device?** A
 * device commitment is `derive_device_commitment(device_secret)` and the secret
 * never leaves the authenticator, so a contract carrying the old account's
 * commitment is a contract that passkey deployed. An attacker who knows both
 * addresses — they are public — cannot produce one, because deploying an
 * account burns the commitment into the constructor and they do not have the
 * preimage.
 *
 * Two more reads bound what a passing request can do. The name must CURRENTLY
 * resolve to the old account, so this cannot be used to seize a name that was
 * never on it; and the new account must carry the one-transaction circuit, so
 * it cannot be used to move a name sideways onto an account that is not an
 * upgrade. Neither is security on its own — both are — and together they mean
 * the worst a passing request can do is move somebody's name from one of their
 * own accounts to another of their own accounts.
 *
 * NOTHING IS SPENT UNTIL EVERY GATE HAS PASSED, and nothing is reported as
 * re-pointed until the registry has been read back showing the name resolving
 * to the new account — the same bar `/register-alias` holds itself to.
 */

/** What the desk answers with, in the shape the server responds. */
export interface RepointOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface RepointRequestBody {
  name?: unknown;
  newAccount?: unknown;
  oldAccount?: unknown;
  network?: unknown;
}

/**
 * A read that could not be made, carrying the status and the error name the
 * route should refuse under.
 *
 * A thrown failure rather than a returned outcome, for the reason
 * `./gift.ts`'s `ColourPayFailure` gives: the distinction between "the indexer
 * is down" and "that address is not an account" has to survive the trip, and
 * flattening it into a sentence loses it.
 */
export class RepointReadFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepointReadFailure';
  }
}

export interface RepointDeskDeps {
  networkId: string;
  /** Whether the re-point leg can run at all, and why not when it cannot. */
  available: boolean;
  unavailableReason: string | null;
  /** Validates and normalises a raw 64-hex contract address, or throws. */
  normaliseAccount(value: string): string;
  /** Validates and normalises a Passport alias label, or throws. */
  normaliseAlias(value: string): string;
  /** The `.night` form of a label, for every sentence a reader sees. */
  domainOf(label: string): string;
  /** What the name resolves to right now, or null when it is not registered. */
  resolve(
    label: string,
  ): Promise<{ resolverAddress: string; target: { kind: string; hex: string } } | null>;
  /** The 32-byte owner key one resolver leaf carries, or null when unreadable. */
  leafOwnerKey(resolverAddress: string): Promise<Uint8Array | null>;
  /** This service's own Midnames owner key. */
  sponsorOwnerKey: Uint8Array;
  /**
   * The device commitments an account contract holds IN ITS CURRENT EPOCH, as
   * decimal strings. Throws {@link RepointReadFailure} where the account could
   * not be read or is not an account at all.
   *
   * The epoch matters: a commitment from an older one is still in the
   * contract's map — a Compact map cannot be cleared in-circuit — and is dead.
   * Matching on a dead commitment would let a `recover()`ed Passport's previous
   * device move the name.
   */
  activeDeviceCommitments(address: string): Promise<Set<string>>;
  /**
   * Whether an account carries `transfer_shielded_to_account`, or null when the
   * chain could not be asked. Null does NOT refuse — see the gate.
   */
  hasOneTxTransfer(address: string): Promise<boolean | null>;
  /** `update_domain_target` on the leaf, under this service's spend lock. */
  repoint(request: {
    label: string;
    contractAddress: string;
  }): Promise<{ resolverAddress: string; updateTx: string; updateBlock: number | null }>;
}

export interface RepointDesk {
  repoint(body: RepointRequestBody): Promise<RepointOutcome>;
}

export function createRepointDesk(deps: RepointDeskDeps): RepointDesk {
  /** Labels with a re-point in the air. Claimed before any read. */
  const inFlight = new Set<string>();

  const refuse = (status: number, error: string, message: string): RepointOutcome => {
    console.warn(`[repoint] refused: ${error} — ${message}`);
    return { status, body: { error, message } };
  };

  const repoint = async (body: RepointRequestBody): Promise<RepointOutcome> => {
    /* Logged on ARRIVAL, not only on the way out — the same rule
       `/fund-account` and `/register-alias` keep, and for the same reason: a
       request that goes silent must still leave a line saying it was asked
       for. */
    console.log(
      `[repoint] asked to move ${typeof body.name === 'string' ? body.name : '(no name)'} to ${
        typeof body.newAccount === 'string' ? body.newAccount : '(no address)'
      }`,
    );

    if (!deps.available) {
      return refuse(
        503,
        'repoint-unsupported',
        deps.unavailableReason ?? 'This balancer cannot re-point names right now.',
      );
    }

    /* 1. SHAPE. Everything is validated before anything touches the chain, and
          the alias rules are the demo's own — same normalisation — so a name
          the browser would refuse is refused here too. */
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return refuse(
        400,
        'invalid-alias',
        'POST a JSON body of the form {"name": "…", "newAccount": "64 hex", "oldAccount": "64 hex"}.',
      );
    }
    let label: string;
    try {
      label = deps.normaliseAlias(body.name);
    } catch (cause) {
      return refuse(400, 'invalid-alias', cause instanceof Error ? cause.message : String(cause));
    }

    if (typeof body.newAccount !== 'string' || typeof body.oldAccount !== 'string') {
      return refuse(
        400,
        'invalid-contract-address',
        'newAccount and oldAccount must both be 64-hex Midnight contract addresses.',
      );
    }
    let newAccount: string;
    let oldAccount: string;
    try {
      newAccount = deps.normaliseAccount(body.newAccount);
      oldAccount = deps.normaliseAccount(body.oldAccount);
    } catch (cause) {
      return refuse(
        400,
        'invalid-contract-address',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (newAccount === oldAccount) {
      return refuse(
        400,
        'invalid-contract-address',
        'The new account and the old one are the same address, so there is nothing to move.',
      );
    }

    if (body.network !== undefined && body.network !== deps.networkId) {
      return refuse(
        400,
        'wrong-network',
        `That request names the ${String(body.network)} network; this balancer re-points names on ${deps.networkId}.`,
      );
    }

    /* 2. IN FLIGHT. Claimed BEFORE any registry read, because that read cannot
          see an update that is still in the air. */
    if (inFlight.has(label)) {
      return refuse(
        409,
        'repoint-in-flight',
        `A move of ${deps.domainOf(label)} is already in progress. Wait for it to finish before asking again.`,
      );
    }
    inFlight.add(label);
    try {
      /* 3. THE NAME, AND WHERE IT POINTS NOW. A real read of the deployed
            registry, never a cache. */
      let current: Awaited<ReturnType<RepointDeskDeps['resolve']>>;
      try {
        current = await deps.resolve(label);
      } catch (cause) {
        return refuse(
          503,
          'registry-unreachable',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
      if (!current) {
        return refuse(
          404,
          'name-not-registered',
          `${deps.domainOf(label)} is not registered on ${deps.networkId}, so there is no resolver to point anywhere.`,
        );
      }

      /* ALREADY DONE. Answered before a single further read, so a client that
         retries after a landed re-point gets a cheap yes rather than a second
         proof — the same idempotence `/fund-account` keeps per leg. */
      if (current.target.kind === 'contract' && current.target.hex === newAccount) {
        console.log(`[repoint] ${deps.domainOf(label)} already resolves to ${newAccount}`);
        return {
          status: 200,
          body: {
            name: label,
            domain: deps.domainOf(label),
            network: deps.networkId,
            resolverAddress: current.resolverAddress,
            target: { kind: 'contract', address: newAccount },
            alreadyPointing: true,
          },
        };
      }

      /* 4. IT MUST BE ON THE OLD ACCOUNT. Without this, a passing proof of
            control over two accounts would move ANY name the caller could name
            onto one of them. With it, the only name this request can touch is
            the one already on the account whose passkey it proved. */
      if (current.target.kind !== 'contract' || current.target.hex !== oldAccount) {
        return refuse(
          409,
          'target-moved',
          `${deps.domainOf(label)} does not currently resolve to that Passport, so this service will not move it.`,
        );
      }

      /* 5. THE LEAF MUST STILL BE THIS SERVICE'S. A leaf `change_owner` has
            handed to its holder cannot be re-pointed from here at all —
            `assert_is_owner` would refuse in-circuit after the fee was spent —
            and the holder's own Passport can do it themselves. Saying so is the
            useful answer; spending a fee to discover it is not. */
      let leafOwner: Uint8Array | null;
      try {
        leafOwner = await deps.leafOwnerKey(current.resolverAddress);
      } catch (cause) {
        return refuse(
          503,
          'registry-unreachable',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
      if (leafOwner === null) {
        return refuse(
          503,
          'registry-unreachable',
          `The resolver for ${deps.domainOf(label)} could not be read, so this service cannot tell whether it may move it.`,
        );
      }
      if (!sameBytes(leafOwner, deps.sponsorOwnerKey)) {
        return refuse(
          409,
          'owner-is-user',
          `The resolver for ${deps.domainOf(label)} belongs to its holder, not to this service, so the Passport that holds it can move it itself.`,
        );
      }

      /* 6. PROOF OF CONTROL. See the header: the new account must carry, as an
            active device, a commitment the old account also carries as an
            active device. Only the passkey that controls the old account can
            have deployed such a contract. */
      let oldDevices: Set<string>;
      let newDevices: Set<string>;
      try {
        [oldDevices, newDevices] = await Promise.all([
          deps.activeDeviceCommitments(oldAccount),
          deps.activeDeviceCommitments(newAccount),
        ]);
      } catch (cause) {
        if (cause instanceof RepointReadFailure) {
          return refuse(cause.status, cause.error, cause.message);
        }
        return refuse(
          503,
          'indexer-unreachable',
          `The two Passports could not be compared: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const shared = [...newDevices].some((commitment) => oldDevices.has(commitment));
      if (!shared) {
        return refuse(
          403,
          'not-your-passport',
          'That new Passport is not controlled by the same passkey as the one holding this name, so this service will not move it.',
        );
      }

      /* 7. IT HAS TO BE AN UPGRADE. This endpoint exists so a Passport that has
            moved to the account build that can send in one transaction keeps
            its name; it is not a general re-pointing service. A chain that
            could not be asked does NOT refuse — the proof above already holds,
            and turning a Passport away because an indexer was slow would be a
            refusal about us rather than about them. */
      let upgraded: boolean | null;
      try {
        upgraded = await deps.hasOneTxTransfer(newAccount);
      } catch {
        upgraded = null;
      }
      if (upgraded === false) {
        return refuse(
          409,
          'not-an-upgrade',
          'That new Passport is the same kind as the old one, so moving the name would achieve nothing.',
        );
      }

      /* THE SPEND. Every gate has passed. */
      let moved: Awaited<ReturnType<RepointDeskDeps['repoint']>>;
      try {
        moved = await deps.repoint({ label, contractAddress: newAccount });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[repoint] ${deps.domainOf(label)} was not moved: ${message}`);
        return refuse(502, 'repoint-failed', message);
      }

      console.log(
        `[repoint] ${deps.domainOf(label)} now resolves to ${newAccount} (${moved.updateTx || 'already pointing'})`,
      );
      return {
        status: 200,
        body: {
          name: label,
          domain: deps.domainOf(label),
          network: deps.networkId,
          resolverAddress: moved.resolverAddress,
          updateTx: moved.updateTx || null,
          updateBlock: moved.updateBlock,
          target: { kind: 'contract', address: newAccount },
          alreadyPointing: false,
        },
      };
    } finally {
      inFlight.delete(label);
    }
  };

  return { repoint };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

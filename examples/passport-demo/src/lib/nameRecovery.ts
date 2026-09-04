/**
 * FINDING A PASSPORT BY ITS `.night` NAME — the rule, and only the rule.
 *
 * WHY THE PATH EXISTS AT ALL (2026/09/04)
 * ---------------------------------------
 * Every recovery Passport had went through the WebAuthn largeBlob extension: a
 * claim writes the account's address onto the credential, and a device that has
 * never seen this Passport reads it back on its first assertion. Android does
 * not implement it. Google Password Manager's passkeys give PRF — which is
 * where the wallet seed and the device secret come from, so the Passport itself
 * works perfectly — and no largeBlob at all. On the platform the reviewers were
 * actually holding there was therefore never a blob to write, nothing to read
 * back, and consequently NO way to return to an existing Passport on a browser
 * that had forgotten it. What such a person met was "Choose your .night name",
 * over a Passport that already had one, where claiming again would set up a
 * second account and pay for a second name.
 *
 * WHAT A NAME IS WORTH, WHICH IS THE WHOLE OF THIS MODULE
 * ------------------------------------------------------
 * A `.night` name is PUBLIC. It is in the registry, anybody can resolve it, and
 * knowing one proves nothing whatsoever. So the name is only ever the QUESTION:
 * it says which account to go and look at. The ANSWER comes from the account —
 * the passkey's PRF-derived device secret is checked against the contract's own
 * active device set, on chain, by `../identity/accountCustody.ts`'s
 * `accountHoldsDevice`. That is the same proof a restored backup file must
 * pass, for the same reason: a name, an address, and a transaction id are all
 * things an attacker can know, and the device set inside the contract is the
 * only thing that answers "can this Passport spend from it".
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PROTECT
 * --------------------------------------------
 * "That is not yours" and "we could not ask" must never look alike. The first
 * tells somebody their Passport is not theirs; the second is a bad minute on a
 * train. Collapsing them — which any `try { … } catch { return false }` around
 * a chain read does — means an indexer blip tells a person they have lost their
 * identity. Every branch below is one or the other, deliberately, and the
 * unreachable answers carry the reason they were unreachable.
 *
 * It is a rule and nothing else: no network, no storage, no clock. It is in the
 * coverage denominator because every way it can be wrong is a way of telling
 * somebody an untruth about whether they still have a Passport.
 */

/** What a name look-up settled on. */
export type NameRecoveryOutcome =
  /** Proved. The account is this Passport's, and the caller may restore it. */
  | { kind: 'found'; address: string; resolverAddress: string }
  /** The registry has no such name. */
  | { kind: 'unknown' }
  /**
   * The name resolves and this passkey is not part of the account — INCLUDING
   * a name that resolves to something other than an account-custody contract.
   * Both are "not a Passport you can open", and the second is not worth a
   * fourth answer nobody could act on differently.
   */
  | { kind: 'not-yours' }
  /** The question could not be put. Never confused with an answer of no. */
  | { kind: 'unreachable'; detail: string };

/** What the registry said, in the shape `../identity/midnames.ts` answers with. */
export interface ResolvedName {
  resolverAddress: string;
  target: { kind: 'contract' | 'shielded' | 'wallet'; hex: string };
}

/**
 * The answer while the wallet is still coming up.
 *
 * An ordinary state a second away from resolving itself rather than a fault, so
 * the sentence says to try again — it does not report an error, and it very
 * deliberately does not say the name is not theirs. A constant rather than a
 * literal at the call site because the caller reaches it through a null check
 * that TypeScript needs for narrowing, and a sentence written out there would
 * be the second copy of it.
 */
export function nameRecoveryStillOpening(): NameRecoveryOutcome {
  return {
    kind: 'unreachable',
    detail: 'Your Passport is still opening. Try again in a moment.',
  };
}

/**
 * Whether there is a registry to ask on this network at all, or `null` when
 * there is.
 *
 * A build decision rather than a fault, and NAMED: "it did not work" on a
 * network Passport was never able to read is the kind of message that sends
 * somebody looking for a problem with their phone.
 */
export function registryUnavailableFor(
  network: string,
  registryNetworks: readonly string[],
): NameRecoveryOutcome | null {
  if (registryNetworks.includes(network)) return null;
  return {
    kind: 'unreachable',
    detail: `Passport cannot read the ${network} registry from here.`,
  };
}

/**
 * What the registry's answer is worth, before the chain has been asked.
 *
 * `null` means "keep going" — the name resolves to an account-custody contract
 * and the ownership proof is the next step. Everything else ends it.
 *
 * A name pointing at a bare wallet address or a shielded key is `not-yours`
 * rather than an error: Passport binds names to account-custody contracts, so
 * such a name is somebody else's arrangement whatever the registry says about
 * it, and there is nothing this app could open even if it wanted to.
 */
export function nameResolutionOutcome(
  resolved: ResolvedName | null,
): NameRecoveryOutcome | null {
  if (!resolved) return { kind: 'unknown' };
  if (resolved.target.kind !== 'contract') return { kind: 'not-yours' };
  return null;
}

/**
 * The final answer, once the chain has been asked whether this Passport's
 * device is one of the account's.
 *
 * `holds` is deliberately a `boolean` and never `boolean | null`: a caller that
 * could not complete the read must reach {@link unreachableBecause} instead, so
 * a failed question can never arrive here dressed as a `false`.
 */
export function nameOwnershipOutcome(
  resolved: ResolvedName,
  holds: boolean,
): NameRecoveryOutcome {
  return holds
    ? { kind: 'found', address: resolved.target.hex, resolverAddress: resolved.resolverAddress }
    : { kind: 'not-yours' };
}

/**
 * A question that could not be put, carrying whatever the failure said.
 *
 * One function so every caller phrases it identically, and so nothing is
 * tempted to turn a thrown read into a `false` on its way past.
 */
export function unreachableBecause(cause: unknown): NameRecoveryOutcome {
  return {
    kind: 'unreachable',
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * The name as the registry holds it: lower case, and without the `.night` a
 * person will very reasonably type because it is how the name is shown to them
 * everywhere else in the app.
 *
 * Trailing and leading space goes too. A name pasted out of a message carries
 * it, and a lookup that failed on an invisible character would be indisputably
 * the app's fault and completely opaque to the person it happened to.
 */
export function normaliseNameForRecovery(typed: string): string {
  return typed.trim().replace(/\.night$/i, '').trim().toLowerCase();
}

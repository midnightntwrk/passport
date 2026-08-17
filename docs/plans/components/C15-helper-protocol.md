# C15 · Helper protocol

**Serves:** P5 · P8.

## Outcome

The protocol that recovery helpers run — interface between C14 and the
people or services holding recovery material. Substitutable per P8
(multiple helper implementations possible).

**Status 2026/07 — working candidate realised.** With C14 decided on
BUSS / ANARKey, the working candidate is the prototype's guardian
protocol: **stateless guardians** — a guardian stores nothing and
derives its share on demand from keys it already holds, so there is
nothing to back up, verify, or keep alive between recoveries. The wire
formats are copy/paste strings (`buss-req.v0` / `buss-sig.v0` /
`buss-paper.v0`) shared between the CLI and the app, so any conforming
client can guard any account. Formalisation belongs to the
recovery-paths MIP; DeRec remains a substitutable profile behind the
same seam.

## Dependencies

- **C14** — invoked during recovery; fixes the on-chain side (recovery
  commitment, BUSS public vector φ, session nonce, epoch-bump seam).
- **External** — the ANARKey construction (ePrint 2025/551) and the
  Pleiades library the prototype binds; the MIP specifies the
  construction, not the library.

## Open questions

**Guardian identity model.** Persistent guardian keys are the BUSS
model — a guardian derives shares from keys it already holds, so the
identity is durable by construction. Rotation and replacement
ceremonies (a guardian leaves, a key is compromised) need defining;
each re-share requires a fresh session identifier, and removing a
guardian requires rotating the recovery secret.

**Transport.** Copy/paste wire strings work today and keep the
protocol operator-free. Does a v1.0 add an asynchronous relay for
convenience, and if so, how does it stay substitutable rather than
becoming a required operator (P8)?

**Non-collusion.** Above-quorum guardian collusion reconstructs the
recovery secret. Session nonces bound the window and out-of-band
confirmation raises the bar; whether v1.0 adds cryptographic
prevention (for example verifiable encryption to the user's quorum) or
documents the trust assumption is open.

## Failure modes

**Guardian unavailable at recovery time.** A guardian is unreachable
when the user needs shares. Stateless guardians make this a
recovery-time liveness question only (no ongoing verification exists
to detect drift earlier); the paper-key arm is the no-social-graph
backstop. *Detection:* recovery ceremony stalls below quorum.

**Guardian key leaked.** A guardian's long-term key is breached.
Below-quorum breaches reconstruct nothing; the failure is above-quorum
compromise. *Detection / response:* rotate the recovery secret and
re-share with a fresh session identifier.

**Protocol incompatibility.** Different helper implementations do not
interoperate. The shared `buss-*.v0` wire formats exist precisely to
prevent this; versioned formats and the MIP's conformance vectors are
the guard. *Detection:* a recovery attempt fails across client
implementations.

## Alternatives

**A — DeRec protocol.** Not chosen for the primary mechanism: stateful
helpers with a daily-verification liveness burden. Remains a
substitutable profile behind the same recovery seam.

**B — BUSS stateless-guardian protocol (Passport-specific wire
format).** **Chosen via C14** — realised in the prototype, shared
across CLI and app; to be formalised in the recovery-paths MIP.

**C — Cheqd or similar credential-secured helper protocol.** Reuses
credential infrastructure; unexplored.

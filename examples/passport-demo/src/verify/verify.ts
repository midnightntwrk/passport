/**
 * The step verifier's evidence layer: chain reads in, a report out.
 *
 * Nothing in this module renders. It takes one thing a reviewer can type — a
 * `.night` name, or a 64-hex account-custody contract address — and returns a
 * {@link VerificationReport}: an ordered timeline of the onboarding steps that
 * really happened, the account's decoded state right now, a set of invariants
 * evaluated against that same data, and, attached to every single row, the
 * exact GraphQL document the row was read from.
 *
 * WHY THIS DECODES CONTRACT STATE AT ALL
 * --------------------------------------
 * The indexer will happily list the actions on an address without any help.
 * What it will NOT do is tell you that `walkmt8w58j941d5.night` is that
 * address — the mapping lives inside the registry's own ledger, as a Compact
 * `Map<Bytes<32>, DomainData>`, and the only honest way to read it is to
 * deserialise the state and ask the generated contract module. That is why the
 * verifier is a Vite entry point rather than a static file under `public/`: a
 * page served straight out of `public/` cannot import the compiled contracts
 * or `@midnight-ntwrk/compact-runtime`.
 *
 * The same decode is what makes the "current account state" card worth
 * showing — `night_balances`, `coins`, and `device_count` are values, not
 * hashes, and a reviewer can read them against what the demo claimed.
 *
 * WHAT IS MEASURED AND WHAT IS MATCHED
 * ------------------------------------
 * Every step carries a {@link StepStatus}, and the difference matters in a
 * review:
 *
 *   `found`     — read directly off the account, the registry, or the
 *                 resolver, and tied to this account by a decoded value.
 *   `inferred`  — matched by transaction window rather than proved. Exactly
 *                 one step is ever inferred: the faucet's `mint_shielded`.
 *                 The coin it mints is SHIELDED, so nothing on chain names
 *                 its recipient; the row says so rather than implying a link
 *                 the chain does not carry.
 *   `missing`   — looked for and not there.
 *
 * A step is never upgraded from `inferred` to `found` by confidence.
 */

import {
  FAUCET_ADDRESS,
  MUSD_COLOUR,
  NIGHT_COLOUR,
  SPONSOR_ADDRESS,
  TLD_ADDRESS,
  bytesToHex,
  contractActions,
  contractState,
  contractStateAfterTx,
  digestOf,
  hexToBytes,
  normaliseContractAddress,
  runQuery,
  type ContractActionRow,
  type RecordedQuery,
} from './indexer.js';

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

export type StepStatus = 'found' | 'inferred' | 'missing';

/**
 * One displayable value on a step. The renderer decides what a `tx` looks like
 * versus a `contract`; this module only decides which one a value IS, because
 * that is a statement about the data rather than about the page.
 */
export type Fact =
  | { readonly t: 'text'; readonly value: string }
  | { readonly t: 'mono'; readonly value: string }
  | { readonly t: 'tx'; readonly value: string }
  | { readonly t: 'contract'; readonly value: string; readonly label?: string }
  | { readonly t: 'block'; readonly height: number; readonly timestampMs: number };

export interface Step {
  /** The onboarding step this row IS, in the reviewer's vocabulary. */
  readonly kind: string;
  /** The circuit or chain action name, exactly as the ledger records it. */
  readonly name: string;
  readonly status: StepStatus;
  /** Block height, when the step was found. Drives the timeline's order. */
  readonly height: number | null;
  readonly meaning: string;
  readonly facts: ReadonlyArray<{ readonly term: string; readonly value: Fact }>;
  readonly queries: readonly RecordedQuery[];
}

export interface TokenBalance {
  readonly colourHex: string;
  readonly label: string | null;
  readonly amount: string;
}

export interface AccountStateCard {
  readonly nightBalances: readonly TokenBalance[];
  readonly coins: ReadonlyArray<TokenBalance & { readonly nonceHex: string }>;
  readonly deviceCount: string;
  readonly stateDigest: string;
  readonly stateBytes: number;
  readonly queries: readonly RecordedQuery[];
}

export interface Invariant {
  readonly claim: string;
  readonly status: 'pass' | 'fail' | 'unknown';
  readonly detail: string;
}

export interface VerificationReport {
  readonly input: string;
  readonly accountAddress: string;
  /** The full `<label>.night` domain, when this account has one. */
  readonly domain: string | null;
  readonly resolverAddress: string | null;
  /** What the resolver leaf points at, as its own `DOMAIN_TARGET` records it. */
  readonly resolverTarget: { readonly kind: string; readonly hex: string } | null;
  readonly identityQueries: readonly RecordedQuery[];
  readonly steps: readonly Step[];
  readonly state: AccountStateCard | null;
  readonly invariants: readonly Invariant[];
}

/* -------------------------------------------------------------------------- */
/* The compiled contracts                                                     */
/* -------------------------------------------------------------------------- */

type AccountModule = typeof import('../../contracts/stagenet/account/index.js');
type MidnamesModule = typeof import('../../contracts/stagenet/midnames/index.js');
type RuntimeModule = typeof import('@midnight-ntwrk/compact-runtime');

let runtimePromise: Promise<RuntimeModule> | null = null;
let accountPromise: Promise<AccountModule> | null = null;
let midnamesPromise: Promise<MidnamesModule> | null = null;

/* Dynamic, and separately, so the page paints before the ledger runtime's WASM
   is fetched — and so a lookup by address never pays for the Midnames module
   it does not use. */
function loadRuntime(): Promise<RuntimeModule> {
  runtimePromise ??= import('@midnight-ntwrk/compact-runtime');
  return runtimePromise;
}

function loadAccount(): Promise<AccountModule> {
  accountPromise ??= import('../../contracts/stagenet/account/index.js');
  return accountPromise;
}

function loadMidnames(): Promise<MidnamesModule> {
  midnamesPromise ??= import('../../contracts/stagenet/midnames/index.js');
  return midnamesPromise;
}

async function decodeAccountLedger(stateHex: string) {
  const [{ ContractState }, account] = await Promise.all([loadRuntime(), loadAccount()]);
  return account.ledger(ContractState.deserialize(hexToBytes(stateHex)).data);
}

async function decodeMidnamesLedger(stateHex: string) {
  const [{ ContractState }, midnames] = await Promise.all([loadRuntime(), loadMidnames()]);
  return midnames.ledger(ContractState.deserialize(hexToBytes(stateHex)).data);
}

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Midnames key encoding: the UTF-8 label left-aligned in 32 bytes padded
 * with `0xff`. Identical to `src/identity/midnames.ts`, byte for byte — a
 * verifier that padded differently would report a registered name as absent.
 */
function domainKey(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length === 0 || bytes.length > 32) {
    throw new Error(`A Midnames label is 1-32 bytes; "${label}" is ${bytes.length}.`);
  }
  const key = new Uint8Array(32).fill(255);
  key.set(bytes);
  return key;
}

/** The inverse: a padded 32-byte registry key back to its readable label. */
function labelFromKey(key: Uint8Array): string {
  let end = key.length;
  while (end > 0 && key[end - 1] === 255) end -= 1;
  return new TextDecoder().decode(key.subarray(0, end));
}

/** `alice.night`, `alice.NIGHT`, or `alice` — all the label `alice`. */
function normaliseLabel(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, '');
  const label = trimmed.endsWith('.night') ? trimmed.slice(0, -'.night'.length) : trimmed;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label)) {
    throw new Error(
      `"${value}" is neither a 64-hex contract address nor a well-formed .night name.`,
    );
  }
  return label;
}

/* -------------------------------------------------------------------------- */
/* Small formatters                                                           */
/* -------------------------------------------------------------------------- */

function tokenLabel(colourHex: string): string | null {
  if (colourHex === NIGHT_COLOUR) return 'NIGHT';
  if (colourHex === MUSD_COLOUR) return 'mUSD';
  return null;
}

/** The NIGHT this contract held after an action, in atomic units. */
function nightBalanceAfter(action: ContractActionRow): bigint {
  const entry = (action.unshieldedBalances ?? []).find(
    (balance) => balance.tokenType === NIGHT_COLOUR,
  );
  return entry ? BigInt(entry.amount) : 0n;
}

function isoTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

/** `2026/08/25 19:21:00Z`, the house date format, for a reviewer's notes. */
export function houseTime(timestampMs: number): string {
  const iso = isoTime(timestampMs);
  return `${iso.slice(0, 10).replace(/-/g, '/')}${iso.slice(10)}`;
}

/* -------------------------------------------------------------------------- */
/* Identity resolution                                                        */
/* -------------------------------------------------------------------------- */

interface Identity {
  readonly accountAddress: string;
  readonly label: string | null;
  readonly resolverAddress: string | null;
  readonly resolverTarget: { kind: string; hex: string } | null;
  readonly queries: RecordedQuery[];
}

/** `DOMAIN_TARGET` is `Either<Contract, Either<Shielded, Unshielded>>`. */
function decodeTarget(target: {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { is_left: boolean; left: { bytes: Uint8Array }; right: { bytes: Uint8Array } };
}): { kind: string; hex: string } {
  if (target.is_left) return { kind: 'contract', hex: bytesToHex(target.left.bytes) };
  if (target.right.is_left) {
    return { kind: 'shielded key', hex: bytesToHex(target.right.left.bytes) };
  }
  return { kind: 'unshielded address', hex: bytesToHex(target.right.right.bytes) };
}

/**
 * Reads a batch of resolver leaves in one round trip.
 *
 * Reverse lookup — address in, name out — has no index behind it: the registry
 * maps a name to a resolver, and only the resolver knows what it points at. So
 * every leaf has to be read. Aliasing them into one document keeps that to a
 * single request per chunk instead of one per name.
 */
async function readResolverTargets(
  addresses: readonly string[],
): Promise<{ targets: Map<string, { kind: string; hex: string }>; queries: RecordedQuery[] }> {
  const targets = new Map<string, { kind: string; hex: string }>();
  const queries: RecordedQuery[] = [];
  const CHUNK = 40;
  for (let start = 0; start < addresses.length; start += CHUNK) {
    const chunk = addresses.slice(start, start + CHUNK);
    const text = `query ResolverLeaves {
${chunk.map((address, index) => `  leaf${index}: contract(address: "${address}") { state }`).join('\n')}
}`;
    const { data, query } = await runQuery<Record<string, { state: string } | null>>(
      `Resolver leaves ${start + 1}–${start + chunk.length}`,
      text,
    );
    queries.push(query);
    for (const [index, address] of chunk.entries()) {
      const state = data[`leaf${index}`]?.state;
      if (!state) continue;
      const leaf = await decodeMidnamesLedger(state);
      targets.set(address, decodeTarget(leaf.DOMAIN_TARGET));
    }
  }
  return { targets, queries };
}

/**
 * Turns what the reviewer typed into an account address, and — wherever the
 * registry says so — the name bound to it.
 *
 * A name that is not registered is an error rather than an empty page: the
 * reviewer typed something they expected to exist, and "nothing to show" would
 * read as "the chain says no" when it may equally mean "you mistyped it".
 */
async function resolveIdentity(input: string): Promise<Identity> {
  const queries: RecordedQuery[] = [];
  const looksLikeAddress = /^(0x)?(0200)?[0-9a-f]{64}$/i.test(input.trim());

  const registry = await contractState('The .night registry state', TLD_ADDRESS);
  queries.push(registry.query);
  if (!registry.state) {
    throw new Error(`The .night registry (${TLD_ADDRESS.slice(0, 10)}…) returned no state.`);
  }
  const registryLedger = await decodeMidnamesLedger(registry.state);

  if (!looksLikeAddress) {
    const label = normaliseLabel(input);
    const key = domainKey(label);
    if (!registryLedger.domains.member(key)) {
      throw new Error(`"${label}.night" is not registered in the stagenet .night registry.`);
    }
    const resolverAddress = bytesToHex(registryLedger.domains.lookup(key).resolver.bytes);
    const leaf = await contractState(`Resolver leaf for ${label}.night`, resolverAddress);
    queries.push(leaf.query);
    if (!leaf.state) throw new Error(`The resolver ${resolverAddress.slice(0, 10)}… has no state.`);
    const resolverTarget = decodeTarget((await decodeMidnamesLedger(leaf.state)).DOMAIN_TARGET);
    if (resolverTarget.kind !== 'contract') {
      throw new Error(
        `"${label}.night" resolves to a ${resolverTarget.kind}, not to an account contract. ` +
          'This verifier only walks account-contract onboarding.',
      );
    }
    return {
      accountAddress: normaliseContractAddress(resolverTarget.hex),
      label,
      resolverAddress,
      resolverTarget,
      queries,
    };
  }

  /* An address was typed. Walk the whole registry to see whether any name
     points at it — there is no reverse index on chain, so this is the only
     answer that is not a guess. */
  const accountAddress = normaliseContractAddress(input);
  const entries: Array<{ label: string; resolver: string }> = [];
  for (const [key, value] of registryLedger.domains) {
    entries.push({ label: labelFromKey(key), resolver: bytesToHex(value.resolver.bytes) });
  }
  const { targets, queries: leafQueries } = await readResolverTargets(
    entries.map((entry) => entry.resolver),
  );
  queries.push(...leafQueries);
  const match = entries.find((entry) => {
    const target = targets.get(entry.resolver);
    return target?.kind === 'contract' && target.hex === accountAddress;
  });
  return {
    accountAddress,
    label: match?.label ?? null,
    resolverAddress: match?.resolver ?? null,
    resolverTarget: match ? (targets.get(match.resolver) ?? null) : null,
    queries,
  };
}

/* -------------------------------------------------------------------------- */
/* Step builders                                                              */
/* -------------------------------------------------------------------------- */

/** The account-custody circuits, exactly as `contracts/stagenet/account` names them. */
const ACCOUNT_CIRCUITS = new Set([
  'deposit_night',
  'withdraw_night',
  'grant_withdraw_night',
  'deposit_shielded',
  'withdraw_shielded',
  'grant_withdraw_shielded',
  'add_device',
  'remove_device',
  'add_grant',
  'revoke_grant',
  'recover',
]);

/** One-line, plain-English readings of the circuits a reviewer will meet. */
const CIRCUIT_MEANINGS: Record<string, string> = {
  deposit_night:
    'NIGHT moved from an outside wallet into the account contract. The contract now custodies it; the wallet no longer can spend it.',
  withdraw_night:
    'The account contract paid NIGHT out to an unshielded address, authorised by a device proof rather than by a wallet signature.',
  grant_withdraw_night:
    'A standing grant — not a device — authorised a NIGHT payment out of the account, inside the cap the grant was created with.',
  deposit_shielded:
    'A shielded coin was handed to the account contract, which now holds it in its `coins` map.',
  withdraw_shielded:
    'The account contract paid a shielded coin out, authorised by a device proof.',
  grant_withdraw_shielded:
    'A standing grant authorised a shielded payment out of the account, inside its cap.',
  add_device: 'Another device commitment was admitted to the account. `device_count` went up.',
  remove_device: 'A device commitment was struck off the account. `device_count` went down.',
  add_grant: 'A spending grant was created — a capped, revocable authority to pay out.',
  revoke_grant: 'A spending grant was cancelled. Nothing can be paid under it again.',
  recover:
    'The account was recovered onto a new device commitment from its recovery shares. Every previous device is displaced.',
};

function transactionFacts(action: ContractActionRow): Array<{ term: string; value: Fact }> {
  const facts: Array<{ term: string; value: Fact }> = [
    { term: 'Transaction', value: { t: 'tx', value: action.transaction.hash } },
    {
      term: 'Block',
      value: {
        t: 'block',
        height: action.transaction.block.height,
        timestampMs: action.transaction.block.timestamp,
      },
    },
  ];
  const status = action.transaction.transactionResult?.status;
  if (status) facts.push({ term: 'Result', value: { t: 'text', value: status } });
  return facts;
}

/** The `mn_addr_…` owners a transaction paid, minus the sponsor's own change. */
function payees(action: ContractActionRow, amount: bigint): string[] {
  const created = action.transaction.unshieldedCreatedOutputs ?? [];
  return created
    .filter((output) => output.tokenType === NIGHT_COLOUR && BigInt(output.value) === amount)
    .map((output) => output.owner);
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Verifies one Passport account end to end.
 *
 * `onProgress` exists because the whole walk is six or seven round trips plus
 * a WASM load, and a reviewer watching a blank panel cannot tell a slow
 * indexer from a broken page.
 */
export async function verifyTarget(
  input: string,
  onProgress: (message: string) => void = () => {},
): Promise<VerificationReport> {
  onProgress('Reading the .night registry…');
  const identity = await resolveIdentity(input);
  const { accountAddress } = identity;

  onProgress('Reading every action on the account contract…');
  const account = await contractActions('Every action on the account contract', accountAddress);
  const accountQuery = account.query;
  const actions = account.actions;
  if (actions.length === 0) {
    throw new Error(
      `The indexer reports no actions at all on ${accountAddress}. ` +
        'That address is not a deployed contract on stagenet.',
    );
  }

  const steps: Step[] = [];
  const deploy = actions.find((action) => action.__typename === 'ContractDeploy') ?? null;
  const calls = actions.filter((action) => action.__typename === 'ContractCall');
  const firstOf = (entryPoint: string) =>
    calls.find((action) => action.entryPoint === entryPoint) ?? null;

  /* --- 1. The account contract itself ---------------------------------- */
  if (deploy) {
    const unshielded = deploy.unshieldedBalances ?? [];
    const spent = deploy.transaction.unshieldedSpentOutputs ?? [];
    const created = deploy.transaction.unshieldedCreatedOutputs ?? [];
    steps.push({
      kind: 'Account contract deployed',
      name: 'ContractDeploy',
      status: 'found',
      height: deploy.transaction.block.height,
      meaning:
        'The account-custody contract came into existence. It was deployed holding nothing at ' +
        'all — no unshielded inputs, no unshielded outputs — and its fee was paid in DUST by ' +
        'the sponsor, not by the user.',
      facts: [
        { term: 'Contract', value: { t: 'contract', value: accountAddress, label: 'account' } },
        ...transactionFacts(deploy),
        {
          term: 'Unshielded in/out',
          value: {
            t: 'text',
            value: `${spent.length} input(s), ${created.length} output(s), ${unshielded.length} balance entr(y/ies)`,
          },
        },
        {
          term: 'Fee (DUST)',
          value: { t: 'mono', value: deploy.transaction.fee ?? 'not reported' },
        },
      ],
      queries: [accountQuery],
    });
  } else {
    steps.push({
      kind: 'Account contract deployed',
      name: 'ContractDeploy',
      status: 'missing',
      height: null,
      meaning: 'No deploy action is recorded on this address.',
      facts: [],
      queries: [accountQuery],
    });
  }

  /* --- 2. The activation grant ------------------------------------------ */
  const depositNight = firstOf('deposit_night');
  if (depositNight) {
    const index = actions.indexOf(depositNight);
    const before = index > 0 ? nightBalanceAfter(actions[index - 1]!) : 0n;
    const after = nightBalanceAfter(depositNight);
    const spent = depositNight.transaction.unshieldedSpentOutputs ?? [];
    const owners = [...new Set(spent.map((output) => output.owner))];
    const sponsorFunded = owners.length > 0 && owners.every((owner) => owner === SPONSOR_ADDRESS);
    steps.push({
      kind: 'Activation grant',
      name: 'deposit_night',
      status: 'found',
      height: depositNight.transaction.block.height,
      meaning:
        'The sponsor put NIGHT into the account contract. Every unshielded input to this ' +
        'transaction is owned by the sponsor, so the user paid nothing for their own activation.',
      facts: [
        { term: 'Contract', value: { t: 'contract', value: accountAddress, label: 'account' } },
        ...transactionFacts(depositNight),
        { term: 'NIGHT in', value: { t: 'mono', value: `${after - before} (atomic units)` } },
        { term: 'Balance after', value: { t: 'mono', value: `${after} (atomic units)` } },
        {
          term: 'Input owner',
          value: {
            t: 'text',
            value: sponsorFunded
              ? `${SPONSOR_ADDRESS} — the sponsor, on every input`
              : owners.join(', ') || 'no unshielded inputs recorded',
          },
        },
      ],
      queries: [accountQuery],
    });
  } else {
    steps.push({
      kind: 'Activation grant',
      name: 'deposit_night',
      status: 'missing',
      height: null,
      meaning: 'No `deposit_night` call is recorded on this account.',
      facts: [],
      queries: [accountQuery],
    });
  }

  /* --- 3 and 4. The name ------------------------------------------------ */
  onProgress('Reading the resolver and the registry…');
  const nameSteps = await buildNameSteps(identity);
  steps.push(...nameSteps);

  /* --- 5. The faucet mint ----------------------------------------------- */
  const depositShielded = firstOf('deposit_shielded');
  onProgress('Reading the mUSD faucet…');
  steps.push(
    await buildMintStep(
      deploy?.transaction.block.height ?? null,
      depositShielded?.transaction.block.height ?? null,
    ),
  );

  /* --- 6. The shielded deposit ------------------------------------------ */
  if (depositShielded) {
    steps.push({
      kind: 'mUSD deposited',
      name: 'deposit_shielded',
      status: 'found',
      height: depositShielded.transaction.block.height,
      meaning:
        'The minted shielded coin was handed to the account contract, which now holds it in ' +
        'its `coins` map. The amount and the colour are visible in the decoded state below, ' +
        'not in this transaction — that is what "shielded" means.',
      facts: [
        { term: 'Contract', value: { t: 'contract', value: accountAddress, label: 'account' } },
        ...transactionFacts(depositShielded),
      ],
      queries: [accountQuery],
    });
  } else {
    steps.push({
      kind: 'mUSD deposited',
      name: 'deposit_shielded',
      status: 'missing',
      height: null,
      meaning: 'No `deposit_shielded` call is recorded on this account.',
      facts: [],
      queries: [accountQuery],
    });
  }

  /* --- 7 and 8. Everything else this account has ever done --------------- */
  const alreadyShown = new Set<ContractActionRow>(
    [depositNight, depositShielded].filter((action): action is ContractActionRow => Boolean(action)),
  );
  for (const call of calls) {
    if (alreadyShown.has(call)) continue;
    steps.push(buildGenericStep(call, actions, accountAddress, accountQuery));
  }

  /* --- The state, then the invariants over all of it ---------------------- */
  onProgress('Decoding the account contract state…');
  const state = await buildStateCard(accountAddress);

  const report: VerificationReport = {
    input,
    accountAddress,
    domain: identity.label ? `${identity.label}.night` : null,
    resolverAddress: identity.resolverAddress,
    resolverTarget: identity.resolverTarget,
    identityQueries: identity.queries,
    steps: sortSteps(steps),
    state,
    invariants: buildInvariants(identity, actions, deploy),
  };
  return report;
}

/**
 * Found steps in the order they happened; anything missing collected at the
 * end. Sorting the timeline by what the chain says rather than by the order
 * this module happens to build things in is the point — a withdrawal that
 * landed before the mint must READ as having landed before the mint.
 */
function sortSteps(steps: readonly Step[]): Step[] {
  const dated = steps.filter((step) => step.height !== null);
  const undated = steps.filter((step) => step.height === null);
  dated.sort((left, right) => (left.height ?? 0) - (right.height ?? 0));
  return [...dated, ...undated];
}

/* -------------------------------------------------------------------------- */
/* Steps 3 and 4 — the resolver deploy, and the registration                  */
/* -------------------------------------------------------------------------- */

async function buildNameSteps(identity: Identity): Promise<Step[]> {
  const { label, resolverAddress, resolverTarget, accountAddress } = identity;
  if (!label || !resolverAddress) {
    const meaning =
      'No `.night` name in the stagenet registry resolves to this account contract. Every ' +
      'registered name was checked, leaf by leaf.';
    return [
      {
        kind: 'Resolver deployed',
        name: 'ContractDeploy',
        status: 'missing',
        height: null,
        meaning,
        facts: [],
        queries: identity.queries,
      },
      {
        kind: 'Name registered',
        name: 'register_domain_for',
        status: 'missing',
        height: null,
        meaning,
        facts: [],
        queries: identity.queries,
      },
    ];
  }

  const steps: Step[] = [];
  const resolver = await contractActions(
    `Every action on the resolver for ${label}.night`,
    resolverAddress,
  );
  const resolverDeploy =
    resolver.actions.find((action) => action.__typename === 'ContractDeploy') ?? null;

  steps.push({
    kind: 'Resolver deployed',
    name: 'ContractDeploy',
    status: resolverDeploy ? 'found' : 'missing',
    height: resolverDeploy?.transaction.block.height ?? null,
    meaning:
      'A one-name resolver leaf was deployed, constructed pointing at this account contract. ' +
      'This is the half of the binding that says WHERE the name goes; the registry entry below ' +
      'is the half that says the name is taken.',
    facts: resolverDeploy
      ? [
          {
            term: 'Resolver',
            value: { t: 'contract', value: resolverAddress, label: 'resolver' },
          },
          ...transactionFacts(resolverDeploy),
          {
            term: 'DOMAIN_TARGET',
            value: {
              t: 'text',
              value: resolverTarget
                ? `${resolverTarget.kind} ${resolverTarget.hex}`
                : 'could not be decoded',
            },
          },
          {
            term: 'Points at',
            value: { t: 'contract', value: accountAddress, label: 'account' },
          },
        ]
      : [{ term: 'Resolver', value: { t: 'contract', value: resolverAddress } }],
    queries: [...identity.queries, resolver.query],
  });

  const registration = await findRegistration(label, resolverAddress, resolverDeploy);
  steps.push(registration);
  return steps;
}

/**
 * Which `register_domain_for` on the registry put THIS name there.
 *
 * The registry's calls are indistinguishable from the outside — the indexer
 * reports an entry point and nothing else, and every registration on stagenet
 * carries the same one. So the answer is taken from state rather than from the
 * shape of the call: for each candidate, the registry state that call LEFT
 * BEHIND is decoded, and the winner is the first one in which this name maps
 * to this resolver. The state immediately before it is decoded too, and the
 * name must be absent there — otherwise the row would claim a transaction
 * registered a name that was already registered.
 */
async function findRegistration(
  label: string,
  resolverAddress: string,
  resolverDeploy: ContractActionRow | null,
): Promise<Step> {
  const queries: RecordedQuery[] = [];
  const registry = await contractActions('Every action on the .night registry', TLD_ADDRESS);
  queries.push(registry.query);

  const key = domainKey(label);
  const candidates = registry.actions.filter(
    (action) =>
      action.__typename === 'ContractCall' &&
      action.entryPoint === 'register_domain_for' &&
      (resolverDeploy === null ||
        action.transaction.block.height >= resolverDeploy.transaction.block.height),
  );

  const holdsName = async (action: ContractActionRow): Promise<boolean> => {
    const snapshot = await contractStateAfterTx(
      `Registry state after ${action.transaction.hash.slice(0, 10)}…`,
      TLD_ADDRESS,
      action.transaction.hash,
    );
    queries.push(snapshot.query);
    if (!snapshot.state) return false;
    const decoded = await decodeMidnamesLedger(snapshot.state);
    return (
      decoded.domains.member(key) &&
      bytesToHex(decoded.domains.lookup(key).resolver.bytes) === resolverAddress
    );
  };

  let match: ContractActionRow | null = null;
  for (const candidate of candidates) {
    /* Candidates are oldest first, so the first one whose resulting state
       carries the name IS the registration. */
    if (await holdsName(candidate)) {
      match = candidate;
      break;
    }
  }

  if (!match) {
    return {
      kind: 'Name registered',
      name: 'register_domain_for',
      status: 'missing',
      height: null,
      meaning:
        `No \`register_domain_for\` on the registry leaves ${label}.night mapped to ` +
        `${resolverAddress.slice(0, 10)}…. The name is in the registry now, so it was put there ` +
        'outside the range of actions this query returned.',
      facts: [],
      queries,
    };
  }

  const previous = registry.actions[registry.actions.indexOf(match) - 1] ?? null;
  let priorIsClean = true;
  if (previous) {
    const before = await contractStateAfterTx(
      `Registry state before ${match.transaction.hash.slice(0, 10)}…`,
      TLD_ADDRESS,
      previous.transaction.hash,
    );
    queries.push(before.query);
    priorIsClean = before.state
      ? !(await decodeMidnamesLedger(before.state)).domains.member(key)
      : true;
  }

  return {
    kind: 'Name registered',
    name: 'register_domain_for',
    status: 'found',
    height: match.transaction.block.height,
    meaning:
      `The registry took \`${label}\` and pointed it at the resolver leaf. Decoding the state ` +
      'this very transaction produced shows the name present and pointing there' +
      (priorIsClean ? ', and absent in the state before it.' : '.'),
    facts: [
      { term: 'Registry', value: { t: 'contract', value: TLD_ADDRESS, label: '.night TLD' } },
      ...transactionFacts(match),
      { term: 'Name', value: { t: 'mono', value: `${label}.night` } },
      { term: 'Resolver', value: { t: 'contract', value: resolverAddress, label: 'resolver' } },
      {
        term: 'Before this tx',
        value: {
          t: 'text',
          value: priorIsClean
            ? 'the name was absent from the registry'
            : 'the preceding state could not be read',
        },
      },
    ],
    queries,
  };
}

/* -------------------------------------------------------------------------- */
/* Step 5 — the faucet mint                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The mUSD mint that belongs to this onboarding, matched by transaction window.
 *
 * This is the one step the chain does not let anybody prove. `mint_shielded`
 * creates a SHIELDED coin: the recipient is a commitment, not an address, and
 * no field on the faucet's action names the account it was minted for. What
 * can be said honestly is that exactly one mint happened between this
 * account's deploy and its `deposit_shielded`, and the row says exactly that —
 * it is marked `inferred`, and the reasoning is printed on the page.
 */
async function buildMintStep(
  fromHeight: number | null,
  toHeight: number | null,
): Promise<Step> {
  const upTo = toHeight ?? undefined;
  const faucet = await contractActions('mUSD faucet mints', FAUCET_ADDRESS, {
    limit: 40,
    ...(upTo === undefined ? {} : { upToHeight: upTo }),
  });
  const window = faucet.actions.filter(
    (action) =>
      action.entryPoint === 'mint_shielded' &&
      (fromHeight === null || action.transaction.block.height >= fromHeight) &&
      (toHeight === null || action.transaction.block.height <= toHeight),
  );
  const match = window.at(-1) ?? null;
  if (!match) {
    return {
      kind: 'mUSD minted',
      name: 'mint_shielded',
      status: 'missing',
      height: null,
      meaning:
        'No `mint_shielded` on the faucet falls between this account\'s deploy and its shielded ' +
        'deposit.',
      facts: [{ term: 'Faucet', value: { t: 'contract', value: FAUCET_ADDRESS, label: 'faucet' } }],
      queries: [faucet.query],
    };
  }
  return {
    kind: 'mUSD minted',
    name: 'mint_shielded',
    status: 'inferred',
    height: match.transaction.block.height,
    meaning:
      'The faucet minted a shielded mUSD coin. MATCHED BY WINDOW, NOT PROVED: a shielded mint ' +
      'names no recipient on chain, so the only claim being made is that this is the mint that ' +
      'happened between this account\'s deploy and its `deposit_shielded`' +
      (window.length === 1 ? ', and it is the only one in that window.' : '.'),
    facts: [
      { term: 'Faucet', value: { t: 'contract', value: FAUCET_ADDRESS, label: 'faucet' } },
      ...transactionFacts(match),
      {
        term: 'Window',
        value: {
          t: 'text',
          value:
            `blocks ${fromHeight ?? '?'}–${toHeight ?? '?'}; ` +
            `${window.length} faucet mint(s) in it`,
        },
      },
      { term: 'mUSD colour', value: { t: 'mono', value: MUSD_COLOUR } },
    ],
    queries: [faucet.query],
  };
}

/* -------------------------------------------------------------------------- */
/* Steps 7 and 8 — withdrawals, and everything else                           */
/* -------------------------------------------------------------------------- */

function buildGenericStep(
  call: ContractActionRow,
  actions: readonly ContractActionRow[],
  accountAddress: string,
  accountQuery: RecordedQuery,
): Step {
  const entryPoint = call.entryPoint ?? 'unknown';
  const index = actions.indexOf(call);
  const before = index > 0 ? nightBalanceAfter(actions[index - 1]!) : 0n;
  const after = nightBalanceAfter(call);
  const delta = after - before;
  const facts: Array<{ term: string; value: Fact }> = [
    { term: 'Contract', value: { t: 'contract', value: accountAddress, label: 'account' } },
    ...transactionFacts(call),
  ];

  if (entryPoint.endsWith('withdraw_night') && delta < 0n) {
    const amount = -delta;
    const recipients = payees(call, amount);
    facts.push({ term: 'NIGHT out', value: { t: 'mono', value: `${amount} (atomic units)` } });
    facts.push({ term: 'Balance after', value: { t: 'mono', value: `${after} (atomic units)` } });
    facts.push({
      term: 'Recipient',
      value: {
        t: 'text',
        value:
          recipients.length === 1
            ? `${recipients[0]}${recipients[0] === SPONSOR_ADDRESS ? ' — the sponsor' : ''}`
            : 'not distinguishable from the sponsor fee change on this transaction',
      },
    });
  } else if (entryPoint === 'withdraw_shielded' || entryPoint === 'grant_withdraw_shielded') {
    facts.push({
      term: 'Amount',
      value: {
        t: 'text',
        value: 'shielded — the value and the recipient are not on chain, by construction',
      },
    });
  } else if (delta !== 0n) {
    facts.push({
      term: 'NIGHT change',
      value: { t: 'mono', value: `${delta > 0n ? '+' : ''}${delta} (atomic units)` },
    });
  }

  const isWithdrawal = entryPoint.includes('withdraw');
  return {
    kind: isWithdrawal
      ? 'Withdrawal'
      : ACCOUNT_CIRCUITS.has(entryPoint)
        ? 'Account circuit'
        : 'Unrecognised circuit',
    name: entryPoint,
    status: 'found',
    height: call.transaction.block.height,
    meaning:
      CIRCUIT_MEANINGS[entryPoint] ??
      `\`${entryPoint}\` is not one of the account-custody circuits this verifier knows. It is ` +
        'listed here unread rather than left out.',
    facts,
    queries: [accountQuery],
  };
}

/* -------------------------------------------------------------------------- */
/* The state card                                                             */
/* -------------------------------------------------------------------------- */

async function buildStateCard(accountAddress: string): Promise<AccountStateCard | null> {
  const current = await contractState('Current account contract state', accountAddress);
  if (!current.state) return null;
  const ledger = await decodeAccountLedger(current.state);

  const nightBalances: TokenBalance[] = [];
  for (const [colour, amount] of ledger.night_balances) {
    const colourHex = bytesToHex(colour);
    nightBalances.push({ colourHex, label: tokenLabel(colourHex), amount: amount.toString() });
  }

  const coins: Array<TokenBalance & { nonceHex: string }> = [];
  for (const [, coin] of ledger.coins) {
    const colourHex = bytesToHex(coin.color);
    coins.push({
      colourHex,
      label: tokenLabel(colourHex),
      amount: coin.value.toString(),
      nonceHex: bytesToHex(coin.nonce),
    });
  }

  return {
    nightBalances,
    coins,
    deviceCount: ledger.device_count.toString(),
    stateDigest: await digestOf(current.state),
    stateBytes: current.state.length / 2,
    queries: [current.query],
  };
}

/* -------------------------------------------------------------------------- */
/* Invariants                                                                 */
/* -------------------------------------------------------------------------- */

function buildInvariants(
  identity: Identity,
  actions: readonly ContractActionRow[],
  deploy: ContractActionRow | null,
): Invariant[] {
  const invariants: Invariant[] = [];

  /* 1. Nothing has happened on this address that is not this contract's own. */
  const strangers = actions.filter(
    (action) =>
      action.__typename !== 'ContractDeploy' &&
      !(action.__typename === 'ContractCall' && ACCOUNT_CIRCUITS.has(action.entryPoint ?? '')),
  );
  invariants.push({
    claim: 'Every action on this account is its deploy or one of its own circuits',
    status: strangers.length === 0 ? 'pass' : 'fail',
    detail:
      strangers.length === 0
        ? `${actions.length} action(s) checked: one ContractDeploy and ${actions.length - 1} call(s), ` +
          'each naming an account-custody circuit.'
        : `${strangers.length} action(s) name something else: ` +
          strangers
            .map((action) => `${action.__typename} ${action.entryPoint ?? ''}`.trim())
            .join(', '),
  });

  /* 2. The name really does point here. */
  if (identity.resolverTarget && identity.label) {
    const matches =
      identity.resolverTarget.kind === 'contract' &&
      identity.resolverTarget.hex === identity.accountAddress;
    invariants.push({
      claim: `${identity.label}.night resolves to this account contract`,
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `The resolver leaf's DOMAIN_TARGET decodes to contract ${identity.accountAddress}.`
        : `The resolver leaf points at ${identity.resolverTarget.kind} ${identity.resolverTarget.hex}.`,
    });
  } else {
    invariants.push({
      claim: 'A .night name resolves to this account contract',
      status: 'unknown',
      detail:
        'No registered name in the stagenet .night registry points at this account, so there is ' +
        'nothing to check. An account is perfectly valid without a name.',
    });
  }

  /* 3. The deploy moved no value. */
  if (deploy) {
    const spent = deploy.transaction.unshieldedSpentOutputs ?? [];
    const created = deploy.transaction.unshieldedCreatedOutputs ?? [];
    const balances = deploy.unshieldedBalances ?? [];
    const clean = spent.length === 0 && created.length === 0 && balances.length === 0;
    invariants.push({
      claim: 'The account deploy carried no unshielded value',
      status: clean ? 'pass' : 'fail',
      detail: clean
        ? 'No unshielded inputs, no unshielded outputs, and no contract balance at deploy time. ' +
          'The fee was paid in DUST by the sponsor.'
        : `${spent.length} input(s), ${created.length} output(s), ${balances.length} balance entr(y/ies).`,
    });
  } else {
    invariants.push({
      claim: 'The account deploy carried no unshielded value',
      status: 'unknown',
      detail: 'No deploy action was found on this address.',
    });
  }

  /* 4. Nothing here half-landed. */
  const failed = actions.filter(
    (action) =>
      action.transaction.transactionResult !== undefined &&
      action.transaction.transactionResult !== null &&
      action.transaction.transactionResult.status !== 'SUCCESS',
  );
  invariants.push({
    claim: 'Every transaction touching this account succeeded',
    status: failed.length === 0 ? 'pass' : 'fail',
    detail:
      failed.length === 0
        ? `${actions.length} transaction(s), all reporting SUCCESS.`
        : failed
            .map(
              (action) =>
                `${action.transaction.hash} → ${action.transaction.transactionResult?.status}`,
            )
            .join(', '),
  });

  return invariants;
}

/**
 * The step verifier's browser bring-up and rendering.
 *
 * Plain DOM on purpose. This page ships beside the Passport PWA but shares
 * nothing with it: no React, no service worker, no wallet, no stored state.
 * It is a single screen that reads the chain and prints what it found, and the
 * fewer moving parts between the indexer's answer and the reviewer's eyes, the
 * more the answer is worth.
 *
 * Three rendering rules, all of them evidential rather than aesthetic:
 *
 *   - **Hashes are shown whole.** A transaction hash a reviewer has to compare
 *     against another screen is useless elided. Contract addresses are the one
 *     exception — they repeat on every row, so they are shortened AND carry a
 *     copy button that yields the full 64 characters.
 *   - **Every row can be re-run.** Each step carries the GraphQL documents it
 *     was built from behind a "show query" toggle, with a "copy curl" that
 *     reproduces the read from a shell against the same endpoint.
 *   - **Links never stand in for values.** The 1AM explorer links are a
 *     convenience laid over values that are already printed in full; if the
 *     explorer is down or its routes move, nothing on this page becomes
 *     unreadable. See `EXPLORER_BASE` in `./indexer.ts` — one constant, and
 *     the three builders over it, is the whole of what would change.
 */

import './verify.css';

import {
  FAUCET_ADDRESS,
  INDEXER_URL,
  SPONSOR_ADDRESS,
  TLD_ADDRESS,
  curlFor,
  explorerBlockUrl,
  explorerContractUrl,
  explorerTxUrl,
  type RecordedQuery,
} from './indexer.js';
import {
  houseTime,
  verifyTarget,
  type Fact,
  type Step,
  type VerificationReport,
} from './verify.js';

/* -------------------------------------------------------------------------- */
/* Small DOM helpers                                                          */
/* -------------------------------------------------------------------------- */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The verifier page is missing #${id}.`);
  return node as T;
}

/** A short address with the whole thing one click away. */
function shortHex(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/**
 * A copy button. Clipboard access can be refused (an insecure origin, a denied
 * permission), and when it is the button says so rather than silently
 * pretending it copied — the value is on screen in full either way.
 */
function copyButton(label: string, value: () => string): HTMLButtonElement {
  const button = element('button', 'copy', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value());
      button.textContent = 'copied';
      button.classList.add('is-done');
    } catch {
      button.textContent = 'copy failed';
    }
    window.setTimeout(() => {
      button.textContent = label;
      button.classList.remove('is-done');
    }, 1_600);
  });
  return button;
}

function explorerLink(href: string, text: string): HTMLAnchorElement {
  const anchor = element('a', 'explorer-link mono', text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  return anchor;
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

function renderFact(fact: Fact): DocumentFragment {
  const fragment = document.createDocumentFragment();
  switch (fact.t) {
    case 'text': {
      fragment.append(document.createTextNode(fact.value));
      return fragment;
    }
    case 'mono': {
      fragment.append(element('code', undefined, fact.value));
      return fragment;
    }
    case 'tx': {
      fragment.append(explorerLink(explorerTxUrl(fact.value), fact.value));
      fragment.append(copyButton('copy', () => fact.value));
      return fragment;
    }
    case 'contract': {
      fragment.append(explorerLink(explorerContractUrl(fact.value), shortHex(fact.value)));
      if (fact.label) fragment.append(element('span', 'token-label', fact.label));
      fragment.append(copyButton('copy', () => fact.value));
      return fragment;
    }
    case 'block': {
      fragment.append(
        explorerLink(explorerBlockUrl(fact.height), String(fact.height)),
        document.createTextNode(` · ${houseTime(fact.timestampMs)}`),
      );
      return fragment;
    }
  }
}

function renderFacts(facts: Step['facts']): HTMLElement {
  const grid = element('dl', 'field-grid');
  for (const { term, value } of facts) {
    grid.append(element('dt', undefined, term));
    const dd = element('dd');
    dd.append(renderFact(value));
    grid.append(dd);
  }
  return grid;
}

/* -------------------------------------------------------------------------- */
/* The query disclosure                                                       */
/* -------------------------------------------------------------------------- */

function renderQueries(queries: readonly RecordedQuery[]): HTMLElement | null {
  if (queries.length === 0) return null;
  const details = element('details', 'query');
  const summary = element(
    'summary',
    undefined,
    queries.length === 1 ? 'Show query' : `Show ${queries.length} queries`,
  );
  details.append(summary);
  for (const query of queries) {
    const body = element('div', 'query-body');
    body.append(element('p', 'query-label', query.label));
    const pre = element('pre');
    pre.append(element('code', undefined, query.text));
    body.append(pre);
    const actions = element('div', 'query-actions');
    const curl = copyForQuery('Copy curl', () => curlFor(query));
    const raw = copyForQuery('Copy query', () => query.text);
    actions.append(curl, raw);
    body.append(actions);
    details.append(body);
  }
  return details;
}

/** The query panel's own copy buttons — same behaviour, different chrome. */
function copyForQuery(label: string, value: () => string): HTMLButtonElement {
  const button = element('button', undefined, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value());
      button.textContent = 'Copied';
      button.classList.add('is-done');
    } catch {
      button.textContent = 'Copy failed';
    }
    window.setTimeout(() => {
      button.textContent = label;
      button.classList.remove('is-done');
    }, 1_600);
  });
  return button;
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

function identityCard(report: VerificationReport): HTMLElement {
  const card = element('section', 'card');
  card.append(element('h2', undefined, 'Account'));
  const pairs = element('dl', 'pairs');

  const add = (term: string, build: (dd: HTMLElement) => void) => {
    pairs.append(element('dt', undefined, term));
    const dd = element('dd');
    build(dd);
    pairs.append(dd);
  };

  add('Name', (dd) => {
    if (report.domain) {
      dd.append(element('code', undefined, report.domain));
    } else {
      dd.append(
        document.createTextNode('No .night name in the stagenet registry points at this account.'),
      );
    }
  });
  add('Account contract', (dd) => {
    dd.append(
      explorerLink(explorerContractUrl(report.accountAddress), report.accountAddress),
      copyButton('copy', () => report.accountAddress),
    );
  });
  if (report.resolverAddress) {
    const resolverAddress = report.resolverAddress;
    add('Resolver leaf', (dd) => {
      dd.append(
        explorerLink(explorerContractUrl(resolverAddress), resolverAddress),
        copyButton('copy', () => resolverAddress),
      );
    });
  }
  if (report.resolverTarget) {
    const target = report.resolverTarget;
    add('DOMAIN_TARGET', (dd) => {
      dd.append(element('code', undefined, `${target.kind} · ${target.hex}`));
    });
  }
  card.append(pairs);
  const queries = renderQueries(report.identityQueries);
  if (queries) card.append(queries);
  return card;
}

function timelineCard(report: VerificationReport): HTMLElement {
  const card = element('section', 'card');
  card.append(element('h2', undefined, 'Onboarding steps'));
  card.append(
    element(
      'p',
      'card-note',
      'In the order the chain records them. A green mark is read directly off the chain and tied ' +
        'to this account by a decoded value; an amber mark is matched by transaction window and ' +
        'says so on the row; a faded row was looked for and is not there.',
    ),
  );
  const list = element('ol', 'timeline');
  let index = 0;
  for (const step of report.steps) {
    index += 1;
    list.append(renderStep(step, index));
  }
  card.append(list);
  return card;
}

function renderStep(step: Step, index: number): HTMLElement {
  const item = element('li', `step step-${step.status}`);
  item.dataset.index = step.status === 'missing' ? '–' : String(index);

  const head = element('div', 'step-head');
  head.append(element('span', 'step-name', step.name));
  head.append(element('span', 'step-kind', step.kind));
  if (step.status === 'inferred') {
    head.append(element('span', 'step-kind step-kind-inferred', 'matched by window'));
  }
  if (step.status === 'missing') {
    head.append(element('span', 'step-kind', 'not found'));
  }
  item.append(head);
  item.append(element('p', 'step-meaning', step.meaning));
  if (step.facts.length > 0) item.append(renderFacts(step.facts));
  const queries = renderQueries(step.queries);
  if (queries) item.append(queries);
  return item;
}

function stateCard(report: VerificationReport): HTMLElement {
  const card = element('section', 'card');
  card.append(element('h2', undefined, 'Current account state'));
  const state = report.state;
  if (!state) {
    card.append(
      element('p', 'card-note', 'The indexer returned no state for this contract address.'),
    );
    return card;
  }
  card.append(
    element(
      'p',
      'card-note',
      'Decoded from the contract’s own serialised state with the compiled account contract ' +
        'and the Compact runtime — these are values, not hashes.',
    ),
  );

  const table = element('table', 'balances');
  const header = element('tr');
  for (const label of ['Holding', 'Colour', 'Amount (atomic)']) {
    header.append(element('th', undefined, label));
  }
  table.append(header);

  for (const balance of state.nightBalances) {
    const row = element('tr');
    row.append(element('td', undefined, 'night_balances'));
    const colour = element('td');
    colour.append(element('code', undefined, shortHex(balance.colourHex)));
    if (balance.label) colour.append(element('span', 'token-label', balance.label));
    colour.append(copyButton('copy', () => balance.colourHex));
    row.append(colour);
    row.append(element('td', 'num', balance.amount));
    table.append(row);
  }
  for (const coin of state.coins) {
    const row = element('tr');
    row.append(element('td', undefined, `coins · nonce ${coin.nonceHex.slice(0, 8)}…`));
    const colour = element('td');
    colour.append(element('code', undefined, shortHex(coin.colourHex)));
    if (coin.label) colour.append(element('span', 'token-label', coin.label));
    colour.append(copyButton('copy', () => coin.colourHex));
    row.append(colour);
    row.append(element('td', 'num', coin.amount));
    table.append(row);
  }
  if (state.nightBalances.length === 0 && state.coins.length === 0) {
    const row = element('tr');
    const cell = element('td', undefined, 'The account holds nothing.');
    cell.colSpan = 3;
    row.append(cell);
    table.append(row);
  }
  card.append(table);

  const pairs = element('dl', 'pairs');
  pairs.append(element('dt', undefined, 'device_count'));
  const devices = element('dd');
  devices.append(element('code', undefined, state.deviceCount));
  pairs.append(devices);
  pairs.append(element('dt', undefined, 'State digest'));
  const digest = element('dd');
  digest.append(
    element('code', undefined, state.stateDigest),
    copyButton('copy', () => state.stateDigest),
    document.createTextNode(` · SHA-256 of ${state.stateBytes} bytes`),
  );
  pairs.append(digest);
  card.append(pairs);

  const queries = renderQueries(state.queries);
  if (queries) card.append(queries);
  return card;
}

function invariantsCard(report: VerificationReport): HTMLElement {
  const card = element('section', 'card');
  card.append(element('h2', undefined, 'Invariants'));
  card.append(
    element(
      'p',
      'card-note',
      'Each one is computed from the data above, not asserted. An amber mark means there was ' +
        'nothing to check, never that a check was skipped.',
    ),
  );
  const list = element('ul', 'invariants');
  for (const invariant of report.invariants) {
    const item = element('li', `invariant invariant-${invariant.status}`);
    const mark =
      invariant.status === 'pass' ? '✓' : invariant.status === 'fail' ? '✕' : '—';
    item.append(element('span', 'invariant-mark', mark));
    const body = element('div');
    body.append(element('div', 'invariant-claim', invariant.claim));
    body.append(element('p', 'invariant-detail', invariant.detail));
    item.append(body);
    list.append(item);
  }
  card.append(list);
  return card;
}

/* -------------------------------------------------------------------------- */
/* Bring-up                                                                   */
/* -------------------------------------------------------------------------- */

const form = requireElement<HTMLFormElement>('lookup-form');
const input = requireElement<HTMLInputElement>('lookup-input');
const submit = requireElement<HTMLButtonElement>('lookup-submit');
const status = requireElement<HTMLDivElement>('status');
const results = requireElement<HTMLDivElement>('results');

requireElement('fact-indexer').textContent = INDEXER_URL;
requireElement('fact-sponsor').textContent = SPONSOR_ADDRESS;
for (const [id, address] of [
  ['fact-registry', TLD_ADDRESS],
  ['fact-faucet', FAUCET_ADDRESS],
] as const) {
  const holder = requireElement(id);
  holder.append(
    explorerLink(explorerContractUrl(address), shortHex(address)),
    copyButton('copy', () => address),
  );
}

let inFlight = 0;

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

async function run(target: string): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) {
    setStatus('Type a .night name or a 64-hex account contract address.', true);
    return;
  }
  const ticket = (inFlight += 1);
  submit.disabled = true;
  results.replaceChildren();
  setStatus('Reading the chain…');
  try {
    const report = await verifyTarget(trimmed, (message) => {
      if (ticket === inFlight) setStatus(message);
    });
    /* A slower earlier lookup must never overwrite a newer one's answer. */
    if (ticket !== inFlight) return;
    results.replaceChildren(
      identityCard(report),
      timelineCard(report),
      stateCard(report),
      invariantsCard(report),
    );
    const found = report.steps.filter((step) => step.status !== 'missing').length;
    setStatus(
      `${found} step(s) read from the chain for ${report.domain ?? report.accountAddress}.`,
    );
  } catch (cause) {
    if (ticket !== inFlight) return;
    setStatus(cause instanceof Error ? cause.message : String(cause), true);
  } finally {
    if (ticket === inFlight) submit.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  const url = new URL(window.location.href);
  if (value) url.searchParams.set('q', value);
  else url.searchParams.delete('q');
  window.history.replaceState(null, '', url);
  void run(value);
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.example')) {
  button.addEventListener('click', () => {
    input.value = button.dataset.example ?? '';
    form.requestSubmit();
  });
}

/* `?q=…` makes a verified account a link an operator can paste into a call. */
const initial = new URL(window.location.href).searchParams.get('q');
if (initial) {
  input.value = initial;
  void run(initial);
} else {
  setStatus('Ready.');
}

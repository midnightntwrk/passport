/*
 * The tally service, as four calls.
 *
 * Every response is treated as untrusted: it comes from another origin, and a
 * malformed one becomes a sentence on screen rather than a thrown render.
 */

import { TALLY_URL } from './config.js';
import type { PollResults } from '../service/tally.js';

export type ApiOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

async function call<T>(path: string, init?: RequestInit): Promise<ApiOutcome<T>> {
  try {
    const response = await fetch(`${TALLY_URL}${path}`, {
      ...init,
      ...(init?.body ? { headers: { 'Content-Type': 'application/json' } } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : 'The tally service refused that.';
      return { ok: false, message };
    }
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, message: 'The tally service is not answering. Start it and try again.' };
  }
}

export function listPolls(): Promise<ApiOutcome<{ polls: PollResults[] }>> {
  return call('/api/polls');
}

export function readPoll(id: string): Promise<ApiOutcome<{ poll: PollResults }>> {
  return call(`/api/polls/${encodeURIComponent(id)}`);
}

export function newPoll(
  question: string,
  options: readonly string[],
): Promise<ApiOutcome<{ poll: PollResults }>> {
  return call('/api/polls', { method: 'POST', body: JSON.stringify({ question, options }) });
}

export function vote(
  id: string,
  input: { option: string; account: string; name?: string; proof: { exchange: string; txHash?: string } },
): Promise<ApiOutcome<{ poll: PollResults }>> {
  return call(`/api/polls/${encodeURIComponent(id)}/votes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

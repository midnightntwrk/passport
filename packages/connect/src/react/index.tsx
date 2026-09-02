/* ===========================================================================
 * `@midnight-passport/connect/react`
 * ===========================================================================
 *
 * A provider and three hooks. There is no state management in here beyond what
 * a component needs to render an outcome: the client is the state machine, and
 * these are the twenty lines of `useState` every integrating app was writing
 * around it.
 *
 * The provider owns exactly one client for the life of the tree, because a
 * second client means a second `message` listener and two windows both trying
 * to be `midnight-passport`. It is created lazily and destroyed on unmount.
 * ========================================================================= */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  createPassport,
  type CreatePassportOptions,
  type Passport,
  type PassportIncentive,
  type PassportIncentiveResult,
  type PassportPaymentIntent,
  type PassportPaymentResult,
  type PassportProfileResult,
  type PassportTrafficEvent,
} from '../core/client.js';
import type { PassportPresence } from '../core/transport/types.js';
import type { PassportProfileField } from '../protocol/profile.js';

const PassportContext = createContext<Passport | null>(null);

export interface PassportProviderProps extends CreatePassportOptions {
  children?: ReactNode;
}

export function PassportProvider({ children, ...options }: PassportProviderProps): ReactNode {
  const { origin, transport, timeoutMs, presenceTimeoutMs, closedPollMs, popupFeatures } = options;
  const passport = useMemo(
    () =>
      createPassport({
        origin,
        ...(transport === undefined ? {} : { transport }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(presenceTimeoutMs === undefined ? {} : { presenceTimeoutMs }),
        ...(closedPollMs === undefined ? {} : { closedPollMs }),
        ...(popupFeatures === undefined ? {} : { popupFeatures }),
      }),
    [origin, transport, timeoutMs, presenceTimeoutMs, closedPollMs, popupFeatures],
  );
  useEffect(() => () => passport.destroy(), [passport]);
  return createElement(PassportContext.Provider, { value: passport }, children);
}

function usePassportClient(): Passport {
  const passport = useContext(PassportContext);
  if (!passport) {
    throw new Error('usePassport must be used inside a <PassportProvider origin="…">.');
  }
  return passport;
}

export interface UsePassportResult {
  readonly passport: Passport;
  readonly mode: Passport['mode'];
  /** `null` until the first detection settles. */
  readonly presence: PassportPresence | null;
  /** Every message this page sent or accepted, newest last. */
  readonly traffic: readonly PassportTrafficEvent[];
}

/**
 * The client, the mode, a presence check that runs once, and the transcript.
 *
 * The transcript is not decoration. The protocols are a handful of message
 * types each, and watching the `requestId`/`nonce` pair be minted, echoed, and
 * matched teaches the security model faster than any diagram.
 */
export function usePassport(options?: { detect?: boolean; trafficLimit?: number }): UsePassportResult {
  const passport = usePassportClient();
  const [presence, setPresence] = useState<PassportPresence | null>(null);
  const [traffic, setTraffic] = useState<readonly PassportTrafficEvent[]>([]);
  const limit = options?.trafficLimit ?? 24;

  useEffect(() => {
    return passport.on('message', (event) => {
      setTraffic((current) => [...current, event].slice(-limit));
    });
  }, [passport, limit]);

  const shouldDetect = options?.detect !== false;
  useEffect(() => {
    if (!shouldDetect) return undefined;
    let live = true;
    void passport.detect().then((result) => {
      if (live) setPresence(result);
    });
    return () => {
      live = false;
    };
  }, [passport, shouldDetect]);

  return { passport, mode: passport.mode, presence, traffic };
}

export interface UsePassportProfileResult {
  request(): Promise<PassportProfileResult>;
  readonly result: PassportProfileResult | null;
  readonly pending: boolean;
  reset(): void;
}

export function usePassportProfile(
  fields: readonly PassportProfileField[],
): UsePassportProfileResult {
  const passport = usePassportClient();
  const [result, setResult] = useState<PassportProfileResult | null>(null);
  const [pending, setPending] = useState(false);
  /* The field list is almost always an inline array literal, so depending on
     its identity would re-create `request` on every render. The values are
     what matter. */
  const key = fields.join(',');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const request = useCallback(async () => {
    setPending(true);
    try {
      const outcome = await passport.requestProfile(key.split(',') as PassportProfileField[]);
      if (live.current) setResult(outcome);
      return outcome;
    } finally {
      if (live.current) setPending(false);
    }
  }, [passport, key]);

  const reset = useCallback(() => setResult(null), []);
  return { request, result, pending, reset };
}

export interface UsePassportPaymentResult {
  request(intent: PassportPaymentIntent): Promise<PassportPaymentResult>;
  reportIncentive(incentive: PassportIncentive): Promise<PassportIncentiveResult>;
  readonly result: PassportPaymentResult | null;
  readonly pending: boolean;
  reset(): void;
}

export function usePassportPayment(): UsePassportPaymentResult {
  const passport = usePassportClient();
  const [result, setResult] = useState<PassportPaymentResult | null>(null);
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const request = useCallback(
    async (intent: PassportPaymentIntent) => {
      setPending(true);
      try {
        const outcome = await passport.requestPayment(intent);
        if (live.current) setResult(outcome);
        return outcome;
      } finally {
        if (live.current) setPending(false);
      }
    },
    [passport],
  );

  const reportIncentive = useCallback(
    (incentive: PassportIncentive) => passport.reportIncentive(incentive),
    [passport],
  );

  const reset = useCallback(() => setResult(null), []);
  return { request, reportIncentive, result, pending, reset };
}

import type {
  PassportJoinOptions,
  PassportJoinResult,
  PassportStateInjectionResult,
  PassportStateInjectionOptions,
} from './types.js';

/**
 * Loads state saved for one Passport app/account scope, falling back to the
 * supplied initial state for first join. The caller passes `privateState`
 * directly to Midnight's `initialPrivateState` option.
 */
export interface PassportStateInjection<T> extends PassportStateInjectionResult<T> {}

export async function PassportStateInjection<T>(
  options: PassportStateInjectionOptions<T>,
): Promise<PassportStateInjection<T>> {
  const stored = await options.store.load<T>(options.scope);
  return {
    scope: options.scope,
    privateState: stored ?? options.initialPrivateState,
    source: stored === null ? 'initial' : 'stored',
  };
}

/**
 * Adapter for any Midnight `findDeployedContract`/`deployContract` wrapper.
 * It deliberately knows nothing about wallet seeds or witnesses.
 */
export async function joinWithPassportState<T, TResult>(
  options: PassportJoinOptions<T, TResult>,
): Promise<PassportJoinResult<T, TResult>> {
  const injection = await PassportStateInjection(options);
  return { injection, result: await options.join(injection.privateState) };
}

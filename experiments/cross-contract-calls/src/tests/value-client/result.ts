// VENDORED SLICE — circuit return-value extraction.
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/account.ts (circuitResult), commit 2b0b55d: the
// circuit's declared return value travels in the call result's private
// section; probe the surfaces the midnight-js versions disagree on.

export function circuitResult(r: any): any {
  for (const v of [r?.private?.result, r?.private?.circuitResult, r?.private?.returnValue, r?.result]) {
    if (v !== undefined) return v;
  }
  return undefined;
}

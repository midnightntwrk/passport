// Browser stand-in for Node's `assert`, aliased in vite.config.ts.
// @subsquid/scale-codec (via the wallet SDK's chain client) calls the
// default export as a function; Vite's own externalisation stub is not
// callable, which surfaced at runtime as "(0, assert_1.default) is not a
// function" during local-wallet creation.

type AssertFn = {
  (value: unknown, message?: string | Error): asserts value
  ok: (value: unknown, message?: string | Error) => asserts value
  strictEqual: (actual: unknown, expected: unknown, message?: string | Error) => void
  notStrictEqual: (actual: unknown, expected: unknown, message?: string | Error) => void
  fail: (message?: string | Error) => never
}

function raise(message?: string | Error): never {
  if (message instanceof Error) throw message
  throw new Error(message ?? 'Assertion failed')
}

const assert = ((value: unknown, message?: string | Error) => {
  if (!value) raise(message)
}) as AssertFn

assert.ok = assert
assert.strictEqual = (actual, expected, message) => {
  if (!Object.is(actual, expected)) {
    raise(message ?? `Expected ${String(actual)} to strictly equal ${String(expected)}`)
  }
}
assert.notStrictEqual = (actual, expected, message) => {
  if (Object.is(actual, expected)) {
    raise(message ?? `Expected values to differ, both were ${String(actual)}`)
  }
}
assert.fail = (message) => raise(message)

export default assert
export const ok = assert.ok
export const strictEqual = assert.strictEqual
export const notStrictEqual = assert.notStrictEqual
export const fail = assert.fail

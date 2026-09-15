import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DISABLED_SESSION,
  DYNAMIC_SOCIAL_PROVIDERS,
  DYNAMIC_TEST_MESSAGE,
  describeDynamicIdentity,
  describeDynamicSession,
  dynamicEnvironmentId,
  isDynamicEnabled,
  publishDynamicActions,
  publishDynamicSession,
  readDynamicActions,
  readDynamicSession,
  resetDynamicSessionStoreForTests,
  shortEvmAddress,
  socialProviderLabel,
  subscribeToDynamicSession,
  type DynamicSession,
} from './dynamicSession.js'

afterEach(() => {
  resetDynamicSessionStoreForTests()
})

describe('the gate', () => {
  it('is off when the variable is absent, which is every build shipped today', () => {
    expect(isDynamicEnabled({})).toBe(false)
    expect(dynamicEnvironmentId({})).toBeNull()
  })

  it('is off when the variable is present but empty', () => {
    expect(isDynamicEnabled({ VITE_DYNAMIC_ENVIRONMENT_ID: '' })).toBe(false)
  })

  it('is off when the variable is only whitespace', () => {
    /* A deployment dashboard that will not let a variable be deleted is how
       this arrives: somebody blanks the field and means "off". Booting the SDK
       against " " fails later and further away than declining to boot it. */
    expect(isDynamicEnabled({ VITE_DYNAMIC_ENVIRONMENT_ID: '   \n\t ' })).toBe(false)
    expect(dynamicEnvironmentId({ VITE_DYNAMIC_ENVIRONMENT_ID: '  ' })).toBeNull()
  })

  it('is off when the variable is not a string at all', () => {
    expect(isDynamicEnabled({ VITE_DYNAMIC_ENVIRONMENT_ID: 42 })).toBe(false)
    expect(isDynamicEnabled({ VITE_DYNAMIC_ENVIRONMENT_ID: undefined })).toBe(false)
  })

  it('is on for a real id, and hands back the id trimmed', () => {
    const env = { VITE_DYNAMIC_ENVIRONMENT_ID: '  4f1b0e7a-0000-4000-8000-abcdefabcdef \n' }
    expect(isDynamicEnabled(env)).toBe(true)
    expect(dynamicEnvironmentId(env)).toBe('4f1b0e7a-0000-4000-8000-abcdefabcdef')
  })

  it('reads import.meta.env when nothing is passed, so the app needs no argument', () => {
    vi.stubEnv('VITE_DYNAMIC_ENVIRONMENT_ID', 'from-import-meta')
    try {
      expect(dynamicEnvironmentId()).toBe('from-import-meta')
      expect(isDynamicEnabled()).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(isDynamicEnabled()).toBe(false)
  })
})

describe('provider labels', () => {
  it('asks for exactly the four providers this slice is about', () => {
    expect([...DYNAMIC_SOCIAL_PROVIDERS]).toEqual(['google', 'discord', 'microsoft', 'twitter'])
  })

  it('renders twitter as X, which is the one place that rename lives', () => {
    expect(socialProviderLabel('twitter')).toBe('X')
    expect(socialProviderLabel('X')).toBe('X')
    expect(socialProviderLabel(' Twitter ')).toBe('X')
  })

  it('title-cases the rest', () => {
    expect(socialProviderLabel('google')).toBe('Google')
    expect(socialProviderLabel('discord')).toBe('Discord')
    expect(socialProviderLabel('microsoft')).toBe('Microsoft')
  })

  it('names the email strategies Email rather than title-casing the wire value', () => {
    expect(socialProviderLabel('emailOnly')).toBe('Email')
    expect(socialProviderLabel('email')).toBe('Email')
  })

  it('does not render a blank provider as a blank label', () => {
    expect(socialProviderLabel('   ')).toBe('Unknown')
  })
})

describe('shortEvmAddress', () => {
  it('keeps both ends, which is what makes two of them comparable by eye', () => {
    expect(shortEvmAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
  })

  it('leaves anything already short alone rather than padding it with an ellipsis', () => {
    expect(shortEvmAddress('0x1234')).toBe('0x1234')
    expect(shortEvmAddress('0x12345678901')).toBe('0x12345678901')
  })
})

describe('describeDynamicIdentity', () => {
  it('has nothing to say about nobody', () => {
    expect(describeDynamicIdentity(null)).toEqual({ provider: null, handle: null })
    expect(describeDynamicIdentity(undefined)).toEqual({ provider: null, handle: null })
  })

  it('picks the social credential out rather than trusting the first one', () => {
    /* The embedded wallet is a verified credential too, and Dynamic does not
       promise an order. Reading credentials[0] would label a signed-in X user
       with their own Ethereum address. */
    const identity = describeDynamicIdentity({
      verifiedCredentials: [
        { format: 'blockchain', address: '0xabc' },
        { format: 'oauth', oauthProvider: 'twitter', oauthUsername: 'ada' },
      ],
    })
    expect(identity).toEqual({ provider: 'X', handle: 'ada' })
  })

  it('falls back through display name, credential email, user email, and username', () => {
    const base = { format: 'oauth', oauthProvider: 'google' }
    expect(describeDynamicIdentity({ verifiedCredentials: [{ ...base, oauthDisplayName: 'Ada L' }] }))
      .toEqual({ provider: 'Google', handle: 'Ada L' })
    expect(describeDynamicIdentity({ verifiedCredentials: [{ ...base, email: 'a@example.test' }] }))
      .toEqual({ provider: 'Google', handle: 'a@example.test' })
    expect(
      describeDynamicIdentity({ email: 'user@example.test', verifiedCredentials: [{ ...base }] }),
    ).toEqual({ provider: 'Google', handle: 'user@example.test' })
    expect(describeDynamicIdentity({ username: 'ada', verifiedCredentials: [{ ...base }] })).toEqual({
      provider: 'Google',
      handle: 'ada',
    })
  })

  it('treats a blank string from the API as an absence, not as a handle', () => {
    expect(
      describeDynamicIdentity({
        verifiedCredentials: [{ oauthProvider: 'discord', oauthUsername: '   ' }],
      }),
    ).toEqual({ provider: 'Discord', handle: null })
  })

  it('ignores a credential whose provider field is blank', () => {
    expect(
      describeDynamicIdentity({
        email: 'a@example.test',
        verifiedCredentials: [{ oauthProvider: '  ', oauthUsername: 'ghost' }],
      }),
    ).toEqual({ provider: 'Email', handle: 'a@example.test' })
  })

  it('still names an email-only user rather than rendering them as nobody', () => {
    expect(describeDynamicIdentity({ email: 'a@example.test' })).toEqual({
      provider: 'Email',
      handle: 'a@example.test',
    })
    expect(describeDynamicIdentity({ verifiedCredentials: null })).toEqual({
      provider: null,
      handle: null,
    })
  })
})

describe('describeDynamicSession', () => {
  it('is loading until the SDK says it has loaded', () => {
    expect(
      describeDynamicSession({ sdkHasLoaded: false, user: { email: 'a@b.test' }, walletAddress: '0x1' }),
    ).toEqual({ ...DISABLED_SESSION, status: 'loading' })
  })

  it('is signed out when the SDK is live and nobody is there', () => {
    expect(describeDynamicSession({ sdkHasLoaded: true, user: null, walletAddress: null })).toEqual({
      ...DISABLED_SESSION,
      status: 'signed-out',
    })
  })

  it('is signed in the moment there is a user, before the address exists', () => {
    /* The address arrives after the auth flow resolves. Deciding on the wallet
       would flip the row back to signed-out mid-sign-in. */
    expect(
      describeDynamicSession({
        sdkHasLoaded: true,
        user: { verifiedCredentials: [{ oauthProvider: 'microsoft', oauthUsername: 'ada' }] },
        walletAddress: undefined,
      }),
    ).toEqual({ status: 'signed-in', provider: 'Microsoft', handle: 'ada', evmAddress: null })
  })

  it('carries the address once it is there, and treats a blank one as absent', () => {
    const user = { verifiedCredentials: [{ oauthProvider: 'google', oauthUsername: 'ada' }] }
    expect(describeDynamicSession({ sdkHasLoaded: true, user, walletAddress: '0xabc' }).evmAddress).toBe(
      '0xabc',
    )
    expect(describeDynamicSession({ sdkHasLoaded: true, user, walletAddress: '  ' }).evmAddress).toBeNull()
  })
})

describe('the store', () => {
  it('starts disabled, with no actions', () => {
    expect(readDynamicSession()).toEqual(DISABLED_SESSION)
    expect(readDynamicActions()).toBeNull()
  })

  it('returns the SAME object until something changes, or useSyncExternalStore loops', () => {
    const first = readDynamicSession()
    publishDynamicSession({ ...DISABLED_SESSION })
    expect(readDynamicSession()).toBe(first)
  })

  it('notifies subscribers exactly once per real change', () => {
    const listener = vi.fn()
    subscribeToDynamicSession(listener)

    const session: DynamicSession = {
      status: 'signed-in',
      provider: 'X',
      handle: 'ada',
      evmAddress: '0xabc',
    }
    publishDynamicSession(session)
    expect(listener).toHaveBeenCalledTimes(1)

    publishDynamicSession({ ...session })
    expect(listener).toHaveBeenCalledTimes(1)

    publishDynamicSession({ ...session, evmAddress: '0xdef' })
    expect(listener).toHaveBeenCalledTimes(2)
    publishDynamicSession({ ...session, evmAddress: '0xdef', handle: 'grace' })
    expect(listener).toHaveBeenCalledTimes(3)
    publishDynamicSession({ ...session, evmAddress: '0xdef', handle: 'grace', provider: 'Google' })
    expect(listener).toHaveBeenCalledTimes(4)
    publishDynamicSession({ ...DISABLED_SESSION })
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToDynamicSession(listener)
    unsubscribe()
    publishDynamicSession({ ...DISABLED_SESSION, status: 'loading' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('hands back whatever actions the bridge registered, and lets it withdraw them', () => {
    const actions = {
      openAuthFlow: vi.fn(),
      signMessage: vi.fn(() => Promise.resolve('0xsig')),
      signOut: vi.fn(() => Promise.resolve()),
    }
    publishDynamicActions(actions)
    expect(readDynamicActions()).toBe(actions)
    publishDynamicActions(null)
    expect(readDynamicActions()).toBeNull()
  })
})

describe('the test message', () => {
  it('carries no nonce and no timestamp, so two signatures of it are comparable', () => {
    expect(DYNAMIC_TEST_MESSAGE).toBe('Midnight Passport test message')
  })

  it('is not the envelope the account circuit verifies, which keccak makes unusable here', () => {
    expect(DYNAMIC_TEST_MESSAGE).not.toContain('midnight_signed_message')
  })
})

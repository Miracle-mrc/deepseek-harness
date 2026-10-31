/** AWS token refresh reconciles durable sessions without holding locks across CLI work. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthProvider } from '@modelcontextprotocol/client'
import { refreshAwsCliToken } from '../src/aws-cli.ts'
import { createAwsCliAuth, createAwsCliGrant, parseAwsCliGrant, type AwsCliGrant } from '../src/aws-grant.ts'
import { cloudMcpUrl } from '../src/catalog.ts'
import { parseConnectionGrant } from '../src/connection-grant.ts'
import { CloudConnectionError } from '../src/errors.ts'
import { cloudCredentialKey, type CloudGrant } from '../src/oauth-provider.ts'

vi.mock('../src/aws-cli.ts', () => ({ refreshAwsCliToken: vi.fn() }))

const NOW = 2_000_000_000_000
const options = { executable: '/fixture/aws', commandTimeoutMs: 20_000 }
const refreshToken = vi.mocked(refreshAwsCliToken)
const contexts: Context[] = []

function tokens(accessToken: string): AwsCliGrant['tokens'] {
  return { accessToken, expiresAt: NOW + 600_000 }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  refreshToken.mockReset().mockResolvedValue(tokens('new-token'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function credentialStore(initial: AwsCliGrant) {
  const ctx = new Context()
  contexts.push(ctx)
  let record: CredentialRecord | undefined = { kind: 'grant', payload: initial }
  let tail: Promise<unknown> = Promise.resolve()
  let locked = false
  let writes = 0
  const modifyRecord = vi.fn<Context['credentials']['modifyRecord']>((key, mutate) => {
    expect(key).toBe(cloudCredentialKey('aws'))
    const operation = tail.then(async () => {
      locked = true
      try {
        const replacement = await mutate(record)
        if (replacement !== undefined) {
          record = replacement
          writes += 1
        }
        return record
      } finally {
        locked = false
      }
    })
    tail = operation.catch(() => undefined)
    return operation
  })
  ctx.provide('credentials', { modifyRecord })
  return {
    ctx, modifyRecord, locked: () => locked, writes: () => writes,
    read: () => parseAwsCliGrant(record),
    replace: (next: AwsCliGrant | undefined) => { record = next === undefined ? undefined : { kind: 'grant', payload: next } },
  }
}

function fixture(token = tokens('original-token')) {
  const grant = { ...createAwsCliGrant('us-east-1', 'harness', 'existing', token), confirmed: true, allowedTools: ['aws___call'] }
  const store = credentialStore(grant)
  const controller = new AbortController()
  const auth = createAwsCliAuth(store.ctx, grant, options, controller.signal)
  const unauthorized: Parameters<NonNullable<AuthProvider['onUnauthorized']>>[0] = {
    serverUrl: new URL(grant.endpoint), response: new Response(null, { status: 401 }), fetchFn: vi.fn<typeof fetch>(),
  }
  return { grant, store, controller, auth, unauthorized }
}

function legacyGrant(provider: 'aws' | 'supabase'): CloudGrant {
  return {
    grantId: 'b89d9bd7-27bf-457f-a69f-302861b82f01', provider,
    endpoint: cloudMcpUrl(provider), ...(provider === 'aws' ? { region: 'us-east-1' } : {}),
    redirectUri: 'http://127.0.0.1:60432/oauth/callback',
    tokens: { access_token: 'legacy-token', token_type: 'Bearer' },
    clientInformation: { client_id: 'legacy-client' }, confirmed: false, allowedTools: [],
  }
}

describe('AWS CLI durable grants', () => {
  it('creates separate unconfirmed sessions with the selected profile, method and fixed endpoint', () => {
    const first = createAwsCliGrant('eu-west-1', 'harness.dev', 'sso', tokens('initial-token'))
    const second = createAwsCliGrant('eu-west-1', 'harness.dev', 'sso', tokens('initial-token'))
    expect(first).toMatchObject({
      authMethod: 'aws-cli', provider: 'aws', region: 'eu-west-1', profile: 'harness.dev', loginMethod: 'sso',
      endpoint: cloudMcpUrl('aws', 'eu-west-1'), tokens: tokens('initial-token'), confirmed: false, allowedTools: [],
    })
    expect(first.grantId).not.toBe(second.grantId)
    expect(parseAwsCliGrant({ kind: 'grant', payload: JSON.parse(JSON.stringify(first)) })).toEqual(first)
  })

  it('accepts an expired durable token so the transport can refresh it', () => {
    const original = createAwsCliGrant('us-east-1', 'default', 'login', { accessToken: 'expired-token', expiresAt: NOW - 1 })
    expect(parseAwsCliGrant({ kind: 'grant', payload: original })).toEqual(original)
    expect(parseAwsCliGrant(undefined)).toBeUndefined()
    expect(parseAwsCliGrant({ kind: 'api-key', key: 'unrelated-key' })).toBeUndefined()
  })

  it.each([
    { name: 'different authentication method', patch: { authMethod: 'other' } },
    { name: 'different provider', patch: { provider: 'supabase' } },
    { name: 'missing session identity', patch: { grantId: undefined } },
    { name: 'invalid session identity', patch: { grantId: 'not-a-uuid' } },
    { name: 'external endpoint', patch: { endpoint: 'https://unrelated.example/mcp' } },
    { name: 'endpoint in another region', patch: { endpoint: cloudMcpUrl('aws', 'eu-west-1') } },
    { name: 'unsupported region', patch: { region: 'unlisted-region' } },
    { name: 'empty profile', patch: { profile: '' } },
    { name: 'profile containing whitespace', patch: { profile: 'harness development' } },
    { name: 'profile containing command options', patch: { profile: '--endpoint-url' } },
    { name: 'profile containing shell syntax', patch: { profile: 'harness;env' } },
    { name: 'unknown login route', patch: { loginMethod: 'other' } },
    { name: 'empty token', patch: { tokens: { accessToken: '', expiresAt: NOW + 600_000 } } },
    { name: 'non-finite expiry', patch: { tokens: { accessToken: 'invalid-token', expiresAt: Number.POSITIVE_INFINITY } } },
    { name: 'invalid expiry', patch: { tokens: { accessToken: 'invalid-token', expiresAt: -1 } } },
    { name: 'missing consent', patch: { confirmed: undefined } },
    { name: 'invalid tool selection', patch: { allowedTools: [1] } },
  ])('rejects a durable grant with $name', ({ patch }) => {
    const original = createAwsCliGrant('us-east-1', 'harness', 'existing', tokens('initial-token'))
    expect(parseAwsCliGrant({ kind: 'grant', payload: { ...original, ...patch } })).toBeUndefined()
  })

  it('reports invalid factory inputs without retaining their values in an error', () => {
    for (const [region, profile, token] of [
      ['invalid-region', 'harness', tokens('sensitive-token')],
      ['us-east-1', '--invalid-profile', tokens('sensitive-token')],
      ['us-east-1', 'harness', { accessToken: 'sensitive-token', expiresAt: Number.NaN }],
    ] as const) {
      expect(() => createAwsCliGrant(region, profile, 'existing', token)).toThrow(new CloudConnectionError('authorization-failed'))
    }
  })

  it('routes CLI sessions explicitly and continues to read untagged legacy OAuth grants', () => {
    const original = createAwsCliGrant('us-east-1', 'harness', 'existing', tokens('initial-token'))
    expect(parseConnectionGrant('aws', { kind: 'grant', payload: original })).toEqual(original)
    expect(parseConnectionGrant('supabase', { kind: 'grant', payload: original })).toBeUndefined()
    for (const provider of ['aws', 'supabase'] as const) {
      const legacy = legacyGrant(provider)
      expect(parseConnectionGrant(provider, { kind: 'grant', payload: legacy })).toEqual(legacy)
      expect(parseConnectionGrant(provider, { kind: 'grant', payload: { ...legacy, authMethod: 'aws-cli' } })).toBeUndefined()
      expect(parseConnectionGrant(provider, { kind: 'grant', payload: { ...legacy, authMethod: 'unknown' } })).toBeUndefined()
    }
    expect(parseConnectionGrant('aws', undefined)).toBeUndefined()
  })
})

describe('AWS CLI transport authentication', () => {
  it('reconciles durable credentials before every token read', async () => {
    const { auth, grant, store } = fixture()
    await expect(auth.token()).resolves.toBe('original-token')
    store.replace({ ...grant, tokens: tokens('another-host-token') })
    await expect(auth.token()).resolves.toBe('another-host-token')
    expect(store.modifyRecord).toHaveBeenCalledTimes(2)
    expect(store.writes()).toBe(0)
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it.each([NOW - 1, NOW + 30_000])('refreshes a token expiring at %i before exposing it to transport', async (expiresAt) => {
    const { auth, grant, store, controller } = fixture({ accessToken: 'expiring-token', expiresAt })
    refreshToken.mockImplementationOnce(async () => {
      expect(store.locked()).toBe(false)
      return tokens('refreshed-token')
    })
    await expect(auth.token()).resolves.toBe('refreshed-token')
    expect(refreshToken).toHaveBeenCalledExactlyOnceWith({ ...options, profile: 'harness', region: 'us-east-1', signal: controller.signal })
    expect(store.read()).toEqual({ ...grant, tokens: tokens('refreshed-token') })
    expect(store.writes()).toBe(1)
  })

  it('shares one CLI refresh between simultaneous expired-token reads', async () => {
    const { auth, store } = fixture({ accessToken: 'expired-token', expiresAt: NOW - 1 })
    const entered = Promise.withResolvers<undefined>()
    const minted = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => {
      expect(store.locked()).toBe(false)
      entered.resolve(undefined)
      return minted.promise
    })
    const pending = [auth.token(), auth.token(), auth.token()]
    try {
      await entered.promise
      minted.resolve(tokens('shared-token'))
      await expect(Promise.all(pending)).resolves.toEqual(['shared-token', 'shared-token', 'shared-token'])
      expect(refreshToken).toHaveBeenCalledOnce()
      expect(store.writes()).toBe(1)
    } finally {
      minted.resolve(tokens('shared-token'))
      await Promise.allSettled(pending)
    }
  })

  it('shares one unauthorized refresh and never invokes transport fetch', async () => {
    const { auth, store, unauthorized } = fixture()
    const entered = Promise.withResolvers<undefined>()
    const minted = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => {
      expect(store.locked()).toBe(false)
      entered.resolve(undefined)
      return minted.promise
    })
    const first = auth.onUnauthorized!(unauthorized)
    const second = auth.onUnauthorized!(unauthorized)
    expect(second).toBe(first)
    try {
      await entered.promise
      minted.resolve(tokens('shared-token'))
      await Promise.all([first, second])
      await expect(auth.token()).resolves.toBe('shared-token')
      expect(refreshToken).toHaveBeenCalledOnce()
      expect(unauthorized.fetchFn).not.toHaveBeenCalled()
    } finally {
      minted.resolve(tokens('shared-token'))
      await Promise.allSettled([first, second])
    }
  })

  it('reuses another Host token when the rejected token has already been replaced', async () => {
    const { auth, grant, store, unauthorized } = fixture()
    await auth.token()
    store.replace({ ...grant, tokens: tokens('another-host-token') })
    await expect(auth.onUnauthorized!(unauthorized)).resolves.toBeUndefined()
    await expect(auth.token()).resolves.toBe('another-host-token')
    expect(refreshToken).not.toHaveBeenCalled()
    expect(store.writes()).toBe(0)
  })

  it.each(['token', 'consent'] as const)('preserves a concurrent %s update when committing a minted token', async (change) => {
    const { auth, grant, store, unauthorized } = fixture()
    const entered = Promise.withResolvers<undefined>()
    const minted = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => { entered.resolve(undefined); return minted.promise })
    const refreshing = auth.onUnauthorized!(unauthorized)
    try {
      await entered.promise
      const latest = { ...grant, confirmed: false, allowedTools: [], tokens: change === 'token' ? tokens('external-token') : grant.tokens }
      store.replace(latest)
      minted.resolve(tokens('minted-token'))
      await refreshing
      expect(store.read()).toEqual({ ...latest, tokens: change === 'token' ? latest.tokens : tokens('minted-token') })
      expect(store.writes()).toBe(change === 'token' ? 0 : 1)
    } finally {
      minted.resolve(tokens('minted-token'))
      await Promise.allSettled([refreshing])
    }
  })

  it.each(['disconnect', 'replacement'] as const)('does not revive a session changed by %s during CLI minting', async (change) => {
    const { auth, store, unauthorized } = fixture()
    const entered = Promise.withResolvers<undefined>()
    const minted = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => { entered.resolve(undefined); return minted.promise })
    const refreshing = auth.onUnauthorized!(unauthorized)
    const rejected = expect(refreshing).rejects.toMatchObject({ code: 'session-expired' })
    try {
      await entered.promise
      const replacement = change === 'disconnect' ? undefined : createAwsCliGrant('eu-west-1', 'another-profile', 'sso', tokens('replacement-token'))
      store.replace(replacement)
      minted.resolve(tokens('stale-token'))
      await rejected
      expect(store.read()).toEqual(replacement)
      expect(store.writes()).toBe(0)
      await expect(auth.token()).rejects.toMatchObject({ code: 'session-expired' })
    } finally {
      minted.resolve(tokens('stale-token'))
      await Promise.allSettled([refreshing])
    }
  })

  it.each(['disconnect', 'replacement'] as const)('refuses cached credentials after %s before any CLI work', async (change) => {
    const { auth, store, unauthorized } = fixture()
    await auth.token()
    store.replace(change === 'disconnect' ? undefined : createAwsCliGrant('us-east-1', 'another-profile', 'existing', tokens('replacement-token')))
    await expect(auth.token()).rejects.toMatchObject({ code: 'session-expired' })
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toMatchObject({ code: 'session-expired' })
    expect(refreshToken).not.toHaveBeenCalled()
    expect(store.writes()).toBe(0)
  })

  it('refuses cancelled requests without exposing the cancellation reason', async () => {
    const { auth, controller, store, unauthorized } = fixture()
    controller.abort(new Error('sensitive-cancellation-detail'))
    await expect(auth.token()).rejects.toThrow(new CloudConnectionError('session-expired'))
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toThrow(new CloudConnectionError('session-expired'))
    expect(store.modifyRecord).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('does not commit a token returned after cancellation', async () => {
    const { auth, grant, store, controller, unauthorized } = fixture()
    const entered = Promise.withResolvers<undefined>()
    const minted = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => { entered.resolve(undefined); return minted.promise })
    const refreshing = auth.onUnauthorized!(unauthorized)
    const rejected = expect(refreshing).rejects.toMatchObject({ code: 'session-expired' })
    try {
      await entered.promise
      controller.abort(new Error('sensitive-cancellation-detail'))
      minted.resolve(tokens('cancelled-token'))
      await rejected
      expect(store.read()).toEqual(grant)
      expect(store.writes()).toBe(0)
    } finally {
      minted.resolve(tokens('cancelled-token'))
      await Promise.allSettled([refreshing])
    }
  })

  it('sanitizes a credential-storage failure without changing the saved session', async () => {
    const { auth, grant, store } = fixture()
    store.modifyRecord.mockRejectedValueOnce(new Error('sensitive-storage-detail'))
    const rejected: unknown = await auth.token().catch((error: unknown) => error)
    expect(rejected).toEqual(new CloudConnectionError('session-expired'))
    expect(rejected).not.toHaveProperty('cause')
    expect(store.read()).toEqual(grant)
    await expect(auth.token()).resolves.toBe('original-token')
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('releases a failed refresh for retry without logging CLI output or publishing tokens', async () => {
    const { auth, grant, store, unauthorized } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    refreshToken.mockRejectedValueOnce(new Error('sensitive-cli-output'))
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toThrow(new CloudConnectionError('session-expired'))
    expect(store.read()).toEqual(grant)
    expect(warning).not.toHaveBeenCalled()
    expect(loggedError).not.toHaveBeenCalled()
    await expect(auth.onUnauthorized!(unauthorized)).resolves.toBeUndefined()
    await expect(auth.token()).resolves.toBe('new-token')
    expect(refreshToken).toHaveBeenCalledTimes(2)
  })

  it('does not expose a minted token when its durable replacement fails', async () => {
    const { auth, store, grant, unauthorized } = fixture()
    const modify = store.modifyRecord.getMockImplementation()!
    store.modifyRecord.mockImplementation((key, mutate) => {
      if (store.modifyRecord.mock.calls.length === 2) return Promise.reject(new Error('sensitive-write-diagnostic'))
      return modify(key, mutate)
    })
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toThrow(new CloudConnectionError('session-expired'))
    expect(store.read()).toEqual(grant)
    expect(store.writes()).toBe(0)
    await expect(auth.token()).resolves.toBe('original-token')
  })

  it('refuses a token whose remaining lifetime becomes too short while its write completes', async () => {
    const { auth, store, unauthorized } = fixture()
    const shortLived = { accessToken: 'short-lived-token', expiresAt: NOW + 61_000 }
    refreshToken.mockResolvedValueOnce(shortLived)
    const modify = store.modifyRecord.getMockImplementation()!
    store.modifyRecord.mockImplementation(async (key, mutate) => {
      const record = await modify(key, mutate)
      if (store.writes() > 0) vi.mocked(Date.now).mockReturnValue(NOW + 2_000)
      return record
    })
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toMatchObject({ code: 'session-expired' })
    expect(store.read()?.tokens).toEqual(shortLived)
    expect(store.writes()).toBe(1)
  })

  it('refuses an external expired record observed after proactive refresh instead of returning it', async () => {
    const { auth, store, grant } = fixture({ accessToken: 'expired-token', expiresAt: NOW - 1 })
    const external = { ...grant, tokens: { accessToken: 'external-expired-token', expiresAt: NOW - 1 } }
    const modify = store.modifyRecord.getMockImplementation()!
    store.modifyRecord.mockImplementation((key, mutate) => {
      if (store.writes() > 0) store.replace(external)
      return modify(key, mutate)
    })
    await expect(auth.token()).rejects.toMatchObject({ code: 'session-expired' })
    expect(store.read()).toEqual(external)
    expect(refreshToken).toHaveBeenCalledOnce()
  })

  it('preserves the helper fixed permission failure category', async () => {
    const { auth, store, grant, unauthorized } = fixture()
    const failure = new CloudConnectionError('aws-permission-required')
    refreshToken.mockRejectedValueOnce(failure)
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toBe(failure)
    expect(store.read()).toEqual(grant)
    expect(failure).not.toHaveProperty('cause')
  })

  it('does not publish an unusable freshly minted token', async () => {
    const { auth, store, grant, unauthorized } = fixture()
    refreshToken.mockResolvedValueOnce({ accessToken: 'already-expiring-token', expiresAt: NOW + 30_000 })
    await expect(auth.onUnauthorized!(unauthorized)).rejects.toMatchObject({ code: 'session-expired' })
    expect(store.read()).toEqual(grant)
    expect(store.writes()).toBe(0)
  })

  it('refuses to refresh for an unrelated protected resource', async () => {
    const { auth, store, unauthorized } = fixture()
    await expect(auth.onUnauthorized!({ ...unauthorized, serverUrl: new URL('https://unrelated.example/mcp') }))
      .rejects.toMatchObject({ code: 'session-expired' })
    expect(store.modifyRecord).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('allows independent Host minting without replacing the first fresh committed token', async () => {
    const { grant, store, controller, auth, unauthorized } = fixture()
    const peer = createAwsCliAuth(store.ctx, grant, options, controller.signal)
    const bothEntered = Promise.withResolvers<undefined>()
    const firstToken = Promise.withResolvers<AwsCliGrant['tokens']>()
    const secondToken = Promise.withResolvers<AwsCliGrant['tokens']>()
    refreshToken.mockImplementationOnce(() => {
      return firstToken.promise
    }).mockImplementationOnce(() => {
      bothEntered.resolve(undefined)
      return secondToken.promise
    })
    const first = auth.onUnauthorized!(unauthorized)
    const second = peer.onUnauthorized!(unauthorized)
    try {
      await bothEntered.promise
      firstToken.resolve(tokens('first-host-token'))
      await first
      secondToken.resolve(tokens('second-host-token'))
      await second
      await expect(auth.token()).resolves.toBe('first-host-token')
      await expect(peer.token()).resolves.toBe('first-host-token')
      expect(refreshToken).toHaveBeenCalledTimes(2)
      expect(store.writes()).toBe(1)
    } finally {
      firstToken.resolve(tokens('first-host-token'))
      secondToken.resolve(tokens('second-host-token'))
      await Promise.allSettled([first, second])
    }
  })
})

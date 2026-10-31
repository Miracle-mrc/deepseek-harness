/** OAuth exercises the installed SDK, with focused cancellation cases at its discovery-fetch adapter. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { auth, discoverOAuthServerInfo, type FetchLike, type OAuthDiscoveryState } from '@modelcontextprotocol/client'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { cloudMcpUrl } from '../src/catalog.ts'
import {
  cloudAuthorizationFetch, CloudOAuthProvider, CloudOAuthReconnectRequiredError, parseCloudGrant, type CloudGrant,
} from '../src/oauth-provider.ts'

vi.mock('@modelcontextprotocol/client', async (original) => {
  const actual = await original<typeof import('@modelcontextprotocol/client')>()
  return { ...actual, discoverOAuthServerInfo: vi.fn(actual.discoverOAuthServerInfo) }
})

const endpoint = cloudMcpUrl('supabase')
const issuer = 'https://identity.example'
const redirectUri = 'http://127.0.0.1:60432/oauth/callback'
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  scopes_supported: ['mcp:read', 'mcp:write', 'offline_access'],
  authorization_response_iss_parameter_supported: true,
}
const discovery: OAuthDiscoveryState = {
  authorizationServerUrl: issuer,
  authorizationServerMetadata: metadata,
  resourceMetadata: { resource: endpoint, authorization_servers: [issuer], scopes_supported: ['mcp:read', 'mcp:write'] },
}

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function grant(): CloudGrant {
  return {
    grantId: randomUUID(), provider: 'supabase', endpoint, redirectUri,
    tokens: { access_token: 'old-access', refresh_token: 'old-refresh', token_type: 'Bearer', issuer },
    clientInformation: {
      client_id: 'registered-client', client_secret: 'registered-client-secret',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_basic', issuer,
    },
    confirmed: true, allowedTools: ['execute_sql'],
  }
}

function credentialStore(initial?: CloudGrant) {
  const ctx = new Context()
  contexts.push(ctx)
  let record: CredentialRecord | undefined = initial === undefined ? undefined : { kind: 'grant', payload: initial }
  let tail: Promise<unknown> = Promise.resolve()
  const modifyRecord = vi.fn<Context['credentials']['modifyRecord']>((_key, mutate) => {
    const operation = tail.then(async () => {
      const next = await mutate(record)
      if (next !== undefined) record = next
      return record
    })
    tail = operation.catch(() => undefined)
    return operation
  })
  ctx.provide('credentials', { modifyRecord })
  return {
    ctx, modifyRecord,
    read: () => record,
    replace: (next: CloudGrant | undefined) => {
      record = next === undefined ? undefined : { kind: 'grant', payload: next }
    },
  }
}

function json(body: object): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

function fakeIdentity(token: (body: URLSearchParams, headers: Headers) => Response | Promise<Response>, register = false) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp') return json(discovery.resourceMetadata!)
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return json(metadata)
    if (url === `${issuer}/register` && register) {
      expect(init?.method).toBe('POST')
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON registration request')
      expect(JSON.parse(init.body)).toMatchObject({
        redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic', application_type: 'native',
        scope: 'mcp:read mcp:write offline_access',
      })
      return json(grant().clientInformation)
    }
    if (url === `${issuer}/token`) {
      expect(init?.method).toBe('POST')
      if (typeof init?.body !== 'string' && !(init?.body instanceof URLSearchParams)) {
        throw new Error('Expected a form token request')
      }
      return token(new URLSearchParams(init.body), new Headers(init.headers))
    }
    throw new Error('Unexpected OAuth fixture request')
  })
}

describe('cloud OAuth provider', () => {
  it('uses Supabase registration credentials and PKCE without exposing secrets in the browser URL', async () => {
    const store = credentialStore()
    const redirect = vi.fn<(url: URL) => void>()
    const provider = new CloudOAuthProvider(store.ctx, 'supabase', redirectUri, redirect, 'callback-state')
    const token = vi.fn((body: URLSearchParams, headers: Headers) => {
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('registered-client:registered-client-secret')}`)
      expect(body.has('client_secret')).toBe(false)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('one-time-code')
      expect(body.get('code_verifier')).toBe(provider.codeVerifier())
      expect(body.get('redirect_uri')).toBe(redirectUri)
      expect(body.get('resource')).toBe(endpoint)
      return json({ access_token: 'authorized-access', refresh_token: 'authorized-refresh', token_type: 'Bearer' })
    })
    const fetchFn = fakeIdentity(token, true)

    await expect(auth(provider, { serverUrl: endpoint, fetchFn, forceReauthorization: true })).resolves.toBe('REDIRECT')
    expect(provider.discoveryState()).toMatchObject(discovery)
    const url = redirect.mock.calls[0]?.[0]
    expect(url?.origin).toBe(issuer)
    expect(url?.searchParams.get('state')).toBe('callback-state')
    expect(url?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url?.searchParams.get('code_challenge')).toBe(createHash('sha256').update(provider.codeVerifier()).digest('base64url'))
    expect(url?.searchParams.get('scope')).toBe('mcp:read mcp:write offline_access')
    expect(url?.searchParams.get('resource')).toBe(endpoint)
    expect(url?.href).not.toContain('registered-client-secret')
    expect(url?.href).not.toContain('authorized-access')
    expect(url?.href).not.toContain('authorized-refresh')

    const beforeCallback = fetchFn.mock.calls.length
    await expect(auth(provider, { serverUrl: endpoint, fetchFn, authorizationCode: 'one-time-code', iss: issuer }))
      .resolves.toBe('AUTHORIZED')
    expect(fetchFn.mock.calls.length - beforeCallback).toBe(1)
    expect(token).toHaveBeenCalledOnce()
    const result = provider.toGrant(endpoint, undefined)
    expect(result).toMatchObject({
      redirectUri, confirmed: false, allowedTools: [], tokens: { issuer },
      clientInformation: { client_id: 'registered-client', client_secret: 'registered-client-secret', token_endpoint_auth_method: 'client_secret_basic', issuer },
    })
    expect(provider.toGrant(endpoint, undefined).grantId).toBe(result.grantId)
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: result })).toEqual(result)
    expect(store.modifyRecord).not.toHaveBeenCalled()
  })

  it('retains public-client registration metadata for the legacy AWS OAuth path', () => {
    const { ctx } = credentialStore()
    const provider = new CloudOAuthProvider(ctx, 'aws', redirectUri, () => undefined, 'callback-state')
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('refuses incomplete sign-in state and never reuses an interactive callback after restoration', async () => {
    const { ctx } = credentialStore()
    const provider = new CloudOAuthProvider(ctx, 'aws', redirectUri, () => undefined)
    expect(() => provider.state()).toThrow(CloudOAuthReconnectRequiredError)
    expect(() => provider.codeVerifier()).toThrow('Cloud OAuth: missing PKCE verifier')
    expect(() => provider.toGrant(cloudMcpUrl('aws'), 'us-east-1')).toThrow(/no usable tokens or client registration/)
    await provider.saveTokens({ access_token: 'new-token', token_type: 'Bearer' })
    expect(() => provider.toGrant(cloudMcpUrl('aws'), 'us-east-1')).toThrow(/no usable tokens or client registration/)
    provider.saveClientInformation({ client_id: 'new-client' })
    expect(provider.toGrant(cloudMcpUrl('aws'), 'us-east-1')).toMatchObject({ provider: 'aws', region: 'us-east-1' })
    const restored = CloudOAuthProvider.fromGrant(ctx, 'supabase', grant())
    expect(() => restored.state()).toThrow(CloudOAuthReconnectRequiredError)
  })

  it('refuses a callback from a different issuer before exchanging the code', async () => {
    const { ctx } = credentialStore()
    const provider = new CloudOAuthProvider(ctx, 'supabase', redirectUri, () => undefined, 'callback-state')
    provider.saveDiscoveryState(discovery)
    provider.saveClientInformation(grant().clientInformation)
    provider.saveCodeVerifier('fixture-verifier')
    const fetchFn = vi.fn<FetchLike>(() => Promise.reject(new Error('Token exchange must not run')))
    await expect(auth(provider, { serverUrl: endpoint, fetchFn, authorizationCode: 'one-time-code', iss: 'https://other.example' }))
      .rejects.toThrow(/issuer|iss/i)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes a restored interactive grant and persists rotation without another browser sign-in', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const redirect = vi.spyOn(provider, 'redirectToAuthorization')
    const token = vi.fn((body: URLSearchParams, headers: Headers) => {
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('old-refresh')
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('registered-client:registered-client-secret')}`)
      expect(body.get('resource')).toBe(endpoint)
      return json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' })
    })

    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }),
    })).resolves.toBeUndefined()
    expect(token).toHaveBeenCalledOnce()
    expect(redirect).not.toHaveBeenCalled()
    expect(provider.redirectUrl).toBe(redirectUri)
    expect(provider.tokens()).toEqual({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', issuer })
    expect(parseCloudGrant('supabase', store.read())).toEqual({ ...original, tokens: provider.tokens() })
  })

  it('requires reconnecting instead of opening a stale callback when refresh is unavailable', async () => {
    const original = grant()
    original.tokens = { access_token: 'old-access', token_type: 'Bearer', issuer }
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const token = vi.fn(() => { throw new Error('No token request expected') })
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }),
    })).rejects.toMatchObject({
      code: 'reconnect-required', message: 'Cloud OAuth: reconnect this account from Plugins.',
    })
    expect(() => { provider.redirectToAuthorization(new URL(`${issuer}/authorize`)) }).toThrow(/reconnect/)
    expect(token).not.toHaveBeenCalled()
    expect(store.modifyRecord).toHaveBeenCalledOnce()
  })

  it('shares one refresh between concurrent unauthorized requests and persists rotation once', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const adapter = provider.transportAuth()
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    const token = vi.fn((body: URLSearchParams) => {
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('old-refresh')
      entered.resolve(undefined)
      return response.promise
    })
    const resourceMetadataUrl = 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp'
    const context = {
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token),
      response: new Response(null, { status: 401, headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:read mcp:write"`,
      } }),
    }
    const first = adapter.onUnauthorized!(context)
    await entered.promise
    const second = adapter.onUnauthorized!(context)
    expect(second).toBe(first)
    response.resolve(json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' }))
    await Promise.all([first, second])

    expect(token).toHaveBeenCalledOnce()
    expect(store.modifyRecord).toHaveBeenCalledOnce()
    expect(provider.discoveryState()?.resourceMetadataUrl).toBe(resourceMetadataUrl)
    await expect(adapter.token()).resolves.toBe('new-access')
    expect(parseCloudGrant('supabase', store.read())).toEqual({ ...original, tokens: provider.tokens() })
  })

  it('releases a failed shared refresh so a later transport request can retry', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const adapter = provider.transportAuth()
    const success = fakeIdentity(() => json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' }))
    let failDiscovery = true
    const fetchFn = vi.fn<FetchLike>((input, init) => {
      if (failDiscovery) {
        failDiscovery = false
        return Promise.reject(new TypeError('OAuth fixture discovery unavailable'))
      }
      return success(input, init)
    })
    const context = { serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }) }
    const first = adapter.onUnauthorized!(context)
    const second = adapter.onUnauthorized!(context)
    expect(second).toBe(first)
    await expect(Promise.all([first, second])).rejects.toMatchObject({ code: 'refresh-unavailable' })
    expect(store.modifyRecord).toHaveBeenCalledOnce()
    await expect(adapter.onUnauthorized!(context)).resolves.toBeUndefined()
    expect(store.modifyRecord).toHaveBeenCalledTimes(2)
    await expect(adapter.token()).resolves.toBe('new-access')
  })

  it('does not expose a transport adapter before a durable grant has been restored', () => {
    const { ctx } = credentialStore()
    const provider = new CloudOAuthProvider(ctx, 'supabase', redirectUri, () => undefined, 'callback-state')
    expect(() => provider.transportAuth()).toThrow(/reconnect/)
  })

  it.each(['new-access', 'old-access'])('shares one rotating refresh across two providers, even when access token becomes %s', async (accessToken) => {
    const original = grant()
    const store = credentialStore(original)
    const first = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const second = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const firstAdapter = first.transportAuth()
    const secondAdapter = second.transportAuth()
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    const rotated = { access_token: accessToken, refresh_token: 'rotated-refresh', token_type: 'Bearer' }
    const token = vi.fn((body: URLSearchParams) => {
      expect(body.get('refresh_token')).toBe('old-refresh')
      entered.resolve(undefined)
      return response.promise
    })
    const context = { serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }) }
    const pending = [firstAdapter.onUnauthorized!(context)]
    try {
      await entered.promise
      pending.push(secondAdapter.onUnauthorized!(context))
      response.resolve(json(rotated))
      await Promise.all(pending)
      expect(token).toHaveBeenCalledOnce()
      expect(first.tokens()).toEqual({ ...rotated, issuer })
      expect(second.tokens()).toEqual({ ...rotated, issuer })
      expect(parseCloudGrant('supabase', store.read())).toEqual({ ...original, tokens: { ...rotated, issuer } })
      await expect(firstAdapter.token()).resolves.toBe(accessToken)
      await expect(secondAdapter.token()).resolves.toBe(accessToken)
    } finally {
      response.resolve(json(rotated))
      await Promise.allSettled(pending)
    }
  })

  it('reads another Host\'s latest tokens before the next transport request', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const latest = { ...original, tokens: { ...original.tokens, access_token: 'latest-access', refresh_token: 'latest-refresh' } }
    store.replace(latest)
    await expect(provider.transportAuth().token()).resolves.toBe('latest-access')
    expect(provider.tokens()).toEqual(latest.tokens)
    expect(parseCloudGrant('supabase', store.read())).toEqual(latest)
  })

  it('bounds a stalled refresh so another Host can regain the credential lock', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const peer = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const deadline = new AbortController()
    const timeoutFailure = new DOMException('Fixture refresh deadline', 'TimeoutError')
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const entered = Promise.withResolvers<undefined>()
    const identity = fakeIdentity(() => { throw new Error('Token fetch belongs to the deadline fixture') })
    const fetchFn: FetchLike = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== `${issuer}/token`) return identity(input, init)
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal == null) throw new Error('Refresh must forward its deadline')
        signal.throwIfAborted()
        signal.addEventListener('abort', () => { reject(timeoutFailure) }, { once: true })
        entered.resolve(undefined)
      })
    }
    const refresh = provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'refresh-unavailable' })
    const pending: Promise<unknown>[] = [refresh]
    try {
      await entered.promise
      const read = peer.transportAuth().token()
      pending.push(read)
      expect(timeout).toHaveBeenCalledWith(20_000)
      expect(store.modifyRecord).toHaveBeenCalledTimes(2)
      deadline.abort(timeoutFailure)
      await rejected
      await expect(read).resolves.toBe('old-access')
      expect(parseCloudGrant('supabase', store.read())).toEqual(original)
    } finally {
      deadline.abort()
      await Promise.allSettled(pending)
    }
  })

  it.each(['replacement', 'disconnect'] as const)('refuses cached transport credentials after %s', async (change) => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const adapter = provider.transportAuth()
    store.replace(change === 'disconnect' ? undefined : grant())
    const fetchFn = vi.fn<FetchLike>()
    await expect(adapter.token()).rejects.toBeInstanceOf(CloudOAuthReconnectRequiredError)
    await expect(adapter.onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })).rejects.toBeInstanceOf(CloudOAuthReconnectRequiredError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])('sanitizes %s without logging the provider response', async (errorCode) => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const redirect = vi.spyOn(provider, 'redirectToAuthorization')
    const token = vi.fn(() => new Response(JSON.stringify({
      error: errorCode, error_description: 'sensitive-refresh-token-in-provider-error',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }),
    })).rejects.toMatchObject({
      name: 'CloudOAuthReconnectRequiredError', code: 'reconnect-required',
      message: 'Cloud OAuth: reconnect this account from Plugins.',
    })
    expect(token).toHaveBeenCalledOnce()
    expect(redirect).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    expect(loggedError).not.toHaveBeenCalled()
    expect(provider.tokens()).toEqual(original.tokens)
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it('sanitizes a temporary token response failure and permits a later refresh attempt', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const adapter = provider.transportAuth()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const token = vi.fn<(body: URLSearchParams) => Response>()
      .mockReturnValueOnce(new Response('sensitive-token-in-upstream-body', { status: 503 }))
      .mockReturnValueOnce(json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' }))
    const context = { serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }) }
    await expect(adapter.onUnauthorized!(context)).rejects.toMatchObject({
      code: 'refresh-unavailable',
      message: 'Cloud OAuth: could not refresh this session. Retry the request or reconnect from Plugins.',
    })
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
    expect(warning).not.toHaveBeenCalled()
    await expect(adapter.onUnauthorized!(context)).resolves.toBeUndefined()
    expect(token).toHaveBeenCalledTimes(2)
    await expect(adapter.token()).resolves.toBe('new-access')
  })

  it.each(['tokens', 'clientInformation'] as const)('refuses to refresh %s issued by another authorization server', async (field) => {
    const original = grant()
    original[field]['issuer'] = 'https://another-issuer.example'
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const token = vi.fn(() => { throw new Error('A mismatched issuer must not receive credentials') })
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }),
    })).rejects.toBeInstanceOf(CloudOAuthReconnectRequiredError)
    expect(token).not.toHaveBeenCalled()
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it('does not send refresh credentials for an unrelated protected resource', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const token = vi.fn(() => { throw new Error('An unrelated resource must not receive credentials') })
    const identity = fakeIdentity(token)
    const fetchFn: FetchLike = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(json({ resource: 'https://unrelated.example/mcp', authorization_servers: [issuer] }))
      }
      return identity(input, init)
    }
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })).rejects.toMatchObject({ code: 'refresh-unavailable' })
    expect(token).not.toHaveBeenCalled()
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it('refuses a transport refresh for another server before sending credentials', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const fetchFn = vi.fn<FetchLike>()
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL('https://unrelated.example/mcp'), fetchFn, response: new Response(null, { status: 401 }),
    })).rejects.toBeInstanceOf(CloudOAuthReconnectRequiredError)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it.each(['stored-slash', 'discovered-slash'] as const)('retains the SDK issuer equivalence for %s', async (variant) => {
    const original = grant()
    const discoveredIssuer = variant === 'discovered-slash' ? `${issuer}/` : issuer
    if (variant === 'stored-slash') {
      original.tokens['issuer'] = `${issuer}/`
      original.clientInformation['issuer'] = `${issuer}/`
    }
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const identity = fakeIdentity(() => json({ access_token: 'refreshed-token', refresh_token: 'new-refresh', token_type: 'Bearer' }))
    const fetchFn: FetchLike = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(json({ ...discovery.resourceMetadata, authorization_servers: [discoveredIssuer] }))
      }
      if (url === `${issuer}/.well-known/oauth-authorization-server`) return Promise.resolve(json({ ...metadata, issuer: discoveredIssuer }))
      return identity(input, init)
    }
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })).resolves.toBeUndefined()
    expect(provider.tokens()).toMatchObject({ access_token: 'refreshed-token', issuer: discoveredIssuer })
  })

  it.each([false, true])('refreshes legacy metadata discovery with an explicit resource validator: %s', async (explicitResource) => {
    const original = grant()
    const fallbackIssuer = 'https://mcp.supabase.com/'
    original.tokens['issuer'] = fallbackIssuer
    original.clientInformation['issuer'] = fallbackIssuer
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const validate = vi.fn(async () => new URL(endpoint))
    if (explicitResource) Object.assign(provider, { validateResourceURL: validate })
    const token = vi.fn((body: URLSearchParams) => {
      expect(body.get('resource')).toBe(explicitResource ? endpoint : null)
      return json({ access_token: 'legacy-refreshed-token', refresh_token: 'new-refresh', token_type: 'Bearer' })
    })
    const fetchFn: FetchLike = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith('https://mcp.supabase.com/.well-known/')) return new Response(null, { status: 404 })
      if (url === 'https://mcp.supabase.com/token' && init?.body instanceof URLSearchParams) return token(init.body)
      throw new Error('Unexpected legacy discovery request')
    }
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })).resolves.toBeUndefined()
    expect(token).toHaveBeenCalledOnce()
    expect(provider.discoveryState()?.authorizationServerMetadata).toBeUndefined()
    expect(provider.tokens()).toMatchObject({ access_token: 'legacy-refreshed-token', issuer: fallbackIssuer })
    if (explicitResource) expect(validate).toHaveBeenCalledWith(new URL(endpoint), undefined)
  })

  it.each(['request', 'init'] as const)('keeps the %s cancellation signal when SDK discovery supplies a Request and request init', async (cancelled) => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const request = new AbortController()
    const init = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    vi.mocked(discoverOAuthServerInfo).mockImplementationOnce(async (_endpoint, options) => {
      if (options?.fetchFn === undefined) throw new Error('Expected a bounded discovery fetch')
      // Exercise the native fetch Request input at the JavaScript SDK boundary, beyond its narrower URL declaration.
      const pending: unknown = Reflect.apply(options.fetchFn, undefined, [
        new Request(`${issuer}/discovery-probe`, { signal: request.signal }), { signal: init.signal },
      ])
      await pending
      return discovery
    })
    const fetchFn: FetchLike = (_input, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal
      if (signal == null) throw new Error('Expected the combined cancellation signal')
      signal.addEventListener('abort', () => { reject(new Error('private-request-cancellation-detail')) }, { once: true })
      entered.resolve(undefined)
    })
    const pending = provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn, response: new Response(null, { status: 401 }),
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'refresh-unavailable' })
    await entered.promise
    if (cancelled === 'request') request.abort()
    else init.abort()
    await rejected
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it('keeps refreshed tokens private until their durable replacement succeeds', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    store.modifyRecord.mockImplementationOnce(async (_key, mutate) => {
      await mutate(store.read())
      throw new Error('sensitive-storage-diagnostic')
    })
    const token = vi.fn(() => json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' }))
    await expect(provider.transportAuth().onUnauthorized!({
      serverUrl: new URL(endpoint), fetchFn: fakeIdentity(token), response: new Response(null, { status: 401 }),
    })).rejects.toMatchObject({ code: 'refresh-unavailable' })
    expect(token).toHaveBeenCalledOnce()
    expect(provider.tokens()).toEqual(original.tokens)
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })

  it.each(['replacement', 'disconnect'] as const)('does not write an in-flight refresh after %s', async (change) => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    const refreshing = auth(provider, { serverUrl: endpoint, fetchFn: fakeIdentity(() => {
      entered.resolve(undefined)
      return response.promise
    }) })
    await entered.promise
    const replacement = change === 'disconnect' ? undefined : {
      ...grant(), tokens: { access_token: 'other-account-access', token_type: 'Bearer', issuer },
    }
    store.replace(replacement)
    const rejected = expect(refreshing).rejects.toMatchObject({ code: 'reconnect-required' })
    response.resolve(json({ access_token: 'stale-access', refresh_token: 'stale-refresh', token_type: 'Bearer' }))
    await rejected
    expect(parseCloudGrant('supabase', store.read())).toEqual(replacement)
    expect(provider.tokens()).toEqual(original.tokens)
  })

  it('does not publish rotated tokens when credential persistence fails', async () => {
    const original = grant()
    const store = credentialStore(original)
    const provider = CloudOAuthProvider.fromGrant(store.ctx, 'supabase', original)
    store.modifyRecord.mockRejectedValueOnce(new Error('Credential store unavailable'))
    await expect(provider.saveTokens({ access_token: 'new-access', token_type: 'Bearer' })).rejects.toThrow(/unavailable/)
    expect(provider.tokens()).toEqual(original.tokens)
    expect(parseCloudGrant('supabase', store.read())).toEqual(original)
  })
})

describe('interactive OAuth response privacy', () => {
  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])('prevents actual SDK %s diagnostics from echoing credentials', async (errorCode) => {
    const store = credentialStore()
    const provider = new CloudOAuthProvider(store.ctx, 'supabase', redirectUri, () => undefined, 'callback-state')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = new Response(JSON.stringify({
      error: errorCode, error_description: 'sensitive-authorization-code-and-refresh-token',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const token = vi.fn(() => response)
    const fetchFn = cloudAuthorizationFetch(fakeIdentity(token, true))
    await expect(auth(provider, { serverUrl: endpoint, forceReauthorization: true, fetchFn })).resolves.toBe('REDIRECT')
    await expect(auth(provider, { serverUrl: endpoint, authorizationCode: 'one-time-code', iss: issuer, fetchFn })).rejects.toMatchObject({
      code: 'server_error', message: 'Cloud OAuth: authorization request failed. Try connecting again from Plugins.',
    })
    expect(token).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(warning).not.toHaveBeenCalled()
    expect(loggedError).not.toHaveBeenCalled()
    expect(store.read()).toBeUndefined()
    expect(provider.tokens()).toBeUndefined()
  })

  it('keeps successful OAuth responses unchanged and owned by the SDK', async () => {
    const response = json({ access_token: 'successful-token', token_type: 'Bearer' })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const fetchFn = cloudAuthorizationFetch(vi.fn<typeof fetch>().mockResolvedValue(response))
    expect(await fetchFn(`${issuer}/token`)).toBe(response)
    expect(cancel).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ access_token: 'successful-token', token_type: 'Bearer' })
  })

  it('preserves discovery 404 status without retaining its upstream body metadata', async () => {
    const response = new Response('sensitive-upstream-body', {
      status: 404, statusText: 'sensitive-upstream-status',
      headers: {
        'content-type': 'text/plain', 'content-length': '23', 'content-encoding': 'gzip',
        'www-authenticate': 'Bearer error="invalid_grant", error_description="sensitive-challenge"',
      },
    })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const fetchFn = cloudAuthorizationFetch(vi.fn<typeof fetch>().mockResolvedValue(response))
    const safe = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`)
    expect(safe.status).toBe(404)
    expect(safe.statusText).toBe('')
    expect(safe.headers.get('content-type')).toBe('application/json')
    expect(safe.headers.has('content-length')).toBe(false)
    expect(safe.headers.has('content-encoding')).toBe(false)
    expect(safe.headers.has('www-authenticate')).toBe(false)
    expect(await safe.text()).not.toContain('sensitive-upstream')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves a bodyless unsuccessful response', async () => {
    const fetchFn = cloudAuthorizationFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 })))
    const response = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`)
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
  })

  it('strips request exceptions before the SDK can log their message or cause', async () => {
    const fetchFn = cloudAuthorizationFetch(vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive-proxy-diagnostic')))
    const result = await fetchFn(`${issuer}/token`).catch((error: unknown) => error)
    expect(result).toMatchObject({
      code: 'authorization-unavailable', message: 'Cloud OAuth: authorization request failed. Try connecting again from Plugins.',
    })
    expect(result).not.toHaveProperty('cause')
    expect(String(result)).not.toContain('sensitive-proxy-diagnostic')
  })
})

describe('cloud grant validation', () => {
  it('refuses an unsupported AWS region even when all persisted OAuth fields are present', () => {
    expect(parseCloudGrant('aws', { kind: 'grant', payload: {
      ...grant(), provider: 'aws', endpoint: cloudMcpUrl('aws'), region: 'unsupported-region',
    } })).toBeUndefined()
  })
  it('requires a sign-in identity and registered loopback redirect instead of upgrading legacy grants', () => {
    const { grantId: _identity, redirectUri: _redirect, ...legacy } = grant()
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: legacy })).toBeUndefined()
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: { ...legacy, grantId: randomUUID() } })).toBeUndefined()
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: { ...legacy, redirectUri } })).toBeUndefined()
  })

  it.each([
    'https://external.example/oauth/callback', 'http://localhost:60432/oauth/callback',
    'http://127.0.0.1:60432/other', 'http://127.0.0.1:60432/oauth/callback?code=secret',
    'http://127.0.0.1:60432/oauth/callback#fragment', 'http://user@127.0.0.1:60432/oauth/callback',
    'http://127.0.0.1:0/oauth/callback', 'http://127.0.0.1:65536/oauth/callback',
    'http://127.1:60432/oauth/callback', 'not-a-url',
  ])('rejects an untrusted persisted redirect %s', (untrusted) => {
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: { ...grant(), redirectUri: untrusted } })).toBeUndefined()
  })
})

/** MCP OAuth 2.1 credentials: scoped to one provider and stored in Harness credentials. */

import type {
  AuthProvider, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import {
  discoverOAuthServerInfo, extractWWWAuthenticateParams, OAuthClientFlowError, OAuthError, OAuthErrorCode,
  refreshAuthorization, selectResourceURL,
} from '@modelcontextprotocol/client'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { CloudProvider } from './catalog.ts'
import { cloudMcpUrl } from './catalog.ts'

const tokenSchema = z.looseObject({ access_token: z.string().min(1), token_type: z.string() })
const clientSchema = z.looseObject({ client_id: z.string().min(1) })
/** Bound refresh I/O below the local credential store's 30-second lock-wait budget. */
const REFRESH_TIMEOUT_MS = 20_000
/** Provider failures for which the stored grant may still authorize a later retry. */
const RETRYABLE_OAUTH_CODES: ReadonlySet<string> = new Set<string>([
  OAuthErrorCode.ServerError, OAuthErrorCode.TemporarilyUnavailable, OAuthErrorCode.TooManyRequests,
])
const redirectUriSchema = z.url().refine((value) => {
  const url = URL.parse(value)
  return url !== null && url.href === value && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    url.port !== '' && Number(url.port) > 0 && url.pathname === '/oauth/callback' &&
    url.username === '' && url.password === '' && url.search === '' && url.hash === ''
})
const grantSchema = z.object({
  grantId: z.uuid(),
  provider: z.enum(['aws', 'supabase']),
  endpoint: z.url(),
  redirectUri: redirectUriSchema,
  region: z.string().optional(),
  tokens: tokenSchema,
  clientInformation: clientSchema,
  confirmed: z.boolean(),
  allowedTools: z.array(z.string()),
})

/** Durable provider grant. The token and registration fields never cross the Remote boundary. */
export type CloudGrant = z.infer<typeof grantSchema>

/**
 * Address the credential record owned by this cloud provider.
 * @param provider - Cloud provider whose grant is stored.
 * @returns The Host-only credential key.
 */
export function cloudCredentialKey(provider: CloudProvider): CredentialKey {
  return credentialKey('cloud-connectors', provider)
}

/**
 * Parse the exact provider's record. Legacy grants without a sign-in identity or
 * loopback redirect require reconnecting; they never authorize tools.
 * @param provider - Expected cloud provider.
 * @param record - Durable credential record, or undefined when disconnected.
 * @returns A validated grant, or undefined for missing, legacy or invalid records.
 */
export function parseCloudGrant(provider: CloudProvider, record: CredentialRecord | undefined): CloudGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const parsed = grantSchema.safeParse(record.payload)
  if (!parsed.success || parsed.data.provider !== provider) return undefined
  try {
    if (parsed.data.endpoint !== cloudMcpUrl(provider, parsed.data.region)) return undefined
  } catch {
    return undefined
  }
  return parsed.data
}

/** A revoked, replaced, or unusable grant needs explicit browser sign-in; provider details stay private. */
export class CloudOAuthReconnectRequiredError extends Error {
  /** Stable discriminator for withdrawing unusable cloud connections without inspecting provider text. */
  readonly code = 'reconnect-required'

  constructor() {
    super('Cloud OAuth: reconnect this account from Plugins.')
    this.name = 'CloudOAuthReconnectRequiredError'
  }
}

/** Retryable refresh failure without provider response bodies, credential values, or an unsafe error cause. */
class CloudOAuthRefreshUnavailableError extends Error {
  readonly code = 'refresh-unavailable'

  constructor() {
    super('Cloud OAuth: could not refresh this session. Retry the request or reconnect from Plugins.')
    this.name = 'CloudOAuthRefreshUnavailableError'
  }
}

/** Interactive request failure stripped of transport details that can echo authorization credentials. */
class CloudOAuthAuthorizationUnavailableError extends Error {
  readonly code = 'authorization-unavailable'

  constructor() {
    super('Cloud OAuth: authorization request failed. Try connecting again from Plugins.')
    this.name = 'CloudOAuthAuthorizationUnavailableError'
  }
}

/**
 * Keep unsuccessful interactive OAuth responses out of the SDK's diagnostics.
 * Successful token bodies remain untouched; rejected bodies are cancelled,
 * not buffered or logged. Do not use this wrapper for MCP business responses.
 * @param fetchFn - The sign-in attempt's cancellation-aware fetch.
 * @returns Fetch for OAuth discovery, client registration, and code exchange only.
 * @throws CloudOAuthAuthorizationUnavailableError without raw request or response details.
 */
export function cloudAuthorizationFetch(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      const response = await fetchFn(input, init)
      if (response.ok) return response
      await response.body?.cancel()
      return new Response(response.status === 304 ? null : JSON.stringify({
        error: 'server_error', error_description: 'Cloud OAuth: authorization request failed. Try connecting again from Plugins.',
      }), { status: response.status, headers: { 'content-type': 'application/json' } })
    } catch {
      throw new CloudOAuthAuthorizationUnavailableError()
    }
  }
}

/** The SDK treats a single trailing slash as the same issuer; all other changes require sign-in. */
function sameIssuer(stored: unknown, discovered: string): boolean {
  return typeof stored === 'string' && (stored === discovered || stored.endsWith('/') && stored.slice(0, -1) === discovered
    || discovered.endsWith('/') && discovered.slice(0, -1) === stored)
}

/**
 * Credential-backed MCP OAuth provider. Redirect state and verifier live only
 * for the current sign-in; access/refresh tokens remain private to the Host.
 */
export class CloudOAuthProvider implements OAuthClientProvider {
  private tokenSet: StoredOAuthTokens | undefined
  private clientInfo: StoredOAuthClientInformation | undefined
  private verifier: string | undefined
  private discovery: OAuthDiscoveryState | undefined
  private grantId: string = randomUUID()
  private shouldPersist = false
  private refreshInFlight: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    readonly provider: CloudProvider,
    readonly redirectUrl: string,
    private readonly redirect: (url: URL) => void,
    private readonly callbackState?: string,
  ) {}

  /**
   * Restore an interactive grant for token refresh, without opening a browser.
   * @param ctx - Host context owning the credential store.
   * @param provider - Provider of the validated grant.
   * @param grant - Validated durable grant; its redirect remains registered with the OAuth server.
   * @returns A provider that refreshes only this sign-in and refuses new interactive authorization.
   */
  static fromGrant(ctx: Context, provider: CloudProvider, grant: CloudGrant): CloudOAuthProvider {
    const result = new CloudOAuthProvider(ctx, provider, grant.redirectUri, () => {
      throw new CloudOAuthReconnectRequiredError()
    })
    result.grantId = grant.grantId
    result.tokenSet = grant.tokens
    result.clientInfo = grant.clientInformation
    result.shouldPersist = true
    return result
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DeepSeek Harness cloud connections',
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: this.provider === 'supabase' ? 'client_secret_basic' : 'none',
    }
  }

  state(): string {
    if (this.callbackState === undefined) throw new CloudOAuthReconnectRequiredError()
    return this.callbackState
  }

  clientInformation(): StoredOAuthClientInformation | undefined { return this.clientInfo }
  /** @param info - Registration returned by the OAuth authorization server. */
  saveClientInformation(info: StoredOAuthClientInformation): void { this.clientInfo = info }
  tokens(): StoredOAuthTokens | undefined { return this.tokenSet }

  /**
   * Adapt a restored grant to transport authentication. Every bearer read sees
   * the durable grant, and refresh holds its storage lock across exchange and
   * replacement so Hosts cannot concurrently consume the same refresh token.
   * @returns An adapter that shares concurrent 401 recovery and never starts browser sign-in.
   * @throws CloudOAuthReconnectRequiredError when no durable grant was restored.
   */
  transportAuth(): AuthProvider {
    if (!this.shouldPersist) throw new CloudOAuthReconnectRequiredError()
    return {
      token: async () => {
        const record = await this.ctx.credentials.modifyRecord(cloudCredentialKey(this.provider), (current) => {
          this.requireGrant(current)
          return Promise.resolve(undefined)
        })
        const grant = this.requireGrant(record)
        this.tokenSet = grant.tokens
        this.clientInfo = grant.clientInformation
        return grant.tokens.access_token
      },
      onUnauthorized: (context) => {
        this.refreshInFlight ??= this.refresh(context).finally(() => { this.refreshInFlight = undefined })
        return this.refreshInFlight
      },
    }
  }

  /** Reject a removed or replaced account without allowing cached tokens to resurrect it. */
  private requireGrant(record: CredentialRecord | undefined): CloudGrant {
    const grant = parseCloudGrant(this.provider, record)
    if (grant?.grantId !== this.grantId) throw new CloudOAuthReconnectRequiredError()
    return grant
  }

  /** Refresh only the rejected grant, preserving consent and using the SDK's issuer/resource validation. */
  private async refresh(context: Parameters<NonNullable<AuthProvider['onUnauthorized']>>[0]): Promise<void> {
    const rejectedTokens = this.tokenSet
    try {
      const record = await this.ctx.credentials.modifyRecord(cloudCredentialKey(this.provider), async (current) => {
        const grant = this.requireGrant(current)
        if (context.serverUrl.href !== grant.endpoint) throw new CloudOAuthReconnectRequiredError()
        // Another Host may have recovered this 401 while this one waited for
        // the storage lock. Reuse its durable rotation instead of consuming it.
        if (grant.tokens.access_token !== rejectedTokens?.access_token
          || grant.tokens['refresh_token'] !== rejectedTokens.refresh_token) return undefined
        const refreshToken = grant.tokens['refresh_token']
        if (typeof refreshToken !== 'string' || refreshToken.length === 0) throw new CloudOAuthReconnectRequiredError()
        const deadline = AbortSignal.timeout(REFRESH_TIMEOUT_MS)
        const fetchFn: typeof context.fetchFn = (input, init) => context.fetchFn(input, {
          ...init,
          signal: AbortSignal.any([
            deadline,
            ...(init?.signal == null ? [] : [init.signal]),
            ...(input instanceof Request ? [input.signal] : []),
          ]),
        })
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(context.response)
        const discovery = await discoverOAuthServerInfo(grant.endpoint, {
          fetchFn,
          ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        })
        const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl
        if (!sameIssuer(grant.tokens['issuer'], issuer) || !sameIssuer(grant.clientInformation['issuer'], issuer)) {
          throw new CloudOAuthReconnectRequiredError()
        }
        const selectedResource = await selectResourceURL(grant.endpoint, this, discovery.resourceMetadata)
        const resource = selectedResource === undefined ? undefined : discovery.resourceMetadata?.resource ?? selectedResource
        // auth() can log provider error bodies before rejecting. The SDK's
        // refresh primitive has no interactive fallback or diagnostic logging.
        const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
          ...(discovery.authorizationServerMetadata === undefined ? {} : { metadata: discovery.authorizationServerMetadata }),
          clientInformation: grant.clientInformation,
          refreshToken, ...(resource === undefined ? {} : { resource }), fetchFn,
        })
        this.discovery = {
          ...discovery, ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: resourceMetadataUrl.href }),
        }
        return { kind: 'grant', payload: { ...grant, tokens: { ...tokens, issuer } } }
      })
      const grant = this.requireGrant(record)
      this.tokenSet = grant.tokens
      this.clientInfo = grant.clientInformation
    } catch (error) {
      if (error instanceof CloudOAuthReconnectRequiredError) throw error
      if (error instanceof OAuthClientFlowError || error instanceof OAuthError
        && !RETRYABLE_OAUTH_CODES.has(error.code)) {
        throw new CloudOAuthReconnectRequiredError()
      }
      // OAuth errors can include a raw response body or echoed refresh token;
      // neither their message nor their cause may enter tool results or logs.
      throw new CloudOAuthRefreshUnavailableError()
    }
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    if (this.shouldPersist) {
      await this.ctx.credentials.modifyRecord(cloudCredentialKey(this.provider), (record) => {
        const grant = this.requireGrant(record)
        return Promise.resolve({ kind: 'grant', payload: { ...grant, tokens } })
      })
    }
    this.tokenSet = tokens
  }

  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery }
  /** @param state - Discovery metadata retained with this sign-in's PKCE verifier. */
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state }
  /** @param url - SDK-validated browser authorization destination. */
  redirectToAuthorization(url: URL): void { this.redirect(url) }
  /** @param verifier - PKCE verifier for the current browser sign-in. */
  saveCodeVerifier(verifier: string): void { this.verifier = verifier }
  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('Cloud OAuth: missing PKCE verifier')
    return this.verifier
  }

  /**
   * Create an unconfirmed grant after a successful OAuth exchange.
   * @param endpoint - Fixed provider MCP endpoint used for this authorization.
   * @param region - AWS region, or undefined for Supabase.
   * @returns A grant with this sign-in's stable identity and no enabled tools.
   */
  toGrant(endpoint: string, region: string | undefined): CloudGrant {
    if (this.tokenSet === undefined || this.clientInfo === undefined) {
      throw new Error('Cloud OAuth: authorization returned no usable tokens or client registration')
    }
    return {
      grantId: this.grantId, provider: this.provider, endpoint, redirectUri: this.redirectUrl,
      ...(region === undefined ? {} : { region }),
      tokens: this.tokenSet, clientInformation: this.clientInfo,
      confirmed: false, allowedTools: [],
    }
  }
}

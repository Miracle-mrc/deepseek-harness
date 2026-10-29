/** MCP OAuth 2.1 credentials: scoped to one provider and stored in Harness credentials. */

import type {
  OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { CloudProvider } from './catalog.ts'
import { cloudMcpUrl } from './catalog.ts'

const tokenSchema = z.looseObject({ access_token: z.string().min(1), token_type: z.string() })
const clientSchema = z.looseObject({ client_id: z.string().min(1) })
const grantSchema = z.object({
  provider: z.enum(['aws', 'supabase']),
  endpoint: z.url(),
  region: z.string().optional(),
  tokens: tokenSchema,
  clientInformation: clientSchema,
  confirmed: z.boolean(),
  allowedTools: z.array(z.string()),
})

/** Durable provider grant. The token and registration fields never cross the Remote boundary. */
export type CloudGrant = z.infer<typeof grantSchema>

/** Credential namespace owned only by the cloud-connection Host. */
export function cloudCredentialKey(provider: CloudProvider) {
  return credentialKey('cloud-connectors', provider)
}

/** Parse only the exact provider's record; stale or malformed records never authorize tools. */
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

/**
 * Credential-backed MCP OAuth provider. Redirect state and verifier live only
 * for the current sign-in; access/refresh tokens remain private to the Host.
 */
export class CloudOAuthProvider implements OAuthClientProvider {
  private tokenSet: StoredOAuthTokens | undefined
  private clientInfo: StoredOAuthClientInformation | undefined
  private verifier: string | undefined
  private shouldPersist = false

  constructor(
    private readonly ctx: Context,
    readonly provider: CloudProvider,
    readonly redirectUrl: string | undefined,
    private readonly redirect: (url: URL) => void,
    private readonly callbackState?: string,
  ) {}

  /** Seed the OAuth provider from an existing local grant. */
  static fromGrant(ctx: Context, provider: CloudProvider, grant: CloudGrant): CloudOAuthProvider {
    const result = new CloudOAuthProvider(ctx, provider, undefined, () => undefined)
    result.tokenSet = grant.tokens
    result.clientInfo = grant.clientInformation
    result.shouldPersist = true
    return result
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.redirectUrl === undefined) {
      return { client_name: 'DeepSeek Harness cloud connections', redirect_uris: [] }
    }
    return {
      client_name: 'DeepSeek Harness cloud connections',
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    if (this.callbackState === undefined) throw new Error('Cloud OAuth: no active browser sign-in')
    return this.callbackState
  }

  clientInformation(): StoredOAuthClientInformation | undefined { return this.clientInfo }
  saveClientInformation(info: StoredOAuthClientInformation): void { this.clientInfo = info }
  tokens(): StoredOAuthTokens | undefined { return this.tokenSet }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    this.tokenSet = tokens
    if (!this.shouldPersist) return
    await this.ctx.credentials.modifyRecord(cloudCredentialKey(this.provider), (record) => {
      const grant = parseCloudGrant(this.provider, record)
      return Promise.resolve(grant === undefined ? record : { kind: 'grant', payload: { ...grant, tokens } })
    })
  }

  redirectToAuthorization(url: URL): void { this.redirect(url) }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier }
  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('Cloud OAuth: missing PKCE verifier')
    return this.verifier
  }

  /** Convert a successful pending OAuth exchange to the only durable grant format. */
  toGrant(endpoint: string, region: string | undefined): CloudGrant {
    if (this.tokenSet === undefined || this.clientInfo === undefined) {
      throw new Error('Cloud OAuth: authorization returned no usable tokens or client registration')
    }
    return {
      provider: this.provider, endpoint, ...(region === undefined ? {} : { region }),
      tokens: this.tokenSet, clientInformation: this.clientInfo,
      confirmed: false, allowedTools: [],
    }
  }
}

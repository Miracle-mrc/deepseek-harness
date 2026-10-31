/** Durable AWS CLI sessions and current-token access for the managed MCP transport. */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthProvider } from '@modelcontextprotocol/client'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { refreshAwsCliToken } from './aws-cli.ts'
import { AWS_MCP_REGIONS, cloudMcpUrl } from './catalog.ts'
import { CloudConnectionError } from './errors.ts'
import { cloudCredentialKey } from './oauth-provider.ts'
import type { AwsLoginMethod } from './types.ts'

const selectorSchema = z.object({
  region: z.enum(AWS_MCP_REGIONS),
  profile: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@+-]*$/),
  loginMethod: z.enum(['login', 'sso', 'existing']),
})
const awsCliGrantSchema = selectorSchema.extend({
  authMethod: z.literal('aws-cli'),
  provider: z.literal('aws'),
  grantId: z.uuid(),
  endpoint: z.url(),
  tokens: z.object({ accessToken: z.string().min(1), expiresAt: z.number().positive() }),
  confirmed: z.boolean(),
  allowedTools: z.array(z.string()),
})
/** Refresh before the token can expire during the managed transport's one-minute tool request. */
const TOKEN_EXPIRY_WINDOW_MS = 60_000

/** Host-only AWS CLI grant; the CLI profile's underlying credentials stay in its own store. */
export type AwsCliGrant = z.infer<typeof awsCliGrantSchema>

/**
 * Validate an AWS CLI grant read from durable credential storage.
 * @param record - Stored credential record, or undefined after disconnection.
 * @returns The grant, including expired tokens eligible for refresh, or undefined when invalid.
 */
export function parseAwsCliGrant(record: CredentialRecord | undefined): AwsCliGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const parsed = awsCliGrantSchema.safeParse(record.payload)
  if (!parsed.success || parsed.data.endpoint !== cloudMcpUrl('aws', parsed.data.region)) return undefined
  return parsed.data
}

/**
 * Create a distinct, unconfirmed AWS CLI session after obtaining its first MCP token.
 * @param region - Supported managed MCP region.
 * @param profile - Named CLI profile without whitespace or command-option syntax.
 * @param method - Official CLI authentication route selected for this session.
 * @param token - MCP access token and its expiry in Unix milliseconds.
 * @returns A fresh grant with no enabled tools.
 * @throws CloudConnectionError with a fixed message when session values cannot be stored.
 */
export function createAwsCliGrant(region: string, profile: string, method: AwsLoginMethod, token: AwsCliGrant['tokens']): AwsCliGrant {
  const selectors = selectorSchema.safeParse({ region, profile, loginMethod: method })
  if (!selectors.success) throw new CloudConnectionError('authorization-failed')
  const parsed = awsCliGrantSchema.safeParse({
    ...selectors.data, authMethod: 'aws-cli', provider: 'aws', grantId: randomUUID(),
    endpoint: cloudMcpUrl('aws', selectors.data.region), tokens: token, confirmed: false, allowedTools: [],
  })
  if (!parsed.success) throw new CloudConnectionError('authorization-failed')
  return parsed.data
}

/**
 * Read current AWS MCP tokens and refresh through the official CLI without holding a storage lock.
 * @param ctx - Host context owning this provider's durable credentials.
 * @param grant - Validated session whose identity must remain present in storage.
 * @param options - Host AWS CLI executable and command time budget.
 * @param signal - Connection lifetime; cancellation prevents later reads and refresh commits.
 * @returns Transport authentication with shared refresh and fixed, credential-free failures.
 */
export function createAwsCliAuth(
  ctx: Context, grant: AwsCliGrant, options: { executable: string; commandTimeoutMs: number }, signal: AbortSignal,
): AuthProvider {
  const key = cloudCredentialKey('aws')
  let presentedToken = grant.tokens.accessToken
  let refreshInFlight: Promise<void> | undefined
  const assertActive = (): void => {
    if (signal.aborted) throw new CloudConnectionError('session-expired')
  }
  const requireGrant = (record: CredentialRecord | undefined): AwsCliGrant => {
    const stored = parseAwsCliGrant(record)
    if (stored?.grantId !== grant.grantId) throw new CloudConnectionError('session-expired')
    return stored
  }
  const fresh = (token: AwsCliGrant['tokens']): boolean => token.expiresAt > Date.now() + TOKEN_EXPIRY_WINDOW_MS
  const safeError = (error: unknown): CloudConnectionError => error instanceof CloudConnectionError
    ? error : new CloudConnectionError('session-expired')
  const readGrant = async (): Promise<AwsCliGrant> => {
    assertActive()
    const record = await ctx.credentials.modifyRecord(key, (current) => {
      assertActive()
      requireGrant(current)
      return Promise.resolve(undefined)
    })
    assertActive()
    return requireGrant(record)
  }
  const refreshOnce = async (rejectedToken: string | undefined): Promise<void> => {
    const current = await readGrant()
    if (fresh(current.tokens) && (rejectedToken === undefined || current.tokens.accessToken !== rejectedToken)) return
    const tokens = await refreshAwsCliToken({
      ...options, profile: current.profile, region: current.region, signal,
    })
    assertActive()
    if (!fresh(tokens)) throw new CloudConnectionError('session-expired')
    const record = await ctx.credentials.modifyRecord(key, (stored) => {
      assertActive()
      const latest = requireGrant(stored)
      if (latest.tokens.accessToken !== current.tokens.accessToken && fresh(latest.tokens)) return Promise.resolve(undefined)
      return Promise.resolve({ kind: 'grant', payload: { ...latest, tokens } })
    })
    assertActive()
    if (!fresh(requireGrant(record).tokens)) throw new CloudConnectionError('session-expired')
  }
  const refresh = (rejectedToken: string | undefined): Promise<void> => {
    refreshInFlight ??= refreshOnce(rejectedToken).catch((error: unknown) => {
      throw safeError(error)
    }).finally(() => { refreshInFlight = undefined })
    return refreshInFlight
  }
  return {
    token: async () => {
      try {
        let current = await readGrant()
        if (!fresh(current.tokens)) {
          await refresh(undefined)
          current = await readGrant()
        }
        if (!fresh(current.tokens)) throw new CloudConnectionError('session-expired')
        presentedToken = current.tokens.accessToken
        return presentedToken
      } catch (error) {
        throw safeError(error)
      }
    },
    onUnauthorized: (context) => {
      if (signal.aborted || context.serverUrl.href !== grant.endpoint) return Promise.reject(new CloudConnectionError('session-expired'))
      return refresh(presentedToken)
    },
  }
}

/** OAuth-backed, opt-in AWS and Supabase MCP tools for the Desktop plugin page. */

import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { createMcpToolDefinition, publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AWS_MCP_REGIONS, cloudMcpUrl, type CloudProvider } from './catalog.ts'
import type { CloudConnectionView, CloudSignIn } from './types.ts'
import { CloudOAuthProvider, cloudCredentialKey, parseCloudGrant, type CloudGrant } from './oauth-provider.ts'
import { OAuthLoopback } from './oauth-loopback.ts'

export type { CloudProvider } from './catalog.ts'
export { AWS_MCP_REGIONS } from './catalog.ts'
export type { CloudConnectionView, CloudSignIn } from './types.ts'

interface LiveClient {
  client: Client
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: unknown; taskRequired: boolean }>
  disposers: Array<() => void>
}

interface Attempt {
  region?: string
  url: PromiseWithResolvers<string>
  done: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local cloud MCP connection lifecycle and per-tool permissions. */
    cloudConnections: CloudConnections
  }
}

/** The two fixed provider ids, never accepting an arbitrary user-controlled MCP endpoint. */
const PROVIDERS: readonly CloudProvider[] = ['aws', 'supabase']
const AUTH_WAIT_MS = 5 * 60_000

/** Resolve a wire string without allowing the caller to choose another provider. */
function providerOf(value: string): CloudProvider {
  if (value === 'aws' || value === 'supabase') return value
  throw new Error('Cloud connections: unknown provider')
}

/**
 * Owns short-lived local OAuth callbacks and MCP tool registration. It starts
 * without connecting to either cloud service, even when bundled by Desktop.
 */
export class CloudConnections extends TypertRemoteService {
  static inject = ['credentials', 'authorization', 'tools']
  private readonly home: Context
  private readonly live = new Map<CloudProvider, LiveClient>()
  private readonly attempts = new Map<CloudProvider, Attempt>()
  private readonly failed = new Map<CloudProvider, string>()

  constructor(ctx: Context) {
    super(ctx, 'cloudConnections')
    this.home = ctx
    for (const provider of PROVIDERS) {
      ctx.authorization.registerFlow({
        key: cloudCredentialKey(provider), label: provider === 'aws' ? 'AWS' : 'Supabase',
        methods: [{ id: 'oauth', label: 'Sign in with browser' }],
        run: session => this.authorize(provider, session),
      })
    }
    ctx.effect(() => async () => {
      await Promise.all([...this.live.values()].map(async (item) => {
        for (const dispose of item.disposers) dispose()
        await item.client.close()
      }))
      this.live.clear()
    }, 'cloud-connectors: stop MCP clients')
  }

  protected async [Service.init](): Promise<void> {
    // Restart restores only grants the user previously confirmed. New profiles
    // keep both providers unconnected and send no cloud requests.
    await Promise.all(PROVIDERS.map(async (provider) => {
      const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
      if (grant?.confirmed !== true) return
      try {
        await this.connectClient(provider, grant)
      } catch {
        this.failed.set(provider, 'Could not restore the cloud MCP connection. Reconnect to authenticate again.')
      }
    }))
  }

  /** Current connection facts, including tool-level selection after OAuth. */
  @Remote
  async list(): Promise<CloudConnectionView[]> {
    return await Promise.all(PROVIDERS.map(async (provider) => {
      const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
      const attempt = this.attempts.get(provider)
      const live = this.live.get(provider)
      const status: CloudConnectionView['status'] = attempt !== undefined ? 'authorizing'
        : this.failed.has(provider) ? 'failed'
          : grant === undefined ? 'not-connected'
            : grant.confirmed && live !== undefined ? 'connected' : 'choose-permissions'
      const tools = live?.tools.map(tool => ({ name: tool.name, description: tool.description })) ?? []
      const failure = this.failed.get(provider)
      return { provider, status, tools, enabledTools: grant?.allowedTools ?? [],
        ...(failure === undefined ? {} : { error: failure }) }
    }))
  }

  /**
   * Begin a browser OAuth grant. The browser URL is returned without waiting
   * for login; the loopback callback completes the attempt asynchronously.
   * @param providerId - AWS or Supabase.
   * @param awsRegion - Region of the AWS-managed MCP endpoint.
   * @returns Browser authorization page.
   */
  @Remote
  async start(providerId: string, awsRegion: string): Promise<CloudSignIn> {
    const provider = providerOf(providerId)
    if (provider === 'aws' && !(AWS_MCP_REGIONS as readonly string[]).includes(awsRegion)) {
      throw new Error('Cloud connections: select a supported AWS region')
    }
    if (this.attempts.has(provider)) throw new Error('Cloud connections: sign-in already in progress')
    const url = Promise.withResolvers<string>()
    const attempt: Attempt = { ...(provider === 'aws' ? { region: awsRegion } : {}), url, done: Promise.resolve() }
    this.attempts.set(provider, attempt)
    this.failed.delete(provider)
    const done = this.home.authorization.begin({
      key: cloudCredentialKey(provider), method: 'oauth',
      interaction: {
        notify: (notice) => {
          if (notice.url !== undefined) url.resolve(notice.url)
        },
        prompt: () => Promise.reject(new Error('Cloud connections: unexpected identity-provider prompt')),
      },
    }).then(async (outcome) => {
      if (outcome.status !== 'authorized') throw new Error('Cloud connections: authorization was cancelled')
      const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
      if (grant === undefined) throw new Error('Cloud connections: authorization did not store its grant')
      await this.connectClient(provider, grant)
    }).catch(() => {
      // Never mirror identity-provider errors (which may contain sensitive URLs)
      // into the browser-visible connection-status endpoint.
      this.failed.set(provider, 'Cloud sign-in failed. Try again or check the provider\'s authorization policy.')
      url.reject(new Error('Cloud connections: sign-in failed; see connection status'))
    }).finally(() => {
      if (this.attempts.get(provider) === attempt) this.attempts.delete(provider)
    })
    attempt.done = done
    return { url: await Promise.race([url.promise, done.then(() => { throw new Error('Cloud connections: sign-in ended before browser authorization') })]) }
  }

  /**
   * Confirm the selected subset of tools after OAuth. Tool names not offered
   * by the connected MCP server are refused; no IAM/database privilege is
   * granted by toggling a tool here.
   * @param providerId - Provider to enable.
   * @param selected - Model-visible raw MCP tool names.
   * @returns Updated connection facts.
   */
  @Remote
  async confirm(providerId: string, selected: string[]): Promise<CloudConnectionView[]> {
    const provider = providerOf(providerId)
    const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
    const client = this.live.get(provider)
    if (grant === undefined || client === undefined) throw new Error('Cloud connections: sign in before selecting tools')
    const available = new Set(client.tools.map(tool => tool.name))
    if (new Set(selected).size !== selected.length || selected.some(name => !available.has(name))) {
      throw new Error('Cloud connections: unknown or duplicate tool selection')
    }
    await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve({
      kind: 'grant', payload: { ...grant, confirmed: true, allowedTools: [...selected] },
    }))
    try {
      this.registerTools(provider, client, selected)
    } catch (error) {
      // If the ToolRuntime refuses a tool, do not leave a durable consent
      // record that could silently enable it on the next launch.
      await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve({
        kind: 'grant', payload: { ...grant, confirmed: false, allowedTools: [] },
      }))
      throw error
    }
    return await this.list()
  }

  /**
   * Remove the local OAuth grant and every associated model tool. External
   * token revocation is controlled by the identity provider, not this action.
   * @param providerId - Provider to disconnect.
   * @returns Updated connection facts.
   */
  @Remote
  async disconnect(providerId: string): Promise<CloudConnectionView[]> {
    const provider = providerOf(providerId)
    if (this.attempts.has(provider)) {
      this.home.authorization.cancel(cloudCredentialKey(provider))
      await this.attempts.get(provider)?.done
    }
    await this.dropClient(provider)
    await this.home.credentials.deleteRecord(cloudCredentialKey(provider))
    this.failed.delete(provider)
    return await this.list()
  }

  private async authorize(provider: CloudProvider, session: AuthorizationSession): Promise<void> {
    const attempt = this.attempts.get(provider)
    if (attempt === undefined) throw new Error('Cloud connections: missing authorization attempt')
    const endpoint = cloudMcpUrl(provider, attempt.region)
    const loopback = await OAuthLoopback.listen(session.signal)
    const oauth = new CloudOAuthProvider(this.home, provider, loopback.url, (url) => {
      session.notify({ message: 'Continue in your browser to authorize this cloud connection', url: url.href })
    }, loopback.state)
    try {
      const initial = await auth(oauth, { serverUrl: endpoint, forceReauthorization: true })
      if (initial !== 'REDIRECT') throw new Error('Cloud connections: identity provider did not offer browser authorization')
      const callback = await Promise.race([
        loopback.result,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error('Cloud connections: sign-in timed out')) }, AUTH_WAIT_MS)
          session.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cloud connections: sign-in cancelled')) }, { once: true })
          void loopback.result.finally(() => { clearTimeout(timer) }).catch(() => undefined)
        }),
      ])
      const completed = await auth(oauth, { serverUrl: endpoint, authorizationCode: callback.code,
        ...(callback.iss === undefined ? {} : { iss: callback.iss }) })
      if (completed !== 'AUTHORIZED') throw new Error('Cloud connections: OAuth code exchange was not completed')
      await session.commit({ kind: 'grant', payload: oauth.toGrant(endpoint, attempt.region) })
    } finally {
      await loopback.close()
    }
  }

  private async connectClient(provider: CloudProvider, grant: CloudGrant): Promise<void> {
    await this.dropClient(provider)
    const oauth = CloudOAuthProvider.fromGrant(this.home, provider, grant)
    const client = new Client({ name: 'dsh-cloud-connectors', version: '0.2.2' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(grant.endpoint), { authProvider: oauth }))
      const response = await client.listTools()
      const live: LiveClient = {
        client,
        tools: response.tools.map(tool => ({
          name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          taskRequired: tool.execution?.taskSupport === 'required',
        })),
        disposers: [],
      }
      this.live.set(provider, live)
      this.failed.delete(provider)
      if (grant.confirmed) this.registerTools(provider, live, grant.allowedTools)
    } catch (error) {
      this.live.delete(provider)
      await client.close()
      throw error
    }
  }

  private registerTools(provider: CloudProvider, live: LiveClient, allowed: readonly string[]): void {
    const previous = live.disposers
    const permitted = new Set(allowed)
    const staged: Array<() => void> = []
    // The tool registry enforces unique names. Withdraw the previous
    // generation before registering a newly confirmed subset.
    for (const dispose of previous) dispose()
    live.disposers = []
    try {
      for (const tool of live.tools) {
        if (!permitted.has(tool.name)) continue
        const name = publicToolName(provider, tool.name)
        staged.push(this.home.tools.register(createMcpToolDefinition(this.home, {
          name, rawName: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema, taskRequired: tool.taskRequired,
          call: (args, execution) => live.client.callTool(
            { name: tool.name, arguments: args },
            { signal: execution.signal, timeout: 60_000 },
          ),
        })))
      }
    } catch (error) {
      for (const dispose of staged) dispose()
      throw error
    }
    live.disposers = staged
  }

  private async dropClient(provider: CloudProvider): Promise<void> {
    const live = this.live.get(provider)
    if (live === undefined) return
    this.live.delete(provider)
    for (const dispose of live.disposers) dispose()
    await live.client.close()
  }
}

/** Plugin metadata for profile composition. */
export const name = 'cloud-connectors'
/** Services required by the CloudConnections service. */
export const inject = ['credentials', 'authorization', 'tools']
/** Host entry for the optional cloud connector plugin. */
export const apply = CloudConnections

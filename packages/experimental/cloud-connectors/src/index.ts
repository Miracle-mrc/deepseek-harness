/** OAuth-backed, opt-in AWS and Supabase MCP tools for the Desktop plugin page. */

import { Client, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { createMcpToolDefinition, publicToolName } from '@deepseek-ai/dsh-mcp-client'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AWS_MCP_REGIONS, cloudMcpUrl, type CloudProvider } from './catalog.ts'
import type { CloudConnectionView, CloudSignIn } from './types.ts'
import {
  CloudOAuthProvider, CloudOAuthReconnectRequiredError, cloudAuthorizationFetch, cloudCredentialKey, parseCloudGrant, type CloudGrant,
} from './oauth-provider.ts'
import { OAuthLoopback } from './oauth-loopback.ts'

export type { CloudProvider } from './catalog.ts'
export { AWS_MCP_REGIONS } from './catalog.ts'
export type { CloudConnectionView, CloudSignIn } from './types.ts'

interface LiveClient {
  client: Client
  transport: StreamableHTTPClientTransport
  controller: AbortController
  grantId: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: unknown; taskRequired: boolean }>
  allowedTools: ReadonlySet<string>
  disposers: Array<() => void>
  closing?: Promise<void>
}

interface Attempt {
  region?: string
  controller: AbortController
  url: PromiseWithResolvers<string>
  authorization: Promise<void>
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

/** OAuth discovery, refresh, and MCP requests share the connection's cancellation. */
function cancellableFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, {
    ...init,
    signal: init?.signal == null ? signal : AbortSignal.any([signal, init.signal]),
  })
}

/**
 * Owns short-lived local OAuth callbacks and MCP tool registration. It starts
 * without connecting to either cloud service when the Harness home has no saved grants.
 */
export class CloudConnections extends TypertRemoteService {
  static inject = ['credentials', 'authorization', 'tools']
  private readonly home: Context
  private readonly live = new Map<CloudProvider, LiveClient>()
  private readonly attempts = new Map<CloudProvider, Attempt>()
  private readonly failed = new Map<CloudProvider, string>()
  private readonly lifetime = new AbortController()
  private readonly clients = new Set<LiveClient>()
  private readonly operations = new Map<CloudProvider, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'cloudConnections')
    this.home = ctx
    for (const provider of PROVIDERS) {
      ctx.authorization.registerFlow({
        key: cloudCredentialKey(provider), label: provider === 'aws' ? 'AWS' : 'Supabase',
        methods: [{ id: 'oauth', label: 'Sign in with browser' }],
        run: (session) => {
          const attempt = this.attempts.get(provider)
          if (attempt === undefined) throw new Error('Cloud connections: missing authorization attempt')
          attempt.authorization = this.authorize(provider, session)
          return attempt.authorization
        },
      })
    }
    ctx.effect(() => async () => {
      this.lifetime.abort()
      for (const attempt of this.attempts.values()) attempt.controller.abort()
      const closing = Promise.allSettled([...this.clients].map(item => this.closeClient(item)))
      // AuthorizationService can settle cancellation before its runner exits.
      // Each attempt includes that runner's cleanup, and negotiating clients
      // are owned before their first network request.
      await Promise.allSettled([...this.pending])
      const outcomes = await closing
      this.live.clear()
      const errors: unknown[] = []
      for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Cloud connections: client cleanup failed')
    }, 'cloud-connectors: stop MCP clients')
  }

  protected async [Service.init](): Promise<void> {
    // A saved login can rediscover pending consent; only confirmed selections
    // register tools. A Harness home without grants sends no cloud requests.
    await Promise.all(PROVIDERS.map(provider => this.enqueue(provider, async () => {
      const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
      if (grant === undefined) return
      try {
        await this.connectClient(provider, grant)
      } catch {
        if (!this.lifetime.signal.aborted) this.failed.set(provider, 'Could not restore the cloud MCP connection. Reconnect to authenticate again.')
      }
    })))
  }

  /**
   * Current connection facts, including tool-level selection after OAuth.
   * @returns Credential-free provider status and available tool selections.
   * @throws If the owning plugin is stopping.
   */
  @Remote
  async list(): Promise<CloudConnectionView[]> {
    this.assertActive()
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
    const attempt = await this.enqueue(provider, async () => {
      if (this.attempts.has(provider)) throw new Error('Cloud connections: sign-in already in progress')
      await this.dropClient(provider)
      this.assertActive()
      const url = Promise.withResolvers<string>()
      // Failure may precede the Remote caller receiving this attempt.
      void url.promise.catch(() => undefined)
      const attempt: Attempt = {
        ...(provider === 'aws' ? { region: awsRegion } : {}), controller: new AbortController(),
        url, authorization: Promise.resolve(), done: Promise.resolve(),
      }
      this.attempts.set(provider, attempt)
      this.failed.delete(provider)
      attempt.done = this.track(this.home.authorization.begin({
        key: cloudCredentialKey(provider), method: 'oauth',
        signal: AbortSignal.any([this.lifetime.signal, attempt.controller.signal]),
        interaction: {
          notify: (notice) => {
            if (notice.url !== undefined) url.resolve(notice.url)
          },
          prompt: () => Promise.reject(new Error('Cloud connections: unexpected identity-provider prompt')),
        },
      }).then(async (outcome) => {
        if (outcome.status !== 'authorized') throw new Error('Cloud connections: authorization was cancelled')
        await this.enqueue(provider, async () => {
          attempt.controller.signal.throwIfAborted()
          const grant = parseCloudGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
          if (grant === undefined) throw new Error('Cloud connections: authorization did not store its grant')
          await this.connectClient(provider, grant, attempt.controller.signal)
        })
      }).catch(() => {
        // Identity-provider failures can contain credentials or sensitive URLs.
        if (!this.lifetime.signal.aborted && !attempt.controller.signal.aborted) {
          this.failed.set(provider, 'Cloud sign-in failed. Try again or check the provider\'s authorization policy.')
        }
        url.reject(new Error('Cloud connections: sign-in failed; see connection status'))
      }).then(async () => {
        await Promise.allSettled([attempt.authorization])
        if (this.attempts.get(provider) === attempt) this.attempts.delete(provider)
      }))
      return attempt
    })
    return { url: await Promise.race([attempt.url.promise, attempt.done.then(() => { throw new Error('Cloud connections: sign-in ended before browser authorization') })]) }
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
    await this.enqueue(provider, async () => {
      const client = this.live.get(provider)
      if (client === undefined || client.controller.signal.aborted) throw new Error('Cloud connections: sign in before selecting tools')
      const available = new Set(client.tools.map(tool => tool.name))
      if (new Set(selected).size !== selected.length || selected.some(name => !available.has(name))) {
        throw new Error('Cloud connections: unknown or duplicate tool selection')
      }
      await this.home.credentials.modifyRecord(cloudCredentialKey(provider), (record) => {
        this.assertActive()
        client.controller.signal.throwIfAborted()
        const grant = parseCloudGrant(provider, record)
        if (grant?.grantId !== client.grantId) throw new Error('Cloud connections: connection changed; sign in again')
        return Promise.resolve({ kind: 'grant', payload: { ...grant, confirmed: true, allowedTools: [...selected] } })
      })
      try {
        this.assertActive()
        client.controller.signal.throwIfAborted()
        this.registerTools(provider, client, selected)
      } catch (error) {
        // Never resurrect a disconnected or replaced grant during rollback.
        await this.home.credentials.modifyRecord(cloudCredentialKey(provider), (record) => {
          const grant = parseCloudGrant(provider, record)
          return Promise.resolve(grant?.grantId !== client.grantId ? undefined : {
            kind: 'grant', payload: { ...grant, confirmed: false, allowedTools: [] },
          })
        })
        throw error
      }
    })
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
    this.assertActive()
    this.attempts.get(provider)?.controller.abort()
    this.live.get(provider)?.controller.abort()
    const attempt = await this.enqueue(provider, async () => {
      const attempt = this.attempts.get(provider)
      attempt?.controller.abort()
      await this.dropClient(provider)
      await this.home.credentials.deleteRecord(cloudCredentialKey(provider))
      this.failed.delete(provider)
      return attempt
    })
    // A cancelled attempt may have queued its connect behind this operation.
    // Wait outside the provider queue so it can observe cancellation and exit.
    await attempt?.done
    return await this.list()
  }

  private async authorize(provider: CloudProvider, session: AuthorizationSession): Promise<void> {
    const attempt = this.attempts.get(provider)
    if (attempt === undefined) throw new Error('Cloud connections: missing authorization attempt')
    const endpoint = cloudMcpUrl(provider, attempt.region)
    const signal = AbortSignal.any([session.signal, this.lifetime.signal, AbortSignal.timeout(AUTH_WAIT_MS)])
    signal.throwIfAborted()
    const loopback = await OAuthLoopback.listen(signal)
    const oauth = new CloudOAuthProvider(this.home, provider, loopback.url, (url) => {
      session.notify({ message: 'Continue in your browser to authorize this cloud connection', url: url.href })
    }, loopback.state)
    try {
      const fetchFn = cloudAuthorizationFetch(cancellableFetch(signal))
      const initial = await auth(oauth, { serverUrl: endpoint, forceReauthorization: true, fetchFn })
      if (initial !== 'REDIRECT') throw new Error('Cloud connections: identity provider did not offer browser authorization')
      const callback = await loopback.result
      signal.throwIfAborted()
      const completed = await auth(oauth, { serverUrl: endpoint, authorizationCode: callback.code, fetchFn,
        ...(callback.iss === undefined ? {} : { iss: callback.iss }) })
      if (completed !== 'AUTHORIZED') throw new Error('Cloud connections: OAuth code exchange was not completed')
      await session.commit({ kind: 'grant', payload: oauth.toGrant(endpoint, attempt.region) })
    } finally {
      await loopback.close()
    }
  }

  private async connectClient(provider: CloudProvider, grant: CloudGrant, signal = this.lifetime.signal): Promise<void> {
    await this.dropClient(provider)
    this.assertActive()
    signal.throwIfAborted()
    const oauth = CloudOAuthProvider.fromGrant(this.home, provider, grant)
    const client = new Client({ name: 'dsh-cloud-connectors', version: '0.2.2' })
    const controller = new AbortController()
    const connectionSignal = AbortSignal.any([this.lifetime.signal, signal, controller.signal])
    const transport = new StreamableHTTPClientTransport(new URL(grant.endpoint), {
      authProvider: oauth.transportAuth(), fetch: cancellableFetch(connectionSignal),
    })
    const live: LiveClient = {
      client, transport, controller, grantId: grant.grantId, tools: [], allowedTools: new Set(), disposers: [],
    }
    this.clients.add(live)
    try {
      await client.connect(transport)
      connectionSignal.throwIfAborted()
      const response = await client.listTools()
      connectionSignal.throwIfAborted()
      live.tools = response.tools.map(tool => ({
        name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        taskRequired: tool.execution?.taskSupport === 'required',
      }))
      this.live.set(provider, live)
      this.failed.delete(provider)
      if (grant.confirmed) this.registerTools(provider, live, grant.allowedTools)
    } catch (error) {
      if (this.live.get(provider) === live) this.live.delete(provider)
      await this.closeClient(live)
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
    live.allowedTools = new Set()
    try {
      for (const tool of live.tools) {
        if (!permitted.has(tool.name)) continue
        const name = publicToolName(provider, tool.name)
        staged.push(this.home.tools.register(createMcpToolDefinition(this.home, {
          name, rawName: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema, taskRequired: tool.taskRequired,
          call: (args, execution) => this.track(this.callTool(provider, live, tool.name, args, execution)),
        })))
      }
    } catch (error) {
      for (const dispose of staged) dispose()
      throw error
    }
    live.disposers = staged
    live.allowedTools = permitted
  }

  /** Admit against the shared on-disk consent, then drain the entire admitted operation on unload. */
  private async callTool(
    provider: CloudProvider, live: LiveClient, name: string, args: Record<string, unknown>, execution: ToolExecution,
  ): Promise<unknown> {
    try {
      this.assertToolActive(provider, live, name, execution.signal)
      // readRecord is a cached read. A no-op modification reconciles the shared
      // file under its lock without rewriting it or holding it across MCP I/O.
      const record = await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve(undefined))
      this.assertToolActive(provider, live, name, execution.signal)
      const grant = parseCloudGrant(provider, record)
      if (grant?.grantId !== live.grantId) throw new CloudOAuthReconnectRequiredError()
      if (!grant.confirmed || !grant.allowedTools.includes(name)) {
        this.registerTools(provider, live, grant.confirmed ? grant.allowedTools : [])
        throw new Error('Cloud connections: tool permission was withdrawn')
      }
      return await live.client.callTool(
        { name, arguments: args },
        { signal: AbortSignal.any([execution.signal, live.controller.signal]), timeout: 60_000 },
      )
    } catch (error) {
      if (error instanceof CloudOAuthReconnectRequiredError ||
        error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpAuthentication) {
        if (this.live.get(provider) === live && !this.lifetime.signal.aborted && !live.controller.signal.aborted) {
          this.live.delete(provider)
          this.failed.set(provider, 'Cloud authentication is no longer valid. Reconnect to authenticate again.')
          await this.closeClient(live)
        }
        // The SDK may attach provider-controlled HTTP fields. Neither those
        // fields nor an old generation's error belong in model-facing results.
        throw new CloudOAuthReconnectRequiredError()
      }
      throw error
    }
  }

  private assertToolActive(provider: CloudProvider, live: LiveClient, name: string, signal: AbortSignal): void {
    this.assertActive()
    signal.throwIfAborted()
    live.controller.signal.throwIfAborted()
    if (this.live.get(provider) !== live || !live.allowedTools.has(name)) {
      throw new Error('Cloud connections: tool permission was withdrawn')
    }
  }

  private async dropClient(provider: CloudProvider): Promise<void> {
    const live = this.live.get(provider)
    if (live === undefined) return
    this.live.delete(provider)
    await this.closeClient(live)
  }

  /** Stop transport negotiation as well as an already initialized MCP client. */
  private closeClient(live: LiveClient): Promise<void> {
    if (live.closing !== undefined) return live.closing
    live.controller.abort()
    live.allowedTools = new Set()
    for (const dispose of live.disposers) dispose()
    live.disposers = []
    live.closing = (async () => {
      try { await live.transport.close() } finally { await live.client.close() }
    })().finally(() => { this.clients.delete(live) })
    return live.closing
  }

  private assertActive(): void {
    if (this.lifetime.signal.aborted) throw new Error('Cloud connections: plugin is stopping')
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  /** Provider mutations serialize consent, replacement, and disconnection. */
  private enqueue<T>(provider: CloudProvider, operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const task = (this.operations.get(provider) ?? Promise.resolve()).then(() => {
      this.assertActive()
      return operation()
    })
    const settled = task.then(() => undefined, () => undefined)
    this.operations.set(provider, settled)
    void settled.then(() => {
      if (this.operations.get(provider) === settled) this.operations.delete(provider)
    })
    return this.track(task)
  }
}

/** Plugin metadata for profile composition. */
export const name = 'cloud-connectors'
/** Services required by the CloudConnections service. */
export const inject = ['credentials', 'authorization', 'tools']
/** Host entry for the optional cloud connector plugin. */
export const apply = CloudConnections

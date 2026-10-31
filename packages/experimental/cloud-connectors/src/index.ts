/** Opt-in AWS CLI and Supabase OAuth connections for GUI and terminal consumers. */

import { Client, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createMcpToolDefinition, publicToolName } from '@deepseek-ai/dsh-mcp-client'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AWS_MCP_REGIONS, cloudMcpUrl, type CloudProvider } from './catalog.ts'
import type {
  AwsLoginMethod, CloudAttemptId, CloudConnectionErrorCode, CloudConnectionPrompt,
  CloudConnectionView, CloudPromptId, CloudSignIn, CloudStartOptions,
} from './types.ts'
import {
  CloudOAuthProvider, CloudOAuthReconnectRequiredError, cloudAuthorizationFetch, cloudCredentialKey,
} from './oauth-provider.ts'
import { OAuthLoopback } from './oauth-loopback.ts'
import { CloudConnectionError } from './errors.ts'
import { authorizeAwsCli } from './aws-cli.ts'
import { createAwsCliAuth, createAwsCliGrant } from './aws-grant.ts'
import { parseConnectionGrant, type CloudConnectionGrant } from './connection-grant.ts'

export type { CloudProvider } from './catalog.ts'
export { AWS_MCP_REGIONS } from './catalog.ts'
export type {
  AwsLoginMethod, CloudAttemptId, CloudConnectionErrorCode, CloudConnectionPrompt,
  CloudConnectionView, CloudPromptId, CloudSignIn, CloudStartOptions,
} from './types.ts'
export { CloudConnectionError } from './errors.ts'

/** Deployment settings for cloud authorization and MCP requests. */
export interface Config {
  /** Restore saved connections during startup; CLI help disables this. */
  restoreOnStart?: boolean
  /** Named AWS CLI profile, isolated from the default profile unless explicitly changed. */
  awsProfile?: string
  /** Official AWS CLI sign-in method used when a caller omits its selection. */
  awsMethod?: AwsLoginMethod
  /** Region used by generic authorization callers which do not supply a selection. */
  awsRegion?: typeof AWS_MCP_REGIONS[number]
  /** Trusted local AWS CLI executable, resolved by the Host. */
  awsExecutable?: string
  /** Complete browser/CLI authorization deadline in milliseconds. */
  authorizationTimeoutMs?: number
  /** AWS CLI version/token command deadline in milliseconds. */
  awsCommandTimeoutMs?: number
  /** Complete MCP tool-call deadline in milliseconds. */
  mcpTimeoutMs?: number
}

/** Validated defaults, shared by direct construction and Cordis composition. */
export const Config = z.object({
  restoreOnStart: z.boolean().default(true),
  awsProfile: z.string().pattern(/^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/).default('dsh-cloud'),
  awsMethod: z.union([z.const('login'), z.const('sso'), z.const('existing')]).default('login'),
  awsRegion: z.union(AWS_MCP_REGIONS.map(region => z.const(region))).default('us-east-1'),
  awsExecutable: z.string().pattern(/\S/).default('aws'),
  authorizationTimeoutMs: z.number().min(1).step(1).default(300_000),
  awsCommandTimeoutMs: z.number().min(1).max(25_000).step(1).default(20_000),
  mcpTimeoutMs: z.number().min(1).step(1).default(60_000),
})

interface LiveClient {
  provider: CloudProvider
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
  id: CloudAttemptId
  region: string
  awsProfile: string
  awsMethod: AwsLoginMethod
  controller: AbortController
  signal: AbortSignal
  authorizationUrl?: string
  code?: string
  prompt?: { view: CloudConnectionPrompt; resolve: (response: string) => void }
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
 * Owns browser authorization, AWS CLI sign-in, and MCP tool registration. It starts
 * without connecting to either cloud service when the Harness home has no saved grants.
 */
export class CloudConnections extends TypertRemoteService {
  static inject = ['credentials', 'authorization', 'tools']
  static Config = Config
  private readonly home: Context
  private readonly live = new Map<CloudProvider, LiveClient>()
  private readonly attempts = new Map<CloudProvider, Attempt>()
  private readonly disconnecting = new Set<CloudProvider>()
  private readonly failed = new Map<CloudProvider, CloudConnectionErrorCode>()
  private readonly lifetime = new AbortController()
  private readonly clients = new Set<LiveClient>()
  private readonly operations = new Map<CloudProvider, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private stopping?: Promise<void>
  private readonly spec: Required<Config>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'cloudConnections')
    this.home = ctx
    this.spec = Config(config)
    for (const provider of PROVIDERS) {
      ctx.authorization.registerFlow({
        key: cloudCredentialKey(provider), label: provider === 'aws' ? 'AWS' : 'Supabase',
        methods: [{ id: 'oauth', label: 'Sign in with browser' }],
        run: session => this.runRegisteredFlow(provider, session),
      })
    }
    ctx.on('credentials/record-updated', (key) => {
      const provider = PROVIDERS.find(item => cloudCredentialKey(item) === key)
      // The admitted sign-in reconciles its committed record before settling.
      if (provider === undefined || this.attempts.has(provider) || this.disconnecting.has(provider) || this.lifetime.signal.aborted) return
      void this.enqueue(provider, () => this.reconcile(provider)).catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) this.failed.set(provider, this.failureCode(error, 'connection-failed'))
      })
    })
    // Cordis announces unload before awaiting an unfinished Service.init().
    // Stop its requests now; effect cleanup joins the same owned shutdown.
    // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the effect also awaits this promise.
    ctx.on('internal/plugin', (fiber) => {
      if (fiber !== ctx.fiber || fiber.uid !== null) return
      return this.stop()
    }, { global: true })
    ctx.effect(() => () => this.stop(), 'cloud-connectors: stop MCP clients')
  }

  protected async [Service.init](): Promise<void> {
    // A saved login can rediscover pending consent; only confirmed selections
    // register tools. A Harness home without grants sends no cloud requests.
    if (!this.spec.restoreOnStart) return
    await Promise.all(PROVIDERS.map(provider => this.enqueue(provider, async () => {
      try {
        await this.reconcile(provider)
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.failed.set(provider, this.failureCode(error, 'connection-failed'))
      }
    })))
  }

  /**
   * Current connection facts, including tool-level selection after sign-in.
   * @returns Credential-free provider status and available tool selections.
   * @throws If the owning plugin is stopping.
   */
  @Remote
  async list(): Promise<CloudConnectionView[]> {
    this.assertActive()
    return await Promise.all(PROVIDERS.map(async (provider) => {
      const grant = parseConnectionGrant(provider, await this.home.credentials.readRecord(cloudCredentialKey(provider)))
      const attempt = this.attempts.get(provider)
      const live = this.live.get(provider)
      const currentLive = live !== undefined && !live.controller.signal.aborted && live.grantId === grant?.grantId ? live : undefined
      const status: CloudConnectionView['status'] = attempt !== undefined ? 'authorizing'
        : this.failed.has(provider) ? 'failed'
          : grant === undefined ? 'not-connected'
            : grant.confirmed && currentLive !== undefined ? 'connected' : 'choose-permissions'
      const tools = currentLive?.tools.map(tool => ({ name: tool.name, description: tool.description })) ?? []
      const failure = this.failed.get(provider)
      return { provider, status, tools, enabledTools: grant?.allowedTools ?? [],
        ...(failure === undefined ? {} : { errorCode: failure }),
        ...(attempt === undefined ? {} : {
          attemptId: attempt.id,
          ...(attempt.authorizationUrl === undefined ? {} : { authorizationUrl: attempt.authorizationUrl }),
          ...(attempt.code === undefined ? {} : { code: attempt.code }),
          ...(attempt.prompt === undefined ? {} : { prompt: attempt.prompt.view }),
        }),
        ...(provider !== 'aws' ? {} : {
          awsProfile: attempt?.awsProfile ?? (grant !== undefined && 'profile' in grant ? grant.profile : this.spec.awsProfile),
          awsMethod: attempt?.awsMethod ?? (grant !== undefined && 'loginMethod' in grant ? grant.loginMethod : this.spec.awsMethod),
        }),
      }
    }))
  }

  /**
   * Admit one sign-in without waiting for provider I/O. Notices and private
   * prompts are projected by list(); cancellation uses the returned identity.
   * @param providerId - AWS or Supabase.
   * @param awsRegion - Region of the AWS-managed MCP endpoint.
   * @param options - Explicit AWS CLI selectors; omitted fields use plugin configuration.
   * @returns Identity of this caller's admitted authorization operation.
   */
  @Remote
  async start(providerId: string, awsRegion: string, options?: CloudStartOptions): Promise<CloudSignIn> {
    const provider = providerOf(providerId)
    if (provider === 'aws' && !(AWS_MCP_REGIONS as readonly string[]).includes(awsRegion)) {
      throw new Error('Cloud connections: select a supported AWS region')
    }
    const attempt = await this.enqueue(provider, async () => {
      if (this.attempts.has(provider) || this.disconnecting.has(provider)) throw new Error('Cloud connections: sign-in already in progress')
      await this.dropClient(provider)
      this.assertActive()
      const attempt = this.createAttempt(provider === 'aws' ? awsRegion : undefined, options ?? {})
      this.attempts.set(provider, attempt)
      this.failed.delete(provider)
      attempt.done = this.track(this.home.authorization.begin({
        key: cloudCredentialKey(provider), method: 'oauth',
        signal: attempt.signal,
        interaction: {
          notify: (notice) => {
            if (notice.url !== undefined) {
              const url = URL.parse(notice.url)
              if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
                throw new CloudConnectionError('authorization-failed')
              }
              attempt.authorizationUrl = url.href
            }
            if (notice.code !== undefined) attempt.code = notice.code
          },
          prompt: request => this.requestResponse(attempt, request),
        },
      }).then(async (outcome) => {
        if (outcome.status !== 'authorized') throw new Error('Cloud connections: authorization was cancelled')
        await this.enqueue(provider, async () => {
          attempt.signal.throwIfAborted()
          await this.reconcile(provider, attempt.signal)
        })
      }).catch((error: unknown) => {
        // Identity-provider failures can contain credentials or sensitive URLs.
        if (!this.lifetime.signal.aborted && !attempt.controller.signal.aborted) {
          this.failed.set(provider, this.failureCode(error, 'authorization-failed'))
        }
      }).then(async () => {
        await Promise.allSettled([attempt.authorization])
        this.attempts.delete(provider)
      }))
      return attempt
    })
    return { attemptId: attempt.id,
      ...(attempt.authorizationUrl === undefined ? {} : { url: attempt.authorizationUrl }) }
  }

  /**
   * Return a browser response to its exact pending prompt without logging it.
   * @param providerId - Provider whose sign-in is waiting.
   * @param promptId - Identity supplied by list(); stale prompts are rejected.
   * @param response - Private authorization response or callback URL from the browser.
   * @returns Connection state without echoing the supplied response.
   */
  @Remote
  async complete(providerId: string, promptId: CloudPromptId, response: string): Promise<CloudConnectionView[]> {
    this.assertActive()
    const attempt = this.attempts.get(providerOf(providerId))
    const prompt = attempt?.prompt
    if (attempt === undefined || prompt === undefined || prompt.view.id !== promptId || attempt.controller.signal.aborted) {
      throw new CloudConnectionError('authorization-failed')
    }
    if (response.length === 0 || Buffer.byteLength(response, 'utf8') > 65_536) {
      throw new CloudConnectionError('authorization-failed')
    }
    if (prompt.view.kind === 'select' && response !== 'yes' && response !== 'no') {
      throw new CloudConnectionError('authorization-failed')
    }
    delete attempt.prompt
    prompt.resolve(response)
    return await this.list()
  }

  /**
   * Cancel only the caller's admitted operation; never disconnect another login.
   * A saved login without a live catalog remains unavailable and offers retry.
   * @param providerId - Provider of the sign-in operation.
   * @param attemptId - Identity returned by start(); a stale identity is a no-op.
   * @returns State after the owned authorization runner has stopped.
   */
  @Remote
  async cancel(providerId: string, attemptId: CloudAttemptId): Promise<CloudConnectionView[]> {
    this.assertActive()
    const provider = providerOf(providerId)
    const attempt = this.attempts.get(provider)
    if (attempt?.id === attemptId) {
      attempt.controller.abort()
      await attempt.done
      await this.enqueue(provider, async () => {
        if (this.attempts.has(provider)) return
        const record = await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve(undefined))
        const grant = parseConnectionGrant(provider, record)
        const live = this.live.get(provider)
        if (grant !== undefined && live?.grantId !== grant.grantId) {
          this.failed.set(provider, 'connection-failed')
        }
      })
    }
    return await this.list()
  }

  /**
   * Restore saved credentials only when a noninteractive consumer requests it.
   * @param providerId - Provider to restore; missing credentials leave it disconnected.
   * @returns Connection facts after MCP discovery, or a safe failed state.
   */
  async restore(providerId: string): Promise<CloudConnectionView[]> {
    const provider = providerOf(providerId)
    await this.enqueue(provider, async () => {
      try { await this.reconcile(provider) } catch (error) {
        this.failed.set(provider, this.failureCode(error, 'connection-failed'))
      }
    })
    return await this.list()
  }

  /**
   * Confirm the selected subset of tools after sign-in. Tool names not offered
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
        const grant = parseConnectionGrant(provider, record)
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
          const grant = parseConnectionGrant(provider, record)
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
   * Remove the local cloud grant and every associated model tool. External
   * token revocation is controlled by the identity provider, not this action.
   * @param providerId - Provider to disconnect.
   * @returns Updated connection facts.
   */
  @Remote
  async disconnect(providerId: string): Promise<CloudConnectionView[]> {
    const provider = providerOf(providerId)
    this.assertActive()
    this.disconnecting.add(provider)
    this.attempts.get(provider)?.controller.abort()
    for (const client of this.clients) if (client.provider === provider) client.controller.abort()
    try {
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
    } finally {
      this.disconnecting.delete(provider)
    }
    return await this.list()
  }

  private createAttempt(region: string | undefined, options: CloudStartOptions = {}): Attempt {
    const controller = new AbortController()
    return {
      id: brandString<CloudAttemptId>(randomUUID()),
      region: region ?? this.spec.awsRegion, controller,
      signal: AbortSignal.any([this.lifetime.signal, controller.signal, AbortSignal.timeout(this.spec.authorizationTimeoutMs)]),
      awsProfile: options.awsProfile ?? this.spec.awsProfile,
      awsMethod: options.awsMethod ?? this.spec.awsMethod,
      authorization: Promise.resolve(), done: Promise.resolve(),
    }
  }

  /** The registered flow is also usable by a neutral authorization consumer. */
  private runRegisteredFlow(provider: CloudProvider, session: AuthorizationSession): Promise<void> {
    const admitted = this.attempts.get(provider)
    if (admitted !== undefined) {
      admitted.authorization = this.authorize(provider, session, admitted)
      return admitted.authorization
    }
    const attempt = this.createAttempt(provider === 'aws' ? this.spec.awsRegion : undefined)
    this.attempts.set(provider, attempt)
    this.failed.delete(provider)
    const runner = this.track((async () => {
      try {
        await this.authorize(provider, session, attempt)
        await this.enqueue(provider, () => this.reconcile(provider, attempt.signal))
      } catch (error) {
        if (!this.lifetime.signal.aborted && !attempt.controller.signal.aborted && !session.signal.aborted) {
          this.failed.set(provider, this.failureCode(error, 'authorization-failed'))
        }
        throw error
      } finally {
        this.attempts.delete(provider)
      }
    })())
    attempt.authorization = runner
    attempt.done = runner.then(() => undefined, () => undefined)
    return runner
  }

  private async authorize(provider: CloudProvider, session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const endpoint = cloudMcpUrl(provider, attempt.region)
    const signal = AbortSignal.any([session.signal, attempt.signal])
    signal.throwIfAborted()
    if (provider === 'aws') {
      const token = await authorizeAwsCli({
        executable: this.spec.awsExecutable, profile: attempt.awsProfile, method: attempt.awsMethod,
        region: attempt.region, signal, commandTimeoutMs: this.spec.awsCommandTimeoutMs,
        notify: (notice) => { session.notify(notice) }, prompt: request => session.prompt(request),
      })
      signal.throwIfAborted()
      await session.commit({ kind: 'grant', payload: createAwsCliGrant(
        attempt.region, attempt.awsProfile, attempt.awsMethod, token,
      ) })
      return
    }
    const loopback = await OAuthLoopback.listen(signal)
    const oauth = new CloudOAuthProvider(this.home, provider, loopback.url, (url) => {
      session.notify({ message: 'Continue in your browser to authorize this cloud connection', url: url.href })
    }, loopback.state)
    try {
      const fetchFn = cloudAuthorizationFetch(cancellableFetch(signal))
      const initial = await auth(oauth, { serverUrl: endpoint, forceReauthorization: true, fetchFn })
      if (initial !== 'REDIRECT') throw new Error('Cloud connections: identity provider did not offer browser authorization')
      const manual = new AbortController()
      const manualCallback = (async () => {
        while (true) {
          const response = await session.prompt({ kind: 'secret', signal: manual.signal,
            message: 'If the browser cannot reach this Host, paste its callback URL here.' })
          if (loopback.completeCallback(response.trim())) return await loopback.result
          session.notify({ message: 'That callback does not match this sign-in. Copy the complete callback URL from the browser.' })
        }
      })()
      let callback: Awaited<typeof loopback.result>
      try {
        callback = await Promise.race([loopback.result, manualCallback])
      } finally {
        manual.abort()
        await Promise.allSettled([manualCallback])
      }
      signal.throwIfAborted()
      const completed = await auth(oauth, { serverUrl: endpoint, authorizationCode: callback.code, fetchFn,
        ...(callback.iss === undefined ? {} : { iss: callback.iss }) })
      if (completed !== 'AUTHORIZED') throw new Error('Cloud connections: OAuth code exchange was not completed')
      await session.commit({ kind: 'grant', payload: oauth.toGrant(endpoint, undefined) })
    } finally {
      await loopback.close()
    }
  }

  private async connectClient(provider: CloudProvider, grant: CloudConnectionGrant, signal: AbortSignal): Promise<boolean> {
    await this.dropClient(provider)
    this.assertActive()
    signal.throwIfAborted()
    const controller = new AbortController()
    const connectionSignal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const abortSetup = () => { controller.abort() }
    signal.addEventListener('abort', abortSetup, { once: true })
    const authProvider = 'authMethod' in grant
      ? createAwsCliAuth(this.home, grant, {
        executable: this.spec.awsExecutable, commandTimeoutMs: this.spec.awsCommandTimeoutMs,
      }, connectionSignal)
      : CloudOAuthProvider.fromGrant(this.home, provider, grant).transportAuth()
    const client = new Client({ name: 'dsh-cloud-connectors', version: '0.2.2' })
    const transport = new StreamableHTTPClientTransport(new URL(grant.endpoint), {
      authProvider, fetch: cancellableFetch(connectionSignal),
    })
    const live: LiveClient = {
      provider, client, transport, controller, grantId: grant.grantId, tools: [], allowedTools: new Set(), disposers: [],
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
      const record = await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve(undefined))
      connectionSignal.throwIfAborted()
      const current = parseConnectionGrant(provider, record)
      // Another Host may replace or withdraw the login during discovery.
      // Never publish that older client's catalog or its cached consent.
      if (current?.grantId !== grant.grantId) {
        await this.closeClient(live)
        return false
      }
      this.live.set(provider, live)
      this.failed.delete(provider)
      if (current.confirmed) this.registerTools(provider, live, current.allowedTools)
      return true
    } catch (error) {
      if (this.live.get(provider) === live) this.live.delete(provider)
      await this.closeClient(live)
      throw error
    } finally {
      // Once published, the connection belongs to its own lifetime rather
      // than the completed sign-in request's deadline.
      signal.removeEventListener('abort', abortSetup)
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
      const grant = parseConnectionGrant(provider, record)
      if (grant?.grantId !== live.grantId) throw new CloudOAuthReconnectRequiredError()
      if (!grant.confirmed || !grant.allowedTools.includes(name)) {
        this.registerTools(provider, live, grant.confirmed ? grant.allowedTools : [])
        throw new Error('Cloud connections: tool permission was withdrawn')
      }
      return await live.client.callTool(
        { name, arguments: args },
        { signal: AbortSignal.any([execution.signal, live.controller.signal]), timeout: this.spec.mcpTimeoutMs },
      )
    } catch (error) {
      if (error instanceof CloudOAuthReconnectRequiredError ||
        error instanceof CloudConnectionError && error.code === 'session-expired' ||
        error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpAuthentication) {
        if (this.live.get(provider) === live && !this.lifetime.signal.aborted && !live.controller.signal.aborted) {
          this.live.delete(provider)
          this.failed.set(provider, 'session-expired')
          await this.closeClient(live)
        }
        // The SDK may attach provider-controlled HTTP fields. Neither those
        // fields nor an old generation's error belong in model-facing results.
        if (error instanceof CloudConnectionError) throw error
        throw new CloudOAuthReconnectRequiredError()
      }
      if (error instanceof CloudConnectionError) throw error
      if (execution.signal.aborted || live.controller.signal.aborted || this.lifetime.signal.aborted) {
        throw new CloudConnectionError('connection-failed')
      }
      // SDK transport errors may retain response bodies or echoed credentials.
      // Provider tool-result content follows its ordinary MCP result path.
      throw new CloudConnectionError('connection-failed')
    }
  }

  private failureCode(error: unknown, fallback: CloudConnectionErrorCode): CloudConnectionErrorCode {
    if (error instanceof CloudConnectionError) return error.code
    if (error instanceof CloudOAuthReconnectRequiredError) return 'session-expired'
    return fallback
  }

  /** Reconcile one committed shared credential without restarting a client for token rotation. */
  private async reconcile(provider: CloudProvider, requestedSignal?: AbortSignal): Promise<void> {
    const signal = requestedSignal ?? AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.spec.mcpTimeoutMs)])
    for (;;) {
      this.assertActive()
      if (this.disconnecting.has(provider)) return
      signal.throwIfAborted()
      const record = await this.home.credentials.modifyRecord(cloudCredentialKey(provider), () => Promise.resolve(undefined))
      if (this.disconnecting.has(provider)) return
      const grant = parseConnectionGrant(provider, record)
      const live = this.live.get(provider)
      if (grant === undefined) {
        await this.dropClient(provider)
        this.failed.delete(provider)
        return
      }
      if (live?.grantId === grant.grantId && !live.controller.signal.aborted) {
        const selected = grant.confirmed ? grant.allowedTools : []
        if (selected.length !== live.allowedTools.size || selected.some(name => !live.allowedTools.has(name))) {
          this.registerTools(provider, live, selected)
        }
        this.failed.delete(provider)
        return
      }
      if (await this.connectClient(provider, grant, signal)) return
      // Only a committed credential-generation change restarts discovery;
      // a transport failure is reported without retrying it here.
    }
  }

  /** One private prompt owns its settlement and removes both abort listeners before returning. */
  private async requestResponse(attempt: Attempt, request: AuthorizationPrompt): Promise<string> {
    if (request.kind === 'text' || attempt.prompt !== undefined) throw new CloudConnectionError('authorization-failed')
    if (request.kind === 'select' && (request.options.length !== 2
      || !request.options.some(option => option.id === 'yes') || !request.options.some(option => option.id === 'no'))) {
      throw new CloudConnectionError('authorization-failed')
    }
    const signal = AbortSignal.any([this.lifetime.signal, attempt.controller.signal,
      ...(request.signal === undefined ? [] : [request.signal])])
    signal.throwIfAborted()
    const response = Promise.withResolvers<string>()
    const id = brandString<CloudPromptId>(randomUUID())
    const view: CloudConnectionPrompt = request.kind === 'secret' ? { id, kind: 'secret' }
      : { id, kind: 'select', purpose: 'replace-aws-login' }
    const prompt = { view, resolve: response.resolve }
    attempt.prompt = prompt
    const abort = () => { response.reject(new CloudConnectionError('authorization-failed')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await response.promise
    } finally {
      signal.removeEventListener('abort', abort)
      if (attempt.prompt === prompt) delete attempt.prompt
    }
  }

  private assertToolActive(provider: CloudProvider, live: LiveClient, name: string, signal: AbortSignal): void {
    this.assertActive()
    signal.throwIfAborted()
    live.controller.signal.throwIfAborted()
    if (this.disconnecting.has(provider) || this.live.get(provider) !== live || !live.allowedTools.has(name)) {
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
      try {
        try { await live.transport.close() } finally { await live.client.close() }
      } catch {
        // SDK close failures may carry the same sensitive HTTP fields as requests.
        throw new CloudConnectionError('connection-failed')
      }
    })().finally(() => { this.clients.delete(live) })
    return live.closing
  }

  private stop(): Promise<void> {
    this.stopping ??= (async () => {
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
    })()
    return this.stopping
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

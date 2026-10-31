/** Loader composition and durable consent under cancellation and concurrent writes. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as cloudPlugin from '../src/index.ts'
import { CloudOAuthReconnectRequiredError, cloudCredentialKey, parseCloudGrant } from '../src/oauth-provider.ts'
import { CloudConnectionError } from '../src/errors.ts'
import { parseAwsCliGrant } from '../src/aws-grant.ts'

const awsCli = vi.hoisted(() => ({
  authorize: vi.fn<typeof import('../src/aws-cli.ts').authorizeAwsCli>(),
  refresh: vi.fn<typeof import('../src/aws-cli.ts').refreshAwsCliToken>(),
}))

vi.mock('../src/aws-cli.ts', () => ({
  authorizeAwsCli: awsCli.authorize,
  refreshAwsCliToken: awsCli.refresh,
}))

const sdk = vi.hoisted(() => {
  const connect = vi.fn<() => Promise<void>>()
  const listTools = vi.fn<() => Promise<{ tools: Array<{
    name: string
    description?: string
    inputSchema: { type: 'object' }
    outputSchema?: { type: 'object' }
    execution?: { taskSupport: 'required' }
  }> }>>()
  const close = vi.fn<() => Promise<void>>()
  const transportClose = vi.fn<() => Promise<void>>()
  const callTool = vi.fn()
  const auth = vi.fn<typeof import('@modelcontextprotocol/client').auth>()
  const transportOptions = vi.fn<(options: ConstructorParameters<typeof import('@modelcontextprotocol/client').StreamableHTTPClientTransport>[1]) => void>()
  class Client {
    connect = connect
    listTools = listTools
    close = close
    callTool = callTool
  }
  class StreamableHTTPClientTransport {
    constructor(_url: URL, options: ConstructorParameters<typeof import('@modelcontextprotocol/client').StreamableHTTPClientTransport>[1]) {
      transportOptions(options)
    }
    close = transportClose
  }
  return { connect, listTools, close, transportClose, callTool, auth, transportOptions, Client, StreamableHTTPClientTransport }
})

vi.mock('@modelcontextprotocol/client', async original => ({
  ...await original<typeof import('@modelcontextprotocol/client')>(),
  Client: sdk.Client,
  StreamableHTTPClientTransport: sdk.StreamableHTTPClientTransport,
  auth: sdk.auth,
}))

const KEY = cloudCredentialKey('supabase')
const TOOL = 'mcp__supabase__execute_sql'
const discovered = { tools: [
  { name: 'execute_sql', description: 'Execute SQL', inputSchema: { type: 'object' as const } },
  { name: 'apply_migration', description: 'Apply migration', inputSchema: { type: 'object' as const } },
] }
let callbackUrl: string

/** Real loopback callback: the identity-provider exchange alone is mocked. */
async function callback(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    get(callbackUrl, (response) => {
      response.resume()
      response.once('end', () => {
        if (response.statusCode === 200) resolve()
        else reject(new Error('callback refused'))
      })
      response.once('error', reject)
    }).once('error', reject)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  sdk.connect.mockResolvedValue(undefined)
  sdk.listTools.mockResolvedValue(discovered)
  sdk.close.mockResolvedValue(undefined)
  sdk.transportClose.mockResolvedValue(undefined)
  awsCli.authorize.mockResolvedValue({ accessToken: 'private-aws-mcp-token', expiresAt: Date.now() + 3_600_000 })
  awsCli.refresh.mockResolvedValue({ accessToken: 'private-refreshed-aws-mcp-token', expiresAt: Date.now() + 3_600_000 })
  sdk.auth.mockImplementation(async (provider: OAuthClientProvider, options) => {
    if (options.authorizationCode !== undefined) {
      await provider.saveTokens({ access_token: 'access-before-refresh', refresh_token: 'refresh-before-rotation', token_type: 'Bearer' })
      return 'AUTHORIZED'
    }
    await provider.saveClientInformation?.({ client_id: 'fixture-client' })
    const url = new URL(provider.redirectUrl!)
    url.searchParams.set('state', await provider.state!())
    url.searchParams.set('code', 'fixture-code')
    callbackUrl = url.href
    await provider.redirectToAuthorization(new URL('https://login.example.invalid/authorize'))
    return 'REDIRECT'
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** The normal Loader reads a test-only composition; all credential writes are real. */
async function fixture(options: { credentialsPath?: string; watch?: boolean; cloud?: cloudPlugin.Config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-lifecycle-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${dir}/`).href
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const credentialsPath = options.credentialsPath ?? join(dir, 'credentials.yml')
  await writeFile(join(dir, 'cordis.yml'), JSON.stringify([
    { id: 'credentials', name: 'cordis:credentials', config: { path: credentialsPath, watch: options.watch ?? false, debounceMs: 1 } },
    { id: 'authorization', name: 'cordis:authorization' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'cloud', name: 'cordis:cloud', config: options.cloud ?? {} },
  ]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, credentials: LocalCredentialProvider, authorization: AuthorizationService,
    prompt: SystemPrompt, tools: ToolRuntime, executor: NativeToolExecutor, cloud: cloudPlugin,
  })
  await ctx.loader.root.update([{ id: 'fixture', name: 'cordis:include', config: { path: './cordis.yml' } }])
  await ctx.loader.await()
  const owner = ctx.loader.resolve('fixture:cloud').fiber!
  await owner.await()
  return { ctx, host: ctx.cloudConnections, owner, credentialsPath }
}

async function beginSignIn(host: cloudPlugin.CloudConnections): Promise<cloudPlugin.CloudSignIn> {
  const admitted = await host.start('supabase', '')
  expect(admitted.attemptId).toEqual(expect.any(String))
  await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.authorizationUrl)
    .toBe('https://login.example.invalid/authorize')
  return admitted
}

async function signIn(host: cloudPlugin.CloudConnections): Promise<void> {
  await beginSignIn(host)
  await callback()
  await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
}

async function pendingPrompt(host: cloudPlugin.CloudConnections, provider: cloudPlugin.CloudProvider = 'supabase') {
  await expect.poll(async () => (await host.list()).find(view => view.provider === provider)?.prompt).toBeDefined()
  return (await host.list()).find(view => view.provider === provider)!.prompt!
}

/** A second Host sharing the same file; the first Host has no file watcher. */
async function sharedCredentials(path: string): Promise<Context> {
  const peer = new Context()
  onTestFinished(async () => { await peer.fiber.dispose() })
  await peer.plugin(LocalCredentialProvider, { path, watch: false })
  return peer
}

/** Exercise the real tool executor, not the MCP mock directly. */
async function executeSql(ctx: Context, name = TOOL) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('cloud-permission-call'), name, arguments: '{}' }],
    signal: new AbortController().signal,
  })
  return batch.results[0]!.result
}

/** Read the real bearer adapter installed on the first mocked network transport. */
async function transportToken(): Promise<string | undefined> {
  const provider = sdk.transportOptions.mock.calls[0]![0]!.authProvider!
  if (!('token' in provider)) throw new Error('fixture expected a bearer auth provider')
  return provider.token()
}

describe('cloud connections through the Loader', () => {
  it('rejects unknown wire provider and AWS region values before beginning authorization', async () => {
    const { host } = await fixture()
    await expect(host.start('other-cloud', '')).rejects.toThrow('unknown provider')
    await expect(host.start('aws', 'us-east-1.example.invalid')).rejects.toThrow('select a supported AWS region')
    await expect(host.confirm('supabase', ['execute_sql'])).rejects.toThrow('sign in before selecting tools')
    expect(sdk.auth).not.toHaveBeenCalled()
    expect(awsCli.authorize).not.toHaveBeenCalled()
  })

  it('refuses a second sign-in while preserving the first caller\'s prompt', async () => {
    const { host } = await fixture()
    const first = await beginSignIn(host)
    const prompt = await pendingPrompt(host)
    await expect(host.start('supabase', '')).rejects.toThrow('sign-in already in progress')
    expect((await host.list()).find(view => view.provider === 'supabase')).toMatchObject({ attemptId: first.attemptId, prompt })
    await host.cancel('supabase', first.attemptId)
  })

  it('withholds an unsafe authorization destination supplied by the OAuth server', async () => {
    const { host } = await fixture()
    sdk.auth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL('http://identity.example.invalid/authorize'))
      return 'REDIRECT'
    })
    const admitted = await host.start('supabase', '')
    await pendingPrompt(host)
    expect((await host.list()).find(view => view.provider === 'supabase')?.authorizationUrl).toBeUndefined()
    await host.cancel('supabase', admitted.attemptId)
  })

  it('combines the connection and individual MCP request cancellation signals', async () => {
    const { host } = await fixture()
    await host.start('aws', 'us-east-1', { awsMethod: 'existing' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    let observed: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      observed = init?.signal
      return new Response('{}')
    }))
    const request = new AbortController()
    await sdk.transportOptions.mock.calls[0]![0]!.fetch!('https://aws-mcp.us-east-1.api.aws/mcp', { signal: request.signal })
    expect(observed).not.toBe(request.signal)
    expect(observed?.aborted).toBe(false)
    request.abort()
    expect(observed?.aborted).toBe(true)
  })

  it('admits before discovery and drains only its owned cancellation', async () => {
    const { ctx, host } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (input !== 'https://discovery.example.invalid/') return originalFetch(input, init)
      entered.resolve(undefined)
      init!.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await release.promise
      init!.signal!.throwIfAborted()
      throw new Error('discovery unexpectedly survived cancellation')
    }))
    sdk.auth.mockImplementationOnce(async (_provider, options) => {
      await options.fetchFn!('https://discovery.example.invalid/')
      return 'REDIRECT'
    })
    const admitted = await host.start('supabase', '')
    expect(admitted.attemptId).toEqual(expect.any(String))
    expect(admitted.url).toBeUndefined()
    await entered.promise
    const state = (await host.list()).find(view => view.provider === 'supabase')!
    expect(state).toEqual({ provider: 'supabase', status: 'authorizing', tools: [], enabledTools: [], attemptId: admitted.attemptId })
    let cancelled = false
    const cancellation = host.cancel('supabase', admitted.attemptId).then((result) => { cancelled = true; return result })
    await aborted.promise
    expect(cancelled).toBe(false)
    release.resolve(undefined)
    expect((await cancellation).find(view => view.provider === 'supabase')).toEqual({
      provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [],
    })
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('refuses stale prompts and leaves a later caller\'s sign-in and connected grant intact', async () => {
    const { ctx, host } = await fixture()
    const first = await beginSignIn(host)
    const firstPrompt = await pendingPrompt(host)
    await host.cancel('supabase', first.attemptId)
    const second = await beginSignIn(host)
    const secondPrompt = await pendingPrompt(host)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(secondPrompt.id).not.toBe(firstPrompt.id)
    expect((await host.cancel('supabase', first.attemptId)).find(view => view.provider === 'supabase')).toMatchObject({
      status: 'authorizing', attemptId: second.attemptId, prompt: secondPrompt,
    })
    await expect(host.complete('supabase', firstPrompt.id, 'private-stale-response')).rejects.toThrow(CloudConnectionError)
    const returned = await host.complete('supabase', secondPrompt.id, callbackUrl)
    expect(JSON.stringify(returned)).not.toContain('fixture-code')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    await host.confirm('supabase', ['execute_sql'])
    const grant = await ctx.credentials.readRecord(KEY)
    expect((await host.cancel('supabase', second.attemptId)).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect(await ctx.credentials.readRecord(KEY)).toEqual(grant)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect(sdk.close).not.toHaveBeenCalled()
  })

  it('re-prompts for an unrelated callback and accepts a private manual callback without echoing it', async () => {
    const { ctx, host } = await fixture()
    await beginSignIn(host)
    const first = await pendingPrompt(host)
    const unrelated = new URL(callbackUrl)
    unrelated.searchParams.set('state', 'private-unrelated-state')
    const rejected = await host.complete('supabase', first.id, unrelated.href)
    expect(JSON.stringify(rejected)).not.toContain('private-unrelated-state')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.prompt?.id).not.toBe(first.id)
    const next = await pendingPrompt(host)
    const manual = new URL(callbackUrl)
    manual.searchParams.set('code', 'private-manual-authorization-code')
    const returned = await host.complete('supabase', next.id, `  ${manual.href}  `)
    expect(JSON.stringify(returned)).not.toContain('private-manual-authorization-code')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    expect(sdk.auth.mock.calls[1]![1].authorizationCode).toBe('private-manual-authorization-code')
    expect((await host.list()).find(view => view.provider === 'supabase')?.prompt).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('rejects empty and oversized private responses without consuming the prompt', async () => {
    const { host } = await fixture()
    const admitted = await beginSignIn(host)
    const prompt = await pendingPrompt(host)
    for (const response of ['', '😀'.repeat(16_385)]) {
      await expect(host.complete('supabase', prompt.id, response)).rejects.toThrow(CloudConnectionError)
      expect((await host.list()).find(view => view.provider === 'supabase')?.prompt).toEqual(prompt)
    }
    await host.cancel('supabase', admitted.attemptId)
  })

  it('preserves the verified OAuth issuer through the automatic callback exchange', async () => {
    const { host } = await fixture()
    await beginSignIn(host)
    const redirect = new URL(callbackUrl)
    redirect.searchParams.set('iss', 'https://identity.example.invalid')
    callbackUrl = redirect.href
    await callback()
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    expect(sdk.auth.mock.calls[1]![1]).toMatchObject({ authorizationCode: 'fixture-code', iss: 'https://identity.example.invalid' })
  })

  it('keeps provider denial details out of connection state after an HTTP callback', async () => {
    const { ctx, host } = await fixture()
    await beginSignIn(host)
    const redirect = new URL(callbackUrl)
    redirect.searchParams.set('error', 'access_denied')
    redirect.searchParams.set('error_description', 'private-provider-denial-body')
    callbackUrl = redirect.href
    await callback()
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('failed')
    expect((await host.list()).find(view => view.provider === 'supabase')?.errorCode).toBe('authorization-failed')
    expect(JSON.stringify(await host.list())).not.toContain('private-provider-denial-body')
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it.each(['initial', 'exchange'] as const)('refuses an incomplete OAuth %s result', async (phase) => {
    const { ctx, host } = await fixture()
    const authorize = sdk.auth.getMockImplementation()!
    sdk.auth.mockImplementation((provider, options) => {
      if (phase === 'initial') return Promise.resolve('AUTHORIZED')
      if (options.authorizationCode !== undefined) return Promise.resolve('REDIRECT')
      return authorize(provider, options)
    })
    if (phase === 'exchange') {
      await beginSignIn(host)
      await callback()
    } else await host.start('supabase', '')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('failed')
    expect((await host.list()).find(view => view.provider === 'supabase')?.errorCode).toBe('authorization-failed')
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('withdraws the manual prompt as soon as the automatic callback wins', async () => {
    const { host } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const authorize = sdk.auth.getMockImplementation()!
    sdk.auth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode !== undefined) {
        entered.resolve(undefined)
        await release.promise
      }
      return authorize(provider, options)
    })
    await beginSignIn(host)
    const prompt = await pendingPrompt(host)
    await callback()
    await entered.promise
    expect((await host.list()).find(view => view.provider === 'supabase')).toMatchObject({ status: 'authorizing' })
    expect((await host.list()).find(view => view.provider === 'supabase')?.prompt).toBeUndefined()
    await expect(host.complete('supabase', prompt.id, 'private-late-response')).rejects.toThrow(CloudConnectionError)
    release.resolve(undefined)
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
  })

  it('runs a registered authorization flow through the generic credential surface', async () => {
    const { ctx, host } = await fixture()
    const notice = vi.fn()
    await expect(ctx.authorization.begin({
      key: KEY,
      interaction: { notify: notice, prompt: async () => callbackUrl },
    })).resolves.toEqual({ status: 'authorized' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://login.example.invalid/authorize' }))
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))?.confirmed).toBe(false)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('uses configured AWS selectors when the generic credential surface starts its flow', async () => {
    const { ctx, host } = await fixture({ cloud: { awsProfile: 'engineering', awsMethod: 'existing' } })
    await expect(ctx.authorization.begin({
      key: cloudCredentialKey('aws'), interaction: { notify: vi.fn(), prompt: async () => 'unused' },
    })).resolves.toEqual({ status: 'authorized' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    expect(awsCli.authorize).toHaveBeenCalledWith(expect.objectContaining({ profile: 'engineering', method: 'existing', region: 'us-east-1' }))
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('reports a safe generic-flow failure and releases its attempt', async () => {
    const { ctx, host } = await fixture()
    awsCli.authorize.mockRejectedValueOnce(new CloudConnectionError('aws-login-failed'))
    await expect(ctx.authorization.begin({
      key: cloudCredentialKey('aws'), interaction: { notify: vi.fn(), prompt: async () => 'unused' },
    })).rejects.toThrow(CloudConnectionError)
    expect((await host.list()).find(view => view.provider === 'aws')).toMatchObject({ status: 'failed', errorCode: 'aws-login-failed' })
    expect((await host.list()).find(view => view.provider === 'aws')?.attemptId).toBeUndefined()
  })

  it('drains a generic AWS authorization when its admitted owner cancels it', async () => {
    const { ctx, host } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    awsCli.authorize.mockImplementationOnce(async (options) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      throw new CloudConnectionError('authorization-failed')
    })
    const begun = ctx.authorization.begin({
      key: cloudCredentialKey('aws'), interaction: { notify: vi.fn(), prompt: async () => 'unused' },
    })
    const refusal = expect(begun).rejects.toThrow(CloudConnectionError)
    await entered.promise
    const attemptId = (await host.list()).find(view => view.provider === 'aws')!.attemptId!
    await host.cancel('aws', attemptId)
    await refusal
    expect((await host.list()).find(view => view.provider === 'aws')).toMatchObject({ status: 'not-connected', tools: [], enabledTools: [] })
  })

  it('keeps generic caller cancellation distinct from a failed AWS login', async () => {
    const { ctx, host } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    awsCli.authorize.mockImplementationOnce(async (options) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      stopped.resolve(undefined)
      throw new CloudConnectionError('authorization-failed')
    })
    const begun = ctx.authorization.begin({
      key: cloudCredentialKey('aws'), signal: controller.signal,
      interaction: { notify: vi.fn(), prompt: async () => 'unused' },
    })
    await entered.promise
    controller.abort()
    await expect(begun).resolves.toEqual({ status: 'cancelled' })
    await stopped.promise
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.attemptId).toBeUndefined()
    expect((await host.list()).find(view => view.provider === 'aws')).toMatchObject({ status: 'not-connected', tools: [] })
  })

  it('drains a generic authorization when its registered cloud entry unloads', async () => {
    const { ctx, host, owner } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    awsCli.authorize.mockImplementationOnce(async (options) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      stopped.resolve(undefined)
      throw new CloudConnectionError('authorization-failed')
    })
    const begun = ctx.authorization.begin({
      key: cloudCredentialKey('aws'), interaction: { notify: vi.fn(), prompt: async () => 'unused' },
    })
    await entered.promise
    await owner.dispose()
    await stopped.promise
    await expect(begun).resolves.toEqual({ status: 'cancelled' })
    expect(ctx.authorization.list()).toEqual([])
    expect(sdk.connect).not.toHaveBeenCalled()
    await expect(host.list()).rejects.toThrow('plugin is stopping')
  })

  it('reduces an identity-provider exception to a fixed authorization category', async () => {
    const { ctx, host } = await fixture()
    sdk.auth.mockRejectedValueOnce(Object.assign(new Error('private-identity-provider-response'), {
      response: { body: 'private-identity-token', statusText: 'private-identity-status' },
    }))
    await host.start('supabase', '')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('failed')
    const state = (await host.list()).find(view => view.provider === 'supabase')!
    expect(state).toMatchObject({ errorCode: 'authorization-failed', tools: [], enabledTools: [] })
    expect(JSON.stringify(state)).not.toContain('private-')
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('starts disconnected and withdraws its flows when its entry unloads', async () => {
    const { ctx, host, owner } = await fixture()
    expect(await host.list()).toEqual([
      { provider: 'aws', status: 'not-connected', tools: [], enabledTools: [], awsProfile: 'dsh-cloud', awsMethod: 'login' },
      { provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [] },
    ])
    expect(sdk.auth).not.toHaveBeenCalled()
    expect(sdk.connect).not.toHaveBeenCalled()
    expect(ctx.authorization.list()).toHaveLength(2)
    await owner.dispose()
    expect(ctx.authorization.list()).toEqual([])
    await expect(host.start('supabase', '')).rejects.toThrow(/stopping/)
  })

  it('keeps a saved grant network-free until a consumer explicitly restores it', async () => {
    const first = await fixture()
    await signIn(first.host)
    await first.host.confirm('supabase', ['execute_sql'])
    await first.owner.dispose()
    sdk.auth.mockClear()
    sdk.connect.mockClear()
    sdk.listTools.mockClear()
    const { ctx, host } = await fixture({ credentialsPath: first.credentialsPath, cloud: { restoreOnStart: false } })
    await host.list()
    expect(sdk.auth).not.toHaveBeenCalled()
    expect(sdk.connect).not.toHaveBeenCalled()
    expect(sdk.listTools).not.toHaveBeenCalled()
    expect(awsCli.authorize).not.toHaveBeenCalled()
    expect(awsCli.refresh).not.toHaveBeenCalled()
    expect(ctx.tools.schemas()).toEqual([])
    expect((await host.restore('supabase')).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
  })

  it('reports an expired saved grant when an explicit restore cannot authenticate', async () => {
    const first = await fixture()
    await signIn(first.host)
    await first.owner.dispose()
    const { host } = await fixture({ credentialsPath: first.credentialsPath, cloud: { restoreOnStart: false } })
    sdk.connect.mockRejectedValueOnce(new CloudOAuthReconnectRequiredError())
    const returned = await host.restore('supabase')
    expect(returned.find(view => view.provider === 'supabase')).toMatchObject({ status: 'failed', errorCode: 'session-expired', tools: [] })
  })

  it.each(['login', 'sso', 'existing'] as const)('uses the selected AWS profile and %s method without exposing its MCP token', async (method) => {
    const { ctx, host } = await fixture()
    const admitted = await host.start('aws', 'eu-west-1', { awsProfile: 'engineering', awsMethod: method })
    expect(admitted.attemptId).toEqual(expect.any(String))
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    expect(awsCli.authorize).toHaveBeenCalledWith(expect.objectContaining({
      executable: 'aws', profile: 'engineering', method, region: 'eu-west-1', commandTimeoutMs: 20_000,
    }))
    const state = (await host.list()).find(view => view.provider === 'aws')!
    expect(state).toMatchObject({ awsProfile: 'engineering', awsMethod: method, enabledTools: [] })
    expect(JSON.stringify(state)).not.toContain('private-aws-mcp-token')
    expect(parseAwsCliGrant(await ctx.credentials.readRecord(cloudCredentialKey('aws')))).toMatchObject({
      provider: 'aws', authMethod: 'aws-cli', region: 'eu-west-1', profile: 'engineering', loginMethod: method, confirmed: false,
    })
    expect(sdk.auth).not.toHaveBeenCalled()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('projects only private AWS input and replacement consent, withdrawing each settled prompt', async () => {
    const { host } = await fixture()
    const responses: string[] = []
    awsCli.authorize.mockImplementationOnce(async (options) => {
      options.notify({ message: 'private provider text', url: 'https://us-east-1.signin.aws/v1/authorize', code: 'ABCD-EFGH' })
      responses.push(await options.prompt({ kind: 'secret', message: 'private provider prompt' }))
      responses.push(await options.prompt({ kind: 'select', message: 'private replacement prompt', options: [
        { id: 'yes', label: 'private yes' }, { id: 'no', label: 'private no' },
      ] }))
      return { accessToken: 'private-aws-mcp-token', expiresAt: Date.now() + 3_600_000 }
    })
    await host.start('aws', 'us-east-1')
    const secret = await pendingPrompt(host, 'aws')
    expect(secret).toEqual({ id: secret.id, kind: 'secret' })
    expect((await host.list()).find(view => view.provider === 'aws')).toMatchObject({
      authorizationUrl: 'https://us-east-1.signin.aws/v1/authorize', code: 'ABCD-EFGH',
    })
    const returned = await host.complete('aws', secret.id, 'private-aws-authorization-response')
    expect(JSON.stringify(returned)).not.toContain('private-')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.prompt?.kind).toBe('select')
    const replacement = await pendingPrompt(host, 'aws')
    expect(replacement).toEqual({ id: replacement.id, kind: 'select', purpose: 'replace-aws-login' })
    await expect(host.complete('aws', replacement.id, 'private-invalid-choice')).rejects.toThrow(CloudConnectionError)
    expect((await host.list()).find(view => view.provider === 'aws')?.prompt).toEqual(replacement)
    await host.complete('aws', replacement.id, 'yes')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    expect(responses).toEqual(['private-aws-authorization-response', 'yes'])
    expect((await host.list()).find(view => view.provider === 'aws')?.prompt).toBeUndefined()
    await expect(host.complete('aws', replacement.id, 'yes')).rejects.toThrow(CloudConnectionError)
  })

  it.each([
    { label: 'text', options: undefined },
    { label: 'option count', options: [{ id: 'yes', label: 'Private choice' }] },
    { label: 'missing yes', options: [{ id: 'other', label: 'Private choice' }, { id: 'no', label: 'Private choice' }] },
    { label: 'missing no', options: [{ id: 'yes', label: 'Private choice' }, { id: 'other', label: 'Private choice' }] },
  ])('rejects an unsupported authorization prompt without projecting its text: $label', async ({ options }) => {
    const { host } = await fixture()
    awsCli.authorize.mockImplementationOnce(async (request) => {
      await request.prompt(options === undefined
        ? { kind: 'text', message: 'private-unsupported-prompt' }
        : { kind: 'select', message: 'private-unsupported-prompt', options })
      return { accessToken: 'private-unused-token', expiresAt: Date.now() + 3_600_000 }
    })
    await host.start('aws', 'us-east-1')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('failed')
    const connection = (await host.list()).find(view => view.provider === 'aws')!
    expect(connection.errorCode).toBe('authorization-failed')
    expect(connection.prompt).toBeUndefined()
    expect(JSON.stringify(connection)).not.toContain('private-')
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('rejects overlapping private prompts and withdraws the first prompt before settling', async () => {
    const { host } = await fixture()
    awsCli.authorize.mockImplementationOnce(async (request) => {
      const controller = new AbortController()
      const first = request.prompt({ kind: 'secret', message: 'private-first-prompt', signal: controller.signal })
      try {
        await request.prompt({ kind: 'secret', message: 'private-overlapping-prompt' })
        return { accessToken: 'private-unused-token', expiresAt: Date.now() + 3_600_000 }
      } finally {
        controller.abort()
        await Promise.allSettled([first])
      }
    })
    await host.start('aws', 'us-east-1')
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('failed')
    const connection = (await host.list()).find(view => view.provider === 'aws')!
    expect(connection.errorCode).toBe('authorization-failed')
    expect(connection.prompt).toBeUndefined()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it.each(['aws-cli-required', 'aws-login-failed', 'aws-permission-required'] as const)(
    'publishes the safe AWS failure category %s', async (code) => {
      const { ctx, host } = await fixture()
      awsCli.authorize.mockRejectedValueOnce(new CloudConnectionError(code))
      await host.start('aws', 'us-east-1')
      await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('failed')
      expect((await host.list()).find(view => view.provider === 'aws')).toMatchObject({ errorCode: code, tools: [], enabledTools: [] })
      expect(await ctx.credentials.readRecord(cloudCredentialKey('aws'))).toBeUndefined()
      expect(sdk.connect).not.toHaveBeenCalled()
    },
  )

  it('keeps tools without descriptions usable and refuses tools that require unsupported MCP tasks', async () => {
    const { ctx, host } = await fixture()
    sdk.listTools.mockResolvedValueOnce({ tools: [
      { name: 'plain', inputSchema: { type: 'object' } },
      { name: 'task', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ] })
    await signIn(host)
    expect((await host.list()).find(view => view.provider === 'supabase')?.tools).toEqual([
      { name: 'plain', description: '' }, { name: 'task', description: '' },
    ])
    await host.confirm('supabase', ['plain', 'task'])
    const result = await executeSql(ctx, 'mcp__supabase__task')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('requires task-based execution')
    expect(sdk.callTool).not.toHaveBeenCalled()
    sdk.callTool.mockResolvedValueOnce({ content: [] })
    expect((await executeSql(ctx, 'mcp__supabase__plain')).isError).toBe(false)
  })

  it.each([{ selected: ['execute_sql', 'execute_sql'] }, { selected: ['other_tool'] }])('refuses an unavailable or duplicate tool selection: $selected', async ({ selected }) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await expect(host.confirm('supabase', selected)).rejects.toThrow('unknown or duplicate tool selection')
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))?.confirmed).toBe(false)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it.each(['same-login', 'replacement-login'] as const)('rolls back a partial permission registration without overwriting a %s grant', async (replacement) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    const original = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    const foreign = { ...original, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717' }
    const written = Promise.withResolvers<undefined>()
    if (replacement === 'replacement-login') {
      let replace = true
      ctx.on('credentials/record-updated', (key) => {
        if (key !== KEY || !replace) return
        replace = false
        void ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: foreign }))
          .then(() => { written.resolve(undefined) }, written.reject)
      })
    } else written.resolve(undefined)
    const remove = ctx.tools.register({
      name: 'mcp__supabase__apply_migration', description: 'Fixture tool occupying the MCP name', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
    })
    await expect(host.confirm('supabase', ['execute_sql', 'apply_migration'])).rejects.toThrow()
    await written.promise
    const persisted = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    expect(persisted).toMatchObject({ confirmed: false, allowedTools: [] })
    expect(persisted.grantId).toBe(replacement === 'replacement-login' ? foreign.grantId : original.grantId)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__supabase__apply_migration'])
    remove()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('fails a saved-grant restore that collides with an already registered tool', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await owner.dispose()
    const remove = ctx.tools.register({
      name: TOOL, description: 'Fixture tool occupying the MCP name', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
    })
    await ctx.loader.update('fixture:cloud', { disabled: false })
    await ctx.loader.await()
    expect((await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')).toMatchObject({
      status: 'failed', errorCode: 'connection-failed', tools: [],
    })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect(sdk.close).toHaveBeenCalledTimes(2)
    remove()
  })

  it('refuses a tool when consent is withdrawn during its durable credential check', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    let block = true
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      const record = await modify(key, mutate)
      if (key === KEY && block) {
        block = false
        entered.resolve(undefined)
        await release.promise
      }
      return record
    })
    const execution = executeSql(ctx)
    await entered.promise
    await host.confirm('supabase', [])
    release.resolve(undefined)
    expect((await execution).isError).toBe(true)
    expect(sdk.callTool).not.toHaveBeenCalled()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('withdraws confirmation in place without reconnecting the same login', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await ctx.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: { ...grant, confirmed: false, allowedTools: [] } })
    })
    await expect.poll(() => ctx.tools.schemas()).toEqual([])
    expect((await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(sdk.close).not.toHaveBeenCalled()
  })

  it('keeps restore from publishing a foreign AWS grant while disconnect still drains a login', async () => {
    const { ctx, host, credentialsPath } = await fixture()
    const key = cloudCredentialKey('aws')
    await host.start('aws', 'us-east-1', { awsMethod: 'existing' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    await host.confirm('aws', ['execute_sql'])
    const original = parseAwsCliGrant(await ctx.credentials.readRecord(key))!
    const peer = await sharedCredentials(credentialsPath)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const deleted = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    awsCli.authorize.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return { accessToken: 'private-cancelled-login-token', expiresAt: Date.now() + 3_600_000 }
    })
    const remove = ctx.credentials.deleteRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'deleteRecord').mockImplementation(async (recordKey) => {
      await remove(recordKey)
      deleted.resolve(undefined)
    })
    await host.start('aws', 'us-east-1', { awsMethod: 'existing' })
    await entered.promise
    const disconnected = host.disconnect('aws')
    await deleted.promise
    const replacement = { ...original, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717' }
    await peer.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: replacement }))
    await host.restore('aws')
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas()).toEqual([])
    release.resolve(undefined)
    await disconnected
    expect((await host.restore('aws')).find(view => view.provider === 'aws')?.status).toBe('connected')
    expect(sdk.connect).toHaveBeenCalledTimes(2)
    expect(parseAwsCliGrant(await ctx.credentials.readRecord(key))).toEqual(replacement)
  })

  it('stops saved-grant restoration when the reloaded cloud entry unloads during negotiation', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await owner.dispose()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    sdk.connect.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('private-cancelled-restore-output')
    })
    const reloading = ctx.loader.update('fixture:cloud', { disabled: false })
    await entered.promise
    const replacement = ctx.loader.resolve('fixture:cloud').fiber!
    const disposal = replacement.dispose()
    await expect.poll(() => sdk.close.mock.calls.length).toBe(2)
    release.resolve(undefined)
    await Promise.all([reloading, disposal])
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.authorization.list()).toEqual([])
  })

  it('reports a failed credential-update reconciliation without retaining old tools', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    sdk.connect.mockRejectedValueOnce(new Error('private-replacement-transport-response'))
    await ctx.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: { ...grant, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717' } })
    })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('failed')
    expect((await host.list()).find(view => view.provider === 'supabase')).toMatchObject({ errorCode: 'connection-failed', tools: [] })
    expect(ctx.tools.schemas()).toEqual([])
    expect(JSON.stringify(await host.list())).not.toContain('private-replacement-transport-response')
  })

  it('drains credential-driven MCP negotiation when its cloud entry unloads', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    sdk.connect.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('private-replacement-transport-response')
    })
    await ctx.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: { ...grant, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717' } })
    })
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await expect.poll(() => sdk.close.mock.calls.length).toBe(2)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await disposal
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.authorization.list()).toEqual([])
  })

  it('reports SDK shutdown failures after the cloud entry finishes disposing', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    const reported: unknown[] = []
    vi.spyOn(owner.ctx.logger, 'error').mockImplementation((error: unknown) => { reported.push(error) })
    sdk.close.mockRejectedValueOnce(new Error('private-provider-shutdown-output'))
    await owner.dispose()
    expect(reported.some(error => error instanceof AggregateError && error.message === 'Cloud connections: client cleanup failed')).toBe(true)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('publishes only confirmed tools, stores consent, and removes both on disconnect', async () => {
    const { ctx, host, credentialsPath } = await fixture()
    await signIn(host)
    expect(ctx.tools.schemas()).toEqual([])
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))?.confirmed).toBe(false)
    await host.confirm('supabase', ['execute_sql', 'apply_migration'])
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual([
      'mcp__supabase__apply_migration', TOOL,
    ])
    expect(await readFile(credentialsPath, 'utf8')).toContain('execute_sql')
    await host.disconnect('supabase')
    expect(ctx.tools.schemas()).toEqual([])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await readFile(credentialsPath, 'utf8')).not.toContain('refresh-before-rotation')
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it('disconnects AWS without closing another provider\'s MCP tools', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.start('aws', 'us-east-1', { awsMethod: 'existing' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    await host.confirm('aws', ['execute_sql'])
    await host.disconnect('aws')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect((await host.list()).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect((await host.list()).find(view => view.provider === 'aws')?.status).toBe('not-connected')
    expect(sdk.close).toHaveBeenCalledTimes(1)
    sdk.callTool.mockResolvedValueOnce({ content: [] })
    expect((await executeSql(ctx)).isError).toBe(false)
  })

  it('does not reconnect a rotated grant while disconnect waits for its queued reconciliation', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    let reads = 0
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      const record = await modify(key, mutate)
      if (key === KEY && ++reads === 2) {
        entered.resolve(undefined)
        await release.promise
      }
      return record
    })
    await ctx.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: { ...grant, tokens: { ...grant.tokens, access_token: 'private-rotation-before-disconnect' } } })
    })
    await entered.promise
    const disconnected = host.disconnect('supabase')
    release.resolve(undefined)
    await disconnected
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(sdk.close).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas()).toEqual([])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('withdraws registered tools on unload and restores only the confirmed subset on reload', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await owner.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.authorization.list()).toEqual([])
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))?.allowedTools).toEqual(['execute_sql'])
    expect(sdk.close).toHaveBeenCalledTimes(1)
    await ctx.loader.update('fixture:cloud', { disabled: false })
    await ctx.loader.await()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect((await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect(sdk.connect).toHaveBeenCalledTimes(2)
  })

  it('rediscovers pending consent after restart without exposing tools before confirmation', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await owner.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    await ctx.loader.update('fixture:cloud', { disabled: false })
    await ctx.loader.await()
    const connection = (await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')
    expect(connection).toMatchObject({
      status: 'choose-permissions', enabledTools: [],
      tools: discovered.tools.map(({ name, description }) => ({ name, description })),
    })
    expect(ctx.tools.schemas()).toEqual([])
    expect(sdk.connect).toHaveBeenCalledTimes(2)
    expect(sdk.auth).toHaveBeenCalledTimes(2)
    await ctx.cloudConnections.confirm('supabase', ['execute_sql'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
  })

  it('reports a pending-grant restore failure without exposing provider errors or tools', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await owner.dispose()
    sdk.connect.mockRejectedValueOnce(new Error('provider rejected fixture-sensitive-token'))
    await ctx.loader.update('fixture:cloud', { disabled: false })
    await ctx.loader.await()
    const connection = (await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')
    expect(connection).toMatchObject({ status: 'failed', tools: [], enabledTools: [] })
    expect(connection?.errorCode).toBe('connection-failed')
    expect(JSON.stringify(connection)).not.toContain('fixture-sensitive-token')
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('updates consent against the latest rotated token, not a stale credential snapshot', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const modify = vi.spyOn(LocalCredentialProvider.prototype, 'modifyRecord')
    const refresh = ctx.credentials.modifyRecord(KEY, async (record) => {
      const grant = parseCloudGrant('supabase', record)!
      entered.resolve(undefined)
      await release.promise
      return { kind: 'grant', payload: { ...grant, tokens: { ...grant.tokens, refresh_token: 'refresh-after-rotation' } } }
    })
    await entered.promise
    const confirmed = host.confirm('supabase', ['execute_sql'])
    await expect.poll(() => modify.mock.calls.length).toBe(2)
    release.resolve(undefined)
    await Promise.all([refresh, confirmed])
    const persisted = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    expect(persisted.tokens.refresh_token).toBe('refresh-after-rotation')
    expect(persisted.allowedTools).toEqual(['execute_sql'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
  })

  it('does not confirm a replacement grant belonging to another login', async () => {
    const { ctx, host, credentialsPath } = await fixture()
    await signIn(host)
    const original = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    const replacement = { ...original, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717', tokens: { access_token: 'other-account', token_type: 'Bearer' } }
    const peer = await sharedCredentials(credentialsPath)
    await peer.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: replacement }))
    await expect(host.confirm('supabase', ['execute_sql'])).rejects.toThrow(/connection changed/)
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))).toEqual(replacement)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it.each(['deleted', 'replaced', 'unconfirmed', 'permission-withdrawn'] as const)(
    'refuses a tool after another Host changed the durable grant: %s', async (change) => {
      const { ctx, host, credentialsPath } = await fixture()
      await signIn(host)
      await host.confirm('supabase', ['execute_sql'])
      const original = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
      const peer = await sharedCredentials(credentialsPath)
      if (change === 'deleted') await peer.credentials.deleteRecord(KEY)
      else await peer.credentials.modifyRecord(KEY, () => Promise.resolve({
        kind: 'grant', payload: {
          ...original,
          ...(change === 'replaced' ? { grantId: '770ba148-9066-4e58-ae44-9d79ee91a717' } : {}),
          ...(change === 'unconfirmed' ? { confirmed: false } : {}),
          ...(change === 'permission-withdrawn' ? { allowedTools: [] } : {}),
        },
      }))
      expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))).toEqual(original)
      sdk.callTool.mockResolvedValueOnce({ content: [] })
      const result = await executeSql(ctx)
      expect(result.isError).toBe(true)
      expect(sdk.callTool).not.toHaveBeenCalled()
      expect(ctx.tools.schemas()).toEqual([])
      expect(JSON.stringify(result)).not.toContain('access-before-refresh')
    },
  )

  it('keeps valid consent when another Host rotates tokens for the same login', async () => {
    const { ctx, host, credentialsPath } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    const peer = await sharedCredentials(credentialsPath)
    await peer.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: {
        ...grant, tokens: { ...grant.tokens, access_token: 'rotated-access-token' },
      } })
    })
    sdk.callTool.mockResolvedValueOnce({ content: [] })
    expect((await executeSql(ctx)).isError).toBe(false)
    await expect(transportToken()).resolves.toBe('rotated-access-token')
    expect(sdk.callTool).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect(sdk.connect).toHaveBeenCalledTimes(1)
    expect(sdk.close).not.toHaveBeenCalled()
  })

  it('reconciles added and removed consent, token rotation, and deletion across two watching Hosts', async () => {
    const first = await fixture({ watch: true })
    await signIn(first.host)
    await first.host.confirm('supabase', ['execute_sql'])
    const peer = await fixture({ credentialsPath: first.credentialsPath, watch: true })
    expect(sdk.connect).toHaveBeenCalledTimes(2)
    await peer.host.confirm('supabase', ['execute_sql', 'apply_migration'])
    await expect.poll(() => first.ctx.tools.schemas().map(tool => tool.name).sort())
      .toEqual(['mcp__supabase__apply_migration', TOOL])
    await peer.host.confirm('supabase', ['apply_migration'])
    await expect.poll(() => first.ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__supabase__apply_migration'])
    expect((await executeSql(first.ctx)).isError).toBe(true)
    expect(sdk.callTool).not.toHaveBeenCalled()
    await peer.host.confirm('supabase', ['execute_sql'])
    await expect.poll(() => first.ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    await peer.ctx.credentials.modifyRecord(KEY, (record) => {
      const grant = parseCloudGrant('supabase', record)!
      return Promise.resolve({ kind: 'grant', payload: { ...grant, tokens: { ...grant.tokens, access_token: 'private-peer-rotation' } } })
    })
    await expect.poll(async () => parseCloudGrant('supabase', await first.ctx.credentials.readRecord(KEY))?.tokens.access_token)
      .toBe('private-peer-rotation')
    await expect(transportToken()).resolves.toBe('private-peer-rotation')
    sdk.callTool.mockResolvedValueOnce({ content: [] })
    expect((await executeSql(first.ctx)).isError).toBe(false)
    expect(sdk.connect).toHaveBeenCalledTimes(2)
    expect(sdk.close).not.toHaveBeenCalled()
    await peer.host.disconnect('supabase')
    await expect.poll(async () => (await first.host.list()).find(view => view.provider === 'supabase')?.status).toBe('not-connected')
    await expect.poll(() => first.ctx.tools.schemas()).toEqual([])
    expect((await executeSql(first.ctx)).isError).toBe(true)
    expect(sdk.callTool).toHaveBeenCalledTimes(1)
    expect(await first.ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('withdraws a replaced login and waits for the other Host\'s new consent', async () => {
    const first = await fixture({ watch: true })
    await signIn(first.host)
    await first.host.confirm('supabase', ['execute_sql'])
    const original = parseCloudGrant('supabase', await first.ctx.credentials.readRecord(KEY))!
    const peer = await fixture({ credentialsPath: first.credentialsPath, watch: true })
    await signIn(peer.host)
    await expect.poll(async () => parseCloudGrant('supabase', await first.ctx.credentials.readRecord(KEY))?.grantId).not.toBe(original.grantId)
    await expect.poll(async () => (await first.host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
    await expect.poll(() => first.ctx.tools.schemas()).toEqual([])
    expect((await executeSql(first.ctx)).isError).toBe(true)
    expect(sdk.callTool).not.toHaveBeenCalled()
    await peer.host.confirm('supabase', ['apply_migration'])
    await expect.poll(() => first.ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__supabase__apply_migration'])
    expect((await first.host.list()).find(view => view.provider === 'supabase')?.enabledTools).toEqual(['apply_migration'])
  })

  it('reconciles a foreign grant committed while this Host is still discovering its own login', async () => {
    const { ctx, host, credentialsPath } = await fixture()
    const peer = await sharedCredentials(credentialsPath)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<typeof discovered>()
    onTestFinished(() => { release.resolve(discovered) })
    sdk.listTools.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    await beginSignIn(host)
    await callback()
    await entered.promise
    const original = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    const replacement = { ...original, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717', confirmed: true,
      allowedTools: ['apply_migration'], tokens: { access_token: 'private-foreign-login', token_type: 'Bearer' } }
    await peer.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: replacement }))
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(undefined))
    expect((await host.list()).find(view => view.provider === 'supabase')).toMatchObject({ status: 'authorizing', tools: [] })
    release.resolve(discovered)
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))).toEqual(replacement)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__supabase__apply_migration'])
    expect(sdk.connect).toHaveBeenCalledTimes(2)
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it.each(['revoked-grant', 'rejected-retry'] as const)('withdraws tools after a typed authentication failure: %s', async (failure) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    sdk.callTool.mockRejectedValueOnce(failure === 'revoked-grant' ? new CloudOAuthReconnectRequiredError() : new SdkHttpError(
      SdkErrorCode.ClientHttpAuthentication, 'provider echoed sensitive-token-fixture',
      { status: 401, statusText: 'sensitive-status-fixture' },
    ))
    const result = await executeSql(ctx)
    expect(result.isError).toBe(true)
    expect(ctx.tools.schemas()).toEqual([])
    expect(sdk.close).toHaveBeenCalledTimes(1)
    const connection = (await host.list()).find(view => view.provider === 'supabase')
    expect(connection).toMatchObject({ status: 'failed', tools: [] })
    expect(connection?.errorCode).toBe('session-expired')
    expect(JSON.stringify({ result, connection })).not.toContain('sensitive-')
  })

  it.each(['session-expired', 'aws-permission-required'] as const)('handles an AWS bearer refresh failure without losing its safe category: %s', async (code) => {
    const { ctx, host } = await fixture()
    awsCli.authorize.mockResolvedValueOnce({ accessToken: 'private-expired-aws-token', expiresAt: Date.now() + 10_000 })
    await host.start('aws', 'eu-west-1', { awsProfile: 'engineering', awsMethod: 'existing' })
    await expect.poll(async () => (await host.list()).find(view => view.provider === 'aws')?.status).toBe('choose-permissions')
    await host.confirm('aws', ['execute_sql'])
    await host.restore('aws')
    awsCli.refresh.mockRejectedValueOnce(code === 'session-expired'
      ? new Error('private-aws-cli-refresh-output') : new CloudConnectionError(code))
    sdk.callTool.mockImplementationOnce(async () => {
      await transportToken()
      return { content: [] }
    })
    const result = await executeSql(ctx, 'mcp__aws__execute_sql')
    expect(result.isError).toBe(true)
    expect(awsCli.refresh).toHaveBeenCalledWith(expect.objectContaining({ profile: 'engineering', region: 'eu-west-1' }))
    expect(JSON.stringify(result)).toContain(new CloudConnectionError(code).message)
    const connection = (await host.list()).find(view => view.provider === 'aws')
    if (code === 'session-expired') {
      expect(ctx.tools.schemas()).toEqual([])
      expect(sdk.close).toHaveBeenCalledTimes(1)
      expect(connection).toMatchObject({ status: 'failed', errorCode: 'session-expired', tools: [] })
    } else {
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__aws__execute_sql'])
      expect(sdk.close).not.toHaveBeenCalled()
      expect(connection?.status).toBe('connected')
    }
    expect(JSON.stringify({ result, connection })).not.toContain('private-')
  })

  it.each(['transport', 'client'] as const)('sanitizes %s shutdown errors after MCP authentication fails', async (failure) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    sdk.callTool.mockRejectedValueOnce(new CloudOAuthReconnectRequiredError())
    const close = failure === 'transport' ? sdk.transportClose : sdk.close
    close.mockRejectedValueOnce(new Error('private-provider-shutdown-body'))
    const result = await executeSql(ctx)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-provider-shutdown-body')
    expect(ctx.tools.schemas()).toEqual([])
    expect((await host.list()).find(view => view.provider === 'supabase')?.errorCode).toBe('session-expired')
  })

  it.each(['disconnect', 'reconnect'] as const)('reports a safe error when MCP shutdown fails during %s', async (action) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    await host.restore('supabase')
    sdk.close.mockRejectedValueOnce(new Error('private-provider-shutdown-body'))
    const result = action === 'disconnect' ? host.disconnect('supabase') : host.start('supabase', '')
    await expect(result).rejects.toThrow(CloudConnectionError)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('does not withdraw a replacement connection after an old call rejects authentication', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    sdk.callTool.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new CloudOAuthReconnectRequiredError()
    })
    const previousCall = executeSql(ctx)
    await entered.promise
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    release.resolve(undefined)
    expect((await previousCall).isError).toBe(true)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect((await host.list()).find(view => view.provider === 'supabase')?.status).toBe('connected')
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it.each(['error', 'http', 'aborted'] as const)('sanitizes a transient %s MCP request failure without revoking consent', async (failure) => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    const error = failure === 'error' ? new Error('private-provider-transport-body', { cause: 'private-provider-cause' })
      : failure === 'aborted' ? new DOMException('private-provider-transport-body', 'AbortError')
        : Object.assign(new Error('private-provider-transport-body'), {
          status: 503, response: { body: 'private-provider-response-body', headers: { authorization: 'private-bearer-token' } },
        })
    sdk.callTool.mockRejectedValueOnce(error)
    const result = await executeSql(ctx)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('The cloud service could not be reached')
    expect(JSON.stringify({ result, state: await host.list() })).not.toContain('private-')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
    expect(sdk.close).not.toHaveBeenCalled()
    expect((await host.list()).find(view => view.provider === 'supabase')?.status).toBe('connected')
  })

  it('drains a pending credential check on unload without sending its MCP call', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const modify = vi.spyOn(LocalCredentialProvider.prototype, 'modifyRecord')
    const blocked = ctx.credentials.modifyRecord(KEY, async () => {
      entered.resolve(undefined)
      await release.promise
      return undefined
    })
    await entered.promise
    const execution = executeSql(ctx)
    await expect.poll(() => modify.mock.calls.length).toBe(2)
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await expect.poll(() => sdk.close.mock.calls.length).toBe(1)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await Promise.all([blocked, execution, disposal])
    expect(sdk.callTool).not.toHaveBeenCalled()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('serializes a pending confirmation with disconnect without resurrecting tools or credentials', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const modify = vi.spyOn(LocalCredentialProvider.prototype, 'modifyRecord')
    const blocked = ctx.credentials.modifyRecord(KEY, async (record) => {
      entered.resolve(undefined)
      await release.promise
      return record
    })
    await entered.promise
    const confirmed = host.confirm('supabase', ['execute_sql'])
    const refusal = expect(confirmed).rejects.toThrow()
    await expect.poll(() => modify.mock.calls.length).toBe(2)
    const disconnected = host.disconnect('supabase')
    release.resolve(undefined)
    await Promise.all([blocked, refusal, disconnected])
    expect(ctx.tools.schemas()).toEqual([])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect((await host.list()).find(view => view.provider === 'supabase')?.status).toBe('not-connected')
  })

  it('waits for a negotiating client to settle and never publishes it after entry unload', async () => {
    const { ctx, host, owner } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<typeof discovered>()
    onTestFinished(() => { release.resolve(discovered) })
    sdk.listTools.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    await beginSignIn(host)
    await callback()
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await expect.poll(() => sdk.transportClose.mock.calls.length).toBe(1)
    expect(disposed).toBe(false)
    release.resolve(discovered)
    await disposal
    expect(sdk.close).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.authorization.list()).toEqual([])
    expect(parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))?.confirmed).toBe(false)
    await expect(host.confirm('supabase', ['execute_sql'])).rejects.toThrow(/stopping/)
  })

  it('awaits an admitted MCP tool call after requesting client shutdown', async () => {
    const { ctx, host, owner } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    sdk.callTool.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return { content: [] }
    })
    const execution = ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('cloud-lifecycle-call'), name: TOOL, arguments: '{}' }],
      signal: new AbortController().signal,
    })
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await expect.poll(() => sdk.close.mock.calls.length).toBe(1)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await Promise.all([execution, disposal])
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('cancels OAuth discovery and awaits its actual runner before unload completes', async () => {
    const { ctx, host, owner } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (input !== 'https://discovery.example.invalid/') return originalFetch(input, init)
      entered.resolve(undefined)
      init!.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await release.promise
      init!.signal!.throwIfAborted()
      throw new Error('fixture request must be cancelled')
    }))
    sdk.auth.mockImplementationOnce(async (_provider, options) => {
      await options.fetchFn!('https://discovery.example.invalid/')
      return 'REDIRECT'
    })
    const admitted = await host.start('supabase', '')
    expect(admitted.attemptId).toEqual(expect.any(String))
    expect(admitted.url).toBeUndefined()
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await disposal
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(sdk.connect).not.toHaveBeenCalled()
  })
})

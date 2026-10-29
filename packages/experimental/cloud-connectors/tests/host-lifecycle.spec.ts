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

const sdk = vi.hoisted(() => {
  const connect = vi.fn<() => Promise<void>>()
  const listTools = vi.fn<() => Promise<{ tools: Array<{ name: string; description: string; inputSchema: { type: 'object' } }> }>>()
  const close = vi.fn<() => Promise<void>>()
  const transportClose = vi.fn<() => Promise<void>>()
  const callTool = vi.fn()
  const auth = vi.fn<typeof import('@modelcontextprotocol/client').auth>()
  class Client {
    connect = connect
    listTools = listTools
    close = close
    callTool = callTool
  }
  class StreamableHTTPClientTransport {
    close = transportClose
  }
  return { connect, listTools, close, transportClose, callTool, auth, Client, StreamableHTTPClientTransport }
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
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-lifecycle-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${dir}/`).href
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const credentialsPath = join(dir, 'credentials.yml')
  await writeFile(join(dir, 'cordis.yml'), JSON.stringify([
    { id: 'credentials', name: 'cordis:credentials', config: { path: credentialsPath, watch: false } },
    { id: 'authorization', name: 'cordis:authorization' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'executor', name: 'cordis:executor' },
    { id: 'cloud', name: 'cordis:cloud' },
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

async function signIn(host: cloudPlugin.CloudConnections): Promise<void> {
  await expect(host.start('supabase', '')).resolves.toEqual({ url: 'https://login.example.invalid/authorize' })
  await callback()
  await expect.poll(async () => (await host.list()).find(view => view.provider === 'supabase')?.status).toBe('choose-permissions')
}

/** A second Host sharing the same file; the first Host has no file watcher. */
async function sharedCredentials(path: string): Promise<Context> {
  const peer = new Context()
  onTestFinished(async () => { await peer.fiber.dispose() })
  await peer.plugin(LocalCredentialProvider, { path, watch: false })
  return peer
}

/** Exercise the real tool executor, not the MCP mock directly. */
async function executeSql(ctx: Context) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('cloud-permission-call'), name: TOOL, arguments: '{}' }],
    signal: new AbortController().signal,
  })
  return batch.results[0]!.result
}

describe('cloud connections through the Loader', () => {
  it('starts disconnected and withdraws its flows when its entry unloads', async () => {
    const { ctx, host, owner } = await fixture()
    expect(await host.list()).toEqual([
      { provider: 'aws', status: 'not-connected', tools: [], enabledTools: [] },
      { provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [] },
    ])
    expect(sdk.auth).not.toHaveBeenCalled()
    expect(sdk.connect).not.toHaveBeenCalled()
    expect(ctx.authorization.list()).toHaveLength(2)
    await owner.dispose()
    expect(ctx.authorization.list()).toEqual([])
    await expect(host.start('supabase', '')).rejects.toThrow(/stopping/)
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
    expect(sdk.close).toHaveBeenCalledTimes(1)
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
    expect(connection?.error).toContain('Reconnect')
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
    const { ctx, host } = await fixture()
    await signIn(host)
    const original = parseCloudGrant('supabase', await ctx.credentials.readRecord(KEY))!
    const replacement = { ...original, grantId: '770ba148-9066-4e58-ae44-9d79ee91a717', tokens: { access_token: 'other-account', token_type: 'Bearer' } }
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: replacement }))
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
    expect(sdk.callTool).toHaveBeenCalledTimes(1)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL])
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
    expect(connection?.error).toContain('Reconnect')
    expect(JSON.stringify({ result, connection })).not.toContain('sensitive-')
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

  it('does not revoke consent for a transient MCP request failure', async () => {
    const { ctx, host } = await fixture()
    await signIn(host)
    await host.confirm('supabase', ['execute_sql'])
    sdk.callTool.mockRejectedValueOnce(new Error('temporary service outage'))
    expect((await executeSql(ctx)).isError).toBe(true)
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
    await host.start('supabase', '')
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
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
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
    const failure = expect(host.start('supabase', '')).rejects.toThrow(/sign-in failed/)
    await entered.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await Promise.all([disposal, failure])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(sdk.connect).not.toHaveBeenCalled()
  })
})

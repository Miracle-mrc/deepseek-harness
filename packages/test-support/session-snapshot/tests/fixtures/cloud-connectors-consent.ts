/** External OAuth/MCP fixtures and consent assertions for the shipped headless profile. */
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-experimental-cloud-connectors'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

const SQL = 'mcp__supabase__execute_sql'
const MIGRATION = 'mcp__supabase__apply_migration'
const PROJECT = 'snapshot-project'
const QUERY = 'select true as accepted'
const ISSUER = 'https://identity.cloud-snapshot.invalid'
const ENDPOINT = 'https://mcp.supabase.com/mcp'

interface RpcRequest {
  id?: string | number
  method: string
  params?: { protocolVersion?: string; name?: string; arguments?: unknown }
}

/** Whether a declaration belongs to either optional cloud provider. */
function cloudTool(name: string): boolean {
  return name.startsWith('mcp__aws__') || name.startsWith('mcp__supabase__')
}

/** Stream one fixed tool-call batch through the ordinary model adapter API. */
function* toolChunks(calls: Array<{ id: string; name: string; args: object }>): Generator<StreamChunk> {
  for (const [index, call] of calls.entries()) {
    const id = ToolCallId(call.id)
    const args = JSON.stringify(call.args)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Initial capture uses this deterministic model; ordinary replay uses the captured Session. */
class ConsentModel extends LlmAdapter {
  private request = 0

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    switch (++this.request) {
      case 1:
        yield* toolChunks([{ id: 'call_consent_instructions', name: 'read', args: { file_path: 'task.txt' } }])
        return
      case 2:
        yield* toolChunks([
          { id: 'call_selected_sql', name: SQL, args: { project_id: PROJECT, query: QUERY } },
          { id: 'call_unselected_migration', name: MIGRATION, args: { name: 'unselected', query: 'create table denied(id int)' } },
        ])
        return
      case 3:
        yield* toolChunks([{ id: 'call_revoked_sql', name: SQL, args: { project_id: PROJECT, query: QUERY } }])
        return
      case 4:
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'DONE' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      default:
        assert.fail('Cloud consent capture requested an unexpected model step')
    }
  }
}

/** Loader identity for the Session-owned cloud consent scenario. */
export const name = 'snapshot-cloud-connectors-consent'
/** Keep the shipped registry, credential store, authorization service, and cloud service real. */
export const inject = ['cloudConnections', 'credentials', 'authorization', 'tools', 'llm']

/** Initial capture selects the scripted model; recorded replay leaves its model adapter untouched. */
export interface Config {
  /** Capture the fixed model stream rather than replaying the committed Session. Defaults to false. */
  captureModel?: boolean
}

/**
 * Mock only external HTTP and model inference, then check consent through real service and tool calls.
 * @param ctx - Profile scope owning the fixtures and assertions.
 * @param config - Enables the deterministic model during initial keyless capture only.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const calls: string[] = []
  const oauth: string[] = []
  const outcomes: Array<{ callId: string; isError: boolean }> = []
  const originalFetch = globalThis.fetch
  ctx.effect(() => {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      request.signal.throwIfAborted()
      if (url.origin === new URL(ENDPOINT).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        oauth.push('resource-discovery')
        return Response.json({ resource: ENDPOINT, authorization_servers: [ISSUER] })
      }
      if (url.origin === ISSUER && url.pathname.startsWith('/.well-known/')) {
        oauth.push('issuer-discovery')
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`, response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.href === `${ISSUER}/register`) {
        oauth.push('client-registration')
        return Response.json({
          ...await request.json() as object,
          client_id: 'snapshot-client', client_secret: 'snapshot-client-secret',
        }, { status: 201 })
      }
      if (url.href === `${ISSUER}/token`) {
        oauth.push('code-exchange')
        assert.equal(new URLSearchParams(await request.text()).get('grant_type'), 'authorization_code')
        return Response.json({
          access_token: 'snapshot-access-token', refresh_token: 'snapshot-refresh-token', token_type: 'Bearer',
        })
      }
      assert.equal(url.href, ENDPOINT, 'Unexpected external request from the cloud consent fixture')
      assert.equal(request.headers.get('authorization'), 'Bearer snapshot-access-token')
      if (request.method === 'GET') return new Response(null, { status: 405 })
      assert.equal(request.method, 'POST')
      const rpc = await request.json() as RpcRequest
      const result = (value: object): Response => Response.json({ jsonrpc: '2.0', id: rpc.id, result: value })
      switch (rpc.method) {
        case 'server/discover':
          return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
        case 'initialize':
          return result({
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} }, serverInfo: { name: 'cloud-consent-fixture', version: '1.0.0' },
          })
        case 'notifications/initialized':
          return new Response(null, { status: 202 })
        case 'tools/list':
          return result({ tools: [
            {
              name: 'execute_sql', description: 'Run fixture SQL against the selected project.',
              inputSchema: {
                type: 'object', properties: { project_id: { type: 'string' }, query: { type: 'string' } },
                required: ['project_id', 'query'], additionalProperties: false,
              },
            },
            {
              name: 'apply_migration', description: 'Apply a fixture database migration.',
              inputSchema: {
                type: 'object', properties: { name: { type: 'string' }, query: { type: 'string' } },
                required: ['name', 'query'], additionalProperties: false,
              },
            },
          ] })
        case 'tools/call':
          assert.equal(rpc.params?.name, 'execute_sql', 'An unselected cloud tool reached MCP')
          assert.deepEqual(rpc.params.arguments, { project_id: PROJECT, query: QUERY })
          calls.push(rpc.params.name)
          return result({ content: [{ type: 'text', text: '[{"accepted":true}]' }], isError: false })
        default:
          assert.fail(`Unexpected fixture MCP method: ${rpc.method}`)
      }
    }
    return () => { globalThis.fetch = originalFetch }
  }, 'snapshot cloud OAuth and MCP HTTP')
  if (config.captureModel === true) ctx.llm.registerAdapter(['deepseek-official'], new ConsentModel())

  /** Wait for a projected authorization fact; the deadline only bounds a failed fixture. */
  const state = async (ready: (view: Awaited<ReturnType<typeof ctx.cloudConnections.list>>[number]) => boolean) => {
    const deadline = AbortSignal.timeout(5_000)
    while (true) {
      const view = (await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')
      assert(view !== undefined)
      if (ready(view)) return view
      assert.notEqual(view.status, 'failed', 'The fixture OAuth/MCP exchange failed')
      await setTimeout(1, undefined, { signal: deadline })
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    outcomes.push({ callId: exec.callId, isError: result.isError })
    if (exec.callId !== 'call_consent_instructions') return downstream
    assert.equal(result.isError, false)
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
    await ctx.cloudConnections.start('supabase', '')
    const awaitingBrowser = await state(view => view.authorizationUrl !== undefined && view.prompt !== undefined)
    assert(awaitingBrowser.authorizationUrl !== undefined && awaitingBrowser.prompt !== undefined)
    const authorization = new URL(awaitingBrowser.authorizationUrl)
    assert.equal(authorization.origin, ISSUER)
    const redirect = authorization.searchParams.get('redirect_uri')
    const callbackState = authorization.searchParams.get('state')
    assert(redirect !== null && callbackState !== null)
    const callback = new URL(redirect)
    callback.searchParams.set('state', callbackState)
    callback.searchParams.set('code', 'snapshot-code')
    await ctx.cloudConnections.complete('supabase', awaitingBrowser.prompt.id, callback.href)
    const pendingConsent = await state(view => view.status === 'choose-permissions')
    assert.deepEqual(pendingConsent.tools.map(tool => tool.name), ['execute_sql', 'apply_migration'])
    assert.deepEqual(pendingConsent.enabledTools, [])
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
    const replacement = await ctx.cloudConnections.start('supabase', '')
    await state(view => view.authorizationUrl !== undefined && view.prompt !== undefined)
    const cancelled = (await ctx.cloudConnections.cancel('supabase', replacement.attemptId))
      .find(view => view.provider === 'supabase')
    assert(cancelled !== undefined)
    assert.equal(cancelled.status, 'failed')
    assert.equal(cancelled.errorCode, 'connection-failed')
    assert.deepEqual(cancelled.tools, [])
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
    const restored = (await ctx.cloudConnections.restore('supabase')).find(view => view.provider === 'supabase')
    assert(restored !== undefined)
    assert.equal(restored.status, 'choose-permissions')
    assert.deepEqual(restored.enabledTools, [])
    assert.deepEqual(restored.tools.map(tool => tool.name), ['execute_sql', 'apply_migration'])
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
    const denied = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('before-consent'), name: SQL, arguments: '{}' }],
      signal: exec.signal,
    })
    assert.equal(denied.results[0]?.result.isError, true)
    assert.deepEqual(calls, [])
    await ctx.cloudConnections.confirm('supabase', ['execute_sql'])
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)).map(tool => tool.name), [SQL])
    return downstream
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.callId === 'call_revoked_sql') {
      assert(exec.toolSet !== undefined, 'Revocation must happen after step admission')
      assert(ctx.tools.get(SQL, exec.agent, exec.toolSet) !== undefined, 'The recorded call was never admitted')
      await ctx.cloudConnections.confirm('supabase', [])
      assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
    }
    return next()
  })

  let requests = 0
  ctx.on('llm/stream', (request, next) => {
    const expected = [[], [SQL], [SQL], []][requests++]
    assert(expected !== undefined, 'Unexpected request after cloud consent scenario completion')
    assert.deepEqual((request.tools ?? []).filter(tool => cloudTool(tool.name)).map(tool => tool.name), expected)
    if (requests === 1) assert.deepEqual(oauth, [], 'Cloud providers were contacted before sign-in')
    return next()
  })
  ctx.on('agent/turn-stopping', async () => {
    assert.equal(requests, 4)
    assert.deepEqual(calls, ['execute_sql'], 'Unselected or revoked tool reached the external MCP server')
    assert.deepEqual(outcomes, [
      { callId: 'call_consent_instructions', isError: false },
      { callId: 'before-consent', isError: true },
      { callId: 'call_selected_sql', isError: false },
      { callId: 'call_unselected_migration', isError: true },
      { callId: 'call_revoked_sql', isError: true },
    ])
    assert(oauth.includes('code-exchange'), 'The real authorization service did not finish its code exchange')
    assert((await ctx.credentials.readRecord(credentialKey('cloud-connectors', 'supabase')))?.kind === 'grant')
    const revoked = (await ctx.cloudConnections.list()).find(view => view.provider === 'supabase')
    assert.deepEqual(revoked?.enabledTools, [])
    assert.deepEqual(ctx.tools.schemas().filter(tool => cloudTool(tool.name)), [])
  })
}

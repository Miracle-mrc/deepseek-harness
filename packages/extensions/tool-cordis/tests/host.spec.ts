import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolBatchInput } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as CordisInspectProviders from '../src/host.ts'
import * as CordisInspectTools from '../src/index.ts'

/**
 * The Host inspect providers are one process-global set: the host entry
 * registers them beside the registry, and the per-session tool rows only read
 * them. Mounting several presets that carry `tool-cordis` over the shared
 * registry is covered by `apps/cli/tests/web-agent-presets.e2e.ts`.
 */

async function host(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  // The tool registry injects `systemPrompt`; nothing under test registers a prompt section.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(CordisInspectRegistryService, 10_000)
  return ctx
}

async function inspection() {
  const ctx = await host()
  const publication = vi.fn(() => { throw new Error('Inspection invoked a publication method') })
  ctx.provide('creatorFork', { repositories: publication, preview: publication, extendReview: publication, publish: publication })
  await ctx.plugin(CordisInspectProviders)
  await ctx.plugin(CordisInspectTools)
  // These providers use the Agent only as the tool registry's scope identity.
  const agent = { id: 'inspect-publication' as Agent['id'] } as Agent
  const call = async (name: string, args: Record<string, unknown>) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'inspect-call' as ToolBatchInput['calls'][number]['id'],
        name, arguments: JSON.stringify(args) }],
      agent, signal: new AbortController().signal,
    })
    const result = batch.results[0]
    if (result === undefined) throw new Error('The inspection executor omitted its result')
    return result.result
  }
  return { ctx, publication, call }
}

describe('the cordis-inspect-providers host entry', () => {
  it('registers the first-party Host providers and withdraws them on disposal', async () => {
    const ctx = await host()
    const fiber = ctx.plugin(CordisInspectProviders)
    await fiber

    expect(ctx.cordisInspect.list().map(provider => provider.id)).toEqual(['Service', 'Event', 'Config', 'Tool'])

    await fiber.dispose()
    expect(ctx.cordisInspect.list()).toEqual([])
  })

  it('describes Creator publication through the registered model tools without invoking it', async () => {
    const { ctx, publication, call } = await inspection()
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['cordis_inspect_list', 'cordis_inspect_query'])
    const listed = await call('cordis_inspect_list', {})
    expect(listed.isError).toBe(false)
    const listService: unknown = expect.objectContaining({ name: 'listService' })
    const providerMethods: unknown = expect.arrayContaining([listService])
    const service: unknown = expect.objectContaining({ id: 'Service', methods: providerMethods })
    const providers: unknown = expect.arrayContaining([service])
    expect(listed.value).toMatchObject({ providers })

    const described = await call('cordis_inspect_query', {
      platform: 'host', provider: 'Service', method: 'listService', input: { service: 'creatorFork' },
    })
    expect(described.isError).toBe(false)
    const methods: unknown = expect.arrayContaining(['repositories(', 'preview(', 'extendReview(', 'publish('].map((prefix): unknown => {
      const signature: unknown = expect.stringContaining(prefix)
      return expect.objectContaining({ signature })
    }))
    expect(described.value).toMatchObject({ data: { mode: 'service', service: { key: 'creatorFork', methods } } })
    expect(publication).not.toHaveBeenCalled()
  })

  it('keeps confirmation-shaped extra tool fields separate from the read-only provider query', async () => {
    const { publication, call } = await inspection()
    const result = await call('cordis_inspect_query', {
      platform: 'host', provider: 'Service', method: 'listService', input: { service: 'creatorFork' },
      action: 'publish', id: 'unreviewed-receipt', confirmed: true,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ data: { mode: 'service', service: { key: 'creatorFork' } } })
    expect(publication).not.toHaveBeenCalled()
  })

  it.each([
    { provider: 'creatorFork', method: 'publish' },
    { provider: 'Service', method: 'publish' },
  ])('refuses publication as an inspection route: $provider.$method', async ({ provider, method }) => {
    const { publication, call } = await inspection()
    const result = await call('cordis_inspect_query', {
      platform: 'host', provider, method, input: { id: 'unreviewed-receipt', confirmed: true },
    })
    expect(result.isError).toBe(true)
    expect(publication).not.toHaveBeenCalled()
  })

  it.each(['creatorFork/repositories', 'creatorFork/preview', 'creatorFork/publish', 'cordis_define', 'cordis_run'])(
    'does not expose %s as a model tool', async (name) => {
      const { publication, call } = await inspection()
      const result = await call(name, { id: 'unreviewed-receipt', confirmed: true })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('unknown tool')
      expect(publication).not.toHaveBeenCalled()
    },
  )
})

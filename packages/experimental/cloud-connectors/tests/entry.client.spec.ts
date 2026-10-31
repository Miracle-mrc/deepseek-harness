// @vitest-environment jsdom
/** The real client entry owns its cards, dictionaries, and generated Remote mount as one Loader entry. */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-experimental-cloud-connectors/remote'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as browser from '../src/client/index.ts'
import {
  CloudConnectionCard, type CloudConnectionActions, type CloudConnectionFace,
} from '../src/client/CloudConnectionCard.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import type { CloudAttemptId, CloudConnectionView, CloudPromptId } from '../src/types.ts'

const contribution = vi.hoisted(() => ({ package: '@deepseek-ai/dsh-experimental-cloud-connectors', descriptors: [] }))
vi.mock('@deepseek-ai/dsh-experimental-cloud-connectors/remote', () => ({ default: contribution }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const views: CloudConnectionView[] = [
  { provider: 'aws', status: 'not-connected', tools: [], enabledTools: [] },
  { provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [] },
]
const attemptId = brandString<CloudAttemptId>('entry-test-attempt')
const promptId = brandString<CloudPromptId>('entry-test-prompt')
const admission = { attemptId, url: 'https://identity.example/authorize' }
const scenarios = [
  { method: 'list', invoke: (actions: CloudConnectionActions) => actions.list(), args: [], result: views },
  { method: 'start', invoke: (actions: CloudConnectionActions) => actions.start('aws', 'eu-west-1', { awsProfile: 'engineering', awsMethod: 'sso' }),
    args: ['aws', 'eu-west-1', { awsProfile: 'engineering', awsMethod: 'sso' }], result: admission },
  { method: 'complete', invoke: (actions: CloudConnectionActions) => actions.complete('supabase', promptId, 'fixture-private-response'),
    args: ['supabase', promptId, 'fixture-private-response'], result: views },
  { method: 'cancel', invoke: (actions: CloudConnectionActions) => actions.cancel('aws', attemptId), args: ['aws', attemptId], result: views },
  { method: 'confirm', invoke: (actions: CloudConnectionActions) => actions.confirm('supabase', ['execute_sql']),
    args: ['supabase', ['execute_sql']], result: views },
  { method: 'disconnect', invoke: (actions: CloudConnectionActions) => actions.disconnect('supabase'), args: ['supabase'], result: views },
] as const

/** Validate the production slot's public injection face before exercising its action callbacks. */
function cloudFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & CloudConnectionFace {
  assert(value.provider === 'aws' || value.provider === 'supabase')
  assert(typeof value.actions === 'object' && value.actions !== null)
  for (const name of ['list', 'start', 'complete', 'cancel', 'confirm', 'disconnect']) {
    assert(name in value.actions && typeof Reflect.get(value.actions, name) === 'function')
  }
}

async function fixture(declareFirst = true) {
  const runtime = await SlotTestRuntime.create()
  const resources: { directory?: string; remoteMock?: RemoteMock } = {}
  onTestFinished(async () => {
    try { await runtime.dispose() }
    finally {
      try { resources.remoteMock?.assertNoUnmatched() }
      finally { if (resources.directory !== undefined) await rm(resources.directory, { recursive: true, force: true }) }
    }
  })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-client-entry-'))
  resources.directory = dir
  const ctx = runtime.ctx
  ctx.baseUrl = pathToFileURL(`${dir}/`).href
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const mock = RemoteMock.create()
  resources.remoteMock = mock
  for (const scenario of scenarios) mock.unary(`cloudConnections/${scenario.method}`, () => ok(scenario.result))
  runtime.remote.provideNamespaces({ cloudConnections: mock.remote.cloudConnections })
  const unmount = vi.fn(async () => {
    expect(runtime.slots.entries('plugins.item')).toEqual([])
  })
  const mount = vi.spyOn(runtime.remote, '$mount').mockResolvedValue(unmount)
  await writeFile(join(dir, 'cordis.yml'), JSON.stringify([{ id: 'cloud', name: 'cordis:cloud' }]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, cloud: browser })
  const declare = () => runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
  if (declareFirst) await declare()
  const start = async () => {
    await ctx.loader.root.update([{ id: 'fixture', name: 'cordis:include', config: { path: './cordis.yml' } }])
    await ctx.loader.await()
    const fiber = ctx.loader.resolve('fixture:cloud').fiber
    assert(fiber !== undefined)
    await fiber.await()
    return fiber
  }
  const face = (provider: 'aws' | 'supabase') => {
    const entry = runtime.slots.entries('plugins.item').find(value => value.options.id === `cloud-${provider}`)
    assert(entry !== undefined && typeof entry.inject === 'function')
    const value = entry.inject()
    cloudFace(value)
    return value
  }
  return { runtime, locale, mock, mount, unmount, declare, start, face }
}

describe('cloud client entry composition', () => {
  it('loads both cards and dictionaries through the Loader without connecting either provider', async () => {
    const f = await fixture()
    const fiber = await f.start()
    expect(browser.inject).toEqual(['remote', 'slots', 'locale'])
    expect(f.mount).toHaveBeenCalledExactlyOnceWith(contribution)
    expect(f.runtime.slots.entries('plugins.item').map(entry => ({
      id: entry.options.id, order: entry.options.order, label: resolveSlotLabel(entry.options.label), component: entry.component,
    }))).toEqual([
      { id: 'cloud-aws', order: 60, label: en.awsTitle, component: CloudConnectionCard },
      { id: 'cloud-supabase', order: 61, label: en.supabaseTitle, component: CloudConnectionCard },
    ])
    expect(f.face('aws').provider).toBe('aws')
    expect(f.face('supabase').provider).toBe('supabase')
    expect(f.locale.bind(NS)('connect')).toBe(en.connect)
    f.locale.setLocale('zh')
    expect(f.locale.bind(NS)('connect')).toBe(zh.connect)
    for (const scenario of scenarios) expect(f.mock.remote.cloudConnections[scenario.method]).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(f.unmount).toHaveBeenCalledOnce()
    expect(f.runtime.slots.entries('plugins.item')).toEqual([])
    const unregister = f.locale.register(NS, 'en', en)
    unregister()
  })

  it('waits for the Remote mount and a later slot declaration before publishing cards', async () => {
    const f = await fixture(false)
    const mounted = Promise.withResolvers<() => Promise<void>>()
    f.mount.mockReturnValueOnce(mounted.promise)
    const starting = f.start()
    await vi.waitFor(() => { expect(f.mount).toHaveBeenCalledOnce() })
    expect(f.runtime.slots.entries('plugins.item')).toEqual([])
    mounted.resolve(f.unmount)
    const fiber = await starting
    expect(f.runtime.slots.entries('plugins.item')).toEqual([])
    await f.declare()
    expect(f.runtime.slots.entries('plugins.item').map(entry => entry.options.id)).toEqual(['cloud-aws', 'cloud-supabase'])
    await fiber.dispose()
    expect(f.unmount).toHaveBeenCalledOnce()
  })

  it.each(scenarios)('forwards $method through the mounted Remote and unwraps success', async (scenario) => {
    const f = await fixture()
    await f.start()
    await expect(scenario.invoke(f.face('aws').actions)).resolves.toEqual(scenario.result)
    expect(f.mock.remote.cloudConnections[scenario.method].mock.calls).toEqual([scenario.args])
  })

  it.each(scenarios)('rejects the $method Remote failure without returning its envelope', async (scenario) => {
    const f = await fixture()
    const failure = new RemoteError('gateway/internal', 'The cloud operation was refused.', {})
    f.mock.unary(`cloudConnections/${scenario.method}`, () => ({ ok: false, error: failure }))
    await f.start()
    await expect(scenario.invoke(f.face('supabase').actions)).rejects.toThrow(failure.message)
  })

  it('keeps a mount failure free of card and locale registrations', async () => {
    const f = await fixture()
    const failure = new Error('Remote mount failed')
    f.mount.mockRejectedValueOnce(failure)
    await expect(f.start()).rejects.toBe(failure)
    expect(f.runtime.slots.entries('plugins.item')).toEqual([])
    expect(f.unmount).not.toHaveBeenCalled()
  })

  it('withdraws partial initialization before unmounting the Remote when locale registration fails', async () => {
    const f = await fixture()
    const failure = new Error('Locale registration failed')
    vi.spyOn(f.locale, 'register').mockImplementationOnce(() => { throw failure })
    await expect(f.start()).rejects.toBe(failure)
    expect(f.runtime.slots.entries('plugins.item')).toEqual([])
    expect(f.unmount).toHaveBeenCalledOnce()
  })
})

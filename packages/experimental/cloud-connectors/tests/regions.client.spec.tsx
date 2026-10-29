/** @vitest-environment jsdom */
/** AWS region selection uses the same supported endpoints as the Host. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '../src/client/index.ts'
import { AWS_MCP_REGIONS, cloudMcpUrl } from '../src/catalog.ts'
import { CloudConnectionCard, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import { en, zh, NS } from '../src/client/locales.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
    cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

function makeActions(): CloudConnectionActions {
  return {
    list: async () => [{ provider: 'aws', status: 'not-connected', tools: [], enabledTools: [] }],
    start: vi.fn(async () => ({ url: 'https://provider.example.test/authorize' })),
    confirm: vi.fn(async () => []),
    disconnect: async () => [],
  }
}

async function renderRegions(actions: CloudConnectionActions, language: 'en' | 'zh' = 'en') {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }), 'cloud region test locale')
  locale.setLocale(language)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({
      name: 'plugins.item', id: 'cloud-aws', locale: NS, inject: () => ({ provider: 'aws' as const, actions }),
    }, CloudConnectionCard)
  } })
  runtime.renderSlot('plugins.item', { view: 'page' })
  await runtime.flush()
}

describe('AWS managed MCP region selection', () => {
  it.each([
    { locale: 'English', language: 'en', dictionary: en, london: 'Europe (London)' },
    { locale: 'Chinese', language: 'zh', dictionary: zh, london: '欧洲（伦敦）' },
  ] as const)('renders all eight Host regions using $locale labels', async ({ language, dictionary, london }) => {
    const actions = makeActions()
    await renderRegions(actions, language)

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(8)
    expect(options.map(option => option.getAttribute('value'))).toEqual(AWS_MCP_REGIONS)
    expect(screen.getByRole('combobox', { name: dictionary.awsRegion })).toHaveProperty('value', 'us-east-1')
    for (const region of AWS_MCP_REGIONS) {
      const option = screen.getByRole('option', { name: dictionary[`region.${region}`] })
      expect(option.getAttribute('value')).toBe(region)
      expect(cloudMcpUrl('aws', region)).toBe(`https://aws-mcp.${region}.api.aws/mcp`)
    }
    expect(screen.getByRole('option', { name: london }).getAttribute('value')).toBe('eu-west-2')
    expect(actions.start).not.toHaveBeenCalled()
    expect(actions.confirm).not.toHaveBeenCalled()
  })

  it('passes London to the Host only after the user presses Connect', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const actions = makeActions()
    await renderRegions(actions)

    fireEvent.change(screen.getByRole('combobox', { name: en.awsRegion }), { target: { value: 'eu-west-2' } })
    expect(actions.start).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.connect })) })

    expect(actions.start).toHaveBeenCalledExactlyOnceWith('aws', 'eu-west-2')
    expect(actions.confirm).not.toHaveBeenCalled()
  })
})

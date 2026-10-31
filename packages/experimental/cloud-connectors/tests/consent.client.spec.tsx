/** @vitest-environment jsdom */
/** The approval UI defaults every discovered tool on but never auto-confirms. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '../src/client/index.ts'
import { CloudConnectionCard, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import type { CloudProvider } from '../src/catalog.ts'
import type { CloudAttemptId, CloudConnectionView } from '../src/types.ts'
import { en, zh, NS } from '../src/client/locales.ts'

const runtimes: SlotTestRuntime[] = []
const attemptId = 'fixture-attempt' as CloudAttemptId

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

async function renderCard(provider: CloudProvider, actions: CloudConnectionActions) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }), 'cloud consent test locale')
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({
      name: 'plugins.item', id: `cloud-${provider}`, locale: NS, inject: () => ({ provider, actions }),
    }, CloudConnectionCard)
  } })
  runtime.renderSlot('plugins.item', { view: 'page' })
  await runtime.flush()
}

async function renderConsent(provider: CloudProvider, tools: CloudConnectionView['tools']) {
  const confirm = vi.fn(async () => [])
  const actions: CloudConnectionActions = {
    list: async () => [{ provider, status: 'choose-permissions', enabledTools: [], tools }],
    start: async () => ({ attemptId, url: 'https://example.test/login' }),
    complete: async () => [],
    cancel: async () => [],
    confirm,
    disconnect: async () => [],
  }
  await renderCard(provider, actions)
  return confirm
}

describe('Supabase tool approval screen', () => {
  it('preselects Database read/write tools and allows unchecking before a deliberate confirm', async () => {
    const confirm = await renderConsent('supabase', [
      { name: 'list_tables', description: 'Inspect schema' },
      { name: 'execute_sql', description: 'Query database' },
      { name: 'apply_migration', description: 'Change schema' },
    ])
    expect(screen.getByRole('checkbox', { name: en.databaseGroup })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /list_tables/ })).toHaveProperty('checked', true)
    expect(screen.getByText(en.supabaseToolsHint)).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /apply_migration/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enableSelected })) })
    expect(confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['list_tables', 'execute_sql'])
  })
})

describe('AWS tool approval screen', () => {
  const tools = [
    { name: 'aws___run_script', description: 'Run AWS APIs' },
    { name: 'aws___call_aws', description: 'Call AWS APIs' },
    { name: 'list_iam_roles', description: 'List IAM roles' },
    { name: 'search_documentation', description: 'Search documentation' },
  ]

  it.each([
    { choice: 'the AWS API group', checkbox: en.iamGroup, expected: ['search_documentation'] },
    { choice: 'the individual script tool', checkbox: /aws___run_script/, expected: ['aws___call_aws', 'list_iam_roles', 'search_documentation'] },
  ])('warns about broad IAM access and preserves deselecting $choice before confirmation', async ({ checkbox, expected }) => {
    const confirm = await renderConsent('aws', tools)
    const group = screen.getByRole('checkbox', { name: 'AWS API access, including IAM' })
    expect(group).toHaveProperty('checked', true)
    for (const tool of tools) {
      expect(screen.getByRole('checkbox', { name: new RegExp(tool.name) })).toHaveProperty('checked', true)
    }
    expect(screen.getByText(en.awsToolsHint)).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: checkbox }))
    // Refreshing the same offered tools must not overwrite the user's selection.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(group).toHaveProperty('checked', false)
    for (const tool of tools) {
      expect(screen.getByRole('checkbox', { name: new RegExp(tool.name) })).toHaveProperty('checked', expected.includes(tool.name))
    }
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enableSelected })) })
    expect(confirm).toHaveBeenCalledExactlyOnceWith('aws', expected)
  })
})

const databaseTools = [
  { name: 'execute_sql', description: 'Query database' },
  { name: 'apply_migration', description: 'Change schema' },
]

function connectionSnapshot(status: CloudConnectionView['status']): CloudConnectionView[] {
  return [{
    provider: 'supabase', status,
    tools: status === 'choose-permissions' || status === 'connected' ? databaseTools : [],
    enabledTools: status === 'connected' ? ['execute_sql'] : [],
  }]
}

async function renderDeferredCard() {
  const reads: Array<PromiseWithResolvers<CloudConnectionView[]>> = []
  const confirmation = Promise.withResolvers<CloudConnectionView[]>()
  const disconnection = Promise.withResolvers<CloudConnectionView[]>()
  const actions: CloudConnectionActions = {
    list: vi.fn(() => {
      const read = Promise.withResolvers<CloudConnectionView[]>()
      reads.push(read)
      return read.promise
    }),
    start: async () => ({ attemptId, url: 'https://provider.example.test/authorize' }),
    complete: async () => [],
    cancel: async () => [],
    confirm: vi.fn(() => confirmation.promise),
    disconnect: vi.fn(() => disconnection.promise),
  }
  await renderCard('supabase', actions)
  return { reads, confirmation, disconnection, actions }
}

describe('cloud consent observation ordering', () => {
  it('lets a connected account change its tool selection without signing in again', async () => {
    let current = connectionSnapshot('connected')
    const actions: CloudConnectionActions = {
      list: async () => current,
      start: vi.fn(async () => ({ attemptId })),
      complete: vi.fn(async () => []),
      cancel: vi.fn(async () => []),
      confirm: vi.fn<CloudConnectionActions['confirm']>(async (_provider, selected) => {
        current = [{ ...current[0]!, enabledTools: selected }]
        return current
      }),
      disconnect: async () => [],
    }
    await renderCard('supabase', actions)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.editPermissions }))
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('checkbox', { name: /execute_sql/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /apply_migration/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.savePermissions })) })

    expect(actions.confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['apply_migration'])
    expect(actions.start).not.toHaveBeenCalled()
    expect(actions.complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(en['status.connected'])).toBeTruthy()
  })

  it('keeps unchecked tools when discovery adds another tool', async () => {
    let current = connectionSnapshot('choose-permissions')
    const actions: CloudConnectionActions = {
      list: async () => current,
      start: async () => ({ attemptId }), complete: async () => [], cancel: async () => [],
      confirm: vi.fn(async () => []), disconnect: async () => [],
    }
    await renderCard('supabase', actions)
    fireEvent.click(screen.getByRole('checkbox', { name: /execute_sql/ }))
    current = [{ ...current[0]!, tools: [...databaseTools, { name: 'list_tables', description: 'Inspect schema' }] }]
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: /list_tables/ })).toHaveProperty('checked', true)
    expect(actions.confirm).not.toHaveBeenCalled()
  })

  it('publishes a settled read while a newer status request is still pending', async () => {
    const { reads } = await renderDeferredCard()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await act(async () => { reads[0]!.resolve(connectionSnapshot('choose-permissions')) })
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
    await act(async () => { reads[1]!.resolve(connectionSnapshot('choose-permissions')) })
  })

  it('keeps an unchecked tool when an older authorizing response arrives after discovery', async () => {
    const { reads, actions } = await renderDeferredCard()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await act(async () => { reads[1]!.resolve(connectionSnapshot('choose-permissions')) })
    fireEvent.click(screen.getByRole('checkbox', { name: /execute_sql/ }))
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', false)

    await act(async () => { reads[0]!.resolve(connectionSnapshot('authorizing')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await act(async () => { reads[2]!.resolve(connectionSnapshot('choose-permissions')) })

    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', true)
    expect(actions.confirm).not.toHaveBeenCalled()
  })

  it.each(['stale-status', 'stale-error'] as const)('does not replace confirmed consent with a %s read', async (outcome) => {
    const { reads, actions, confirmation } = await renderDeferredCard()
    await act(async () => { reads[0]!.resolve(connectionSnapshot('choose-permissions')) })
    fireEvent.click(screen.getByRole('checkbox', { name: /apply_migration/ }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    fireEvent.click(screen.getByRole('button', { name: en.enableSelected }))
    expect(actions.confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['execute_sql'])
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(actions.list).toHaveBeenCalledTimes(2)
    await act(async () => { confirmation.resolve(connectionSnapshot('connected')) })
    expect(screen.getByText(en['status.connected'])).toBeTruthy()
    await act(async () => {
      if (outcome === 'stale-status') reads[1]!.resolve(connectionSnapshot('choose-permissions'))
      else reads[1]!.reject(new Error('old request failed'))
    })

    expect(screen.getByText(en['status.connected'])).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not replace a successful disconnect with an earlier connected snapshot', async () => {
    const { reads, actions, disconnection } = await renderDeferredCard()
    await act(async () => { reads[0]!.resolve(connectionSnapshot('connected')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
    expect(actions.disconnect).toHaveBeenCalledExactlyOnceWith('supabase')
    await act(async () => { disconnection.resolve(connectionSnapshot('not-connected')) })
    await act(async () => { reads[1]!.resolve(connectionSnapshot('connected')) })

    expect(screen.getByText(en['status.not-connected'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en.connect })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.disconnect })).toBeNull()
  })

  it('defaults every tool on for a fast reconnect with the identical discovered names', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    let current = connectionSnapshot('choose-permissions')
    const actions: CloudConnectionActions = {
      list: async () => current,
      start: async () => {
        // OAuth and discovery finish before the next status poll.
        current = connectionSnapshot('choose-permissions')
        return { attemptId, url: 'https://provider.example.test/authorize' }
      },
      complete: async () => [],
      cancel: async () => [],
      confirm: vi.fn(async () => []),
      disconnect: async () => {
        current = connectionSnapshot('not-connected')
        return current
      },
    }
    await renderCard('supabase', actions)
    fireEvent.click(screen.getByRole('checkbox', { name: /apply_migration/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.disconnect })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.connect })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', true)
    expect(actions.confirm).not.toHaveBeenCalled()
  })
})

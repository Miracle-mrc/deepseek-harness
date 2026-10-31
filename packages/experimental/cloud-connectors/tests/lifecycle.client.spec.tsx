/** @vitest-environment jsdom */
/** Navigation failures and late replies never outlive their cloud connection controls. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '../src/client/index.ts'
import type { CloudProvider } from '../src/catalog.ts'
import type { CloudAttemptId, CloudConnectionView, CloudPromptId } from '../src/types.ts'
import { CloudConnectionCard, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

const attemptId = 'lifecycle-attempt' as CloudAttemptId
const promptId = 'lifecycle-prompt' as CloudPromptId
const authorizationUrl = 'https://provider.example.test/authorize'
const runtimes = new Set<SlotTestRuntime>()

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  const errors: unknown[] = []
  try {
    const outcomes = await Promise.allSettled([...runtimes].map(async runtime => runtime.dispose()))
    runtimes.clear()
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason)
    try { cleanup() } catch (error) { errors.push(error) }
    try { expect(vi.getTimerCount()).toBe(0) } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'Cloud lifecycle test cleanup failed')
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function state(status: CloudConnectionView['status'], extra: Partial<CloudConnectionView> = {}): CloudConnectionView {
  return { provider: 'supabase', status, tools: [], enabledTools: [], ...extra }
}

function actionsFor(initial: CloudConnectionView[] = [state('not-connected')]) {
  let current = initial
  const actions = {
    list: vi.fn<CloudConnectionActions['list']>(async () => current),
    start: vi.fn<CloudConnectionActions['start']>(async () => ({ attemptId, url: authorizationUrl })),
    complete: vi.fn<CloudConnectionActions['complete']>(async () => current),
    cancel: vi.fn<CloudConnectionActions['cancel']>(async () => [state('not-connected')]),
    confirm: vi.fn<CloudConnectionActions['confirm']>(async () => current),
    disconnect: vi.fn<CloudConnectionActions['disconnect']>(async () => [state('not-connected')]),
  }
  return { actions, setViews(views: CloudConnectionView[]) { current = views } }
}

async function mountCard(actions: CloudConnectionActions, provider: CloudProvider = 'supabase', view: 'page' | 'summary' = 'page') {
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.effect(() => locale.register(NS, { en, zh }), 'cloud lifecycle test locale')
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({
      name: 'plugins.item', id: `lifecycle-${provider}`, locale: NS, inject: () => ({ provider, actions }),
    }, CloudConnectionCard)
  } })
  runtime.renderSlot('plugins.item', { view })
  await runtime.flush()
  return { async dispose() {
    try { await act(async () => { await runtime.dispose() }) }
    finally { runtimes.delete(runtime) }
  } }
}

async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
}

function popup() {
  const replace = vi.fn<Location['replace']>()
  const tab: Pick<Window, 'closed' | 'opener' | 'close'> & { location: Pick<Location, 'replace'> } = {
    closed: false, opener: window, location: { replace }, close: vi.fn<Window['close']>(),
  }
  return { tab, replace }
}

describe('cloud card lifecycle', () => {
  it.each(['aws', 'supabase'] as const)('shows the %s summary without starting a connection when no view is returned', async (provider) => {
    const { actions } = actionsFor([])
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await mountCard(actions, provider, 'summary')
    expect(screen.getByText(provider === 'aws' ? en.awsSummary : en.supabaseSummary)).toBeTruthy()
    expect(actions.start).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['reserved-window', 'external-browser'] as const)('retains the manual destination when %s navigation is denied', async (target) => {
    const { tab, replace } = popup()
    const { actions } = actionsFor()
    const open = vi.spyOn(window, 'open')
    if (target === 'reserved-window') {
      replace.mockImplementation(() => { throw new Error('private browser detail') })
      open.mockReturnValue(tab as Window)
    } else {
      open.mockReturnValueOnce(null).mockImplementation(() => { throw new Error('private browser detail') })
    }
    await mountCard(actions)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.connect })) })
    expect(screen.getByRole('alert').textContent).toBe(en.connectError)
    expect(screen.getByRole('link', { name: en.openBrowser }).getAttribute('href')).toBe(authorizationUrl)
    expect(actions.confirm).not.toHaveBeenCalled()
    if (target === 'reserved-window') expect(tab.close).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('closes a pending popup and ignores admission %s after unmount', async (outcome) => {
    const { tab } = popup()
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as Window)
    const admission = Promise.withResolvers<Awaited<ReturnType<CloudConnectionActions['start']>>>()
    const { actions } = actionsFor()
    actions.start.mockReturnValue(admission.promise)
    const card = await mountCard(actions)
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await card.dispose()
    expect(tab.close).toHaveBeenCalledOnce()
    await act(async () => {
      if (outcome === 'resolve') admission.resolve({ attemptId, url: authorizationUrl })
      else admission.reject(new Error('private late admission failure'))
    })
    expect(tab.location.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores a status %s after the card is unmounted', async (outcome) => {
    const read = Promise.withResolvers<CloudConnectionView[]>()
    const { actions } = actionsFor()
    actions.list.mockReturnValue(read.promise)
    const card = await mountCard(actions)
    await card.dispose()
    await act(async () => {
      if (outcome === 'resolve') read.resolve([state('connected')])
      else read.reject(new Error('private late status failure'))
    })
    expect(screen.queryByText(en['status.connected'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['confirm', 'disconnect', 'complete', 'cancel'] as const)('contains a late %s settlement after unmount', async (operation) => {
    const reply = Promise.withResolvers<CloudConnectionView[]>()
    const initial = operation === 'complete' || operation === 'cancel'
      ? state('authorizing', { attemptId, prompt: { id: promptId, kind: 'secret' } })
      : state('choose-permissions')
    const { actions } = actionsFor([initial])
    actions[operation].mockReturnValue(reply.promise)
    const card = await mountCard(actions)
    if (operation === 'complete') fireEvent.change(screen.getByLabelText(en.supabaseResponse), { target: { value: 'private-response' } })
    const button = operation === 'confirm' ? en.enableSelected : operation === 'disconnect' ? en.disconnect
      : operation === 'complete' ? en.submitResponse : en.cancelAuthorization
    fireEvent.click(screen.getByRole('button', { name: button }))
    await card.dispose()
    await act(async () => { reply.resolve([state('connected')]) })
    expect(actions[operation]).toHaveBeenCalledOnce()
    expect(screen.queryByText(en['status.connected'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['confirm', 'disconnect', 'complete', 'cancel'] as const)('contains a late %s failure after unmount', async (operation) => {
    const reply = Promise.withResolvers<CloudConnectionView[]>()
    const initial = operation === 'complete' || operation === 'cancel'
      ? state('authorizing', { attemptId, prompt: { id: promptId, kind: 'secret' } })
      : state('choose-permissions')
    const { actions } = actionsFor([initial])
    actions[operation].mockReturnValue(reply.promise)
    const card = await mountCard(actions)
    if (operation === 'complete') fireEvent.change(screen.getByLabelText(en.supabaseResponse), { target: { value: 'private-response' } })
    const button = operation === 'confirm' ? en.enableSelected : operation === 'disconnect' ? en.disconnect
      : operation === 'complete' ? en.submitResponse : en.cancelAuthorization
    fireEvent.click(screen.getByRole('button', { name: button }))
    await card.dispose()
    await act(async () => { reply.reject(new Error('private late operation failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('cloud action admission', () => {
  it.each(['start', 'confirm', 'disconnect', 'cancel'] as const)('admits a rapid duplicate %s gesture only once', async (operation) => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const pending = Promise.withResolvers<CloudConnectionView[]>()
    const { actions } = actionsFor([operation === 'start' ? state('not-connected')
      : operation === 'cancel' ? state('authorizing', { attemptId }) : state('choose-permissions')])
    if (operation !== 'start') actions[operation].mockReturnValue(pending.promise)
    const admission = Promise.withResolvers<Awaited<ReturnType<CloudConnectionActions['start']>>>()
    if (operation === 'start') actions.start.mockReturnValue(admission.promise)
    await mountCard(actions)
    const label = operation === 'start' ? en.connect : operation === 'confirm' ? en.enableSelected
      : operation === 'disconnect' ? en.disconnect : en.cancelAuthorization
    const button = screen.getByRole('button', { name: label })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(actions[operation]).toHaveBeenCalledOnce()
    await act(async () => {
      if (operation === 'start') admission.resolve({ attemptId })
      else pending.resolve([state('not-connected')])
    })
  })

  it('never submits a second, conflicting answer to one AWS replacement prompt', async () => {
    const reply = Promise.withResolvers<CloudConnectionView[]>()
    const { actions } = actionsFor([state('authorizing', {
      provider: 'aws', attemptId, prompt: { id: promptId, kind: 'select', purpose: 'replace-aws-login' },
    })])
    actions.complete.mockReturnValue(reply.promise)
    await mountCard(actions, 'aws')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: en.replaceAwsLoginYes }))
      fireEvent.click(screen.getByRole('button', { name: en.replaceAwsLoginNo }))
    })
    expect(actions.complete).toHaveBeenCalledExactlyOnceWith('aws', promptId, 'yes')
    await act(async () => { reply.resolve([state('not-connected', { provider: 'aws' })]) })
  })

  it('rejects an empty private response without contacting the Host', async () => {
    const { actions } = actionsFor([state('authorizing', { attemptId, prompt: { id: promptId, kind: 'secret' } })])
    await mountCard(actions)
    const input = screen.getByLabelText(en.supabaseResponse)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.submit(input.closest('form')!)
    expect(actions.complete).not.toHaveBeenCalled()
  })

  it('keeps cancellation scoped when the Host has not published an attempt identity', async () => {
    const { actions } = actionsFor([state('authorizing')])
    await mountCard(actions)
    fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization }))
    expect(actions.cancel).not.toHaveBeenCalled()
    expect(actions.disconnect).not.toHaveBeenCalled()
  })

  it('reports a failed disconnect and retains the existing permission choices', async () => {
    const { actions } = actionsFor([state('choose-permissions')])
    actions.disconnect.mockRejectedValue(new Error('private disconnect failure'))
    await mountCard(actions)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.disconnect })) })
    expect(screen.getByRole('alert').textContent).toBe(en.disconnectError)
    expect(screen.getByRole('button', { name: en.enableSelected })).toBeTruthy()
  })

  it('leaves a cancelled popup closed after cancellation fails and a URL arrives later', async () => {
    const { tab } = popup()
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as Window)
    const fixture = actionsFor()
    fixture.actions.start.mockResolvedValue({ attemptId })
    fixture.actions.cancel.mockRejectedValue(new Error('private cancellation failure'))
    await mountCard(fixture.actions)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.connect })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization })) })
    expect(screen.getByRole('alert').textContent).toBe(en.cancelError)
    fixture.setViews([state('authorizing', { attemptId, authorizationUrl })])
    await poll()
    expect(tab.close).toHaveBeenCalledOnce()
    expect(tab.location.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: en.openBrowser }).getAttribute('href')).toBe(authorizationUrl)
  })
})

describe('cloud permission refresh', () => {
  it('can restore an elevated group without selecting unrelated tools', async () => {
    const tools = [{ name: 'execute_sql', description: '' }, { name: 'other_tool', description: 'Other operation' }]
    const fixture = actionsFor([state('choose-permissions', { tools })])
    await mountCard(fixture.actions)
    fireEvent.click(screen.getByRole('checkbox', { name: /other_tool/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.databaseGroup }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.databaseGroup }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enableSelected })) })
    expect(fixture.actions.confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['execute_sql'])
  })

  it('preserves a connected draft while removing unavailable tools and admitting newly enabled tools', async () => {
    const fixture = actionsFor([state('connected', {
      tools: [{ name: 'execute_sql', description: 'SQL' }, { name: 'removed_tool', description: '' }],
      enabledTools: ['execute_sql', 'removed_tool'],
    })])
    await mountCard(fixture.actions)
    fireEvent.click(screen.getByRole('button', { name: en.editPermissions }))
    fireEvent.click(screen.getByRole('checkbox', { name: /execute_sql/ }))
    fixture.setViews([state('connected', {
      tools: [{ name: 'execute_sql', description: 'SQL' }, { name: 'enabled_new', description: '' }, { name: 'disabled_new', description: '' }],
      enabledTools: ['execute_sql', 'enabled_new'],
    })])
    await poll()
    expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', false)
    expect(screen.queryByRole('checkbox', { name: /removed_tool/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /enabled_new/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /disabled_new/ })).toHaveProperty('checked', false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.savePermissions })) })
    expect(fixture.actions.confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['enabled_new'])
  })

  it('ignores unsupported sign-in selections and lets the Host choose an omitted profile', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const { actions } = actionsFor([state('not-connected', { provider: 'aws', awsProfile: 'host-default', awsMethod: 'sso' })])
    await mountCard(actions, 'aws')
    const method = screen.getByRole('combobox', { name: en.awsMethod })
    fireEvent.change(method, { target: { value: 'login' } })
    fireEvent.change(method, { target: { value: 'unsupported-method' } })
    fireEvent.change(screen.getByLabelText(en.awsProfile), { target: { value: '   ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.connect })) })
    expect(actions.start).toHaveBeenCalledExactlyOnceWith('aws', 'us-east-1', { awsMethod: 'login' })
  })
})

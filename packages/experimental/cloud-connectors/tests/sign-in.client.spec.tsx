/** @vitest-environment jsdom */
/** OAuth launch respects Desktop external navigation and Web popup ownership. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '../src/client/index.ts'
import { CloudConnectionCard, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import type { CloudConnectionView } from '../src/types.ts'
import { en, zh, NS } from '../src/client/locales.ts'

const authorizationUrl = 'https://provider.example.test/authorize?state=test-state'
const runtimes: SlotTestRuntime[] = []

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

function makeSignIn() {
  let connection: CloudConnectionView = {
    provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [],
  }
  const request = Promise.withResolvers<{ url: string }>()
  const confirm = vi.fn(async () => [])
  const actions: CloudConnectionActions = {
    list: async () => [connection],
    start: vi.fn(() => {
      connection = { ...connection, status: 'authorizing' }
      return request.promise
    }),
    confirm,
    disconnect: async () => [],
  }
  return {
    request, actions, confirm,
    async render() {
      const runtime = await SlotTestRuntime.create()
      runtimes.push(runtime)
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.effect(() => locale.register(NS, { en, zh }), 'cloud sign-in test locale')
      locale.setLocale('en')
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      await runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
      await runtime.mount({ inject: ['slots'], apply(ctx) {
        ctx.slots.register({
          name: 'plugins.item', id: 'cloud-supabase', locale: NS, inject: () => ({ provider: 'supabase' as const, actions }),
        }, CloudConnectionCard)
      } })
      runtime.renderSlot('plugins.item', { view: 'page' })
      await runtime.flush()
    },
    async resolve(url = authorizationUrl) {
      await act(async () => { request.resolve({ url }) })
      // Publish the Host's authorizing state through the component's real polling.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    },
  }
}

function makeReservedTab() {
  const replace = vi.fn<Location['replace']>()
  const close = vi.fn<Window['close']>()
  const tab: {
    closed: boolean
    opener: Window | null
    location: Pick<Location, 'replace'>
    close: Window['close']
  } = { closed: false, opener: window, location: { replace }, close }
  return { tab, replace, close }
}

describe('cloud sign-in browser hand-off', () => {
  it('launches the resolved HTTPS URL when Desktop denies the blank popup', async () => {
    const openExternal = vi.fn<(url: string) => void>()
    // Desktop denies every popup, opening only HTTP(S) URLs in the system browser.
    const open = vi.spyOn(window, 'open').mockImplementation((url) => {
      if (url !== undefined && new URL(url).protocol === 'https:') openExternal(String(url))
      return null
    })
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(openExternal).not.toHaveBeenCalled()

    await signIn.resolve()
    expect(open).toHaveBeenLastCalledWith(authorizationUrl, '_blank', 'noopener,noreferrer')
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(authorizationUrl)
    expect(signIn.confirm).not.toHaveBeenCalled()
    expect(screen.getByText(en['status.authorizing'])).toBeTruthy()
  })

  it('navigates the synchronously reserved Web popup without opening another window', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    expect(popup.tab.opener).toBeNull()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.connect })).toHaveProperty('disabled', true)

    await signIn.resolve()
    expect(popup.replace).toHaveBeenCalledExactlyOnceWith(authorizationUrl)
    expect(open).toHaveBeenCalledTimes(1)
    expect(signIn.confirm).not.toHaveBeenCalled()
  })

  it('offers a safe manual link if the Web browser blocks both launch attempts', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await signIn.resolve()

    expect(open).toHaveBeenCalledTimes(2)
    const link = screen.getByRole('link', { name: en.openBrowser })
    expect(link.getAttribute('href')).toBe(authorizationUrl)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(signIn.confirm).not.toHaveBeenCalled()
    expect(screen.queryByText(en['status.connected'])).toBeNull()
  })

  it('does not reopen a reserved popup the user closes before authorization is ready', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    popup.tab.closed = true
    await signIn.resolve()

    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: en.openBrowser }).getAttribute('href')).toBe(authorizationUrl)
    expect(signIn.confirm).not.toHaveBeenCalled()
  })

  it('closes the unused popup and reports a rejected start without exposing the error payload', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await act(async () => { signIn.request.reject(new Error('private provider detail')) })

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe(en.connectError)
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
    expect(screen.getByRole('button', { name: en.connect })).toHaveProperty('disabled', false)
    expect(signIn.confirm).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'http://provider.example.test/authorize',
    'https://username:password@provider.example.test/authorize',
    'not-a-url',
  ])('does not navigate to or expose an unsafe authorization URL: %s', async (url) => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await signIn.resolve(url)

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe(en.connectError)
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
    expect(signIn.confirm).not.toHaveBeenCalled()
  })
})

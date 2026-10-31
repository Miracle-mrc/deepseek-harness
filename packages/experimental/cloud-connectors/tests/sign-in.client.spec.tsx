/** @vitest-environment jsdom */
/** OAuth launch respects Desktop external navigation and Web popup ownership. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '../src/client/index.ts'
import { CloudConnectionCard, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import type { CloudProvider } from '../src/catalog.ts'
import type { CloudAttemptId, CloudConnectionView, CloudPromptId, CloudSignIn } from '../src/types.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'

const authorizationUrl = 'https://provider.example.test/authorize?state=test-state'
const attemptId = 'fixture-attempt' as CloudAttemptId
const promptId = 'fixture-prompt' as CloudPromptId
const dictionaries = { en, zh, ja, es, fr, de, ru, pt }
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

function makeSignIn(provider: CloudProvider = 'supabase', initial?: CloudConnectionView) {
  let connection: CloudConnectionView = initial ?? {
    provider, status: 'not-connected', tools: [], enabledTools: [],
    ...(provider === 'aws' ? { awsProfile: 'dsh-cloud', awsMethod: 'login' } : {}),
  }
  const request = Promise.withResolvers<CloudSignIn>()
  const confirm = vi.fn(async () => [])
  const actions: CloudConnectionActions = {
    list: async () => [connection],
    start: vi.fn(() => {
      connection = { ...connection, status: 'authorizing', attemptId }
      return request.promise
    }),
    confirm,
    complete: vi.fn(async () => []),
    cancel: vi.fn(async () => {
      connection = { provider, status: 'not-connected', tools: [], enabledTools: [] }
      return [connection]
    }),
    disconnect: async () => [],
  }
  return {
    request, actions, confirm,
    async render(language: keyof typeof dictionaries = 'en') {
      const runtime = await SlotTestRuntime.create()
      runtimes.push(runtime)
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.effect(() => locale.register(NS, dictionaries), 'cloud sign-in test locale')
      if (language !== 'en' && language !== 'zh') {
        runtime.ctx.effect(() => locale.addLanguage({ id: language, label: language, fallback: 'en' }), 'cloud sign-in test language')
      }
      locale.setLocale(language)
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
    },
    async resolve(url = authorizationUrl) {
      await act(async () => { request.resolve({ attemptId, url }) })
      // Publish the Host's authorizing state through the component's real polling.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    },
    async publish(current: CloudConnectionView) {
      connection = current
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
    expect(open).not.toHaveBeenCalled()
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

describe('cloud authorization attempt ownership', () => {
  it('retains the gesture popup until the matching attempt publishes its URL', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await act(async () => { signIn.request.resolve({ attemptId }) })

    expect(popup.replace).not.toHaveBeenCalled()
    expect(popup.close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.cancelAuthorization })).toBeTruthy()
    const authorizing: CloudConnectionView = {
      provider: 'supabase', status: 'authorizing', attemptId, authorizationUrl,
      code: 'PUBLIC-CODE', tools: [], enabledTools: [],
    }
    await signIn.publish(authorizing)
    await signIn.publish(authorizing)

    expect(popup.replace).toHaveBeenCalledExactlyOnceWith(authorizationUrl)
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText('PUBLIC-CODE')).toBeTruthy()
    expect(screen.getByText(authorizationUrl)).toBeTruthy()
    expect(signIn.confirm).not.toHaveBeenCalled()
  })

  it.each(['choose-permissions', 'connected', 'failed'] as const)('closes an unused popup when discovery reaches %s before offering a URL', async (status) => {
    const popup = makeReservedTab()
    vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await act(async () => { signIn.request.resolve({ attemptId }) })
    await signIn.publish({ provider: 'supabase', status, tools: [], enabledTools: [] })

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
  })

  it('closes the preopened popup when the user explicitly reuses an AWS profile', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn('aws')
    await signIn.render()
    fireEvent.change(screen.getByRole('combobox', { name: en.awsMethod }), { target: { value: 'existing' } })
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await act(async () => { signIn.request.resolve({ attemptId }) })

    expect(signIn.actions.start).toHaveBeenCalledExactlyOnceWith('aws', 'us-east-1', { awsProfile: 'dsh-cloud', awsMethod: 'existing' })
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
    expect(screen.getByText(en.checkingProfile)).toBeTruthy()
    expect(screen.queryByText(en.browserHint)).toBeNull()
  })

  it('cancels a pending admission by its returned ID without navigating or disconnecting', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    const disconnect = vi.spyOn(signIn.actions, 'disconnect')
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization }))
    expect(popup.close).toHaveBeenCalledOnce()
    expect(signIn.actions.cancel).not.toHaveBeenCalled()
    await act(async () => { signIn.request.resolve({ attemptId, url: authorizationUrl }) })

    expect(signIn.actions.cancel).toHaveBeenCalledExactlyOnceWith('supabase', attemptId)
    expect(disconnect).not.toHaveBeenCalled()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en['status.not-connected'])).toBeTruthy()
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never navigates the local popup using a replacement attempt’s URL', async () => {
    const popup = makeReservedTab()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup.tab as Window)
    const signIn = makeSignIn()
    await signIn.render()
    fireEvent.click(screen.getByRole('button', { name: en.connect }))
    await act(async () => { signIn.request.resolve({ attemptId }) })
    await signIn.publish({
      provider: 'supabase', status: 'authorizing', attemptId: 'replacement-attempt' as CloudAttemptId,
      authorizationUrl, tools: [], enabledTools: [],
    })

    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.replace).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: en.openBrowser }).getAttribute('href')).toBe(authorizationUrl)
  })

  it('ignores a cancelled attempt’s earlier status read', async () => {
    const signIn = makeSignIn('supabase', {
      provider: 'supabase', status: 'authorizing', attemptId, authorizationUrl, tools: [], enabledTools: [],
    })
    await signIn.render()
    const staleRead = Promise.withResolvers<CloudConnectionView[]>()
    vi.spyOn(signIn.actions, 'list').mockReturnValueOnce(staleRead.promise)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization })) })
    await act(async () => { staleRead.resolve([{
      provider: 'supabase', status: 'authorizing', attemptId, authorizationUrl, tools: [], enabledTools: [],
    }]) })

    expect(signIn.actions.cancel).toHaveBeenCalledExactlyOnceWith('supabase', attemptId)
    expect(screen.getByText(en['status.not-connected'])).toBeTruthy()
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
  })
})

describe('private cloud authorization responses', () => {
  function makePrompt(provider: CloudProvider = 'supabase') {
    return makeSignIn(provider, {
      provider, status: 'authorizing', attemptId, authorizationUrl,
      prompt: { id: promptId, kind: 'secret' }, tools: [], enabledTools: [],
    })
  }

  it.each(['aws', 'supabase'] as const)('sends the %s response only through complete and clears the field before the request', async (provider) => {
    const signIn = makePrompt(provider)
    await signIn.render()
    const input = screen.getByLabelText(provider === 'aws' ? en.awsResponse : en.supabaseResponse)
    const completion = Promise.withResolvers<CloudConnectionView[]>()
    vi.mocked(signIn.actions.complete).mockImplementation(() => {
      expect(input).toHaveProperty('value', '')
      return completion.promise
    })
    fireEvent.change(input, { target: { value: '  private-browser-response  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.submitResponse }))

    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(signIn.actions.complete).toHaveBeenCalledExactlyOnceWith(provider, promptId, 'private-browser-response')
    expect(signIn.actions.start).not.toHaveBeenCalled()
    expect(signIn.actions.confirm).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    await act(async () => { completion.resolve([{ provider, status: 'choose-permissions', tools: [], enabledTools: [] }]) })
    expect(screen.queryByLabelText(provider === 'aws' ? en.awsResponse : en.supabaseResponse)).toBeNull()
    expect(screen.getByText(en['status.choose-permissions'])).toBeTruthy()
  })

  it('clears a response draft when a different private prompt arrives', async () => {
    const signIn = makePrompt()
    await signIn.render()
    const input = screen.getByLabelText(en.supabaseResponse)
    fireEvent.change(input, { target: { value: 'old-private-response' } })
    await signIn.publish({
      provider: 'supabase', status: 'authorizing', attemptId, tools: [], enabledTools: [],
      prompt: { id: 'replacement-prompt' as CloudPromptId, kind: 'secret' },
    })

    expect(screen.getByLabelText(en.supabaseResponse)).toHaveProperty('value', '')
    expect(signIn.actions.complete).not.toHaveBeenCalled()
  })

  it('clears the response on cancellation and ignores a late failed submission', async () => {
    const signIn = makePrompt()
    await signIn.render()
    const completion = Promise.withResolvers<CloudConnectionView[]>()
    vi.mocked(signIn.actions.complete).mockReturnValue(completion.promise)
    const input = screen.getByLabelText(en.supabaseResponse)
    fireEvent.change(input, { target: { value: 'private-response' } })
    fireEvent.click(screen.getByRole('button', { name: en.submitResponse }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization })) })
    await act(async () => { completion.reject(new Error('private-provider-detail')) })

    expect(input).toHaveProperty('value', '')
    expect(signIn.actions.cancel).toHaveBeenCalledExactlyOnceWith('supabase', attemptId)
    expect(screen.getByText(en['status.not-connected'])).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByLabelText(en.supabaseResponse)).toBeNull()
  })

  it('keeps a rejected response empty and shows a localized retry hint', async () => {
    const signIn = makePrompt()
    await signIn.render()
    vi.mocked(signIn.actions.complete).mockRejectedValue(new Error('private-provider-detail'))
    const input = screen.getByLabelText(en.supabaseResponse)
    fireEvent.change(input, { target: { value: 'private-response' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.submitResponse })) })

    expect(input).toHaveProperty('value', '')
    expect(screen.getByRole('alert').textContent).toBe(en.responseError)
    expect(screen.getByRole('button', { name: en.submitResponse })).toHaveProperty('disabled', false)
  })

  it('clears an unsubmitted private response before cancelling', async () => {
    const signIn = makePrompt()
    await signIn.render()
    const cancellation = Promise.withResolvers<CloudConnectionView[]>()
    vi.mocked(signIn.actions.cancel).mockImplementation(() => {
      expect(input).toHaveProperty('value', '')
      return cancellation.promise
    })
    const input = screen.getByLabelText(en.supabaseResponse)
    fireEvent.change(input, { target: { value: 'unsubmitted-private-response' } })
    fireEvent.click(screen.getByRole('button', { name: en.cancelAuthorization }))
    expect(screen.queryByRole('link', { name: en.openBrowser })).toBeNull()
    await act(async () => { cancellation.resolve([{ provider: 'supabase', status: 'not-connected', tools: [], enabledTools: [] }]) })
    expect(signIn.actions.complete).not.toHaveBeenCalled()
  })

  it.each([
    { button: en.replaceAwsLoginYes, response: 'yes' },
    { button: en.replaceAwsLoginNo, response: 'no' },
  ] as const)('requires an explicit choice to answer $response to replacing an AWS login', async ({ button, response }) => {
    const signIn = makeSignIn('aws', {
      provider: 'aws', status: 'authorizing', attemptId, tools: [], enabledTools: [],
      prompt: { id: promptId, kind: 'select', purpose: 'replace-aws-login' },
    })
    await signIn.render()
    expect(screen.getByText(en.replaceAwsLogin)).toBeTruthy()
    expect(signIn.actions.complete).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: button })) })

    expect(signIn.actions.complete).toHaveBeenCalledExactlyOnceWith('aws', promptId, response)
    expect(signIn.actions.start).not.toHaveBeenCalled()
  })

  it('does not restore an answered AWS login prompt from an older status read', async () => {
    const prompt: CloudConnectionView = {
      provider: 'aws', status: 'authorizing', attemptId, tools: [], enabledTools: [],
      prompt: { id: promptId, kind: 'select', purpose: 'replace-aws-login' },
    }
    const signIn = makeSignIn('aws', prompt)
    await signIn.render()
    const staleRead = Promise.withResolvers<CloudConnectionView[]>()
    vi.spyOn(signIn.actions, 'list').mockReturnValueOnce(staleRead.promise)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    vi.mocked(signIn.actions.complete).mockResolvedValue([{ ...prompt, prompt: { id: 'next-prompt' as CloudPromptId, kind: 'secret' } }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.replaceAwsLoginNo })) })
    await act(async () => { staleRead.resolve([prompt]) })

    expect(screen.queryByRole('button', { name: en.replaceAwsLoginYes })).toBeNull()
    expect(screen.getByLabelText(en.awsResponse)).toHaveProperty('value', '')
    expect(signIn.actions.complete).toHaveBeenCalledExactlyOnceWith('aws', promptId, 'no')
  })
})

describe('localized cloud sign-in recovery', () => {
  it('clears a failed status-read alert when a later read reports a connected account', async () => {
    const signIn = makeSignIn()
    vi.spyOn(signIn.actions, 'list').mockRejectedValueOnce(new Error('temporary read failure'))
    await signIn.render()
    expect(screen.getByRole('alert').textContent).toBe(en.loadError)

    await signIn.publish({ provider: 'supabase', status: 'connected', tools: [], enabledTools: [] })

    expect(screen.getByText(en['status.connected'])).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains an action failure when an unrelated status read succeeds', async () => {
    const signIn = makeSignIn('supabase', {
      provider: 'supabase', status: 'choose-permissions', tools: [], enabledTools: [],
    })
    vi.mocked(signIn.actions.confirm).mockRejectedValue(new Error('private save failure'))
    await signIn.render()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.enableSelected })) })
    expect(screen.getByRole('alert').textContent).toBe(en.confirmError)

    await signIn.publish({ provider: 'supabase', status: 'choose-permissions', tools: [], enabledTools: [] })

    expect(screen.getByRole('alert').textContent).toBe(en.confirmError)
  })

  it.each(Object.entries(dictionaries))('shows actionable AWS CLI help in %s', async (language, dictionary) => {
    const signIn = makeSignIn('aws', {
      provider: 'aws', status: 'failed', errorCode: 'aws-cli-required', tools: [], enabledTools: [],
      awsProfile: 'dedicated-host-profile', awsMethod: 'sso',
    })
    await signIn.render(language as keyof typeof dictionaries)

    expect(screen.getByRole('alert').textContent).toBe(dictionary['error.aws-cli-required'])
    expect(screen.getByLabelText(dictionary.awsProfile)).toHaveProperty('value', 'dedicated-host-profile')
    expect(screen.getByRole('combobox', { name: dictionary.awsMethod })).toHaveProperty('value', 'sso')
    const help = screen.getByRole('link', { name: dictionary.awsCliInstall })
    expect(help.getAttribute('href')).toBe('https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html')
    expect(screen.getByRole('button', { name: dictionary.retry })).toBeTruthy()
    expect(signIn.actions.start).not.toHaveBeenCalled()
  })

  it.each(['authorization-failed', 'connection-failed', 'session-expired', 'aws-login-failed', 'aws-permission-required'] as const)('translates the safe Host failure category %s', async (errorCode) => {
    const signIn = makeSignIn('aws', { provider: 'aws', status: 'failed', errorCode, tools: [], enabledTools: [] })
    await signIn.render('zh')
    expect(screen.getByRole('alert').textContent).toBe(zh[`error.${errorCode}`])
  })

  it('lets a failed AWS sign-in retry with edited profile and method', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const signIn = makeSignIn('aws', {
      provider: 'aws', status: 'failed', errorCode: 'aws-login-failed', tools: [], enabledTools: [],
      awsProfile: 'dsh-cloud', awsMethod: 'login',
    })
    await signIn.render()
    fireEvent.change(screen.getByLabelText(en.awsProfile), { target: { value: 'team-sso' } })
    fireEvent.change(screen.getByRole('combobox', { name: en.awsMethod }), { target: { value: 'sso' } })
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await act(async () => { signIn.request.resolve({ attemptId }) })

    expect(signIn.actions.start).toHaveBeenCalledExactlyOnceWith('aws', 'us-east-1', { awsProfile: 'team-sso', awsMethod: 'sso' })
    expect(signIn.actions.confirm).not.toHaveBeenCalled()
    expect(screen.getByText(en['status.authorizing'])).toBeTruthy()
  })
})

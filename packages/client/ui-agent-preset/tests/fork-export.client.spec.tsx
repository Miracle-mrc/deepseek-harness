// @vitest-environment jsdom
/** The Creator menu reviews local source files before exposing a browser download. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SourceExportResult } from '@deepseek-ai/dsh-api-remotes/client'
import { ForkExportMenuItem, ForkExportOverlay } from '../src/client/ForkExport.tsx'
import { ForkExportController, type ReadySourceExport } from '../src/client/fork-export-store.ts'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: ReadySourceExport = {
  status: 'ready', formatVersion: 1, repository: 'alice/harness', branch: 'my-changes', profile: 'web', reviewRequired: true,
  files: [{ path: 'profiles/saved/cordis.patch.yml', content: 'entries: []\n' }],
}

function translate(copy: typeof en): (key: keyof typeof en, params?: Record<string, string>) => string {
  return (key, params) => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value), copy[key],
  )
}

function unusedHook(): never { throw new Error('The export menu does not read this source') }

function menu(state: Partial<AgentPresetSettingsState> = {}, allowed = true) {
  const source = createSnapshotStore<AgentPresetSettingsState>({
    status: 'ready', error: null, options: [{ id: 'standard' }, { id: 'cordis' }], ...state,
  })
  const calls: string[] = []
  const load = vi.fn(async () => {})
  const props: ComponentProps<typeof ForkExportMenuItem> = {
    t: translate(en), useAgentPresets: bindSnapshotSelector(source),
    usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook, useWorkspaces: unusedHook, useResource: unusedHook,
    ...allowAllAccess, useRemoteAccess: () => allowed,
    load, onDismiss: () => { calls.push('dismiss') }, open: () => { calls.push('open') },
  }
  render(<ForkExportMenuItem {...props} />)
  return { source, calls, load, item: screen.getByRole<HTMLButtonElement>('menuitem') }
}

function overlay(copy = en, prepare: (request: { repository: string; branch: string }) => Promise<SourceExportResult> = async () => READY) {
  const save = vi.fn()
  const controller = new ForkExportController(prepare, save)
  controller.open()
  controller.edit('repository', READY.repository)
  controller.edit('branch', READY.branch)
  const props: ComponentProps<typeof ForkExportOverlay> = {
    t: translate(copy), useForkExport: bindSnapshotSelector(controller.store),
    close: () => { controller.close() }, edit: (field, value) => { controller.edit(field, value) },
    inspect: () => controller.inspect(), review: (value) => { controller.review(value) },
    download: () => { controller.download() }, dismissNotice: () => { controller.dismissNotice() },
  }
  render(<ForkExportOverlay {...props} />)
  return { controller, save }
}

describe('Save to My Fork entry', () => {
  it('names the local download and dismisses before opening it without changing modes', () => {
    const view = menu()
    expect(view.load).toHaveBeenCalledOnce()
    expect(view.item.textContent).toContain('Save to My Fork')
    expect(view.item.textContent).toContain(en.forkDescription)
    fireEvent.click(view.item)
    expect(view.calls).toEqual(['dismiss', 'open'])
  })

  it.each(['idle', 'loading', 'error', 'unavailable'] as const)('keeps a disabled entry when the roster is %s', (status) => {
    const view = menu({ status })
    expect(view.item.disabled).toBe(true)
    expect(view.item.textContent).toContain(status === 'idle' || status === 'loading' ? en.createPluginChecking : en.createPluginUnavailable)
    fireEvent.click(view.item)
    expect(view.calls).toEqual([])
  })

  it('keeps its identity when Creator leaves the roster', () => {
    const view = menu()
    act(() => { view.source.set({ status: 'ready', error: null, options: [{ id: 'standard' }] }) })
    expect(screen.getByRole('menuitem')).toBe(view.item)
    expect(view.item.disabled).toBe(true)
    expect(view.item.textContent).toContain(en.createPluginMissing)
  })

  it('explains when the current peer cannot export sources', () => {
    const view = menu({}, false)
    expect(view.item.disabled).toBe(true)
    expect(view.item.textContent).toContain(en.forkUnavailable)
  })
})

describe('source export dialog', () => {
  it.each([['en', en], ['zh', zh]] as const)('presents accessible review and local-only copy in %s', async (_language, copy) => {
    const { controller, save } = overlay(copy)
    expect(screen.queryByRole('button', { name: copy.forkDownload })).toBeNull()
    await act(async () => { await controller.inspect() })
    const dialog = screen.getByRole('dialog', { name: copy.forkTitle })
    expect(dialog.textContent).toContain(copy.forkIntro)
    expect(dialog.textContent).toContain(copy.forkExclusions)
    expect(within(dialog).getByText(READY.files[0]!.path)).toBeTruthy()
    expect(dialog.querySelector('pre')?.textContent).toBe(READY.files[0]!.content)
    const download = within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkDownload })
    expect(download.disabled).toBe(true)
    expect({
      dialog: dialog.getAttribute('aria-label'),
      fields: within(dialog).getAllByRole<HTMLInputElement>('textbox').map(input => ({
        label: input.labels?.[0]?.textContent, value: input.value, required: input.getAttribute('aria-required'),
      })),
      actions: within(dialog).getAllByRole<HTMLButtonElement>('button').map(button => ({
        label: button.getAttribute('aria-label') ?? button.textContent, disabled: button.disabled,
      })),
      review: screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkReviewed }).checked,
      text: dialog.textContent,
    }).toMatchSnapshot()
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkReviewed }))
    expect(download.disabled).toBe(false)
    fireEvent.click(download)
    expect(save).toHaveBeenCalledExactlyOnceWith(READY)
    expect(screen.getByText(copy.forkDownloaded)).toBeTruthy()
  })

  it.each(['repository', 'branch'] as const)('discards pending files when %s changes during inspection', async (field) => {
    const pending = Promise.withResolvers<SourceExportResult>()
    const prepare = vi.fn(() => pending.promise)
    const { controller, save } = overlay(en, prepare)
    fireEvent.click(screen.getByRole('button', { name: en.forkInspect }))
    expect(screen.getByRole('status', { name: en.forkInspect })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkInspect }).disabled).toBe(true)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: field === 'branch' ? en.forkBranch : en.forkRepository })
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'new-target' } })
    await act(async () => { pending.resolve(READY); await pending.promise })
    expect(controller.store.getSnapshot().preview).toBeNull()
    expect(screen.queryByRole('button', { name: en.forkDownload })).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('associates target refusals with their fields and retains typed values', async () => {
    overlay(en, async () => ({ status: 'blocked', issues: [{ code: 'invalid-repository' }, { code: 'invalid-branch' }] }))
    fireEvent.click(screen.getByRole('button', { name: en.forkInspect }))
    await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(2) })
    const fields = [
      [en.forkRepository, en.forkInvalidRepository, READY.repository], [en.forkBranch, en.forkInvalidBranch, READY.branch],
    ] as const
    for (const [label, error, value] of fields) {
      const input = screen.getByRole<HTMLInputElement>('textbox', { name: label })
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(error)
      expect(input.value).toBe(value)
    }
    expect(screen.getByRole('button', { name: en.forkRetry })).toBeTruthy()
  })

  it.each([
    ['profile-unavailable', 'forkProfileUnavailable'], ['unsafe-path', 'forkUnsafePath'],
    ['source-unavailable', 'forkSourceUnavailable'], ['unsupported-source', 'forkUnsupportedSource'],
    ['secret-suspected', 'forkSecretSuspected'], ['source-changed', 'forkSourceChanged'], ['too-large', 'forkTooLarge'],
  ] as const)('reports the localized %s refusal beside its safe path', async (code, key) => {
    overlay(en, async () => ({ status: 'blocked', issues: [
      code === 'profile-unavailable' ? { code } : { code, path: 'bundles/0/index.ts' },
    ] }))
    fireEvent.click(screen.getByRole('button', { name: en.forkInspect }))
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain(en[key])
    if (code !== 'profile-unavailable') expect(notice.textContent).toContain('bundles/0/index.ts')
    expect(screen.queryByRole('button', { name: en.forkDownload })).toBeNull()
  })

  it('keeps review available after a failed download and preserves its outcome after Escape', async () => {
    const { controller, save } = overlay()
    await act(async () => { await controller.inspect() })
    save.mockImplementationOnce(() => { throw new Error('browser denied download') })
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkReviewed }))
    fireEvent.click(screen.getByRole('button', { name: en.forkDownload }))
    expect(screen.getByText(en.forkDownloadFailed)).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(en.forkDownloadFailed)).toBeTruthy()
  })

  it('offers Retry after a failed read without losing the target', async () => {
    const prepare = vi.fn(async () => READY).mockRejectedValueOnce(new Error('disconnected'))
    overlay(en, prepare)
    fireEvent.click(screen.getByRole('button', { name: en.forkInspect }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.forkInspectFailed)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.forkRepository }).value).toBe(READY.repository)
    fireEvent.click(screen.getByRole('button', { name: en.forkRetry }))
    await screen.findByRole('checkbox', { name: en.forkReviewed })
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})

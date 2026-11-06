// @vitest-environment jsdom
/** Fork publication presents authorized destinations and byte-exact review before any remote write. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ForkCommitId, ForkPreviewId, ForkPreviewResult, ForkPublishResult, ForkRepositoriesResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ForkPublishOverlay } from '../src/client/ForkPublish.tsx'
import { ForkPublishController } from '../src/client/fork-publish-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const REPOSITORIES = {
  status: 'ready', account: 'alice', upstream: 'deepseek-ai/deepseek-harness',
  repositories: [{ repository: 'alice/harness', defaultBranch: 'trunk' }],
} satisfies ForkRepositoriesResult
const PREVIEW = {
  status: 'ready', id: 'preview-1' as ForkPreviewId, account: 'alice', repository: 'alice/harness',
  branch: 'creator/saved', upstream: REPOSITORIES.upstream, base: 'trunk', head: 'old-head' as ForkCommitId,
  files: [
    { path: 'customizations/bundles/0/index.ts', before: 'export const value = 1', after: 'export const value = 1\n' },
    { path: 'customizations/profiles/saved/cordis.patch.yml', before: null, after: '[]\n' },
  ],
} satisfies ForkPreviewResult

function overlay(copy = en) {
  const repositories = vi.fn(async (): Promise<ForkRepositoriesResult> => REPOSITORIES)
  const preview = vi.fn(async (): Promise<ForkPreviewResult> => PREVIEW)
  const publish = vi.fn(async (_id: ForkPreviewId, _confirmed: boolean): Promise<ForkPublishResult> => ({
    status: 'saved', repository: PREVIEW.repository, branch: PREVIEW.branch, commit: 'saved-commit' as ForkCommitId,
    pullRequestUrl: 'https://github.com/alice/harness/pull/1',
  }))
  const openPullRequest = vi.fn()
  const controller = new ForkPublishController({ repositories, preview, publish, openPullRequest })
  controller.open()
  const props: ComponentProps<typeof ForkPublishOverlay> = {
    t: makeTranslate(copy), useForkPublish: bindSnapshotSelector(controller.store),
    close: () => { controller.close() }, connect: () => controller.connect(),
    edit: (field, value) => { controller.edit(field, value) }, inspect: () => controller.inspect(),
    review: (value) => { controller.review(value) }, publish: () => controller.publish(), retry: () => controller.retry(),
    dismissNotice: () => { controller.dismissNotice() },
  }
  render(<ForkPublishOverlay {...props} />)
  return { controller, repositories, preview, publish, openPullRequest }
}

async function inspect(copy = en) {
  fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConnect }))
  const repository = await screen.findByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository })
  fireEvent.change(repository, { target: { value: PREVIEW.repository } })
  fireEvent.change(screen.getByRole('textbox', { name: copy.forkBranch }), { target: { value: PREVIEW.branch } })
  fireEvent.click(screen.getByRole('button', { name: copy.forkPublishInspect }))
  await screen.findByRole('checkbox', { name: copy.forkPublishReviewed })
}

function fileList(label = 'Files'): HTMLSelectElement {
  const list = screen.queryByRole<HTMLSelectElement>('listbox', { name: label })
  expect(list).not.toBeNull()
  if (list === null) throw new Error('File selector is missing')
  return list
}

function fileOptions(list: HTMLSelectElement): HTMLOptionElement[] {
  return [...list.options].filter(option => option.value !== '')
}

function renderedText(): (string | null)[] {
  return [...screen.getByRole('dialog', { name: en.forkPublishTitle }).querySelectorAll('pre')].map(element => element.textContent)
}

describe('direct fork publication dialog', () => {
  it.each(['main', 'master', 'develop'].flatMap(base => [
    { locale: 'en', copy: en, base, newBranch: `New branch from the selected fork’s ${base}`,
      intro: 'Load your authorized forks, choose a branch, and review every file. Confirmation creates a commit and opens a pull request to the selected fork’s default branch.' },
    { locale: 'zh', copy: zh, base, newBranch: `从所选 Fork 的 ${base} 创建新分支`,
      intro: '加载已授权的 Fork，选择分支并检查每个文件。确认后将创建提交，并向所选 Fork 的默认分支打开拉取请求' },
  ]))('shows the actual fork base $base in $locale before confirming a new branch', async ({ copy, base, newBranch, intro }) => {
    const view = overlay(copy)
    view.repositories.mockResolvedValueOnce({ ...REPOSITORIES,
      repositories: [{ repository: PREVIEW.repository, defaultBranch: base }],
    })
    view.preview.mockResolvedValueOnce({ ...PREVIEW, base, head: null })
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    expect(within(dialog).getByText(`${PREVIEW.repository}:${base}`, { exact: true })).toBeTruthy()
    expect(within(dialog).getByText(newBranch, { exact: true })).toBeTruthy()
    expect(within(dialog).getByText(intro, { exact: true })).toBeTruthy()
    expect(screen.queryByText(copy.forkPublishBranchHistory)).toBeNull()
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(([
    { locale: 'en', copy: en, effect: 'unknown', newBranch: 'New branch from the selected fork’s develop',
      conflict: 'The destination changed. Review the branch and pull request on GitHub before continuing.' },
    { locale: 'zh', copy: zh, effect: 'unknown', newBranch: '从所选 Fork 的 develop 创建新分支',
      conflict: '目标已发生变化，请先在 GitHub 上检查分支和拉取请求，再继续操作' },
    { locale: 'en', copy: en, effect: 'committed', newBranch: 'New branch from the selected fork’s develop',
      conflict: 'The destination changed. Review the branch and pull request on GitHub before continuing.' },
    { locale: 'zh', copy: zh, effect: 'committed', newBranch: '从所选 Fork 的 develop 创建新分支',
      conflict: '目标已发生变化，请先在 GitHub 上检查分支和拉取请求，再继续操作' },
  ] as const).flatMap(testCase => (['conflict', 'default-branch'] as const).map(code => ({ ...testCase, code }))))(
    'retains the reviewed base in $locale after $code with $effect effects and reopening', async ({ copy, effect, newBranch, conflict, code }) => {
      const view = overlay(copy)
      view.preview.mockResolvedValueOnce({ ...PREVIEW, base: 'develop', head: null })
      await inspect(copy)
      view.publish.mockResolvedValueOnce({ status: 'blocked', code, effect })
      fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
      await screen.findByText(effect === 'unknown' ? copy.forkPublishUnknown : copy.forkPublishCommitted)
      await act(async () => {
        view.controller.close()
        view.controller.open()
      })
      const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
      expect(within(dialog).getByText(`${PREVIEW.repository}:develop`, { exact: true })).toBeTruthy()
      expect(within(dialog).getByText(newBranch, { exact: true })).toBeTruthy()
      expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishRetry }).disabled).toBe(false)
      expect(screen.queryByRole('checkbox')).toBeNull()
      expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
      const alert = within(dialog).getByRole('alert')
      expect(within(alert).getByText(conflict, { exact: true })).toBeTruthy()
      expect(within(alert).queryByText(copy.forkPublishDefaultBranch, { exact: true })).toBeNull()
    })

  it.each([['en', en], ['zh', zh]] as const)('keeps ordinary default-branch guidance when publication has no effects in %s', async (_locale, copy) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'default-branch', effect: 'none' })
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText(copy.forkPublishDefaultBranch, { exact: true })).toBeTruthy()
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(false)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(false)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(false)
    expect(within(dialog).queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
    expect(within(alert).queryByText(copy.forkPublishConflict, { exact: true })).toBeNull()
  })

  it.each([['en', en], ['zh', zh]] as const)('requires explicit discovery, exact review, and confirmation in %s', async (_locale, copy) => {
    const view = overlay(copy)
    expect(view.repositories).not.toHaveBeenCalled()
    expect(view.preview).not.toHaveBeenCalled()
    expect(view.publish).not.toHaveBeenCalled()
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const destination = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository })
    expect([...destination.options].map(option => option.value)).toEqual(['', 'alice/harness'])
    expect(dialog.textContent).toContain('alice')
    expect(dialog.textContent).toContain(REPOSITORIES.upstream)
    expect(within(dialog).getByText(`${PREVIEW.repository}:${PREVIEW.base}`, { exact: true })).toBeTruthy()
    expect(dialog.textContent).toContain(PREVIEW.head)
    expect(dialog.textContent).toContain(copy.forkPublishBranchHistory)
    expect(dialog.textContent).toContain(PREVIEW.files[0]!.path)
    const files = fileList(_locale === 'zh' ? '文件' : 'Files')
    expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    fireEvent.change(files, { target: { value: PREVIEW.files[0]!.path } })
    const before = within(dialog).getByRole('region', { name: copy.forkPublishBefore })
    const after = within(dialog).getByRole('region', { name: copy.forkPublishAfter })
    fireEvent.click(within(before).getByRole('button'))
    fireEvent.click(within(after).getByRole('button'))
    expect([...dialog.querySelectorAll('pre')].map(element => element.textContent)).toContain(JSON.stringify(PREVIEW.files[0]!.before))
    expect([...dialog.querySelectorAll('pre')].map(element => element.textContent)).toContain(JSON.stringify(PREVIEW.files[0]!.after))
    expect([...dialog.querySelectorAll('pre')].map(element => element.textContent)).toContain(PREVIEW.files[0]!.before)
    expect([...dialog.querySelectorAll('pre')].map(element => element.textContent)).toContain(PREVIEW.files[0]!.after)
    expect(dialog.textContent).toContain(makeTranslate(copy)('forkPublishTextMetrics', { bytes: '22', newlines: '0' }))
    expect(dialog.textContent).toContain(makeTranslate(copy)('forkPublishTextMetrics', { bytes: '23', newlines: '1' }))
    fireEvent.change(files, { target: { value: PREVIEW.files[1]!.path } })
    expect(dialog.textContent).toContain(copy.forkPublishAbsent)
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(view.publish).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: copy.forkPublishReviewed }))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true) })
    expect((await screen.findByRole('link', { name: copy.forkPublishOpenPr })).getAttribute('href')).toBe('https://github.com/alice/harness/pull/1')
    expect(view.openPullRequest).toHaveBeenCalledOnce()
  })

  it('lazy file preview bounds a 2000-file receipt and leaves source unmounted until a file is chosen', async () => {
    const view = overlay()
    const files = Array.from({ length: 2000 }, (_, index) => ({
      path: `customizations/bundles/0/file-${String(index).padStart(4, '0')}.txt`,
      before: index % 2 === 0 ? null : `before-${String(index)}\n`, after: `after-${String(index)}\n`,
    }))
    view.preview.mockResolvedValueOnce({ ...PREVIEW, files })
    const sources = new Set(files.flatMap(file => file.before === null ? [file.after] : [file.before, file.after]))
    const stringify = vi.spyOn(JSON, 'stringify')
    const serializedSource = (): boolean => stringify.mock.calls.some(([value]) => typeof value === 'string' && sources.has(value))
    try {
      await inspect()
      expect(screen.getByRole('dialog', { name: en.forkPublishTitle }).querySelectorAll('pre').length).toBe(0)
      expect(serializedSource()).toBe(false)
      expect(renderedText()).toEqual([])
      const list = fileList()
      expect(list.tagName).toBe('SELECT')
      expect(list.size).toBeGreaterThanOrEqual(2)
      expect(list.options.length).toBeLessThanOrEqual(51)
      expect(fileOptions(list)).toHaveLength(50)
      expect(list.value).toBe('')
      const placeholder = within(list).getByRole<HTMLOptionElement>('option', { name: 'Choose a file', selected: true })
      expect(placeholder.disabled).toBe(false)
      expect(fileOptions(list)[0]?.textContent).toContain(files[0]!.path)
      expect(fileOptions(list)[0]?.textContent).toContain('Created')
      expect(fileOptions(list)[1]?.textContent).toContain(files[1]!.path)
      expect(fileOptions(list)[1]?.textContent).toContain('Modified')
      expect(fileOptions(list)[0]?.textContent).toMatch(/^Created · file-0000\.txt — /)
      expect(fileOptions(list)[1]?.textContent).toMatch(/^Modified · file-0001\.txt — /)
      expect(screen.getByText('Matching files: 2000', { exact: true })).toBeTruthy()
      fireEvent.focus(list)
      expect(list.value).toBe('')
      expect(renderedText()).toEqual([])
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'FILE-1999' } })
      expect(fileOptions(list).map(option => option.value)).toEqual([files[1999]!.path])
      expect(screen.getByText('Matching files: 1', { exact: true })).toBeTruthy()
      expect(renderedText()).toEqual([])
      fireEvent.change(list, { target: { value: files[1999]!.path } })
      expect(renderedText()).toEqual([files[1999]!.before, files[1999]!.after])
      expect(serializedSource()).toBe(false)
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).checked).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishConfirm }).disabled).toBe(true)
      expect(view.publish).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('lazy file preview preserves Unicode, BOM, CRLF, tabs, and exact selected text with explicit escaped disclosure', async () => {
    const view = overlay()
    const file = { path: PREVIEW.files[0]!.path, before: '\uFEFF初始😀\r\n\tcafe\u0301', after: '\uFEFF新的😀\r\n\tcafe\u0301\n尾部' }
    const next = { path: PREVIEW.files[1]!.path, before: null, after: 'next file\t\r\n' }
    const encodedBefore = JSON.stringify(file.before)
    const encodedAfter = JSON.stringify(file.after)
    view.preview.mockResolvedValueOnce({ ...PREVIEW, files: [file, next] })
    const stringify = vi.spyOn(JSON, 'stringify')
    const serialized = (value: string): boolean => stringify.mock.calls.some(([input]) => input === value)
    try {
      await inspect()
      const list = fileList()
      expect(renderedText()).toEqual([])
      expect(serialized(file.before)).toBe(false)
      expect(serialized(file.after)).toBe(false)
      fireEvent.change(list, { target: { value: file.path } })
      expect(renderedText()).toEqual([file.before, file.after])
      expect(serialized(file.before)).toBe(false)
      expect(serialized(file.after)).toBe(false)
      const before = screen.getByRole('region', { name: en.forkPublishBefore })
      const after = screen.getByRole('region', { name: en.forkPublishAfter })
      expect(within(before).getByText(makeTranslate(en)('forkPublishTextMetrics', { bytes: '22', newlines: '1' }), { exact: true })).toBeTruthy()
      expect(within(after).getByText(makeTranslate(en)('forkPublishTextMetrics', { bytes: '29', newlines: '2' }), { exact: true })).toBeTruthy()
      expect(within(before).getByText('Lines: 2', { exact: true })).toBeTruthy()
      expect(within(after).getByText('Lines: 3', { exact: true })).toBeTruthy()
      const showBefore = within(before).getByRole<HTMLButtonElement>('button')
      const showAfter = within(after).getByRole<HTMLButtonElement>('button')
      expect(showBefore.textContent).toContain(en.forkPublishEscapedText)
      expect(showAfter.textContent).toContain(en.forkPublishEscapedText)
      expect(within(before).getByRole('button', { name: 'Before: exact text with escaped line endings' })).toBe(showBefore)
      expect(within(after).getByRole('button', { name: 'After: exact text with escaped line endings' })).toBe(showAfter)
      expect(showBefore.getAttribute('aria-expanded')).toBe('false')
      expect(showAfter.getAttribute('aria-expanded')).toBe('false')
      const beforeId = showBefore.getAttribute('aria-controls')
      const afterId = showAfter.getAttribute('aria-controls')
      expect(beforeId).toBeTruthy()
      expect(afterId).toBeTruthy()
      expect(beforeId).not.toBe(afterId)
      const beforeContent = document.getElementById(beforeId ?? '')
      const afterContent = document.getElementById(afterId ?? '')
      expect(beforeContent).not.toBeNull()
      expect(afterContent).not.toBeNull()
      expect(beforeContent?.textContent).toBe('')
      expect(afterContent?.textContent).toBe('')
      expect(beforeContent?.querySelector('pre')).toBeNull()
      expect(afterContent?.querySelector('pre')).toBeNull()
      fireEvent.click(showBefore)
      expect(showBefore.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(beforeId ?? '')?.textContent).toBe(encodedBefore)
      expect(serialized(file.before)).toBe(true)
      expect(serialized(file.after)).toBe(false)
      fireEvent.click(showAfter)
      expect(showAfter.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(afterId ?? '')?.textContent).toBe(encodedAfter)
      expect(serialized(file.after)).toBe(true)
      fireEvent.click(showBefore)
      fireEvent.click(showAfter)
      expect(showBefore.getAttribute('aria-expanded')).toBe('false')
      expect(showAfter.getAttribute('aria-expanded')).toBe('false')
      expect(document.getElementById(beforeId ?? '')).toBe(beforeContent)
      expect(document.getElementById(afterId ?? '')).toBe(afterContent)
      expect(beforeContent?.textContent).toBe('')
      expect(afterContent?.textContent).toBe('')
      expect(beforeContent?.querySelector('pre')).toBeNull()
      expect(afterContent?.querySelector('pre')).toBeNull()
      expect(renderedText()).toEqual([file.before, file.after])
      fireEvent.click(showBefore)
      fireEvent.click(showAfter)
      fireEvent.change(list, { target: { value: next.path } })
      expect(renderedText()).toEqual([next.after])
      expect(document.getElementById(beforeId ?? '')).toBeNull()
      expect(document.getElementById(afterId ?? '')).toBeNull()
      expect(screen.getByRole('region', { name: en.forkPublishBefore }).textContent).toContain(en.forkPublishAbsent)
      expect(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      expect(serialized(next.after)).toBe(false)
      fireEvent.change(list, { target: { value: file.path } })
      expect(renderedText()).toEqual([file.before, file.after])
      expect(within(screen.getByRole('region', { name: en.forkPublishBefore })).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      expect(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      fireEvent.change(list, { target: { value: '' } })
      expect(list.value).toBe('')
      expect(renderedText()).toEqual([])
      expect(screen.queryByRole('region', { name: en.forkPublishBefore })).toBeNull()
      expect(screen.queryByRole('region', { name: en.forkPublishAfter })).toBeNull()
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).checked).toBe(false)
      expect(view.publish).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('lazy file preview distinguishes a created empty file from an existing empty Before value', async () => {
    const view = overlay()
    const created = { path: 'customizations/created.txt', before: null, after: '' }
    const modified = { path: 'customizations/modified.txt', before: '', after: 'nonempty' }
    view.preview.mockResolvedValueOnce({ ...PREVIEW, files: [created, modified] })
    await inspect()
    const list = fileList()
    expect(fileOptions(list)[0]?.textContent).toContain('Created')
    expect(fileOptions(list)[1]?.textContent).toContain('Modified')
    fireEvent.change(list, { target: { value: created.path } })
    const absent = screen.getByRole('region', { name: en.forkPublishBefore })
    expect(within(absent).getByText(en.forkPublishAbsent, { exact: true })).toBeTruthy()
    expect(absent.querySelectorAll('pre')).toHaveLength(0)
    expect(renderedText()).toEqual([''])
    fireEvent.change(list, { target: { value: modified.path } })
    const before = screen.getByRole('region', { name: en.forkPublishBefore })
    expect(within(before).queryByText(en.forkPublishAbsent, { exact: true })).toBeNull()
    expect(before.querySelector('pre')?.textContent).toBe('')
    expect(within(before).getByText(makeTranslate(en)('forkPublishTextMetrics', { bytes: '0', newlines: '0' }), { exact: true })).toBeTruthy()
    fireEvent.click(within(before).getByRole('button'))
    expect([...before.querySelectorAll('pre')].map(element => element.textContent)).toEqual(['', '""'])
    fireEvent.change(list, { target: { value: created.path } })
    expect(renderedText()).toEqual([''])
    expect(view.publish).not.toHaveBeenCalled()
  })

  it('lazy file preview resets selection at search and page boundaries and exposes an empty search state', async () => {
    const view = overlay()
    const files = Array.from({ length: 101 }, (_, index) => ({
      path: `customizations/file-${String(index).padStart(4, '0')}.txt`, before: null, after: `source-${String(index)}`,
    }))
    view.preview.mockResolvedValueOnce({ ...PREVIEW, files })
    await inspect()
    const list = fileList()
    const search = screen.getByRole('searchbox', { name: 'Search files' })
    const previous = screen.getByRole<HTMLButtonElement>('button', { name: 'Previous files' })
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Next files' })
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(false)
    expect(fileOptions(list).map(option => option.value)).toEqual(files.slice(0, 50).map(file => file.path))
    fireEvent.click(previous)
    expect(fileOptions(list).map(option => option.value)).toEqual(files.slice(0, 50).map(file => file.path))
    fireEvent.change(list, { target: { value: files[49]!.path } })
    expect(renderedText()).toEqual([files[49]!.after])
    fireEvent.click(next)
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(fileOptions(list).map(option => option.value)).toEqual(files.slice(50, 100).map(file => file.path))
    expect(list.options.length).toBeLessThanOrEqual(51)
    expect(previous.disabled).toBe(false)
    fireEvent.change(list, { target: { value: files[99]!.path } })
    fireEvent.click(next)
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(fileOptions(list).map(option => option.value)).toEqual([files[100]!.path])
    expect(next.disabled).toBe(true)
    expect(screen.getByText('Matching files: 101', { exact: true })).toBeTruthy()
    fireEvent.click(next)
    expect(fileOptions(list).map(option => option.value)).toEqual([files[100]!.path])
    fireEvent.change(list, { target: { value: files[100]!.path } })
    fireEvent.change(search, { target: { value: 'file-0000' } })
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(fileOptions(list).map(option => option.value)).toEqual([files[0]!.path])
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(true)
    expect(screen.getByText('Matching files: 1', { exact: true })).toBeTruthy()
    fireEvent.change(list, { target: { value: files[0]!.path } })
    fireEvent.change(search, { target: { value: 'no-such-file' } })
    expect(fileOptions(list)).toEqual([])
    expect(list.options).toHaveLength(1)
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(screen.getByText('Matching files: 0', { exact: true })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/no .*files|no .*matches|no .*results/i)
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(true)
    fireEvent.change(search, { target: { value: '' } })
    expect(fileOptions(list).map(option => option.value)).toEqual(files.slice(0, 50).map(file => file.path))
    expect(list.value).toBe('')
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).checked).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(['repository', 'branch'] as const)('lazy file preview clears selected source and acknowledgement after a %s edit', async (field) => {
    const view = overlay()
    await inspect()
    const list = fileList()
    fireEvent.change(list, { target: { value: PREVIEW.files[0]!.path } })
    fireEvent.click(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button'))
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    const destination = field === 'repository' ? screen.getByRole('combobox', { name: en.forkRepository })
      : screen.getByRole('textbox', { name: en.forkBranch })
    fireEvent.change(destination, { target: { value: field === 'repository' ? '' : 'creator/another' } })
    expect(screen.queryByRole('listbox', { name: 'Files' })).toBeNull()
    expect(renderedText()).toEqual([])
    expect(screen.queryByRole('checkbox', { name: en.forkPublishReviewed })).toBeNull()
    expect(screen.queryByRole('button', { name: en.forkPublishConfirm })).toBeNull()
    expect(view.controller.store.getSnapshot().preview).toBeNull()
    expect(view.controller.store.getSnapshot().reviewed).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it('lazy file preview preserves an explicit acknowledgement during view-only selection, search, and paging', async () => {
    const view = overlay()
    const files = Array.from({ length: 51 }, (_, index) => ({
      path: `customizations/file-${String(index).padStart(4, '0')}.txt`, before: null, after: `source-${String(index)}`,
    }))
    view.preview.mockResolvedValueOnce({ ...PREVIEW, files })
    await inspect()
    const list = fileList()
    const reviewed = screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed })
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishConfirm })
    fireEvent.click(reviewed)
    fireEvent.change(list, { target: { value: files[0]!.path } })
    fireEvent.click(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button'))
    expect(reviewed.checked).toBe(true)
    expect(confirm.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Next files' }))
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(reviewed.checked).toBe(true)
    expect(confirm.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Previous files' }))
    expect(reviewed.checked).toBe(true)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'file-0050' } })
    expect(list.value).toBe('')
    expect(fileOptions(list).map(option => option.value)).toEqual([files[50]!.path])
    expect(reviewed.checked).toBe(true)
    expect(confirm.disabled).toBe(false)
    fireEvent.change(list, { target: { value: files[50]!.path } })
    expect(renderedText()).toEqual([files[50]!.after])
    expect(reviewed.checked).toBe(true)
    expect(view.controller.store.getSnapshot().reviewed).toBe(true)
    expect(view.controller.store.getSnapshot().preview?.id).toBe(PREVIEW.id)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it('lazy file preview resets selection and escaped text for a new receipt with the same file path', async () => {
    const view = overlay()
    await inspect()
    fireEvent.change(fileList(), { target: { value: PREVIEW.files[0]!.path } })
    fireEvent.click(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button'))
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    const next = { ...PREVIEW, id: 'preview-2' as ForkPreviewId,
      files: [{ path: PREVIEW.files[0]!.path, before: 'new receipt before', after: 'new receipt after' }] }
    view.preview.mockResolvedValueOnce(next)
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishInspect }))
    await waitFor(() => { expect(view.controller.store.getSnapshot().preview?.id).toBe(next.id) })
    const list = fileList()
    expect(list.value).toBe('')
    expect(renderedText()).toEqual([])
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).checked).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishConfirm }).disabled).toBe(true)
    fireEvent.change(list, { target: { value: next.files[0]!.path } })
    expect(renderedText()).toEqual([next.files[0]!.before, next.files[0]!.after])
    expect(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.publish).not.toHaveBeenCalled()
  })

  it('clears the visible receipt and acknowledgement when the destination changes', async () => {
    const view = overlay()
    await inspect()
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    fireEvent.change(screen.getByRole('textbox', { name: en.forkBranch }), { target: { value: 'new-branch' } })
    expect(screen.queryByRole('checkbox', { name: en.forkPublishReviewed })).toBeNull()
    expect(screen.queryByRole('button', { name: en.forkPublishConfirm })).toBeNull()
    expect(view.controller.store.getSnapshot().preview).toBeNull()
  })

  it.each([['en', en], ['zh', zh]] as const)('explains unknown and committed effects and offers same-receipt recovery in %s', async (_locale, copy) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'unknown' })
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    expect(await screen.findByText(copy.forkPublishUnknown)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.forkPublishRetry })).toBeTruthy()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishRetry }))
    expect(await screen.findByText(copy.forkPublishCommitted)).toBeTruthy()
    await act(async () => { view.controller.close(); view.controller.open() })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(copy.forkPublishCommitted)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishRetry }))
    await screen.findByRole('link', { name: copy.forkPublishOpenPr })
    expect(view.publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true], [PREVIEW.id, true]])
  })

  it.each([
    ['auth-required', 'en', en, 'forkPublishAuthRequired'], ['auth-required', 'zh', zh, 'forkPublishAuthRequired'],
    ['too-large', 'en', en, 'forkPublishTooLarge'], ['too-large', 'zh', zh, 'forkPublishTooLarge'],
  ] as const)('retains %s discovery failure and explicit retry in %s', async (code, _locale, copy, key) => {
    const view = overlay(copy)
    view.repositories.mockResolvedValueOnce({ status: 'blocked', code, effect: 'none' })
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConnect }))
    expect(await screen.findByText(copy[key])).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.forkPublishConnect })).toBeTruthy()
    expect(view.repositories).toHaveBeenCalledOnce()
    expect(view.preview).not.toHaveBeenCalled()
  })

  it.each([['en', en], ['zh', zh]] as const)('links a closed or merged PR without suggesting another creation attempt in %s', async (_locale, copy) => {
    const view = overlay(copy)
    await inspect(copy)
    const pullRequestUrl = 'https://github.com/alice/harness/pull/1'
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'pull-request-closed', effect: 'committed', pullRequestUrl })
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    expect(await screen.findByText(copy.forkPublishPullRequestClosed)).toBeTruthy()
    expect(screen.queryByText(copy.forkPublishCommitted)).toBeNull()
    const link = screen.getByRole('link', { name: copy.forkPublishOpenPr })
    expect(link.getAttribute('href')).toBe(pullRequestUrl)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('button', { name: copy.forkPublishRetry })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(false)
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch })
    expect(branch.disabled).toBe(false)
    fireEvent.change(branch, { target: { value: 'creator/next-save' } })
    expect(screen.queryByRole('link', { name: copy.forkPublishOpenPr })).toBeNull()
    expect(view.publish).toHaveBeenCalledOnce()
    expect(view.openPullRequest).not.toHaveBeenCalled()
  })

  it('explains an empty authorized list without offering an arbitrary repository textbox', async () => {
    const view = overlay()
    view.repositories.mockResolvedValueOnce({ ...REPOSITORIES, repositories: [] })
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConnect }))
    expect(await screen.findByText(en.forkPublishEmpty)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: en.forkRepository })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishInspect }).disabled).toBe(true)
  })

  it.each(['invalid-repository', 'invalid-branch'] as const)('associates the Host %s refusal with its field', async (code) => {
    const view = overlay()
    view.preview.mockResolvedValueOnce({ status: 'blocked', code, effect: 'none' })
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConnect }))
    const repository = await screen.findByRole('combobox', { name: en.forkRepository })
    fireEvent.change(repository, { target: { value: PREVIEW.repository } })
    fireEvent.change(screen.getByRole('textbox', { name: en.forkBranch }), { target: { value: PREVIEW.branch } })
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishInspect }))
    const alert = await screen.findByRole('alert')
    const field = code === 'invalid-repository' ? repository : screen.getByRole('textbox', { name: en.forkBranch })
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('distinguishes safe preview refresh from same-receipt retry and retains a saved PR link when opening fails', async () => {
    const view = overlay()
    view.preview.mockResolvedValueOnce({ ...PREVIEW, head: null })
    await inspect()
    expect(screen.getByText(makeTranslate(en)('forkPublishNewBranch', { base: PREVIEW.base }))).toBeTruthy()
    expect(screen.queryByText(en.forkPublishBranchHistory)).toBeNull()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'conflict', effect: 'none' })
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConfirm }))
    expect(await screen.findByText(en.forkPublishNoEffects)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.forkPublishRetry })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishInspect }))
    await screen.findByRole('checkbox', { name: en.forkPublishReviewed })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'none' })
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConfirm }))
    const retry = await screen.findByRole('button', { name: en.forkPublishRetry })
    view.openPullRequest.mockImplementationOnce(() => { throw new Error('tab blocked') })
    fireEvent.click(retry)
    expect(await screen.findByText(en.forkPublishOpenFailed)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.forkPublishOpenPr })).toBeTruthy()
  })
})

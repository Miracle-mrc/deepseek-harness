// @vitest-environment jsdom
/** Fork publication presents authorized destinations and byte-exact review before any remote write. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ForkCommitId, ForkPreviewId, ForkPreviewResult, ForkPublishResult, ForkRepositoriesResult, ForkReviewResult,
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

const ACCESS_FAILURES = [
  { code: 'mixed-account', key: 'forkPublishMixedAccount' },
  { code: 'permission-denied', key: 'forkPublishPermissionDenied' },
  { code: 'not-found', key: 'forkPublishNotFound' },
  { code: 'wrong-fork', key: 'forkPublishWrongFork' },
  { code: 'auth-required', key: 'forkPublishAuthRequired' },
] as const
const ACCESS_LOCALES = [
  { locale: 'en', copy: en,
    retainedAccess: 'Restore GitHub access for the account and fork shown above. Inspect the branch and pull request on GitHub before retrying this same save.' },
  { locale: 'zh', copy: zh,
    retainedAccess: '恢复此 Host 上所显示账号及 Fork 的 GitHub 访问权限。请先在 GitHub 检查分支和拉取请求，再重试同一保存' },
] as const
const RECEIPT_LOCALES = [
  { locale: 'en', copy: en,
    lostReceipt: 'The approved save receipt is no longer available on this host. Inspect the original account, fork, branch and pull request on GitHub and finish manually before starting another save.',
    unknownOutcome: 'An earlier write may have reached GitHub; its outcome is still unknown.',
    committedOutcome: 'A commit was saved earlier; this host cannot confirm the pull request.' },
  { locale: 'zh', copy: zh,
    lostReceipt: '此 Host 上已无法使用已批准保存的回执。请在 GitHub 检查原账号、Fork、分支和拉取请求，并手动完成此次保存，再开始新的保存',
    unknownOutcome: '先前的写入可能已到达 GitHub，其结果仍未知',
    committedOutcome: '先前已保存提交，此 Host 无法确认拉取请求' },
] as const
const PR_REVIEW_LOCALES = [
  { locale: 'en', copy: en, branchContext: 'Current branch before this save', branchUpdate: 'Branch update',
    confirm: 'Confirm and open PR',
    context: 'Before shows the reviewed default branch; After shows the proposed pull request. Additional branch text shows different content this save will replace.',
    policy: 'GitHub may require signed or verified commits or other branch protection checks. Inspect the branch rules and pull request on GitHub before making further writes.' },
  { locale: 'zh', copy: zh, branchContext: '本次保存前的当前分支', branchUpdate: '分支更新',
    confirm: '确认并打开 PR',
    context: '改动前显示已审查的默认分支，改动后显示拟议拉取请求的内容。额外的分支文本显示此次保存将替换的不同内容',
    policy: 'GitHub 可能要求签名或已验证的提交，或其他分支保护检查。请先在 GitHub 检查分支规则和拉取请求，再进行后续写入' },
] as const
const REVIEW_EXTENSION_LOCALES = [
  { locale: 'en', copy: en, extend: 'Extend review', extending: 'Extending review',
    guidance: 'Previews can expire. Extend review rechecks the destination while preserving these exact files and individual checks; authorize the save again after it succeeds.',
    success: 'Review time extended. Your file checks are kept; confirm again before saving.' },
  { locale: 'zh', copy: zh, extend: '延长检查时间', extending: '正在延长检查时间',
    guidance: '预览可能过期。延长检查时间会重新检查目标，并保留这些精确文件和逐文件检查结果；成功后请重新授权保存',
    success: '已延长检查时间，并保留逐文件检查结果；保存前请重新确认' },
] as const

function overlay(copy = en) {
  const repositories = vi.fn(async (): Promise<ForkRepositoriesResult> => REPOSITORIES)
  const preview = vi.fn(async (): Promise<ForkPreviewResult> => PREVIEW)
  const extendReview = vi.fn(async (id: ForkPreviewId): Promise<ForkReviewResult> => ({ status: 'ready', id }))
  const publish = vi.fn(async (_id: ForkPreviewId, _confirmed: boolean): Promise<ForkPublishResult> => ({
    status: 'saved', repository: PREVIEW.repository, branch: PREVIEW.branch, commit: 'saved-commit' as ForkCommitId,
    pullRequestUrl: 'https://github.com/alice/harness/pull/1',
  }))
  const openPullRequest = vi.fn()
  const controller = new ForkPublishController({ repositories, preview, extendReview, publish, openPullRequest })
  controller.open()
  const props: ComponentProps<typeof ForkPublishOverlay> = {
    t: makeTranslate(copy), useForkPublish: bindSnapshotSelector(controller.store),
    close: () => { controller.close() }, connect: () => controller.connect(),
    edit: (field, value) => { controller.edit(field, value) }, inspect: () => controller.inspect(),
    extendReview: () => controller.extendReview(),
    selectFile: (id, path) => { controller.selectFile(id, path) },
    reviewFile: (id, path, value) => { controller.reviewFile(id, path, value) },
    review: (value) => { controller.review(value) }, publish: () => controller.publish(), retry: () => controller.retry(),
    dismissNotice: () => { controller.dismissNotice() },
  }
  render(<ForkPublishOverlay {...props} />)
  return { controller, repositories, preview, extendReview, publish, openPullRequest }
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

function reviewAllFiles(view: ReturnType<typeof overlay>, copy = en): void {
  const snapshot = view.controller.store.getSnapshot()
  if (snapshot.preview === null) throw new Error('Review requires a current preview')
  const remaining = snapshot.preview.files.length - snapshot.reviewedFiles.length
  for (let index = 0; index < remaining; index++) {
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishNextUnreviewed }))
    const file = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishFileReviewed })
    expect(file.checked).toBe(false)
    fireEvent.click(file)
  }
  expect(new Set(view.controller.store.getSnapshot().reviewedFiles)).toEqual(new Set(snapshot.preview.files.map(file => file.path)))
}

describe('direct fork publication dialog', () => {
  it.each(REVIEW_EXTENSION_LOCALES)('keeps 51-file progress and revokes final consent during review extension in $locale', async ({ copy, extend, extending, guidance, success }) => {
    const view = overlay(copy)
    const files = Array.from({ length: 51 }, (_, index) => ({
      path: `customizations/bundles/0/file-${String(index).padStart(4, '0')}.ts`, before: null,
      after: `\uFEFFexport const value = ${index}\r\n`,
    }))
    const preview = { ...PREVIEW, files }
    view.preview.mockResolvedValueOnce(preview)
    const pending = Promise.withResolvers<ForkReviewResult>()
    view.extendReview.mockReturnValueOnce(pending.promise)
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const extension = within(dialog).getByRole<HTMLButtonElement>('button', { name: extend })
    expect(within(dialog).getByText(guidance, { exact: true })).toBeTruthy()
    reviewAllFiles(view, copy)
    const progress = makeTranslate(copy)('forkPublishReviewProgress', { count: '51', total: '51' })
    const selected = view.controller.store.getSnapshot().activeFile
    const source = within(dialog).getByRole('region', { name: copy.forkPublishAfter }).querySelector('pre')
    expect(source?.textContent).toBe('\uFEFFexport const value = 50\r\n')
    const acknowledgement = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    fireEvent.click(acknowledgement)
    expect(confirm.disabled).toBe(false)
    fireEvent.click(extension)
    expect(view.extendReview).toHaveBeenCalledExactlyOnceWith(preview.id)
    expect(within(dialog).getByText(extending, { exact: true }).closest('[role="status"]')).not.toBeNull()
    expect(extension.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(true)
    expect(acknowledgement.disabled).toBe(true)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByText(progress, { exact: true })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: copy.forkPublishAfter }).querySelector('pre')).toBe(source)
    expect(view.controller.store.getSnapshot().activeFile).toBe(selected)
    expect(view.publish).not.toHaveBeenCalled()
    await act(async () => { pending.resolve({ status: 'ready', id: preview.id }); await pending.promise })
    await screen.findByText(success, { exact: true })
    expect(view.controller.store.getSnapshot().preview).toBe(preview)
    expect(view.controller.store.getSnapshot().reviewedFiles).toHaveLength(51)
    expect(within(dialog).getByText(progress, { exact: true })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: copy.forkPublishAfter }).querySelector('pre')).toBe(source)
    expect(acknowledgement.disabled).toBe(false)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    expect(extension.disabled).toBe(false)
    expect(within(dialog).getByText(copy.forkPublishPublicWarning, { exact: true })).toBeTruthy()
    fireEvent.click(acknowledgement)
    expect(confirm.disabled).toBe(false)
    expect(view.preview).toHaveBeenCalledTimes(1)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(REVIEW_EXTENSION_LOCALES)('requires successful review extension after a no-effect failure in $locale', async ({ copy, extend, success }) => {
    const view = overlay(copy)
    view.extendReview.mockResolvedValueOnce({ status: 'blocked', code: 'conflict', effect: 'none' })
    await inspect(copy)
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    const selected = view.controller.store.getSnapshot().activeFile
    fireEvent.click(screen.getByRole('button', { name: extend }))
    await screen.findByText(copy.forkPublishConflict, { exact: true })
    const acknowledgement = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    expect(view.controller.store.getSnapshot().phase).toBe('blocked')
    expect(view.controller.store.getSnapshot().preview).toBe(PREVIEW)
    expect(view.controller.store.getSnapshot().activeFile).toBe(selected)
    expect(view.controller.store.getSnapshot().reviewedFiles).toHaveLength(PREVIEW.files.length)
    expect(acknowledgement.disabled).toBe(true)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    fireEvent.click(acknowledgement)
    expect(view.controller.store.getSnapshot().reviewed).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: extend }))
    await screen.findByText(success, { exact: true })
    expect(view.extendReview.mock.calls).toEqual([[PREVIEW.id], [PREVIEW.id]])
    expect(acknowledgement.disabled).toBe(false)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(REVIEW_EXTENSION_LOCALES)('recovers a stale no-effect save through explicit review extension in $locale', async ({ copy, extend, success }) => {
    const view = overlay(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'stale-preview', effect: 'none' })
    await inspect(copy)
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    await screen.findByText(copy.forkPublishNoEffects, { exact: true })
    expect(screen.getByText(copy.forkPublishStalePreview, { exact: true }).textContent).toContain(extend)
    expect(screen.queryByRole('checkbox', { name: copy.forkPublishReviewed })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: extend }))
    await screen.findByText(success, { exact: true })
    expect(view.extendReview).toHaveBeenCalledExactlyOnceWith(PREVIEW.id)
    expect(view.controller.store.getSnapshot().operation).toBeNull()
    expect(view.controller.store.getSnapshot().preview).toBe(PREVIEW)
    expect(view.controller.store.getSnapshot().reviewedFiles).toHaveLength(PREVIEW.files.length)
    const acknowledgement = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    expect(acknowledgement.checked).toBe(false)
    expect(acknowledgement.disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm }).disabled).toBe(true)
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
    expect(view.preview).toHaveBeenCalledTimes(1)
  })

  it.each(REVIEW_EXTENSION_LOCALES.flatMap(locale => [51, 2000].map(count => ({ ...locale, count }))))('resumes the last of $count files and permits explicit review extension in $locale', async ({ copy, extend, success, count }) => {
    const view = overlay(copy)
    const files = Array.from({ length: count }, (_, index) => ({
      path: `customizations/bundles/0/file-${String(index).padStart(4, '0')}.ts`, before: null,
      after: `\uFEFFfile ${index}\r\n`,
    }))
    const preview = { ...PREVIEW, files }
    view.preview.mockResolvedValueOnce(preview)
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    expect(fileOptions(fileList(copy.forkPublishFileList))).toHaveLength(50)
    const name = `file-${String(count - 1).padStart(4, '0')}.ts`
    const path = `customizations/bundles/0/${name}`
    fireEvent.change(within(dialog).getByRole('searchbox', { name: copy.forkPublishSearchFiles }), { target: { value: name } })
    fireEvent.change(fileList(copy.forkPublishFileList), { target: { value: path } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: copy.forkPublishFileReviewed }))
    const [close] = within(dialog).getAllByRole('button', { name: copy.close })
    if (close === undefined) throw new Error('Close control is missing')
    fireEvent.click(close)
    expect(screen.queryByRole('dialog', { name: copy.forkPublishTitle })).toBeNull()
    expect(view.extendReview).not.toHaveBeenCalled()
    act(() => { view.controller.open() })
    const resumed = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    expect(fileList(copy.forkPublishFileList).value).toBe(path)
    expect([...resumed.querySelectorAll('pre')].map(node => node.textContent)).toEqual([`\uFEFFfile ${count - 1}\r\n`])
    expect(fileList(copy.forkPublishFileList).options.length).toBeLessThanOrEqual(51)
    expect(within(resumed).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishFileReviewed }).checked).toBe(true)
    expect(within(resumed).getByText(makeTranslate(copy)('forkPublishReviewProgress', { count: '1', total: String(count) }), { exact: true })).toBeTruthy()
    expect(view.controller.store.getSnapshot().preview).toBe(preview)
    expect(view.extendReview).not.toHaveBeenCalled()
    fireEvent.click(within(resumed).getByRole('button', { name: extend }))
    await screen.findByText(success, { exact: true })
    expect(view.controller.store.getSnapshot().activeFile).toBe(path)
    expect(view.controller.store.getSnapshot().reviewedFiles).toEqual([path])
    expect([...resumed.querySelectorAll('pre')].map(node => node.textContent)).toEqual([`\uFEFFfile ${count - 1}\r\n`])
    expect(within(resumed).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed }).disabled).toBe(true)
    expect(view.preview).toHaveBeenCalledTimes(1)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(REVIEW_EXTENSION_LOCALES.flatMap(locale => (['publishing', 'unknown', 'committed', 'saved'] as const)
    .map(status => ({ ...locale, status }))))('omits review extension during $status in $locale', async ({ copy, extend, status }) => {
    const view = overlay(copy)
    const pending = Promise.withResolvers<ForkPublishResult>()
    if (status === 'publishing') view.publish.mockReturnValueOnce(pending.promise)
    else if (status === 'unknown' || status === 'committed') {
      view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: status })
    }
    try {
      await inspect(copy)
      reviewAllFiles(view, copy)
      fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
      await waitFor(() => {
        expect(view.controller.store.getSnapshot().operation?.status).toBe(status === 'publishing' || status === 'saved' ? status : 'blocked')
      })
      expect(screen.queryByRole('button', { name: extend })).toBeNull()
      expect(view.extendReview).not.toHaveBeenCalled()
    } finally {
      if (status === 'publishing') await act(async () => {
        pending.resolve({ status: 'blocked', code: 'network', effect: 'unknown' })
        await pending.promise
      })
    }
  })

  it.each(REVIEW_EXTENSION_LOCALES)('omits review extension before a preview in $locale', ({ copy, extend }) => {
    const view = overlay(copy)
    expect(screen.queryByRole('button', { name: extend })).toBeNull()
    expect(view.extendReview).not.toHaveBeenCalled()
    expect(view.repositories).not.toHaveBeenCalled()
  })

  it.each([
    { locale: 'en', copy: en,
      warning: 'If this fork is public, saved source and retained branch history will be publicly accessible. Check them for private information before confirming.' },
    { locale: 'zh', copy: zh,
      warning: '如果此 Fork 为公开仓库，保存的源文件和保留的分支历史均可被公开访问。确认前请检查其中是否含有私人信息' },
  ])('warns about public fork source and history before final consent in $locale', async ({ copy, warning }) => {
    const view = overlay(copy)
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const notice = within(dialog).getByText(warning, { exact: true })
    const acknowledgement = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    expect(notice.compareDocumentPosition(acknowledgement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.controller.store.getSnapshot().reviewedFiles).toEqual([])
    expect(acknowledgement.disabled).toBe(true)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    reviewAllFiles(view, copy)
    expect(within(dialog).getByText(warning, { exact: true })).toBe(notice)
    expect(acknowledgement.disabled).toBe(false)
    expect(acknowledgement.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    fireEvent.click(acknowledgement)
    expect(confirm.disabled).toBe(false)
    expect(within(dialog).getByText(warning, { exact: true })).toBe(notice)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(PR_REVIEW_LOCALES)('requires every full-PR union path and resets that review for a new receipt in $locale', async ({ copy, context, branchUpdate }) => {
    const view = overlay(copy)
    const alreadyOnBranch = { ...PREVIEW.files[0]!, before: '// default branch\n', after: '// current export\n' }
    const restoration = { path: 'customizations/bundles/0/restored.ts', before: '// reviewed default\n',
      after: '// reviewed default\n', branchBefore: '// current branch differs\r\n' }
    const preview = { ...PREVIEW, files: [alreadyOnBranch, restoration, PREVIEW.files[1]!] }
    view.preview.mockResolvedValueOnce(preview)
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const files = fileList(copy.forkPublishFileList)
    const restorationOption = fileOptions(files).find(option => option.value === restoration.path)
    expect(restorationOption?.textContent).toBe(`${branchUpdate} · restored.ts — ${restoration.path}`)
    expect(within(dialog).getByText(context, { exact: true })).toBeTruthy()
    expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    const progress = (count: number): string => makeTranslate(copy)('forkPublishReviewProgress', { count: String(count), total: '3' })
    const acknowledgement = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    expect(acknowledgement.disabled).toBe(true)
    fireEvent.click(acknowledgement)
    fireEvent.click(confirm)
    expect(view.publish).not.toHaveBeenCalled()
    for (const [index, file] of preview.files.entries()) {
      fireEvent.change(files, { target: { value: file.path } })
      expect(within(dialog).getByText(progress(index), { exact: true })).toBeTruthy()
      expect(acknowledgement.disabled).toBe(true)
      const fileReview = within(dialog).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishFileReviewed })
      expect(fileReview.checked).toBe(false)
      fireEvent.click(fileReview)
      expect(within(dialog).getByText(progress(index + 1), { exact: true })).toBeTruthy()
      expect(acknowledgement.disabled).toBe(index + 1 !== preview.files.length)
      expect(acknowledgement.checked).toBe(false)
      expect(confirm.disabled).toBe(true)
    }
    fireEvent.click(acknowledgement)
    expect(confirm.disabled).toBe(false)
    const next = { ...preview, id: 'preview-union-reset' as ForkPreviewId }
    view.preview.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole('button', { name: copy.forkPublishInspect }))
    const reset = await within(dialog).findByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    expect(reset.disabled).toBe(true)
    expect(reset.checked).toBe(false)
    expect(within(dialog).getByText(progress(0), { exact: true })).toBeTruthy()
    expect(fileList(copy.forkPublishFileList).value).toBe('')
    expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    expect(view.controller.store.getSnapshot().preview?.id).toBe(next.id)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(PR_REVIEW_LOCALES.flatMap(locale => ([
    { kind: 'omitted', branchBefore: undefined }, { kind: 'absent', branchBefore: null },
    { kind: 'empty', branchBefore: '' }, { kind: 'BOM and CRLF', branchBefore: '\uFEFFbranch 😀\r\n\told\r\n' },
  ] as const).map(testCase => ({ ...locale, ...testCase }))))('mounts $kind branch context only for the selected file in $locale', async ({ copy, branchContext, branchBefore }) => {
    const view = overlay(copy)
    const file = { ...PREVIEW.files[0]!, before: '// reviewed default\n', after: '// proposed export\n',
      ...branchBefore === undefined ? {} : { branchBefore } }
    const preview = { ...PREVIEW, files: [file, PREVIEW.files[1]!] }
    view.preview.mockResolvedValueOnce(preview)
    await inspect(copy)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const files = fileList(copy.forkPublishFileList)
    expect(within(dialog).queryByRole('region', { name: branchContext })).toBeNull()
    expect(dialog.querySelectorAll('pre')).toHaveLength(0)
    fireEvent.change(files, { target: { value: file.path } })
    expect(within(dialog).getByRole('region', { name: copy.forkPublishBefore }).querySelector('pre')?.textContent).toBe(file.before)
    expect(within(dialog).getByRole('region', { name: copy.forkPublishAfter }).querySelector('pre')?.textContent).toBe(file.after)
    if (branchBefore === undefined) {
      expect(within(dialog).queryByRole('region', { name: branchContext })).toBeNull()
      expect(dialog.querySelectorAll('pre')).toHaveLength(2)
    } else {
      const branch = within(dialog).getByRole('region', { name: branchContext })
      if (branchBefore === null) {
        expect(within(branch).getByText(copy.forkPublishAbsent, { exact: true })).toBeTruthy()
        expect(branch.querySelectorAll('pre')).toHaveLength(0)
        expect(within(branch).queryByRole('button')).toBeNull()
      } else {
        expect(branch.querySelector('pre')?.textContent).toBe(branchBefore)
        const disclosure = within(branch).getByRole('button')
        expect(disclosure.getAttribute('aria-expanded')).toBe('false')
        const controlledId = disclosure.getAttribute('aria-controls')
        if (controlledId === null) throw new Error('Branch text disclosure requires a controlled element')
        expect(document.getElementById(controlledId)?.textContent).toBe('')
        fireEvent.click(disclosure)
        expect(disclosure.getAttribute('aria-expanded')).toBe('true')
        expect([...branch.querySelectorAll('pre')].map(element => element.textContent)).toEqual([branchBefore, JSON.stringify(branchBefore)])
      }
    }
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed }).disabled).toBe(true)
    fireEvent.change(files, { target: { value: PREVIEW.files[1]!.path } })
    expect(within(dialog).queryByRole('region', { name: branchContext })).toBeNull()
    expect([...dialog.querySelectorAll('pre')].map(element => element.textContent)).toEqual([PREVIEW.files[1]!.after])
    fireEvent.change(files, { target: { value: file.path } })
    if (typeof branchBefore === 'string') {
      const branch = within(dialog).getByRole('region', { name: branchContext })
      expect(within(branch).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      expect([...branch.querySelectorAll('pre')].map(element => element.textContent)).toEqual([branchBefore])
    }
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(PR_REVIEW_LOCALES)('uses a neutral publication action when a reviewed PR can reuse its existing commit in $locale', async ({ copy, confirm }) => {
    const view = overlay(copy)
    await inspect(copy)
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: confirm }).disabled).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(PR_REVIEW_LOCALES.flatMap(locale => (['permission-denied', 'conflict'] as const).flatMap(code =>
    (['none', 'unknown', 'committed'] as const).map(effect => ({ ...locale, code, effect })))))('shows possible branch-policy guidance for $code with $effect effects in $locale', async ({ copy, policy, code, effect }) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code, effect })
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const alert = await within(dialog).findByRole('alert')
    const retained = effect !== 'none'
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(retained)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(retained)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(retained)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(retained)
    if (retained) expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishRetry }).disabled).toBe(false)
    else expect(within(dialog).queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(within(alert).getByText(policy, { exact: true })).toBeTruthy()
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
  })

  it.each(PR_REVIEW_LOCALES.flatMap(locale => (['permission-denied', 'conflict'] as const).map(code => ({ ...locale, code }))))(
    'shows possible branch-policy guidance for a $code preview refusal in $locale', async ({ copy, policy, code }) => {
      const view = overlay(copy)
      view.preview.mockResolvedValueOnce({ status: 'blocked', code, effect: 'none' })
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConnect }))
      const repository = await screen.findByRole('combobox', { name: copy.forkRepository })
      fireEvent.change(repository, { target: { value: PREVIEW.repository } })
      fireEvent.change(screen.getByRole('textbox', { name: copy.forkBranch }), { target: { value: PREVIEW.branch } })
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishInspect }))
      const alert = await screen.findByRole('alert')
      expect(within(alert).getByText(policy, { exact: true })).toBeTruthy()
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(false)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(false)
      expect(screen.queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
      expect(view.publish).not.toHaveBeenCalled()
    })

  it.each([
    ['en', en, 'Files', 'I checked this file for private information', 'Next unreviewed file'],
    ['zh', zh, '文件', '我已检查此文件是否含有私人信息', '下一个未检查的文件'],
  ] as const)('per-file review disables global acknowledgement until each selected file is explicitly checked in %s', async (locale, copy, listLabel, fileLabel, nextLabel) => {
    const view = overlay(copy)
    await inspect(copy)
    const progress = (count: number): string => locale === 'zh' ? `已检查文件：${String(count)}/2` : `Files reviewed: ${String(count)}/2`
    const global = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    expect(global.disabled).toBe(true)
    expect(screen.getByText(progress(0), { exact: true })).toBeTruthy()
    fireEvent.click(global)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm }).disabled).toBe(true)
    expect(view.publish).not.toHaveBeenCalled()
    fireEvent.change(fileList(listLabel), { target: { value: PREVIEW.files[0]!.path } })
    expect(global.disabled).toBe(true)
    const file = screen.getByRole<HTMLInputElement>('checkbox', { name: fileLabel })
    expect(file.checked).toBe(false)
    fireEvent.click(file)
    expect(screen.getByText(progress(1), { exact: true })).toBeTruthy()
    expect(global.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: nextLabel }))
    expect(fileList(listLabel).value).toBe(PREVIEW.files[1]!.path)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: fileLabel }).checked).toBe(false)
    expect(screen.getByText(progress(1), { exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: fileLabel }))
    expect(screen.getByText(progress(2), { exact: true })).toBeTruthy()
    expect(global.disabled).toBe(false)
    expect(global.checked).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
    fireEvent.click(global)
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    await waitFor(() => { expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true) })
  })

  it.each([['en', en], ['zh', zh]] as const)('per-file review requires a new global acknowledgement after revoking a file in %s', async (locale, copy) => {
    const view = overlay(copy)
    await inspect(copy)
    reviewAllFiles(view, copy)
    const global = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConfirm })
    fireEvent.click(global)
    expect(confirm.disabled).toBe(false)
    fireEvent.change(fileList(locale === 'zh' ? '文件' : 'Files'), { target: { value: PREVIEW.files[0]!.path } })
    const file = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishFileReviewed })
    expect(file.checked).toBe(true)
    fireEvent.click(file)
    expect(screen.getByText(makeTranslate(copy)('forkPublishReviewProgress', { count: '1', total: '2' }), { exact: true })).toBeTruthy()
    expect(global.checked).toBe(false)
    expect(global.disabled).toBe(true)
    expect(confirm.disabled).toBe(true)
    fireEvent.click(global)
    fireEvent.click(confirm)
    expect(view.publish).not.toHaveBeenCalled()
    fireEvent.click(file)
    expect(screen.getByText(makeTranslate(copy)('forkPublishReviewProgress', { count: '2', total: '2' }), { exact: true })).toBeTruthy()
    expect(global.disabled).toBe(false)
    expect(global.checked).toBe(false)
    expect(confirm.disabled).toBe(true)
    fireEvent.click(global)
    expect(confirm.disabled).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(['main', 'master', 'develop'].flatMap(base => [
    { locale: 'en', copy: en, base, newBranch: `New branch from the selected fork’s ${base}`,
      intro: 'Load your authorized forks, choose a branch, and review every file. Confirmation creates or reuses the reviewed commit and pull request to the selected fork’s default branch.' },
    { locale: 'zh', copy: zh, base, newBranch: `从所选 Fork 的 ${base} 创建新分支`,
      intro: '加载已授权的 Fork，选择分支并检查每个文件。确认后将创建或复用已审查的提交，以及指向所选 Fork 默认分支的拉取请求' },
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
      reviewAllFiles(view, copy)
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
    reviewAllFiles(view, copy)
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

  it.each(ACCESS_LOCALES.flatMap(locale => ACCESS_FAILURES.flatMap(failure => (['unknown', 'committed'] as const)
    .map(effect => ({ ...locale, ...failure, effect })))))('gives retained-access recovery in $locale for $code with $effect effects', async ({ copy, retainedAccess, code, key, effect }) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code, effect })
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    await screen.findByText(effect === 'unknown' ? copy.forkPublishUnknown : copy.forkPublishCommitted)
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    expect(within(dialog).getByText(PREVIEW.account, { exact: true })).toBeTruthy()
    expect(within(dialog).getByText(`${PREVIEW.repository}:${PREVIEW.base}`, { exact: true })).toBeTruthy()
    const repository = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository })
    expect(repository.value).toBe(PREVIEW.repository)
    expect(repository.disabled).toBe(true)
    const branch = within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch })
    expect(branch.value).toBe(PREVIEW.branch)
    expect(branch.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishRetry }).disabled).toBe(false)
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
    const alert = within(dialog).getByRole('alert')
    expect(alert.firstElementChild?.textContent).toBe(retainedAccess)
    expect(within(alert).queryByText(copy[key], { exact: true })).toBeNull()
  })

  it.each(ACCESS_LOCALES.flatMap(locale => ACCESS_FAILURES.map(failure => ({ ...locale, ...failure }))))(
    'keeps ordinary access guidance in $locale for $code when publication has no effects', async ({ copy, retainedAccess, code, key }) => {
      const view = overlay(copy)
      await inspect(copy)
      view.publish.mockResolvedValueOnce({ status: 'blocked', code, effect: 'none' })
      reviewAllFiles(view, copy)
      fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
      const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
      const alert = await within(dialog).findByRole('alert')
      expect(alert.firstElementChild?.textContent).toBe(copy[key])
      expect(within(alert).queryByText(retainedAccess, { exact: true })).toBeNull()
      expect(within(alert).getByText(copy.forkPublishNoEffects, { exact: true })).toBeTruthy()
      expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(false)
      expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(false)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(false)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(false)
      expect(within(dialog).queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
      expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
    })

  it.each(RECEIPT_LOCALES.flatMap(locale => (['unknown', 'committed'] as const).map(effect => ({ ...locale, effect }))))(
    'retains approved $effect effects with lost-receipt recovery in $locale after retry', async ({ copy, lostReceipt, unknownOutcome, committedOutcome, effect }) => {
      const view = overlay(copy)
      await inspect(copy)
      view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect })
      reviewAllFiles(view, copy)
      fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
      await screen.findByText(effect === 'unknown' ? copy.forkPublishUnknown : copy.forkPublishCommitted)
      view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'stale-preview', effect: 'none' })
      fireEvent.click(screen.getByRole('button', { name: copy.forkPublishRetry }))
      await waitFor(() => {
        expect(view.publish).toHaveBeenCalledTimes(2)
        expect(view.controller.store.getSnapshot().operation?.status).toBe('blocked')
      })
      await act(async () => { view.controller.close(); view.controller.open() })
      const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
      const alert = within(dialog).getByRole('alert')
      expect(alert.firstElementChild?.textContent).toBe(lostReceipt)
      expect(within(alert).queryByText(copy.forkPublishStalePreview, { exact: true })).toBeNull()
      expect(within(alert).queryByText(copy.forkPublishNoEffects, { exact: true })).toBeNull()
      expect(alert.children[1]?.textContent).toBe(effect === 'unknown' ? unknownOutcome : committedOutcome)
      expect(within(alert).queryByText(copy.forkPublishUnknown, { exact: true })).toBeNull()
      expect(within(alert).queryByText(copy.forkPublishCommitted, { exact: true })).toBeNull()
      expect(view.controller.store.getSnapshot().operation).toMatchObject({
        status: 'blocked', preview: PREVIEW, failure: { code: 'stale-preview', effect },
      })
      expect(view.controller.store.getSnapshot().operation?.preview).toBe(PREVIEW)
      expect(within(dialog).getByText(`${PREVIEW.repository}:${PREVIEW.base}`, { exact: true })).toBeTruthy()
      expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(true)
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(true)
      expect(within(dialog).queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
      expect(within(dialog).queryByRole('checkbox')).toBeNull()
      expect(within(dialog).queryByRole('button', { name: copy.forkPublishNextUnreviewed })).toBeNull()
      expect(view.publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true]])
      expect(view.preview).toHaveBeenCalledOnce()
    })

  it.each(RECEIPT_LOCALES)('keeps ordinary stale-preview recovery in $locale before any save effects', async ({ copy, lostReceipt }) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'stale-preview', effect: 'none' })
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const alert = await within(dialog).findByRole('alert')
    expect(alert.firstElementChild?.textContent).toBe(copy.forkPublishStalePreview)
    expect(within(alert).getByText(copy.forkPublishNoEffects, { exact: true })).toBeTruthy()
    expect(within(alert).queryByText(lostReceipt, { exact: true })).toBeNull()
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(false)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(false)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(false)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(false)
    expect(within(dialog).queryByRole('button', { name: copy.forkPublishRetry })).toBeNull()
    const next = { ...PREVIEW, id: 'preview-fresh' as ForkPreviewId }
    view.preview.mockResolvedValueOnce(next)
    fireEvent.click(within(dialog).getByRole('button', { name: copy.forkPublishInspect }))
    const acknowledgement = await within(dialog).findByRole<HTMLInputElement>('checkbox', { name: copy.forkPublishReviewed })
    expect(acknowledgement.disabled).toBe(true)
    expect(acknowledgement.checked).toBe(false)
    expect(view.controller.store.getSnapshot()).toMatchObject({ preview: next, operation: null, reviewedFiles: [], reviewed: false })
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
  })

  it.each([['en', en], ['zh', zh]] as const)('retains committed recovery after a rejected retry transport in %s', async (_locale, copy) => {
    const view = overlay(copy)
    await inspect(copy)
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    reviewAllFiles(view, copy)
    fireEvent.click(screen.getByRole('checkbox', { name: copy.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishConfirm }))
    await screen.findByText(copy.forkPublishCommitted)
    view.publish.mockRejectedValueOnce(new Error('transport disconnected'))
    fireEvent.click(screen.getByRole('button', { name: copy.forkPublishRetry }))
    await waitFor(() => {
      expect(view.publish).toHaveBeenCalledTimes(2)
      expect(view.controller.store.getSnapshot().operation?.status).toBe('blocked')
    })
    const dialog = screen.getByRole('dialog', { name: copy.forkPublishTitle })
    const alert = within(dialog).getByRole('alert')
    expect(within(alert).getByText(copy.forkPublishCommitted, { exact: true })).toBeTruthy()
    expect(within(alert).queryByText(copy.forkPublishUnknown, { exact: true })).toBeNull()
    expect(within(alert).queryByText(copy.forkPublishNoEffects, { exact: true })).toBeNull()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({
      status: 'blocked', preview: PREVIEW, failure: { code: 'network', effect: 'committed' },
    })
    expect(view.controller.store.getSnapshot().operation?.preview).toBe(PREVIEW)
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: copy.forkRepository }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: copy.forkBranch }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishConnect }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishInspect }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: copy.forkPublishRetry }).disabled).toBe(false)
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(view.publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true]])
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
    fireEvent.click(within(dialog).getByRole('checkbox', { name: copy.forkPublishFileReviewed }))
    fireEvent.change(files, { target: { value: PREVIEW.files[1]!.path } })
    expect(dialog.textContent).toContain(copy.forkPublishAbsent)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: copy.forkPublishFileReviewed }))
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
      expect(screen.getByText('Files reviewed: 0/2000', { exact: true })).toBeTruthy()
      fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishFileReviewed }))
      expect(screen.getByText('Files reviewed: 1/2000', { exact: true })).toBeTruthy()
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).disabled).toBe(true)
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
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishFileReviewed }))
    expect(screen.getByText('Files reviewed: 1/101', { exact: true })).toBeTruthy()
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
    expect(screen.getByText(en.forkPublishNoMatchingFiles, { selector: '[role="status"]' }).textContent).toMatch(/no .*files|no .*matches|no .*results/i)
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(true)
    fireEvent.change(search, { target: { value: '' } })
    expect(fileOptions(list).map(option => option.value)).toEqual(files.slice(0, 50).map(file => file.path))
    expect(list.value).toBe('')
    expect(previous.disabled).toBe(true)
    expect(next.disabled).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).checked).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).disabled).toBe(true)
    expect(view.controller.store.getSnapshot().reviewedFiles).toEqual([files[49]!.path])
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(['repository', 'branch'] as const)('lazy file preview clears selected source and acknowledgement after a %s edit', async (field) => {
    const view = overlay()
    await inspect()
    reviewAllFiles(view)
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
    expect(view.controller.store.getSnapshot().reviewedFiles).toEqual([])
    expect(view.controller.store.getSnapshot().activeFile).toBeNull()
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
    expect(reviewed.disabled).toBe(true)
    expect(screen.getByText('Files reviewed: 0/51', { exact: true })).toBeTruthy()
    fireEvent.click(reviewed)
    fireEvent.click(confirm)
    expect(reviewed.checked).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
    fireEvent.change(list, { target: { value: files[0]!.path } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishFileReviewed }))
    expect(screen.getByText('Files reviewed: 1/51', { exact: true })).toBeTruthy()
    expect(reviewed.disabled).toBe(true)
    fireEvent.click(reviewed)
    fireEvent.click(confirm)
    await act(async () => {
      view.controller.review(true)
      await view.controller.publish()
    })
    expect(view.publish).not.toHaveBeenCalled()
    expect(view.controller.store.getSnapshot().reviewed).toBe(false)
    reviewAllFiles(view)
    expect(screen.getByText('Files reviewed: 51/51', { exact: true })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishNextUnreviewed }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous files' }))
    expect(reviewed.disabled).toBe(false)
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
    fireEvent.click(confirm)
    await waitFor(() => { expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true) })
  })

  it('lazy file preview resets selection and escaped text for a new receipt with the same file path', async () => {
    const view = overlay()
    await inspect()
    reviewAllFiles(view)
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
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishReviewed }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.forkPublishConfirm }).disabled).toBe(true)
    expect(screen.getByText('Files reviewed: 0/1', { exact: true })).toBeTruthy()
    expect(view.controller.store.getSnapshot().reviewedFiles).toEqual([])
    fireEvent.change(list, { target: { value: next.files[0]!.path } })
    expect(renderedText()).toEqual([next.files[0]!.before, next.files[0]!.after])
    expect(within(screen.getByRole('region', { name: en.forkPublishAfter })).getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.forkPublishFileReviewed }).checked).toBe(false)
    expect(view.publish).not.toHaveBeenCalled()
  })

  it('clears the visible receipt and acknowledgement when the destination changes', async () => {
    const view = overlay()
    await inspect()
    reviewAllFiles(view)
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
    reviewAllFiles(view, copy)
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
    fireEvent.change(fileList(copy === zh ? '文件' : 'Files'), { target: { value: PREVIEW.files[0]!.path } })
    expect(screen.getByRole('region', { name: copy.forkPublishBefore }).querySelector('pre')?.textContent).toBe(PREVIEW.files[0]!.before)
    expect(screen.queryByRole('checkbox', { name: copy.forkPublishFileReviewed })).toBeNull()
    expect(screen.queryByRole('button', { name: copy.forkPublishNextUnreviewed })).toBeNull()
    expect(view.controller.store.getSnapshot()).toMatchObject({ reviewedFiles: [], reviewed: false })
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
    reviewAllFiles(view, copy)
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
    reviewAllFiles(view)
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConfirm }))
    expect(await screen.findByText(en.forkPublishNoEffects)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.forkPublishRetry })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishInspect }))
    await screen.findByRole('checkbox', { name: en.forkPublishReviewed })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'none' })
    reviewAllFiles(view)
    fireEvent.click(screen.getByRole('checkbox', { name: en.forkPublishReviewed }))
    fireEvent.click(screen.getByRole('button', { name: en.forkPublishConfirm }))
    const retry = await screen.findByRole('button', { name: en.forkPublishRetry })
    view.openPullRequest.mockImplementationOnce(() => { throw new Error('tab blocked') })
    fireEvent.click(retry)
    expect(await screen.findByText(en.forkPublishOpenFailed)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.forkPublishOpenPr })).toBeTruthy()
  })
})

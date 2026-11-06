// @vitest-environment jsdom
/** Direct publication keeps discovery explicit and retries one already-approved Host receipt. */
import { describe, expect, it, vi } from 'vitest'
import type {
  ForkCommitId, ForkPreviewId, ForkPreviewResult, ForkPublishResult, ForkRepositoriesResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ForkPublishController } from '../src/client/fork-publish-store.ts'

const REPOSITORIES = {
  status: 'ready', account: 'alice', upstream: 'deepseek-ai/deepseek-harness',
  repositories: [{ repository: 'alice/harness', defaultBranch: 'trunk' }],
} satisfies ForkRepositoriesResult
const PREVIEW = {
  status: 'ready', id: 'preview-1' as ForkPreviewId, account: 'alice', repository: 'alice/harness',
  branch: 'creator/saved', upstream: REPOSITORIES.upstream, base: 'trunk', head: 'old-head' as ForkCommitId,
  files: [{ path: 'customizations/bundles/0/index.ts', before: 'export const value = 1', after: 'export const value = 1\n' }],
} satisfies ForkPreviewResult
const SAVED = {
  status: 'saved', repository: PREVIEW.repository, branch: PREVIEW.branch, commit: 'saved-commit' as ForkCommitId,
  pullRequestUrl: 'https://github.com/alice/harness/pull/1',
} satisfies ForkPublishResult

function bench() {
  const repositories = vi.fn(async (): Promise<ForkRepositoriesResult> => REPOSITORIES)
  const preview = vi.fn(async (): Promise<ForkPreviewResult> => PREVIEW)
  const publish = vi.fn(async (_id: ForkPreviewId, _confirmed: boolean): Promise<ForkPublishResult> => SAVED)
  const openPullRequest = vi.fn()
  const controller = new ForkPublishController({ repositories, preview, publish, openPullRequest })
  return { controller, repositories, preview, publish, openPullRequest }
}

function reviewEveryFile(controller: ForkPublishController): void {
  const preview = controller.store.getSnapshot().preview
  if (preview === null) throw new Error('Review requires a current preview')
  for (const file of preview.files) {
    controller.selectFile(preview.id, file.path)
    controller.reviewFile(preview.id, file.path, true)
  }
}

async function prepared(result: ForkPreviewResult = PREVIEW, reviewFiles = true) {
  const view = bench()
  view.preview.mockResolvedValueOnce(result)
  view.controller.open()
  await view.controller.connect()
  view.controller.edit('repository', PREVIEW.repository)
  view.controller.edit('branch', PREVIEW.branch)
  await view.controller.inspect()
  if (reviewFiles) reviewEveryFile(view.controller)
  return view
}

async function expectRetainedRetry(view: ReturnType<typeof bench>, effect: 'unknown' | 'committed', calls: number): Promise<void> {
  const operation = view.controller.store.getSnapshot().operation
  expect(operation).toMatchObject({ status: 'blocked', failure: { effect } })
  if (operation?.status !== 'blocked') throw new Error('Expected a retained failed publication')
  expect(operation.preview).toBe(PREVIEW)
  expect(operation.preview.files).toEqual(PREVIEW.files)
  expect(view.openPullRequest).not.toHaveBeenCalled()
  view.preview.mockResolvedValueOnce({ ...PREVIEW, id: 'unreviewed-replacement' as ForkPreviewId,
    files: [{ ...PREVIEW.files[0]!, after: 'unreviewed replacement bytes\n' }] })
  view.controller.edit('branch', 'creator/another')
  view.controller.close()
  view.controller.open()
  expect(view.controller.store.getSnapshot()).toMatchObject({ preview: null, reviewed: false, reviewedFiles: [] })
  expect(view.controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', preview: PREVIEW, failure: { effect } })
  await view.controller.connect()
  await view.controller.inspect()
  expect(view.repositories).toHaveBeenCalledOnce()
  expect(view.preview).toHaveBeenCalledOnce()
  await view.controller.retry()
  expect(view.publish.mock.calls).toEqual(Array.from({ length: calls }, () => [PREVIEW.id, true]))
  expect(view.controller.store.getSnapshot().operation).toMatchObject({ status: 'saved', preview: PREVIEW, result: SAVED })
  expect(view.openPullRequest).toHaveBeenCalledExactlyOnceWith(SAVED.pullRequestUrl)
}

describe('Creator fork publication', () => {
  it.each((['unknown', 'committed'] as const).flatMap(effect =>
    (['stale-preview', 'unavailable', 'timeout'] as const).map(code => ({ effect, code })),
  ))('retry effect knowledge retains $effect after a $code refusal without receipt evidence', async ({ effect, code }) => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code, effect: 'none' })
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', failure: { code, effect } })
    await expectRetainedRetry(view, effect, 3)
  })

  it('retry effect knowledge retains a known commit after a retry transport rejection', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    view.publish.mockRejectedValueOnce(new Error('retry response lost'))
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({
      status: 'blocked', failure: { code: 'network', effect: 'committed' },
    })
    await expectRetainedRetry(view, 'committed', 3)
  })

  it('retry effect knowledge retains a known commit when a later failed response reports only unknown effects', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'unknown' })
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    await expectRetainedRetry(view, 'committed', 3)
  })

  it('retry effect knowledge retains a known commit even when a later failure reports authoritative absence', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'auth-required', effect: 'none' })
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({
      status: 'blocked', failure: { code: 'auth-required', effect: 'committed' },
    })
    await expectRetainedRetry(view, 'committed', 3)
  })

  it('retry effect knowledge retains a commit learned after unknown effects when the next response is lost', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'unknown' })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'committed' })
    view.publish.mockRejectedValueOnce(new Error('later retry response lost'))
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', failure: { effect: 'committed' } })
    await view.controller.retry()
    await expectRetainedRetry(view, 'committed', 4)
  })

  it('retry effect knowledge leaves an initial stale receipt with no writes refreshable', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'stale-preview', effect: 'none' })
    view.controller.review(true)
    await view.controller.publish()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({
      status: 'blocked', failure: { code: 'stale-preview', effect: 'none' },
    })
    const next = { ...PREVIEW, id: 'new-preview' as ForkPreviewId, branch: 'creator/next' }
    view.preview.mockResolvedValueOnce(next)
    await view.controller.connect()
    view.controller.edit('branch', next.branch)
    await view.controller.inspect()
    expect(view.repositories).toHaveBeenCalledTimes(2)
    expect(view.preview).toHaveBeenCalledTimes(2)
    expect(view.controller.store.getSnapshot()).toMatchObject({ preview: next, operation: null, reviewed: false, reviewedFiles: [] })
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
  })

  it('retry effect knowledge permits an unknown write to resolve to authoritative absence for a surviving receipt', async () => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect: 'unknown' })
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'auth-required', effect: 'none' })
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().operation).toMatchObject({
      status: 'blocked', failure: { code: 'auth-required', effect: 'none' },
    })
    const next = { ...PREVIEW, id: 'new-preview' as ForkPreviewId, branch: 'creator/next' }
    view.preview.mockResolvedValueOnce(next)
    await view.controller.connect()
    view.controller.edit('branch', next.branch)
    await view.controller.inspect()
    expect(view.repositories).toHaveBeenCalledTimes(2)
    expect(view.preview).toHaveBeenCalledTimes(2)
    expect(view.controller.store.getSnapshot()).toMatchObject({ preview: next, operation: null, reviewed: false, reviewedFiles: [] })
    expect(view.publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true]])
  })

  it.each([0, 1, 51])('per-file review refuses global approval without individual marks for %s preview files', async (count) => {
    const files = Array.from({ length: count }, (_, index) => ({ path: `customizations/file-${String(index)}.txt`, before: null, after: 'reviewed bytes' }))
    const { controller, publish } = await prepared({ ...PREVIEW, files }, false)
    controller.review(true)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().reviewed).toBe(false)
    expect(controller.store.getSnapshot().operation).toBeNull()
    expect(controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [] })
    controller.store.set({ ...controller.store.getSnapshot(), reviewed: true })
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().operation).toBeNull()
  })

  it('per-file review refuses publication after checking only one of 51 files', async () => {
    const files = Array.from({ length: 51 }, (_, index) => ({ path: `customizations/file-${String(index)}.txt`, before: null, after: 'reviewed bytes' }))
    const { controller, publish } = await prepared({ ...PREVIEW, files }, false)
    controller.selectFile(PREVIEW.id, files[0]!.path)
    controller.reviewFile(PREVIEW.id, files[0]!.path, true)
    controller.review(true)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toMatchObject({ reviewed: false, reviewedFiles: [files[0]!.path] })
    controller.store.set({ ...controller.store.getSnapshot(), reviewed: true })
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().operation).toBeNull()
  })

  it('per-file review requires 51 explicit marks and a separate global acknowledgement', async () => {
    const files = Array.from({ length: 51 }, (_, index) => ({ path: `customizations/file-${String(index)}.txt`, before: null, after: 'reviewed bytes' }))
    const { controller, publish } = await prepared({ ...PREVIEW, files }, false)
    controller.review(true)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    for (const file of files) {
      controller.selectFile(PREVIEW.id, file.path)
      expect(controller.store.getSnapshot().reviewedFiles).not.toContain(file.path)
      controller.reviewFile(PREVIEW.id, file.path, true)
    }
    expect(controller.store.getSnapshot().reviewedFiles).toEqual(files.map(file => file.path))
    expect(controller.store.getSnapshot().reviewed).toBe(false)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    controller.review(true)
    await controller.publish()
    expect(publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
  })

  it('per-file review accepts only the active current file and ignores stale or invalid handlers', async () => {
    const other = { ...PREVIEW.files[0]!, path: 'customizations/other.txt' }
    const { controller, publish } = await prepared({ ...PREVIEW, files: [PREVIEW.files[0]!, other] }, false)
    const path = PREVIEW.files[0]!.path
    const stale = 'stale-preview' as ForkPreviewId
    controller.reviewFile(PREVIEW.id, path, true)
    controller.selectFile(stale, path)
    controller.selectFile(PREVIEW.id, 'customizations/missing.txt')
    expect(controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
    controller.selectFile(PREVIEW.id, path)
    expect(controller.store.getSnapshot()).toMatchObject({ activeFile: path, reviewedFiles: [] })
    controller.reviewFile(PREVIEW.id, other.path, true)
    controller.reviewFile(stale, path, true)
    controller.reviewFile(PREVIEW.id, 'customizations/missing.txt', true)
    controller.reviewFile(PREVIEW.id, path, false)
    expect(controller.store.getSnapshot().reviewedFiles).toEqual([])
    controller.reviewFile(PREVIEW.id, path, true)
    controller.selectFile(stale, other.path)
    controller.selectFile(PREVIEW.id, 'customizations/missing.txt')
    expect(controller.store.getSnapshot()).toMatchObject({ activeFile: path, reviewedFiles: [path], reviewed: false })
    controller.selectFile(PREVIEW.id, null)
    controller.reviewFile(PREVIEW.id, path, false)
    expect(controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [path], reviewed: false })
    expect(publish).not.toHaveBeenCalled()
  })

  it('per-file review revokes global acknowledgement only when an actual file mark changes', async () => {
    const first = PREVIEW.files[0]!
    const last = { ...first, path: 'customizations/last.txt' }
    const { controller, publish } = await prepared({ ...PREVIEW, files: [first, last] })
    controller.review(true)
    expect(controller.store.getSnapshot().reviewed).toBe(true)
    controller.reviewFile(PREVIEW.id, last.path, true)
    controller.reviewFile(PREVIEW.id, first.path, false)
    controller.reviewFile('stale-preview' as ForkPreviewId, last.path, false)
    controller.reviewFile(PREVIEW.id, 'customizations/missing.txt', false)
    expect(controller.store.getSnapshot().reviewed).toBe(true)
    expect(controller.store.getSnapshot().reviewedFiles).toEqual([first.path, last.path])
    controller.selectFile(PREVIEW.id, null)
    expect(controller.store.getSnapshot().reviewed).toBe(true)
    controller.selectFile(PREVIEW.id, last.path)
    controller.reviewFile(PREVIEW.id, last.path, false)
    expect(controller.store.getSnapshot()).toMatchObject({ reviewedFiles: [first.path], reviewed: false })
    controller.review(true)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    controller.reviewFile(PREVIEW.id, last.path, true)
    expect(controller.store.getSnapshot().reviewed).toBe(false)
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    controller.review(true)
    controller.review(false)
    expect(controller.store.getSnapshot()).toMatchObject({ reviewedFiles: [first.path, last.path], reviewed: false })
    controller.review(true)
    await controller.publish()
    expect(publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
  })

  it.each(['repository', 'branch', 'connect', 'inspect', 'close', 'dispose'] as const)(
    'per-file review resets marks and selection after %s and refuses callbacks for the old receipt', async (action) => {
      const view = await prepared()
      view.controller.review(true)
      const next = { ...PREVIEW, id: 'preview-2' as ForkPreviewId }
      if (action === 'connect') await view.controller.connect()
      else if (action === 'inspect') {
        view.preview.mockResolvedValueOnce(next)
        await view.controller.inspect()
      } else if (action === 'close') view.controller.close()
      else if (action === 'dispose') view.controller.dispose()
      else view.controller.edit(action, 'changed')
      expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
      view.controller.selectFile(PREVIEW.id, PREVIEW.files[0]!.path)
      view.controller.reviewFile(PREVIEW.id, PREVIEW.files[0]!.path, true)
      view.controller.review(true)
      await view.controller.publish()
      expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
      expect(view.publish).not.toHaveBeenCalled()
      if (action === 'inspect') {
        expect(view.controller.store.getSnapshot().preview?.id).toBe(next.id)
        view.controller.selectFile(next.id, PREVIEW.files[0]!.path)
        expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: PREVIEW.files[0]!.path, reviewedFiles: [] })
      }
    },
  )

  it.each(['connect', 'inspect'] as const)('per-file review ignores old handlers while %s is pending', async (action) => {
    const view = await prepared()
    view.controller.review(true)
    const discovery = Promise.withResolvers<ForkRepositoriesResult>()
    const inspection = Promise.withResolvers<ForkPreviewResult>()
    if (action === 'connect') view.repositories.mockReturnValueOnce(discovery.promise)
    else view.preview.mockReturnValueOnce(inspection.promise)
    const pending = action === 'connect' ? view.controller.connect() : view.controller.inspect()
    view.controller.selectFile(PREVIEW.id, PREVIEW.files[0]!.path)
    view.controller.reviewFile(PREVIEW.id, PREVIEW.files[0]!.path, true)
    view.controller.review(true)
    expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
    discovery.resolve(REPOSITORIES)
    inspection.resolve({ ...PREVIEW, id: 'preview-2' as ForkPreviewId })
    await pending
    expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
    expect(view.publish).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'committed'] as const)('per-file review keeps retained %s receipts browseable without permitting new marks', async (effect) => {
    const view = await prepared()
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect })
    view.controller.review(true)
    await view.controller.publish()
    view.controller.edit('branch', 'creator/another')
    view.controller.close()
    view.controller.open()
    view.controller.selectFile('stale-preview' as ForkPreviewId, PREVIEW.files[0]!.path)
    expect(view.controller.store.getSnapshot().activeFile).toBeNull()
    view.controller.selectFile(PREVIEW.id, PREVIEW.files[0]!.path)
    expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: PREVIEW.files[0]!.path, reviewedFiles: [], reviewed: false })
    view.controller.reviewFile(PREVIEW.id, PREVIEW.files[0]!.path, true)
    view.controller.review(true)
    expect(view.controller.store.getSnapshot()).toMatchObject({ reviewedFiles: [], reviewed: false })
    await view.controller.retry()
    expect(view.publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true]])
    expect(view.controller.store.getSnapshot().operation?.status).toBe('saved')
  })

  it('per-file review cannot revoke an already approved pending operation', async () => {
    const view = await prepared()
    const pending = Promise.withResolvers<ForkPublishResult>()
    view.publish.mockReturnValueOnce(pending.promise)
    view.controller.review(true)
    const publication = view.controller.publish()
    view.controller.reviewFile(PREVIEW.id, PREVIEW.files[0]!.path, false)
    view.controller.review(false)
    expect(view.controller.store.getSnapshot()).toMatchObject({ reviewedFiles: [PREVIEW.files[0]!.path], reviewed: true })
    view.controller.close()
    expect(view.controller.store.getSnapshot()).toMatchObject({ activeFile: null, reviewedFiles: [], reviewed: false })
    pending.resolve(SAVED)
    await publication
    expect(view.publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
    expect(view.controller.store.getSnapshot().operation?.status).toBe('saved')
  })

  it('makes no requests until explicit discovery and keeps only the authorized repository choices', async () => {
    const { controller, repositories, preview, publish } = bench()
    controller.open()
    controller.close()
    controller.open()
    expect(repositories).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    await controller.connect()
    expect(repositories).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().repositories).toBe(REPOSITORIES)
    expect(controller.store.getSnapshot().repository).toBe('')
    controller.edit('repository', 'bob/unlisted')
    controller.edit('branch', PREVIEW.branch)
    await controller.inspect()
    expect(preview).not.toHaveBeenCalled()
  })

  it('publishes only an explicitly reviewed receipt, without sending source bytes or rediscovering', async () => {
    const { controller, repositories, preview, publish, openPullRequest } = await prepared()
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
    controller.review(true)
    await controller.publish()
    expect(publish).toHaveBeenCalledExactlyOnceWith(PREVIEW.id, true)
    expect(preview).toHaveBeenCalledExactlyOnceWith({ repository: PREVIEW.repository, branch: PREVIEW.branch })
    expect(repositories).toHaveBeenCalledOnce()
    expect(openPullRequest).toHaveBeenCalledExactlyOnceWith(SAVED.pullRequestUrl)
    expect(controller.store.getSnapshot().operation).toMatchObject({ status: 'saved', result: SAVED })
  })

  it.each(['main', 'master', 'trunk'])('refuses the destination default branch %s before requesting a preview', async (branch) => {
    const { controller, preview } = bench()
    controller.open()
    await controller.connect()
    controller.edit('repository', PREVIEW.repository)
    controller.edit('branch', branch)
    await controller.inspect()
    expect(preview).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().failure?.code).toBe('default-branch')
  })

  it.each(['repository', 'branch', 'close'] as const)('invalidates the preview and acknowledgement after %s', async (action) => {
    const { controller, publish } = await prepared()
    controller.review(true)
    if (action === 'close') controller.close()
    else controller.edit(action, 'changed')
    expect(controller.store.getSnapshot()).toMatchObject({ preview: null, reviewed: false })
    await controller.publish()
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(['connect', 'inspect'] as const)('discards a late %s result after closing', async (action) => {
    const view = bench()
    view.controller.open()
    const discovery = Promise.withResolvers<ForkRepositoriesResult>()
    const inspection = Promise.withResolvers<ForkPreviewResult>()
    if (action === 'connect') view.repositories.mockReturnValueOnce(discovery.promise)
    else {
      await view.controller.connect()
      view.controller.edit('repository', PREVIEW.repository)
      view.controller.edit('branch', PREVIEW.branch)
      view.preview.mockReturnValueOnce(inspection.promise)
    }
    const request = action === 'connect' ? view.controller.connect() : view.controller.inspect()
    view.controller.close()
    discovery.resolve(REPOSITORIES)
    inspection.resolve(PREVIEW)
    await request
    expect(view.controller.store.getSnapshot()).toMatchObject({ open: false, phase: 'idle', preview: null, reviewed: false })
    if (action === 'connect') expect(view.controller.store.getSnapshot().repositories).toBeNull()
  })

  it('prevents duplicate submissions and retains the result when the review closes during publication', async () => {
    const { controller, publish, openPullRequest } = await prepared()
    const pending = Promise.withResolvers<ForkPublishResult>()
    publish.mockReturnValueOnce(pending.promise)
    controller.review(true)
    const first = controller.publish()
    await controller.publish()
    controller.close()
    pending.resolve(SAVED)
    await first
    expect(publish).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({ open: false, preview: null, reviewed: false, operation: { status: 'saved', result: SAVED } })
    expect(openPullRequest).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'committed'] as const)('retains an approved receipt after %s effects and reconciles that same receipt', async (effect) => {
    const { controller, publish, preview } = await prepared()
    publish.mockResolvedValueOnce({ status: 'blocked', code: 'network', effect })
    controller.review(true)
    await controller.publish()
    expect(controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', preview: PREVIEW, failure: { effect } })
    controller.edit('branch', 'another-branch')
    controller.close()
    controller.open()
    expect(controller.store.getSnapshot()).toMatchObject({ preview: null, reviewed: false })
    await controller.inspect()
    expect(preview).toHaveBeenCalledOnce()
    await controller.retry()
    expect(publish.mock.calls).toEqual([[PREVIEW.id, true], [PREVIEW.id, true]])
    expect(controller.store.getSnapshot().operation).toMatchObject({ status: 'saved', result: SAVED })
  })

  it('treats a lost publication response as unknown and allows an explicit same-receipt retry', async () => {
    const { controller, publish } = await prepared()
    publish.mockRejectedValueOnce(new Error('connection lost'))
    controller.review(true)
    await controller.publish()
    expect(controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', failure: { code: 'network', effect: 'unknown' } })
    await controller.retry()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it.each(['edit', 'inspect'] as const)('allows a new save after a committed closed PR and clears its receipt on %s', async (action) => {
    const view = await prepared()
    const pullRequestUrl = 'https://github.com/alice/harness/pull/1'
    view.publish.mockResolvedValueOnce({ status: 'blocked', code: 'pull-request-closed', effect: 'committed', pullRequestUrl })
    view.controller.review(true)
    await view.controller.publish()
    await view.controller.connect()
    expect(view.repositories).toHaveBeenCalledTimes(2)
    expect(view.controller.store.getSnapshot().operation).toMatchObject({ status: 'blocked', failure: { pullRequestUrl } })
    if (action === 'edit') view.controller.edit('branch', 'creator/next-save')
    else await view.controller.inspect()
    expect(view.controller.store.getSnapshot()).toMatchObject({ operation: null, reviewed: false })
    expect(view.publish).toHaveBeenCalledOnce()
    if (action === 'inspect') expect(view.preview).toHaveBeenCalledTimes(2)
  })

  it('permits discovery and inspection retries after read failures without publishing', async () => {
    const { controller, repositories, preview, publish } = bench()
    repositories.mockRejectedValueOnce(new Error('offline'))
    controller.open()
    await controller.connect()
    expect(controller.store.getSnapshot().failure).toMatchObject({ code: 'network', effect: 'none' })
    await controller.connect()
    controller.edit('repository', PREVIEW.repository)
    controller.edit('branch', PREVIEW.branch)
    preview.mockResolvedValueOnce({ status: 'blocked', code: 'conflict', effect: 'none' })
    await controller.inspect()
    expect(controller.store.getSnapshot().failure?.code).toBe('conflict')
    await controller.inspect()
    expect(controller.store.getSnapshot().preview).toBe(PREVIEW)
    expect(publish).not.toHaveBeenCalled()
  })

  it('preserves a selected authorized repository across an explicit refresh', async () => {
    const { controller, repositories } = await prepared()
    await controller.connect()
    expect(repositories).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({ repository: PREVIEW.repository, preview: null, reviewed: false })
  })

  it.each(['connect', 'inspect'] as const)('discards a rejected %s after editing or disposal', async (action) => {
    for (const interruption of ['edit', 'dispose'] as const) {
      const view = bench()
      view.controller.open()
      const rejected = Promise.withResolvers<never>()
      if (action === 'connect') view.repositories.mockReturnValueOnce(rejected.promise)
      else {
        await view.controller.connect()
        view.controller.edit('repository', PREVIEW.repository)
        view.controller.edit('branch', PREVIEW.branch)
        view.preview.mockReturnValueOnce(rejected.promise)
      }
      const request = action === 'connect' ? view.controller.connect() : view.controller.inspect()
      if (interruption === 'dispose') view.controller.dispose()
      else view.controller.edit('branch', 'another-branch')
      rejected.reject(new Error('stale request failed'))
      await request
      expect(view.controller.store.getSnapshot()).toMatchObject({ phase: 'idle', preview: null, failure: null })
    }
  })

  it('keeps the form available after a preview transport failure', async () => {
    const view = await prepared()
    view.preview.mockRejectedValueOnce(new Error('offline'))
    await view.controller.inspect()
    expect(view.controller.store.getSnapshot()).toMatchObject({ phase: 'blocked', failure: { code: 'network', effect: 'none' } })
    await view.controller.inspect()
    expect(view.controller.store.getSnapshot().preview).toBe(PREVIEW)
  })

  it('ignores review without a preview and while an approved write is in progress', async () => {
    const view = bench()
    view.controller.open()
    view.controller.review(true)
    expect(view.controller.store.getSnapshot().reviewed).toBe(false)
    await view.controller.connect()
    view.controller.edit('repository', PREVIEW.repository)
    view.controller.edit('branch', PREVIEW.branch)
    await view.controller.inspect()
    reviewEveryFile(view.controller)
    view.controller.review(true)
    const pending = Promise.withResolvers<ForkPublishResult>()
    view.publish.mockReturnValueOnce(pending.promise)
    const publication = view.controller.publish()
    view.controller.review(false)
    await view.controller.retry()
    expect(view.controller.store.getSnapshot().reviewed).toBe(true)
    expect(view.publish).toHaveBeenCalledOnce()
    pending.resolve(SAVED)
    await publication
  })

  it('does not open a browser tab after disposal while the Host settles an approved write', async () => {
    const view = await prepared()
    const pending = Promise.withResolvers<ForkPublishResult>()
    view.publish.mockReturnValueOnce(pending.promise)
    view.controller.review(true)
    const publication = view.controller.publish()
    view.controller.dispose()
    pending.resolve(SAVED)
    await publication
    expect(view.openPullRequest).not.toHaveBeenCalled()
    expect(view.controller.store.getSnapshot().notice).toBeNull()
  })

  it('keeps the successful publication available when opening its PR fails', async () => {
    const { controller, openPullRequest } = await prepared()
    openPullRequest.mockImplementationOnce(() => { throw new Error('browser refused') })
    controller.review(true)
    await controller.publish()
    expect(controller.store.getSnapshot().operation).toMatchObject({ status: 'saved', result: SAVED, openFailed: true })
  })

  it('invalidates reads and refuses new work after disposal', async () => {
    const { controller, repositories, publish } = bench()
    const pending = Promise.withResolvers<ForkRepositoriesResult>()
    repositories.mockReturnValueOnce(pending.promise)
    controller.open()
    const discovery = controller.connect()
    controller.dispose()
    pending.resolve(REPOSITORIES)
    await discovery
    controller.open()
    await controller.connect()
    await controller.publish()
    controller.edit('branch', 'ignored-after-disposal')
    controller.review(true)
    await controller.inspect()
    await controller.retry()
    expect(repositories).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().preview).toBeNull()
  })

  it('does not discover or inspect while the dialog is closed', async () => {
    const view = bench()
    await view.controller.connect()
    await view.controller.inspect()
    await view.controller.retry()
    expect(view.repositories).not.toHaveBeenCalled()
    expect(view.preview).not.toHaveBeenCalled()
    expect(view.publish).not.toHaveBeenCalled()
  })
})

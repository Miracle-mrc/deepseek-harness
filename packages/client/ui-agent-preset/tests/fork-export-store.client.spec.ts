// @vitest-environment jsdom
/** Source export retains reviewed bytes through browser failures and rejects stale inspections. */
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForkExportController, downloadForkExport, type ReadySourceExport } from '../src/client/fork-export-store.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const READY: ReadySourceExport = {
  status: 'ready', formatVersion: 1, repository: 'alice/harness', branch: 'my-changes', profile: 'web', reviewRequired: true,
  files: [{ path: 'profiles/saved/cordis.patch.yml', content: 'entries: []\n' }],
}

function bench() {
  const prepare = vi.fn(async () => READY)
  const save = vi.fn()
  const controller = new ForkExportController(prepare, save)
  controller.open()
  controller.edit('repository', READY.repository)
  controller.edit('branch', READY.branch)
  return { controller, prepare, save }
}

describe('source export review', () => {
  it('downloads only the exact captured result after review, without reading it again', async () => {
    const { controller, prepare, save } = bench()
    controller.download()
    controller.review(true)
    expect(controller.store.getSnapshot().reviewed).toBe(false)
    await controller.inspect()
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ repository: READY.repository, branch: READY.branch })
    controller.download()
    expect(save).not.toHaveBeenCalled()
    controller.review(true)
    controller.download()
    expect(save).toHaveBeenCalledExactlyOnceWith(READY)
    expect(save.mock.calls[0]![0]).toBe(READY)
    expect(prepare).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().notice?.kind).toBe('downloaded')
    controller.dismissNotice()
    expect(controller.store.getSnapshot().notice).toBeNull()
  })

  it.each(['repository', 'branch'] as const)('invalidates captured files and acknowledgement when %s changes', async (field) => {
    const { controller, save } = bench()
    await controller.inspect()
    controller.review(true)
    controller.edit(field, 'new-target')
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'idle', preview: null, reviewed: false, [field]: 'new-target' })
    controller.download()
    expect(save).not.toHaveBeenCalled()
  })

  it('retains form values after an inspection refusal and after closing', async () => {
    const prepare = vi.fn(async () => ({ status: 'blocked' as const, issues: [{ code: 'invalid-branch' as const }] }))
    const controller = new ForkExportController(prepare)
    controller.open()
    controller.edit('repository', 'alice/harness')
    controller.edit('branch', 'master')
    await controller.inspect()
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'blocked', issues: [{ code: 'invalid-branch' }], preview: null })
    controller.close()
    controller.open()
    expect(controller.store.getSnapshot()).toMatchObject({ repository: 'alice/harness', branch: 'master', issues: [], phase: 'idle' })
  })

  it('reports transport failure and permits an explicit retry', async () => {
    const { controller, prepare } = bench()
    prepare.mockRejectedValueOnce(new Error('transport disconnected'))
    await controller.inspect()
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'failed', preview: null, repository: READY.repository })
    await controller.inspect()
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', preview: READY })
  })

  it.each(['edit', 'close', 'dispose'] as const)('discards a pending result after %s', async (action) => {
    const { controller, prepare } = bench()
    const pending = Promise.withResolvers<ReadySourceExport>()
    prepare.mockReturnValueOnce(pending.promise)
    const inspection = controller.inspect()
    await controller.inspect()
    expect(prepare).toHaveBeenCalledOnce()
    if (action === 'edit') controller.edit('branch', 'new-branch')
    else controller[action]()
    pending.resolve(READY)
    await inspection
    expect(controller.store.getSnapshot().preview).toBeNull()
    if (action === 'close') {
      await controller.inspect()
      expect(prepare).toHaveBeenCalledOnce()
      expect(controller.store.getSnapshot().open).toBe(false)
    }
  })

  it('discards a failed pending request after editing', async () => {
    const { controller, prepare } = bench()
    const pending = Promise.withResolvers<ReadySourceExport>()
    prepare.mockReturnValueOnce(pending.promise)
    const inspection = controller.inspect()
    controller.edit('branch', 'new-branch')
    pending.reject(new Error('old request failed'))
    await inspection
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'idle', preview: null })
  })

  it('keeps the reviewed preview after a browser save failure and can retry the same bytes', async () => {
    const { controller, prepare, save } = bench()
    save.mockImplementationOnce(() => { throw new Error('download denied') })
    await controller.inspect()
    controller.review(true)
    controller.download()
    expect(controller.store.getSnapshot()).toMatchObject({ preview: READY, reviewed: true, notice: { kind: 'download-failed' } })
    const seq = controller.store.getSnapshot().notice?.seq
    controller.download()
    expect(controller.store.getSnapshot().notice).toMatchObject({ kind: 'downloaded' })
    expect(controller.store.getSnapshot().notice?.seq).not.toBe(seq)
    expect(prepare).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledTimes(2)
    controller.close()
    controller.download()
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe('local source export download', () => {
  function browser() {
    vi.useFakeTimers()
    vi.stubGlobal('Blob', NodeBlob)
    const objects: Blob[] = []
    const create = vi.fn((blob: Blob) => { objects.push(blob); return `blob:source-export-${objects.length}` })
    const revoke = vi.fn()
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL {
      static override createObjectURL = create
      static override revokeObjectURL = revoke
    })
    const clicked: { href: string; filename: string }[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, filename: this.download })
    })
    return { objects, create, revoke, clicked, click }
  }

  it('downloads the complete JSON and retains the URL through a bounded browser-start grace period', async () => {
    const { objects, revoke, clicked } = browser()
    downloadForkExport(READY)
    expect(clicked).toEqual([{ href: 'blob:source-export-1', filename: 'dsh-source-export.json' }])
    expect(objects[0]!.type).toBe('application/json')
    expect(await objects[0]!.text()).toBe(`${JSON.stringify(READY, null, 2)}\n`)
    expect(document.querySelector('a[download]')).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(39_999)
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:source-export-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires repeated downloads independently and detaches their abort listeners', async () => {
    const { revoke } = browser()
    const lifetime = new AbortController()
    const remove = vi.spyOn(lifetime.signal, 'removeEventListener')
    downloadForkExport(READY, lifetime.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    downloadForkExport(READY, lifetime.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(revoke.mock.calls).toEqual([['blob:source-export-1']])
    expect(remove).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(revoke.mock.calls).toEqual([['blob:source-export-1'], ['blob:source-export-2']])
    expect(remove).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    lifetime.abort()
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('releases a URL and cancels its timer when the download lifetime ends', async () => {
    const { revoke } = browser()
    const lifetime = new AbortController()
    downloadForkExport(READY, lifetime.signal)
    lifetime.abort()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:source-export-1')
    expect(vi.getTimerCount()).toBe(0)
    lifetime.abort()
    await vi.runAllTimersAsync()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('creates no URL or download after the lifetime has ended', () => {
    const { create, revoke, click } = browser()
    const lifetime = new AbortController()
    lifetime.abort(new Error('feature unloaded'))
    expect(() => { downloadForkExport(READY, lifetime.signal) }).toThrow('feature unloaded')
    expect(create).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['createElement', 'append', 'click'] as const)('releases the URL immediately when %s fails', (operation) => {
    const { revoke, click } = browser()
    const lifetime = new AbortController()
    const remove = vi.spyOn(lifetime.signal, 'removeEventListener')
    const fail = () => { throw new Error('download denied') }
    if (operation === 'createElement') vi.spyOn(document, 'createElement').mockImplementationOnce(fail)
    else if (operation === 'append') vi.spyOn(document.body, 'append').mockImplementationOnce(fail)
    else click.mockImplementationOnce(fail)
    expect(() => { downloadForkExport(READY, lifetime.signal) }).toThrow('download denied')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:source-export-1')
    expect(remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    lifetime.abort()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it.each([false, true])('leaves no timer when a click ends its own lifetime (throws: %s)', (throws) => {
    const { revoke, click } = browser()
    const lifetime = new AbortController()
    click.mockImplementationOnce(() => {
      lifetime.abort()
      if (throws) throw new Error('feature unloaded')
    })
    const download = () => { downloadForkExport(READY, lifetime.signal) }
    if (throws) expect(download).toThrow('feature unloaded')
    else download()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:source-export-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps closed-dialog downloads alive and releases every pending URL when the controller unloads', async () => {
    const { revoke, create } = browser()
    const prepare = vi.fn(async () => READY)
    const controller = new ForkExportController(prepare)
    controller.open()
    await controller.inspect()
    controller.review(true)
    controller.download()
    await vi.advanceTimersByTimeAsync(10_000)
    controller.download()
    controller.close()
    expect(revoke).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(2)
    controller.dispose()
    expect(revoke.mock.calls).toEqual([['blob:source-export-1'], ['blob:source-export-2']])
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
    await vi.runAllTimersAsync()
    expect(revoke).toHaveBeenCalledTimes(2)
    controller.open()
    await controller.inspect()
    controller.review(true)
    controller.download()
    expect(create).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().notice?.kind).toBe('download-failed')
  })
})

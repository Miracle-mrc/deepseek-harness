/** Captured source-export review and local download state, independent of the Plugins panel. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SourceExportRequest, SourceExportResult } from '@deepseek-ai/dsh-api-remotes/client'

/** The exact captured files approved for one local download. */
export type ReadySourceExport = Extract<SourceExportResult, { status: 'ready' }>
/** Export preparation failures supplied by the Host. */
export type SourceExportIssue = Extract<SourceExportResult, { status: 'blocked' }>['issues'][number]

/** Form, captured preview, and transient operation feedback shared by the overlay. */
export interface ForkExportState {
  open: boolean
  repository: string
  branch: string
  phase: 'idle' | 'inspecting' | 'ready' | 'blocked' | 'failed'
  preview: ReadySourceExport | null
  issues: readonly SourceExportIssue[]
  reviewed: boolean
  notice: { seq: number; kind: 'downloaded' | 'download-failed' } | null
}

// FileSaver.js retains Blob URLs for 40 seconds: https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js
const DOWNLOAD_URL_GRACE_MS = 40_000

/**
 * Hand captured export bytes to the browser download manager; a successful click does not confirm completion.
 * URLs expire after a grace period for the browser to start downloading or when the lifetime ends; setup failures release them immediately.
 * @param value Exact Host result displayed in the review dialog.
 * @param signal Optional feature lifetime; abort releases URLs and refuses new downloads. Omission uses expiry alone.
 * @throws The signal's abort reason when already aborted, or a browser setup error.
 */
export function downloadForkExport(value: ReadySourceExport, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  let anchor: HTMLAnchorElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', release)
    URL.revokeObjectURL(url)
  }
  try {
    signal?.addEventListener('abort', release, { once: true })
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'dsh-source-export.json'
    document.body.append(anchor)
    anchor.click()
    if (!signal?.aborted) timer = setTimeout(release, DOWNLOAD_URL_GRACE_MS)
  } catch (error) {
    release()
    throw error
  } finally {
    anchor?.remove()
  }
}

/** Owns inspection, stale-response rejection, and review before local download. */
export class ForkExportController {
  /** Registration-private snapshot source bound to the overlay by the renderer. */
  readonly store: SnapshotStore<ForkExportState> = createSnapshotStore({
    open: false, repository: '', branch: '', phase: 'idle', preview: null, issues: [], reviewed: false, notice: null,
  })
  private request = 0
  private noticeSeq = 0
  private readonly downloads = new AbortController()

  /**
   * @param prepare Read-only Host export preparation.
   * @param save Browser download operation; failures retain the captured preview.
   */
  constructor(
    private readonly prepare: (request: SourceExportRequest) => Promise<SourceExportResult>,
    private readonly save: (value: ReadySourceExport) => void = (value) => { downloadForkExport(value, this.downloads.signal) },
  ) {}

  private set(patch: Partial<ForkExportState>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }
  private invalidate(): void {
    this.request++
    this.set({ phase: 'idle', preview: null, issues: [], reviewed: false })
  }

  /** Open an empty review while retaining the person's target fields. */
  open(): void { this.invalidate(); this.set({ open: true }) }
  /** Close the review and discard any pending response. */
  close(): void { this.invalidate(); this.set({ open: false }) }
  /**
   * Edit a target field and invalidate all previous inspection and acknowledgement.
   * @param field Target field being edited.
   * @param value Person's unmodified text.
   */
  edit(field: 'repository' | 'branch', value: string): void {
    this.invalidate()
    this.set({ [field]: value })
  }
  /**
   * Acknowledge review only while an exact captured export is available.
   * @param reviewed Whether the person confirmed reviewing the files.
   */
  review(reviewed: boolean): void { this.set({ reviewed: this.store.getSnapshot().preview !== null && reviewed }) }

  /**
   * Inspect the current targets unless another read is in progress.
   * @returns After the read settles; closing or editing discards a late result.
   */
  async inspect(): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.open || state.phase === 'inspecting') return
    const request = ++this.request
    this.set({ phase: 'inspecting', preview: null, issues: [], reviewed: false })
    try {
      const result = await this.prepare({ repository: state.repository, branch: state.branch })
      if (request !== this.request) return
      if (result.status === 'ready') this.set({ phase: 'ready', preview: result })
      else this.set({ phase: 'blocked', issues: result.issues })
    } catch (_error) {
      // Transport failure leaves the form available for an explicit retry.
      if (request === this.request) this.set({ phase: 'failed' })
    }
  }

  /** Download only the captured files the person acknowledged reviewing. */
  download(): void {
    const state = this.store.getSnapshot()
    if (!state.open || state.preview === null || !state.reviewed) return
    try {
      this.save(state.preview)
      this.set({ notice: { seq: ++this.noticeSeq, kind: 'downloaded' } })
    } catch (_error) {
      // A browser save failure does not invalidate the reviewed source bytes.
      this.set({ notice: { seq: ++this.noticeSeq, kind: 'download-failed' } })
    }
  }
  /** Clear transient download feedback after its Toast settles. */
  dismissNotice(): void { this.set({ notice: null }) }
  /** Invalidate outstanding reads and release pending browser-download URLs when the feature unloads. */
  dispose(): void { this.request++; this.downloads.abort() }
}

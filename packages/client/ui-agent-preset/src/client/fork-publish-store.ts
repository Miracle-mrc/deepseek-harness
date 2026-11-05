/** Explicit GitHub discovery and one reviewed publication receipt, independent of the local export. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ForkFailure, ForkPreviewId, ForkPreviewResult, ForkPublishResult, ForkRepositoriesResult, SourceExportRequest,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Exact proposed writes retained by the Host for review. */
export type ReadyForkPreview = Extract<ForkPreviewResult, { status: 'ready' }>
/** Writable destinations returned by an explicit discovery. */
export type ReadyForkRepositories = Extract<ForkRepositoriesResult, { status: 'ready' }>
/** Confirmed commit and pull request returned by the Host. */
export type SavedForkPublication = Extract<ForkPublishResult, { status: 'saved' }>

/** An approved receipt remains available when a lost response requires reconciliation. */
export type ForkPublicationOperation =
  | { readonly status: 'publishing'; readonly preview: ReadyForkPreview }
  | { readonly status: 'blocked'; readonly preview: ReadyForkPreview; readonly failure: ForkFailure }
  | { readonly status: 'saved'; readonly preview: ReadyForkPreview; readonly result: SavedForkPublication; readonly openFailed: boolean }

/** Form review and the latest separately owned publication outcome. */
export interface ForkPublishState {
  open: boolean
  repository: string
  branch: string
  phase: 'idle' | 'discovering' | 'previewing' | 'ready' | 'blocked'
  repositories: ReadyForkRepositories | null
  preview: ReadyForkPreview | null
  reviewed: boolean
  failure: ForkFailure | null
  operation: ForkPublicationOperation | null
  notice: { readonly seq: number; readonly kind: 'saved' | 'failed' } | null
}

/** Host calls and the browser action available to the publication controller. */
export interface ForkPublishActions {
  repositories: () => Promise<ForkRepositoriesResult>
  preview: (request: SourceExportRequest) => Promise<ForkPreviewResult>
  publish: (id: ForkPreviewId, confirmed: boolean) => Promise<ForkPublishResult>
  openPullRequest: (url: string) => void
}

/** Owns explicit discovery, stale read rejection, confirmation, and same-receipt publication retries. */
export class ForkPublishController {
  /** Registration-private source bound to the overlay by the renderer. */
  readonly store: SnapshotStore<ForkPublishState> = createSnapshotStore({
    open: false, repository: '', branch: '', phase: 'idle', repositories: null, preview: null,
    reviewed: false, failure: null, operation: null, notice: null,
  })
  private revision = 0
  private noticeSeq = 0
  private disposed = false

  /**
   * @param actions Read-only discovery and preview, receipt-only publication, and opening a validated PR URL.
   */
  constructor(private readonly actions: ForkPublishActions) {}

  private set(patch: Partial<ForkPublishState>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }
  private invalidate(): void {
    this.revision++
    this.set({ phase: 'idle', preview: null, reviewed: false, failure: null })
  }
  private unresolved(): boolean {
    const operation = this.store.getSnapshot().operation
    return operation?.status === 'publishing' || (operation?.status === 'blocked'
      && (operation.failure.effect === 'unknown'
        || (operation.failure.effect === 'committed' && operation.failure.code !== 'pull-request-closed')))
  }
  private reading(): boolean {
    const phase = this.store.getSnapshot().phase
    return phase === 'discovering' || phase === 'previewing'
  }
  private refuse(failure: ForkFailure): void { this.set({ phase: 'blocked', failure }) }

  /** Open the form without making requests; an unresolved approved operation remains available. */
  open(): void {
    if (this.disposed) return
    this.invalidate()
    this.set({ open: true })
  }
  /** Close and invalidate active review; confirmed writes continue with their retained receipt. */
  close(): void {
    this.invalidate()
    this.set({ open: false })
  }
  /**
   * Invalidate the current review when a destination changes; uncertain approved effects retain their own receipt.
   * @param field Destination field being edited.
   * @param value Unmodified form value.
   */
  edit(field: 'repository' | 'branch', value: string): void {
    if (this.disposed) return
    const keepOperation = this.unresolved()
    this.invalidate()
    this.set({ [field]: value, ...keepOperation ? {} : { operation: null } })
  }
  /**
   * Discover authorized forks only after an explicit user action.
   * @returns After discovery settles; edits, closure, and disposal discard a late response.
   */
  async connect(): Promise<void> {
    const before = this.store.getSnapshot()
    if (this.disposed || !before.open || this.reading() || this.unresolved()) return
    const revision = ++this.revision
    this.set({ phase: 'discovering', repositories: null, preview: null, reviewed: false, failure: null })
    try {
      const result = await this.actions.repositories()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed || revision !== this.revision) return
      if (result.status === 'blocked') this.refuse(result)
      else this.set({
        phase: 'idle', repositories: result,
        repository: result.repositories.some(item => item.repository === before.repository) ? before.repository : '',
      })
    } catch (_error) {
      // Discovery changes no remote data, so a transport failure permits another explicit read.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (!this.disposed && revision === this.revision) this.refuse({ status: 'blocked', code: 'network', effect: 'none' })
    }
  }
  /**
   * Prepare exact source and destination text for an authorized fork and a non-default branch.
   * @returns After preparation settles; target edits, closure, and disposal discard a late response.
   */
  async inspect(): Promise<void> {
    const state = this.store.getSnapshot()
    if (this.disposed || !state.open || this.reading() || this.unresolved()) return
    const repository = state.repositories?.repositories.find(item => item.repository === state.repository)
    if (repository === undefined) {
      this.refuse({ status: 'blocked', code: 'invalid-repository', effect: 'none' })
      return
    }
    const branch = state.branch.trim()
    if (branch === repository.defaultBranch || ['main', 'master'].includes(branch.toLowerCase())) {
      this.refuse({ status: 'blocked', code: 'default-branch', effect: 'none' })
      return
    }
    const revision = ++this.revision
    this.set({ phase: 'previewing', preview: null, reviewed: false, failure: null, operation: null })
    try {
      const result = await this.actions.preview({ repository: state.repository, branch: state.branch })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed || revision !== this.revision) return
      if (result.status === 'blocked') this.refuse(result)
      else this.set({ phase: 'ready', preview: result })
    } catch (_error) {
      // A preview has no write effects; retry requires a fresh explicit inspection.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (!this.disposed && revision === this.revision) this.refuse({ status: 'blocked', code: 'network', effect: 'none' })
    }
  }
  /**
   * Acknowledge only a current preview that has not already been submitted.
   * @param reviewed Whether the person reviewed every displayed write.
   */
  review(reviewed: boolean): void {
    const state = this.store.getSnapshot()
    if (this.disposed || state.operation !== null) return
    this.set({ reviewed: state.preview !== null && reviewed })
  }
  /**
   * Submit only the reviewed receipt; source text and destination fields never travel in this call.
   * @returns After the Host reports an outcome; a lost response preserves an unknown effect for reconciliation.
   */
  async publish(): Promise<void> {
    const state = this.store.getSnapshot()
    if (this.disposed || !state.open || !state.reviewed || state.preview === null || state.operation !== null) return
    await this.submit(state.preview)
  }
  /**
   * Reconcile or retry an already-approved receipt without preparing or confirming a different write.
   * @returns After the retry reports its observed outcome.
   */
  async retry(): Promise<void> {
    const state = this.store.getSnapshot()
    if (this.disposed || !state.open || state.operation?.status !== 'blocked') return
    await this.submit(state.operation.preview)
  }
  private async submit(preview: ReadyForkPreview): Promise<void> {
    this.set({ operation: { status: 'publishing', preview } })
    let result: ForkPublishResult
    try { result = await this.actions.publish(preview.id, true) }
    catch (_error) {
      // A rejected transport cannot establish whether the approved write reached GitHub.
      result = { status: 'blocked', code: 'network', effect: 'unknown' }
    }
    if (this.disposed) return
    if (result.status === 'blocked') {
      this.set({ operation: { status: 'blocked', preview, failure: result }, notice: { seq: ++this.noticeSeq, kind: 'failed' } })
      return
    }
    let openFailed = false
    try { this.actions.openPullRequest(result.pullRequestUrl) }
    catch (_error) {
      // Opening a browser tab cannot undo the saved commit and PR; the dialog retains the link.
      openFailed = true
    }
    this.set({ operation: { status: 'saved', preview, result, openFailed }, notice: { seq: ++this.noticeSeq, kind: 'saved' } })
  }
  /** Clear transient feedback after its Toast settles. */
  dismissNotice(): void { this.set({ notice: null }) }
  /** Refuse new work and invalidate pending reads; the Host retains ownership of any approved write. */
  dispose(): void { this.disposed = true; this.invalidate(); this.set({ open: false }) }
}

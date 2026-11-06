/** Owner-only, explicitly confirmed publication of captured Creator source to a GitHub fork. */
import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { principalOf, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { exportProfileSource, sourceTextIssue } from './source-export.ts'
import { ForkGithub, ForkGithubError } from './fork-github.ts'
import type { SourceExportRequest } from './types.ts'
import type { ForkCommitId, ForkFailure, ForkIssueCode, ForkPreviewId, ForkPreviewResult, ForkPublishResult, ForkRepositoriesResult, ForkReviewResult } from './fork-types.ts'

const SLUG = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i
const OID = z.string().regex(/^[a-f0-9]{40}$/).transform(value => value as ForkCommitId)
const USER = z.object({ id: z.number().int().positive(), login: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i) })
const IDENTITY = z.object({ id: z.number().int().positive(), full_name: z.string().regex(SLUG) })
const REPO = IDENTITY.extend({ owner: USER, default_branch: z.string().min(1), fork: z.boolean(),
  permissions: z.object({ push: z.boolean() }).optional(), source: IDENTITY.optional(), parent: IDENTITY.optional() })
const REF = z.object({ object: z.object({ type: z.literal('commit'), sha: OID }) })
const COMMIT = z.object({ sha: OID, tree: z.object({ sha: OID }), message: z.string(), parents: z.array(z.object({ sha: OID })) })
const TREE = z.object({
  truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: OID })),
})
const COMPARISON = z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  base_commit: z.object({ sha: OID }), merge_base_commit: z.object({ sha: OID }) })
const PULL = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']),
  head: z.object({ ref: z.string(), sha: OID, repo: z.object({ id: z.number() }) }),
  base: z.object({ ref: z.string(), repo: z.object({ id: z.number() }) }) })
const PREFIX = 'creator-exports/saved/'
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const MUTATION = 'mutation SaveCreator($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'

/** Host executable, upstream, and bounds; credentials always remain in the existing gh store. */
export interface CreatorForkConfig {
  /** Host GitHub CLI executable. */
  ghCommand?: string
  /** Repository network that eligible personal forks must belong to; publication stays in the selected fork. */
  upstreamRepository?: string
  /** Deadline of each GitHub request, in milliseconds. */
  timeoutMs?: number
  /** Deadline of one complete discovery, preview, or publication attempt, in milliseconds. */
  operationTimeoutMs?: number
  /** Maximum bytes captured from each gh output stream. */
  outputBytes?: number
  /** Lifetime of an unsubmitted preview, in milliseconds; unresolved submissions remain until unload. */
  previewLifetimeMs?: number
  /** Maximum retained previews, including unresolved submissions. */
  maxPreviews?: number
}

type Preview = Extract<ForkPreviewResult, { status: 'ready' }>
type Saved = Extract<ForkPublishResult, { status: 'saved' }>
interface Receipt {
  readonly preview: Preview
  readonly accountId: number
  readonly repositoryId: number
  readonly upstreamId: number
  readonly sourceId: number
  readonly baseCommit: ForkCommitId
  readonly parent: ForkCommitId
  readonly additions: readonly { readonly path: string; readonly content: string }[]
  expires: number
  readonly expectedLeaves: ReadonlyMap<string, string>
  attempted: boolean
  commit: ForkCommitId | null
  preparedCommit: ForkCommitId | null
  pending: Promise<ForkPublishResult> | null
  saved: Saved | null
  closed: boolean
}

class Refusal extends Error {
  constructor(readonly code: ForkIssueCode) { super(code) }
}
function refuse(code: ForkIssueCode): never { throw new Refusal(code) }
function decode<T>(type: z.ZodType<T>, value: unknown): T {
  const parsed = type.safeParse(value)
  if (!parsed.success) refuse('invalid-response')
  return parsed.data
}
function codeOf(error: unknown): ForkIssueCode {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
  return error instanceof Refusal || error instanceof ForkGithubError ? error.code : 'unavailable'
}
function failed(error: unknown, effect: ForkFailure['effect'] = 'none'): ForkFailure {
  return { status: 'blocked', code: codeOf(error), effect }
}
function networkId(repo: z.infer<typeof REPO>): number {
  if (!repo.fork) return repo.id
  if (repo.source === undefined) refuse('invalid-response')
  return repo.source.id
}
function sameSlug(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase() }
function blobId(raw: Buffer): string { return createHash('sha1').update(`blob ${String(raw.length)}\0`).update(raw).digest('hex') }
function leaves(tree: z.infer<typeof TREE>): Map<string, string> {
  return new Map(tree.tree.filter(entry => entry.type !== 'tree')
    .map(entry => [entry.path, `${entry.mode}:${entry.type}:${entry.sha}`]))
}
function destination(tree: z.infer<typeof TREE>, path: string): z.infer<typeof TREE>['tree'][number] | undefined {
  for (const entry of tree.tree) {
    const folded = entry.path.normalize('NFC').toLowerCase()
    const target = path.normalize('NFC').toLowerCase()
    if ((folded === target || target.startsWith(`${folded}/`))
      && path.slice(0, entry.path.length) !== entry.path) refuse('unsafe-destination')
    if (path.startsWith(`${entry.path}/`) && (entry.type !== 'tree' || entry.mode !== '040000')) refuse('unsafe-destination')
  }
  return tree.tree.find(entry => entry.path === path)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Explicitly confirmed Creator source publication using the Host's GitHub account. */
    creatorFork: CreatorFork
  }
}

/** Owns bounded source receipts, GitHub identity checks, atomic branch writes, and PR reconciliation. */
export class CreatorFork extends TypertRemoteService {
  static inject = ['profileContext']
  static Config: schema<CreatorForkConfig> = schema.object({
    ghCommand: schema.string().pattern(/\S/).default('gh'),
    upstreamRepository: schema.string().pattern(SLUG).default('deepseek-ai/deepseek-harness'),
    timeoutMs: schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(20000),
    operationTimeoutMs: schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120000),
    outputBytes: schema.natural().min(1).default(16 * 1024 * 1024),
    previewLifetimeMs: schema.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15 * 60 * 1000),
    maxPreviews: schema.natural().min(1).max(32).default(4),
  })
  private readonly github: ForkGithub
  private readonly profile: ProfileContext
  private readonly config: Required<CreatorForkConfig>
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly receipts = new Map<ForkPreviewId, Receipt>()

  constructor(ctx: Context, config: CreatorForkConfig) {
    super(ctx, 'creatorFork')
    this.config = config as Required<CreatorForkConfig>
    this.github = new ForkGithub(this.config)
    this.profile = ctx.profileContext
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.operations])
      this.receipts.clear()
    }, 'creator-fork: settle requests and release source receipts')
  }

  private async operation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | ForkFailure> {
    const invocation = this.ctx.invocation
    if (principalOf(invocation) !== undefined) return failed(new Refusal('permission-denied'))
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.operationTimeoutMs),
      ...invocation === undefined ? [] : [invocation.signal]])
    const pending = Promise.resolve().then(async () => { signal.throwIfAborted(); return run(signal) })
    this.operations.add(pending)
    try { return await pending }
    catch (error) { return failed(error) }
    finally { this.operations.delete(pending) }
  }
  private async get(path: string, signal: AbortSignal): Promise<unknown> { return this.github.request('GET', path, undefined, signal) }
  private async repo(repository: string, signal: AbortSignal): Promise<z.infer<typeof REPO>> {
    const repo = decode(REPO, await this.get(`repos/${repository}`, signal))
    if (!sameSlug(repo.full_name, repository)) refuse('wrong-fork')
    return repo
  }
  private async commit(repository: string, oid: string, signal: AbortSignal): Promise<z.infer<typeof COMMIT>> {
    const result = decode(COMMIT, await this.get(`repos/${repository}/git/commits/${oid}`, signal))
    if (result.sha !== oid) refuse('invalid-response')
    return result
  }
  private async defaultHead(repository: string, branch: string, signal: AbortSignal): Promise<ForkCommitId> {
    return decode(z.object({ commit: z.object({ sha: OID }) }),
      await this.get(`repos/${repository}/branches/${encodeURIComponent(branch)}`, signal)).commit.sha
  }
  private async tree(repository: string, head: ForkCommitId, signal: AbortSignal): Promise<z.infer<typeof TREE>> {
    const commit = await this.commit(repository, head, signal)
    return decode(TREE, await this.get(`repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`, signal))
  }
  private async text(
    repository: string, entry: z.infer<typeof TREE>['tree'][number] | undefined, path: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (entry === undefined) return null
    if (entry.type !== 'blob' || entry.mode !== '100644') refuse('unsafe-destination')
    const blob = decode(z.object({ encoding: z.literal('base64'), size: z.number().int().min(0).max(1024 * 1024), content: z.string() }),
      await this.get(`repos/${repository}/git/blobs/${entry.sha}`, signal))
    const encoded = blob.content.replace(/\r?\n/g, '')
    const raw = Buffer.from(encoded, 'base64')
    if (raw.length !== blob.size || raw.toString('base64') !== encoded || blobId(raw) !== entry.sha) refuse('invalid-response')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) }
    catch (_error) { refuse('unsupported-source') }
    const issue = sourceTextIssue(text, path)
    if (issue !== undefined) refuse(issue)
    return text
  }
  private async checked(repository: string, branch: string, signal: AbortSignal) {
    const user = decode(USER, await this.get('user', signal))
    const upstream = await this.repo(this.config.upstreamRepository, signal)
    const repo = await this.repo(repository, signal)
    if (repo.owner.id !== user.id || repo.owner.login !== user.login) refuse('mixed-account')
    if (repo.id === upstream.id || !repo.fork || networkId(repo) !== networkId(upstream)) refuse('wrong-fork')
    if (repo.permissions?.push !== true) refuse('permission-denied')
    if (branch.toLowerCase() === repo.default_branch.toLowerCase()) refuse('default-branch')
    return { user, repo, upstream }
  }
  private async head(repository: string, branch: string, signal: AbortSignal): Promise<ForkCommitId | null> {
    try { return decode(REF, await this.get(`repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, signal)).object.sha }
    catch (error) { if (error instanceof ForkGithubError && error.code === 'not-found') return null; throw error }
  }
  private async pulls(receipt: Receipt, signal: AbortSignal): Promise<z.infer<typeof PULL>[]> {
    const preview = receipt.preview
    const query = `repos/${preview.repository}/pulls?state=all&base=${encodeURIComponent(preview.base)}&head=${encodeURIComponent(`${preview.account}:${preview.branch}`)}&per_page=100`
    return decode(z.array(PULL), await this.get(query, signal))
  }
  private matches(receipt: Receipt, pull: z.infer<typeof PULL>): boolean {
    return pull.head.repo.id === receipt.repositoryId && pull.head.ref === receipt.preview.branch
      && pull.head.sha === receipt.commit && pull.base.repo.id === receipt.repositoryId && pull.base.ref === receipt.preview.base
  }
  private closed(receipt: Receipt, pull: z.infer<typeof PULL>): ForkFailure {
    receipt.closed = true
    return { ...failed(new Refusal('pull-request-closed'), 'committed'),
      pullRequestUrl: `https://github.com/${receipt.preview.repository}/pull/${String(pull.number)}` }
  }
  private releaseReceipts(): void {
    for (const [id, receipt] of this.receipts) {
      if (receipt.pending !== null) continue
      if (receipt.saved !== null || receipt.closed || (!receipt.attempted && receipt.expires <= Date.now())) this.receipts.delete(id)
    }
  }

  /**
   * Discover writable forks owned by the authenticated Host user. Only this explicit call contacts GitHub.
   * @returns Account, upstream, and authorized fork choices, or a sanitized refusal.
   */
  @Remote
  async repositories(): Promise<ForkRepositoriesResult> {
    return this.operation(async (signal) => {
      const user = decode(USER, await this.get('user', signal))
      const upstream = await this.repo(this.config.upstreamRepository, signal)
      const repositories: { repository: string; defaultBranch: string }[] = []
      // A bounded discovery refuses overflow rather than silently offering an incomplete account inventory.
      for (let page = 1; page <= 10; page++) {
        const listed = decode(z.array(REPO), await this.get(`user/repos?affiliation=owner&per_page=100&page=${String(page)}`, signal))
        for (const item of listed) {
          if (!item.fork || item.owner.id !== user.id || item.permissions?.push !== true || item.id === upstream.id) continue
          const detail = await this.repo(item.full_name, signal)
          if (detail.owner.id === user.id && detail.permissions?.push === true && networkId(detail) === networkId(upstream)) {
            repositories.push({ repository: detail.full_name, defaultBranch: detail.default_branch })
          }
        }
        if (listed.length < 100) return { status: 'ready', account: user.login, upstream: upstream.full_name, repositories } as const
      }
      return failed(new Refusal('too-large'))
    })
  }

  /**
   * Capture the complete default-relative PR diff and additional destination writes, without uploading source or changing GitHub.
   * A new preview releases successful and known-closed receipts; their IDs then become stale.
   * Saved files absent from the current capture are refused; publication never deletes them automatically.
   * Existing destinations must descend from the current default and preserve every non-captured leaf.
   * @param request Authorized fork slug and a non-default branch; new branches start from the fork's reviewed default branch.
   * @returns An expiring receipt for complete PR changes and destination writes, with exact UTF-8 text, or a refusal without source.
   */
  @Remote
  async preview(request: SourceExportRequest): Promise<ForkPreviewResult> {
    return this.operation(async (signal) => {
      const source = await exportProfileSource(this.profile, request)
      if (source.status !== 'ready') return failed(new Refusal(source.issues[0].code))
      const { user, repo, upstream } = await this.checked(source.repository, source.branch, signal)
      this.releaseReceipts()
      if (this.receipts.size >= this.config.maxPreviews) refuse('too-large')
      const base = await this.defaultHead(repo.full_name, repo.default_branch, signal)
      const head = await this.head(repo.full_name, source.branch, signal)
      const parent = head ?? base
      if (head !== null && head !== base) {
        const comparison = decode(COMPARISON, await this.get(`repos/${repo.full_name}/compare/${base}...${head}?per_page=1`, signal))
        if (comparison.base_commit.sha !== base) refuse('invalid-response')
        if (comparison.status !== 'ahead' || comparison.merge_base_commit.sha !== base) refuse('unsafe-destination')
      }
      const baseTree = await this.tree(repo.full_name, base, signal)
      const tree = parent === base ? baseTree : await this.tree(repo.full_name, parent, signal)
      const capturedPaths = new Set(source.files.map(file => `${PREFIX}${file.path}`))
      if (tree.tree.some(entry => entry.type !== 'tree' && entry.path.startsWith(PREFIX) && !capturedPaths.has(entry.path))) {
        refuse('unsafe-destination')
      }
      const baseLeaves = leaves(baseTree)
      const expectedLeaves = leaves(tree)
      for (const [path] of [...baseLeaves, ...expectedLeaves]) {
        if (!capturedPaths.has(path) && baseLeaves.get(path) !== expectedLeaves.get(path)) refuse('unsafe-destination')
      }
      const files: Preview['files'][number][] = []
      const additions: { path: string; content: string }[] = []
      let bytes = 0
      let prChanges = 0
      const addFile = (path: string, before: string | null, branchBefore: string | null, after: string): void => {
        const write = branchBefore !== after
        if (write) {
          additions.push({ path, content: after })
        }
        const changed = before !== after
        if (changed) prChanges++
        const oid = blobId(Buffer.from(after))
        expectedLeaves.set(path, `100644:blob:${oid}`)
        if (!changed && !write) return
        const diff = { path, before, after, ...write && branchBefore !== before ? { branchBefore } : {} }
        bytes += Buffer.byteLength(JSON.stringify(diff))
        if (bytes > MAX_PREVIEW_BYTES) refuse('too-large')
        files.push(diff)
      }
      for (const file of source.files) {
        const path = `${PREFIX}${file.path}`
        const before = await this.text(repo.full_name, destination(baseTree, path), path, signal)
        const branchBefore = tree === baseTree ? before : await this.text(repo.full_name, destination(tree, path), path, signal)
        addFile(path, before, branchBefore, file.content)
      }
      if (prChanges === 0) refuse('no-changes')
      if (await this.head(repo.full_name, source.branch, signal) !== head) refuse('conflict')
      const current = await this.checked(repo.full_name, source.branch, signal)
      if (current.user.id !== user.id) refuse('mixed-account')
      if (current.repo.id !== repo.id || current.upstream.id !== upstream.id || networkId(current.upstream) !== networkId(upstream)) refuse('wrong-fork')
      if (current.repo.default_branch !== repo.default_branch) refuse('conflict')
      if (await this.defaultHead(repo.full_name, repo.default_branch, signal) !== base) refuse('conflict')
      const preview: Preview = { status: 'ready', id: randomUUID() as ForkPreviewId, account: user.login,
        repository: repo.full_name, branch: source.branch, upstream: upstream.full_name, base: repo.default_branch, head, files }
      if (Buffer.byteLength(JSON.stringify(preview)) > MAX_PREVIEW_BYTES) refuse('too-large')
      this.releaseReceipts()
      if (this.receipts.size >= this.config.maxPreviews) refuse('too-large')
      this.receipts.set(preview.id, { preview, accountId: user.id, repositoryId: repo.id, upstreamId: upstream.id,
        sourceId: networkId(upstream), baseCommit: base, parent, additions,
        expires: Date.now() + this.config.previewLifetimeMs, expectedLeaves, attempted: false,
        commit: null, preparedCommit: null, pending: null, saved: null, closed: false })
      return preview
    })
  }

  /**
   * Extend an unsubmitted review after revalidating its account and unchanged GitHub destination.
   * An expired receipt can be extended only while still retained. Captured text and the receipt ID never change.
   * @param id Existing unsubmitted receipt; attempted publications retain their separate retry flow.
   * @returns The same receipt ID with a fresh configured lifetime, or a sanitized refusal without writes.
   */
  @Remote
  async extendReview(id: ForkPreviewId): Promise<ForkReviewResult> {
    return this.operation(async (signal) => {
      const receipt = this.receipts.get(id)
      if (receipt === undefined) refuse('stale-preview')
      const eligible = (): boolean => this.receipts.get(id) === receipt && !receipt.attempted && receipt.pending === null
      if (!eligible()) refuse('stale-preview')
      await this.recheck(receipt, signal)
      if (!eligible()) refuse('stale-preview')
      receipt.expires = Date.now() + this.config.previewLifetimeMs
      return { status: 'ready', id } as const
    })
  }

  /**
   * Apply only retained destination writes after explicit confirmation, reusing an existing commit when no write is needed.
   * Create or reuse its PR to the reviewed default; detected default-name, base-commit or target-head changes stop new writes.
   * Repeated calls share an in-flight operation and reconcile lost responses. A closed PR is reported without recreating it.
   * An in-flight publication retains its receipt past the preview's expiry.
   * A failed PR retains the approved commit; unknown writes remain unknown until reconciliation,
   * with no forced rollback or branch deletion.
   * @param id Receipt from preview; source text and destinations cannot be replaced by this call.
   * @param confirmed Caller attestation of the person's authorization of these exact files and destinations;
   * trusted Host code can supply it directly.
   * @returns Confirmed commit and PR, or a sanitized refusal stating absent, unknown, or committed remote effects.
   */
  @Remote
  async publish(id: ForkPreviewId, confirmed: boolean): Promise<ForkPublishResult> {
    return this.operation(async (signal) => {
      if (!confirmed) return failed(new Refusal('confirmation-required'))
      const receipt = this.receipts.get(id)
      if (receipt === undefined) return failed(new Refusal('stale-preview'))
      if (receipt.pending !== null) return receipt.pending
      if (!receipt.attempted && receipt.expires <= Date.now()) return failed(new Refusal('stale-preview'))
      if (receipt.saved !== null) return receipt.saved
      const pending = this.submit(receipt, signal)
      receipt.pending = pending
      try { return await pending }
      finally { receipt.pending = null }
    })
  }

  private async submit(receipt: Receipt, signal: AbortSignal): Promise<ForkPublishResult> {
    const preview = receipt.preview
    const priorUnknown = receipt.attempted && receipt.commit === null
    receipt.closed = false
    try {
      const { user, repo, upstream } = await this.checked(preview.repository, preview.branch, signal)
      if (user.id !== receipt.accountId) refuse('mixed-account')
      if (repo.id !== receipt.repositoryId || upstream.id !== receipt.upstreamId || networkId(upstream) !== receipt.sourceId) refuse('wrong-fork')
      if (repo.default_branch !== preview.base) refuse('conflict')
      if (await this.defaultHead(preview.repository, preview.base, signal) !== receipt.baseCommit) {
        if (receipt.commit !== null) {
          const closed = (await this.pulls(receipt, signal)).find(pull => pull.state === 'closed' && this.matches(receipt, pull))
          if (closed !== undefined) return this.closed(receipt, closed)
        }
        refuse('conflict')
      }
      const head = await this.head(preview.repository, preview.branch, signal)
      if (receipt.attempted && receipt.commit === null) {
        if (head !== preview.head && head !== null) {
          const commit = await this.commit(preview.repository, head, signal)
          if (commit.message !== this.message(receipt) || commit.parents.length !== 1 || commit.parents[0]?.sha !== receipt.parent) refuse('conflict')
          if (receipt.preparedCommit !== null && head !== receipt.preparedCommit) refuse('conflict')
          const tree = decode(TREE, await this.get(`repos/${preview.repository}/git/trees/${commit.tree.sha}?recursive=1`, signal))
          const leaves = tree.tree.filter(entry => entry.type !== 'tree')
          if (leaves.length !== receipt.expectedLeaves.size || leaves.some(entry =>
            receipt.expectedLeaves.get(entry.path) !== `${entry.mode}:${entry.type}:${entry.sha}`)) refuse('conflict')
          receipt.commit = head
        }
      }
      if (receipt.commit !== null) {
        if (head !== receipt.commit) refuse('conflict')
      } else {
        if (head !== preview.head) refuse('conflict')
        if (receipt.additions.length === 0) {
          await this.recheck(receipt, signal)
          receipt.attempted = true
          receipt.commit = receipt.parent
        } else if (preview.head === null) {
          if (receipt.preparedCommit === null) {
            const parent = await this.commit(preview.repository, receipt.parent, signal)
            await this.recheck(receipt, signal)
            const tree = decode(z.object({ sha: OID }), await this.github.request('POST', `repos/${preview.repository}/git/trees`, {
              base_tree: parent.tree.sha,
              tree: receipt.additions.map(file => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
            }, signal))
            await this.recheck(receipt, signal)
            receipt.preparedCommit = decode(z.object({ sha: OID }), await this.github.request('POST', `repos/${preview.repository}/git/commits`, {
              message: this.message(receipt), tree: tree.sha, parents: [receipt.parent],
            }, signal)).sha
          }
          await this.recheck(receipt, signal)
          receipt.attempted = true
          const created = decode(REF, await this.github.request('POST', `repos/${preview.repository}/git/refs`, {
            ref: `refs/heads/${preview.branch}`, sha: receipt.preparedCommit,
          }, signal))
          if (created.object.sha !== receipt.preparedCommit) refuse('invalid-response')
          receipt.commit = created.object.sha
        } else {
          await this.recheck(receipt, signal)
          receipt.attempted = true
          const response = await this.github.request('POST', 'graphql', { query: MUTATION, variables: { input: {
            branch: { repositoryNameWithOwner: preview.repository, branchName: preview.branch },
            expectedHeadOid: preview.head, message: { headline: this.message(receipt) },
            fileChanges: { additions: receipt.additions.map(file => ({ path: file.path, contents: Buffer.from(file.content).toString('base64') })) },
          } } }, signal)
          const rejection = z.object({ type: z.enum(['STALE_DATA', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'UNPROCESSABLE']) })
          const rejected = z.object({
            data: z.union([z.null(), z.object({ createCommitOnBranch: z.null() })]),
            errors: z.tuple([rejection]).rest(rejection),
          }).safeParse(response)
          if (rejected.success) {
            const codes = { STALE_DATA: 'conflict', FORBIDDEN: 'permission-denied', NOT_FOUND: 'not-found',
              UNAUTHORIZED: 'auth-required', UNPROCESSABLE: 'conflict' } as const
            throw new ForkGithubError(codes[rejected.data.errors[0].type])
          }
          const result = decode(z.object({
            data: z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: OID }) }) }),
          }), response)
          receipt.commit = result.data.createCommitOnBranch.commit.oid
        }
      }
      if (await this.head(preview.repository, preview.branch, signal) !== receipt.commit) refuse('conflict')
      await this.recheck(receipt, signal)
      const pulls = await this.pulls(receipt, signal)
      await this.recheck(receipt, signal)
      let pull = pulls.find(candidate => candidate.state === 'open' && this.matches(receipt, candidate))
        ?? pulls.find(candidate => this.matches(receipt, candidate))
      if (pull === undefined) {
        if (pulls.length >= 100) refuse('too-large')
        pull = decode(PULL, await this.github.request('POST', `repos/${preview.repository}/pulls`, {
          title: 'Save Creator source', head: `${preview.account}:${preview.branch}`, head_repo: preview.repository.split('/')[1], base: preview.base,
          body: 'Reviewed Creator source export. Credentials and machine-local state are excluded.', maintainer_can_modify: false,
        }, signal))
        if (!this.matches(receipt, pull)) refuse('invalid-response')
      }
      await this.recheck(receipt, signal)
      const pullRequestUrl = `https://github.com/${preview.repository}/pull/${String(pull.number)}`
      if (pull.state === 'closed') return this.closed(receipt, pull)
      receipt.saved = { status: 'saved', repository: preview.repository, branch: preview.branch, commit: receipt.commit,
        pullRequestUrl }
      return receipt.saved
    } catch (error) {
      if (receipt.commit === null && error instanceof ForkGithubError
        && ['auth-required', 'permission-denied', 'not-found', 'conflict'].includes(error.code)) {
        receipt.attempted = priorUnknown
      }
      return failed(error, receipt.commit !== null ? 'committed' : receipt.attempted ? 'unknown' : 'none')
    }
  }
  private async recheck(receipt: Receipt, signal: AbortSignal): Promise<void> {
    const { user, repo, upstream } = await this.checked(receipt.preview.repository, receipt.preview.branch, signal)
    if (user.id !== receipt.accountId) refuse('mixed-account')
    if (repo.id !== receipt.repositoryId || upstream.id !== receipt.upstreamId || networkId(upstream) !== receipt.sourceId) refuse('wrong-fork')
    if (repo.default_branch !== receipt.preview.base) refuse('conflict')
    if (await this.defaultHead(receipt.preview.repository, receipt.preview.base, signal) !== receipt.baseCommit) refuse('conflict')
    if (await this.head(receipt.preview.repository, receipt.preview.branch, signal)
      !== (receipt.commit ?? receipt.preview.head)) refuse('conflict')
  }
  private message(receipt: Receipt): string { return `Save Creator source (${receipt.preview.id})` }
}

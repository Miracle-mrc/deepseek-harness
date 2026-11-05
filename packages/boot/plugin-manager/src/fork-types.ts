/** Reviewed Creator source publication over the Host's existing GitHub login. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SourceExportIssueCode } from './types.ts'

/** Opaque receipt for source bytes and GitHub destinations retained by the Host. */
export type ForkPreviewId = Branded<'ForkPreviewId'>

/** GitHub commit object identity supplied by the publication service. */
export type ForkCommitId = Branded<'ForkCommitId'>

/** Publication refusals contain no source excerpts, credentials, or CLI diagnostics. */
export type ForkIssueCode = SourceExportIssueCode | 'auth-required' | 'permission-denied' | 'not-found'
  | 'conflict' | 'timeout' | 'unavailable' | 'invalid-response' | 'network' | 'wrong-fork' | 'mixed-account'
  | 'default-branch' | 'stale-preview' | 'confirmation-required' | 'no-changes' | 'unsafe-destination'
  | 'pull-request-closed'

/** A failed attempt's branch/PR effects; preparation can leave unreachable Git objects after confirmation. */
export interface ForkFailure {
  readonly status: 'blocked'
  readonly code: ForkIssueCode
  readonly effect: 'none' | 'unknown' | 'committed'
  /** Existing PR in the selected fork, constructed from its validated repository and PR number. */
  readonly pullRequestUrl?: string
}

/** A writable fork owned by the currently authenticated GitHub user. */
export interface ForkRepository {
  readonly repository: string
  readonly defaultBranch: string
}

/** User-triggered discovery; no token crosses the remote API. */
export type ForkRepositoriesResult = ForkFailure | {
  readonly status: 'ready'
  readonly account: string
  /** Repository used only to verify fork eligibility. */
  readonly upstream: string
  readonly base: 'master'
  readonly repositories: readonly ForkRepository[]
}

/** Exact UTF-8 before/after text at one complete repository destination. */
export interface ForkFileDiff {
  readonly path: string
  readonly before: string | null
  readonly after: string
}

/** Immutable proposed writes in the selected fork; an absent head starts from that fork's master. */
export type ForkPreviewResult = ForkFailure | {
  readonly status: 'ready'
  readonly id: ForkPreviewId
  readonly account: string
  readonly repository: string
  readonly branch: string
  /** Repository used only to verify fork eligibility; the PR targets repository. */
  readonly upstream: string
  readonly base: 'master'
  readonly head: ForkCommitId | null
  readonly files: readonly ForkFileDiff[]
}

/** A confirmed commit and open PR within one fork, or a refusal preserving uncertainty about remote effects. */
export type ForkPublishResult = ForkFailure | {
  readonly status: 'saved'
  readonly repository: string
  readonly branch: string
  readonly commit: ForkCommitId
  readonly pullRequestUrl: string
}

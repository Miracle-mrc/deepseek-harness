/** Explicitly authorized fork discovery, byte-exact before/after review, and receipt-only publication. */
import { useId, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForkIssueCode } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconWarningOutlineRegular, Input, Modal, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsKey } from './locales.ts'
import type { ForkPublishState, ReadyForkPreview } from './fork-publish-store.ts'
import css from './ForkPublish.module.css'

/** Read-only snapshots and explicit commands supplied by the owning registration. */
export interface ForkPublishOverlayInjected {
  hooks: { forkPublish: SnapshotStore<ForkPublishState> }
  close: () => void
  connect: () => Promise<void>
  edit: (field: 'repository' | 'branch', value: string) => void
  inspect: () => Promise<void>
  review: (reviewed: boolean) => void
  publish: () => Promise<void>
  retry: () => Promise<void>
  dismissNotice: () => void
}

type ForkPublishOverlayProps = PropsLocale<'settings.agentPreset'> & InjectFace<ForkPublishOverlayInjected>
type Translate = ForkPublishOverlayProps['t']

const ISSUE_KEYS = {
  'invalid-repository': 'forkInvalidRepository', 'invalid-branch': 'forkInvalidBranch',
  'profile-unavailable': 'forkProfileUnavailable', 'unsafe-path': 'forkUnsafePath',
  'source-unavailable': 'forkSourceUnavailable', 'unsupported-source': 'forkUnsupportedSource',
  'secret-suspected': 'forkSecretSuspected', 'source-changed': 'forkSourceChanged', 'too-large': 'forkPublishTooLarge',
  'auth-required': 'forkPublishAuthRequired', 'permission-denied': 'forkPublishPermissionDenied',
  'not-found': 'forkPublishNotFound', conflict: 'forkPublishConflict', timeout: 'forkPublishUnavailable',
  unavailable: 'forkPublishUnavailable', 'invalid-response': 'forkPublishUnavailable', network: 'forkPublishUnavailable',
  'wrong-fork': 'forkPublishWrongFork', 'mixed-account': 'forkPublishMixedAccount',
  'default-branch': 'forkPublishDefaultBranch', 'stale-preview': 'forkPublishStalePreview',
  'confirmation-required': 'forkPublishConfirmationRequired', 'no-changes': 'forkPublishNoChanges',
  'unsafe-destination': 'forkPublishUnsafeDestination',
  'pull-request-closed': 'forkPublishPullRequestClosed',
} satisfies Record<ForkIssueCode, AgentPresetSettingsKey>

function textMetrics(value: string, t: Translate): string {
  let newlines = 0
  for (const character of value) if (character === '\n') newlines++
  return t('forkPublishTextMetrics', { bytes: String(new TextEncoder().encode(value).byteLength), newlines: String(newlines) })
}

function ExactText({ value, t }: { readonly value: string; readonly t: Translate }): ReactNode {
  return <>
    <pre tabIndex={0}>{value}</pre>
    <details>
      <summary>{t('forkPublishEscapedText')}</summary>
      <pre tabIndex={0}>{JSON.stringify(value)}</pre>
    </details>
  </>
}

function FilePreview({ preview, t }: { readonly preview: ReadyForkPreview; readonly t: Translate }): ReactNode {
  return <section className={css.preview}>
    <h3>{t('forkPublishFiles', { count: String(preview.files.length) })}</h3>
    <p className={css.hint}>{t('forkPublishExactText')}</p>
    <div className={css.files}>
      {preview.files.map(file => <details key={file.path} open className={css.file}>
        <summary><code>{file.path}</code></summary>
        <section aria-label={t('forkPublishBefore')}>
          <h4>{t('forkPublishBefore')}</h4>
          {file.before === null ? <p className={css.hint}>{t('forkPublishAbsent')}</p> : <>
            <p className={css.hint}>{textMetrics(file.before, t)}</p>
            <ExactText value={file.before} t={t} />
          </>}
        </section>
        <section aria-label={t('forkPublishAfter')}>
          <h4>{t('forkPublishAfter')}</h4>
          <p className={css.hint}>{textMetrics(file.after, t)}</p>
          <ExactText value={file.after} t={t} />
        </section>
      </details>)}
    </div>
  </section>
}

/**
 * Render authorized choices and complete text before requiring an explicit commit and PR confirmation.
 * @param props Publication view state, user-triggered commands, and localized copy.
 * @returns The review dialog and outcome Toast, including after the dialog closes.
 */
export function ForkPublishOverlay({
  useForkPublish, close, connect, edit, inspect, review, publish, retry, dismissNotice, t,
}: ForkPublishOverlayProps): ReactNode {
  const state = useForkPublish(value => value)
  const id = useId()
  const operation = state.operation
  const publishing = operation?.status === 'publishing'
  const uncertain = operation?.status === 'blocked' && (operation.failure.effect === 'unknown'
    || (operation.failure.effect === 'committed' && operation.failure.code !== 'pull-request-closed'))
  const busy = state.phase === 'discovering' || state.phase === 'previewing' || publishing
  const locked = busy || uncertain
  const preview = state.preview ?? operation?.preview
  const metadata = preview ?? state.repositories
  const branchError = state.failure?.code === 'invalid-branch' || state.failure?.code === 'default-branch'
  const repositoryError = state.failure?.code === 'invalid-repository'
  const canRetry = operation?.status === 'blocked' && (operation.failure.effect !== 'none'
    || ['network', 'timeout', 'unavailable'].includes(operation.failure.code))
  const progress = publishing ? 'forkPublishSaving' : state.phase === 'discovering' ? 'forkPublishDiscovering' : 'forkPublishPreviewing'
  return <>
    <Modal open={state.open} onClose={close} title={t('forkPublishTitle')} closeLabel={t('close')}
      description={t('forkPublishIntro')} className={css.dialog as string} contentClassName={css.content as string}
      footer={<div className={css.actions}>
        <Button variant="outline" onClick={close}>{t('close')}</Button>
        <Button variant="outline" disabled={locked} onClick={() => { void connect() }}>{t('forkPublishConnect')}</Button>
        <Button variant={preview === undefined ? 'primary' : 'outline'}
          disabled={locked || state.repositories === null || state.repository === '' || state.branch.trim() === ''}
          onClick={() => { void inspect() }}>{t('forkPublishInspect')}</Button>
        {canRetry ? <Button variant="primary" disabled={busy} onClick={() => { void retry() }}>{t('forkPublishRetry')}</Button> : null}
        {state.preview === null || operation !== null ? null : <Button variant="primary" disabled={!state.reviewed || busy}
          onClick={() => { void publish() }}>{t('forkPublishConfirm')}</Button>}
      </div>}>
      <div className={css.form}>
        {state.repositories === null ? null : <>
          <label className={css.field}>
            <span>{t('forkRepository')}</span>
            <select value={state.repository} disabled={locked} aria-required aria-invalid={repositoryError}
              aria-describedby={repositoryError ? `${id}-failure` : undefined}
              onChange={(event) => { edit('repository', event.target.value) }}>
              <option value="">{t('forkPublishChooseRepository')}</option>
              {state.repositories.repositories.map(item => (
                <option key={item.repository} value={item.repository}>{item.repository}</option>
              ))}
            </select>
          </label>
          {state.repositories.repositories.length === 0 ? <p className={css.hint}>{t('forkPublishEmpty')}</p> : null}
        </>}
        <label className={css.field}>
          <span>{t('forkBranch')}</span>
          <Input value={state.branch} placeholder={t('forkBranchPlaceholder')} disabled={locked} aria-required
            aria-invalid={branchError} aria-describedby={branchError ? `${id}-failure` : `${id}-branch-hint`}
            onChange={(event) => { edit('branch', event.target.value) }} />
        </label>
        <p id={`${id}-branch-hint`} className={css.hint}>{t('forkPublishBranchHint')}</p>
        {metadata === null ? null : <dl className={css.metadata}>
          <dt>{t('forkPublishAccount')}</dt><dd>{metadata.account}</dd>
          <dt>{t('forkPublishUpstream')}</dt><dd>{metadata.upstream}</dd>
          {preview === undefined ? null : <>
            <dt>{t('forkRepository')}</dt><dd>{preview.repository}</dd>
            <dt>{t('forkBranch')}</dt><dd>{preview.branch}</dd>
            <dt>{t('forkPublishBase')}</dt><dd>{`${preview.repository}:${preview.base}`}</dd>
            <dt>{t('forkPublishHead')}</dt><dd>{preview.head ?? t('forkPublishNewBranch', { base: preview.base })}</dd>
          </>}
        </dl>}
        {preview === undefined || preview.head === null ? null : <p className={css.hint}>{t('forkPublishBranchHistory')}</p>}
        {busy ? <div className={css.loading} role="status"><StateDot state="ongoing" /><span>{t(progress)}</span></div> : null}
        {publishing ? <p className={css.hint}>{t('forkPublishClosingHint')}</p> : null}
        {state.failure === null ? null : <p id={`${id}-failure`} className={css.error} role="alert">{t(ISSUE_KEYS[state.failure.code])}</p>}
        {operation?.status !== 'blocked' ? null : <section className={css.failure} role="alert">
          <p>{t(operation.failure.code === 'default-branch' && operation.failure.effect !== 'none'
            ? 'forkPublishConflict' : ISSUE_KEYS[operation.failure.code])}</p>
          {operation.failure.code === 'pull-request-closed' ? null : <p>{t(operation.failure.effect === 'unknown' ? 'forkPublishUnknown'
            : operation.failure.effect === 'committed' ? 'forkPublishCommitted' : 'forkPublishNoEffects')}</p>}
          {operation.failure.pullRequestUrl === undefined ? null : <a href={operation.failure.pullRequestUrl}
            target="_blank" rel="noopener noreferrer">{t('forkPublishOpenPr')}</a>}
        </section>}
        {preview === undefined ? null : <FilePreview preview={preview} t={t} />}
        {state.preview === null || operation !== null ? null : <Checkbox checked={state.reviewed}
          onChange={review} label={t('forkPublishReviewed')} />}
        {operation?.status !== 'saved' ? null : <section className={css.success}>
          <p role="status">{t('forkPublishSaved', { commit: operation.result.commit })}</p>
          {operation.openFailed ? <p>{t('forkPublishOpenFailed')}</p> : null}
          <a href={operation.result.pullRequestUrl} target="_blank" rel="noopener noreferrer">{t('forkPublishOpenPr')}</a>
        </section>}
      </div>
    </Modal>
    {state.notice === null ? null : <Toast key={state.notice.seq}
      text={t(state.notice.kind === 'saved' ? 'forkPublishSavedToast' : 'forkPublishFailedToast')}
      icon={state.notice.kind === 'saved' ? <IconCheckOutlineRegular /> : <IconWarningOutlineRegular />}
      onDone={dismissNotice} />}
  </>
}

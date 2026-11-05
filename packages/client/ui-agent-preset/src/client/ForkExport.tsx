/** Creator-gated source-export entry and a review dialog hosted outside the Plugins page. */
import { useEffect, useId, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconDownloadOutlineRegular, IconWarningOutlineRegular,
  Input, MenuItemButton, Modal, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsState } from './settings-store.ts'
import type { ForkExportKey } from './fork-locales.ts'
import type { ForkExportState, SourceExportIssue } from './fork-export-store.ts'
import menuCss from './CreatePluginMenuItem.module.css'
import css from './ForkExport.module.css'

/** Roster and opening action supplied to the Add plugin contribution. */
export interface ForkExportMenuInjected {
  hooks: { agentPresets: SnapshotStore<AgentPresetSettingsState> }
  load: () => Promise<void>
  open: () => void
}

type ForkExportMenuProps = PropsRuntime<'plugins.add.actions'> & PropsLocale<'settings.agentPreset'> & InjectFace<ForkExportMenuInjected>

/**
 * Close the Add plugin menu before opening the local export review.
 * @param props Shared roster, navigation callback, and localized copy.
 * @returns A stable entry that explains unavailable Creator mode.
 */
export function ForkExportMenuItem({ t, useAgentPresets, useRemoteAccess, load, open, onDismiss }: ForkExportMenuProps): ReactNode {
  const roster = useAgentPresets(state => state)
  const allowed = useRemoteAccess('pluginManager/exportSource')
  const enabled = allowed && roster.status === 'ready' && roster.options.some(option => option.id === 'cordis')
  useEffect(() => { void load() }, [load])
  let description = t('forkDescription')
  if (!allowed) description = t('forkUnavailable')
  else if (roster.status === 'idle' || roster.status === 'loading') description = t('createPluginChecking')
  else if (roster.status === 'error' || roster.status === 'unavailable') description = t('createPluginUnavailable')
  else if (!enabled) description = t('createPluginMissing')
  return <MenuItemButton icon={<IconDownloadOutlineRegular size={14} />} disabled={!enabled}
    onSelect={() => { onDismiss(); open() }}>
    <span className={menuCss.copy}>
      <span>{t('forkTitle')}</span>
      <span className={menuCss.description}>{description}</span>
    </span>
  </MenuItemButton>
}

/** Review commands and state supplied to the shell overlay. */
export interface ForkExportOverlayInjected {
  hooks: { forkExport: SnapshotStore<ForkExportState> }
  close: () => void
  edit: (field: 'repository' | 'branch', value: string) => void
  inspect: () => Promise<void>
  review: (reviewed: boolean) => void
  download: () => void
  dismissNotice: () => void
  openPublish: () => void
}

type ForkExportOverlayProps = PropsLocale<'settings.agentPreset'> & InjectFace<ForkExportOverlayInjected>

const ISSUE_KEYS = {
  'invalid-repository': 'forkInvalidRepository', 'invalid-branch': 'forkInvalidBranch',
  'profile-unavailable': 'forkProfileUnavailable', 'unsafe-path': 'forkUnsafePath',
  'source-unavailable': 'forkSourceUnavailable', 'unsupported-source': 'forkUnsupportedSource',
  'secret-suspected': 'forkSecretSuspected', 'source-changed': 'forkSourceChanged', 'too-large': 'forkTooLarge',
} satisfies Record<SourceExportIssue['code'], ForkExportKey>

/**
 * Render exact captured files and require review before a local JSON download.
 * @param props Read-only preview state, target edits, inspection, and browser save actions.
 * @returns The review modal and download outcome Toast, including after the modal closes.
 */
export function ForkExportOverlay({
  useForkExport, close, edit, inspect, review, download, dismissNotice, openPublish, t,
}: ForkExportOverlayProps): ReactNode {
  const state = useForkExport(value => value)
  const id = useId()
  const repositoryError = state.issues.some(issue => issue.code === 'invalid-repository')
  const branchError = state.issues.some(issue => issue.code === 'invalid-branch')
  const fileIssues = state.issues.filter(issue => issue.code !== 'invalid-repository' && issue.code !== 'invalid-branch')
  const busy = state.phase === 'inspecting'
  const retry = state.phase === 'failed' || state.phase === 'blocked'
  return <>
    <Modal open={state.open} onClose={close} title={t('forkTitle')} closeLabel={t('close')}
      description={t('forkIntro')} className={css.dialog as string} contentClassName={css.content as string}
      footer={<div className={css.actions}>
        <Button variant="outline" onClick={close}>{t('close')}</Button>
        <Button variant="outline" onClick={openPublish}>{t('forkPublishLaunch')}</Button>
        <Button variant={state.preview === null ? 'primary' : 'outline'} disabled={busy} onClick={() => { void inspect() }}>
          {t(retry ? 'forkRetry' : 'forkInspect')}
        </Button>
        {state.preview === null ? null : <Button variant="primary" disabled={!state.reviewed} onClick={download}>
          {t('forkDownload')}
        </Button>}
      </div>}>
      <div className={css.form}>
        <label className={css.field}>
          <span>{t('forkRepository')}</span>
          <Input value={state.repository} placeholder={t('forkRepositoryPlaceholder')} aria-required
            aria-invalid={repositoryError} aria-describedby={repositoryError ? `${id}-repository-error` : `${id}-target-hint`}
            onChange={(event) => { edit('repository', event.target.value) }} />
        </label>
        {repositoryError ? <p id={`${id}-repository-error`} className={css.error} role="alert">{t('forkInvalidRepository')}</p> : null}
        <label className={css.field}>
          <span>{t('forkBranch')}</span>
          <Input value={state.branch} placeholder={t('forkBranchPlaceholder')} aria-required
            aria-invalid={branchError} aria-describedby={branchError ? `${id}-branch-error` : `${id}-target-hint`}
            onChange={(event) => { edit('branch', event.target.value) }} />
        </label>
        {branchError ? <p id={`${id}-branch-error`} className={css.error} role="alert">{t('forkInvalidBranch')}</p> : null}
        <p id={`${id}-target-hint`} className={css.hint}>{t('forkTargetHint')}</p>
        {busy ? <div className={css.loading} role="status" aria-label={t('forkInspect')}><StateDot state="ongoing" /></div> : null}
        {state.phase === 'failed' ? <p className={css.error} role="alert">{t('forkInspectFailed')}</p> : null}
        {fileIssues.length === 0 ? null : <ul className={css.issues} role="alert">
          {fileIssues.map((issue, index) => <li key={`${issue.code}:${issue.path ?? ''}:${index}`}>
            {t(ISSUE_KEYS[issue.code])}{issue.path === undefined ? null : <code className={css.path}>{issue.path}</code>}
          </li>)}
        </ul>}
        {state.preview === null ? null : <section className={css.preview}>
          <h3 className={css.previewTitle}>{t('forkFiles', { count: String(state.preview.files.length) })}</h3>
          <p className={css.hint}>{t('forkReviewNotice')}</p>
          <p className={css.hint}>{t('forkExclusions')}</p>
          <div className={css.files}>
            {state.preview.files.map(file => <details key={file.path} className={css.file}>
              <summary><code>{file.path}</code></summary>
              <pre tabIndex={0}>{file.content}</pre>
            </details>)}
          </div>
          <Checkbox checked={state.reviewed} onChange={review} label={t('forkReviewed')} />
        </section>}
      </div>
    </Modal>
    {state.notice === null ? null : <Toast key={state.notice.seq}
      text={t(state.notice.kind === 'downloaded' ? 'forkDownloaded' : 'forkDownloadFailed')}
      icon={state.notice.kind === 'downloaded' ? <IconCheckOutlineRegular /> : <IconWarningOutlineRegular />}
      onDone={dismissNotice} />}
  </>
}

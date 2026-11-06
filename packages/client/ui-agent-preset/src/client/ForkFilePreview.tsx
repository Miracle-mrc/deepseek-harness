/** Bounded file navigation and explicitly selected, byte-exact source inspection. */
import { memo, useId, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadyForkPreview } from './fork-publish-store.ts'
import css from './ForkPublish.module.css'

type Translate = PropsLocale<'settings.agentPreset'>['t']
type PreviewFile = ReadyForkPreview['files'][number]
type TextSide = 'forkPublishBefore' | 'forkPublishAfter'

/** Fixed navigation density; source content is never included in an option. */
const FILES_PER_PAGE = 50

function statusKey(file: PreviewFile): 'forkPublishFileCreated' | 'forkPublishFileModified' {
  return file.before === null ? 'forkPublishFileCreated' : 'forkPublishFileModified'
}

const ExactText = memo(function ExactText({ value, side, t }: {
  readonly value: string
  readonly side: TextSide
  readonly t: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const escapedId = useId()
  const metrics = useMemo(() => {
    let newlines = 0
    for (const character of value) if (character === '\n') newlines++
    return { bytes: String(new TextEncoder().encode(value).byteLength), newlines: String(newlines),
      lines: String(value.length === 0 ? 0 : newlines + 1) }
  }, [value])
  const escaped = useMemo(() => expanded ? JSON.stringify(value) : null, [expanded, value])
  return <>
    <p className={css.hint}>{t('forkPublishTextMetrics', metrics)}</p>
    <p className={css.hint}>{t('forkPublishLineCount', { count: metrics.lines })}</p>
    <pre tabIndex={0}>{value}</pre>
    <Button variant="outline" className={css.escapedToggle} aria-expanded={expanded} aria-controls={escapedId}
      aria-label={t('forkPublishEscapedTextFor', { side: t(side) })}
      onClick={() => { setExpanded(current => !current) }}>{t('forkPublishEscapedText')}</Button>
    <div id={escapedId} hidden={!expanded}>
      {escaped === null ? null : <pre tabIndex={0}>{escaped}</pre>}
    </div>
  </>
})

const FileDetails = memo(function FileDetails({ file, t }: { readonly file: PreviewFile; readonly t: Translate }) {
  return <article className={css.file}>
    <h4>{file.path}</h4>
    <p className={css.hint}>{t(statusKey(file))}</p>
    <section aria-label={t('forkPublishBefore')}>
      <h5>{t('forkPublishBefore')}</h5>
      {file.before === null ? <p className={css.hint}>{t('forkPublishAbsent')}</p>
        : <ExactText value={file.before} side="forkPublishBefore" t={t} />}
    </section>
    <section aria-label={t('forkPublishAfter')}>
      <h5>{t('forkPublishAfter')}</h5>
      <ExactText value={file.after} side="forkPublishAfter" t={t} />
    </section>
  </article>
})

/**
 * Mount only an explicitly selected file; navigation never changes the publication receipt or acknowledgement.
 * @param props Immutable receipt and localized copy. The owner keys this view by receipt ID.
 * @returns A searchable, paginated file selector and at most one file's exact source and optional escaped text.
 */
export function ForkFilePreview({ preview, t }: { readonly preview: ReadyForkPreview; readonly t: Translate }): ReactNode {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [selectedPath, setSelectedPath] = useState('')
  const id = useId()
  const matching = useMemo(() => {
    const filter = query.trim().toLowerCase()
    return filter === '' ? preview.files : preview.files.filter(file => file.path.toLowerCase().includes(filter))
  }, [preview.files, query])
  const first = page * FILES_PER_PAGE
  const visible = useMemo(() => matching.slice(first, first + FILES_PER_PAGE), [matching, first])
  const selected = visible.find(file => file.path === selectedPath)
  const changePage = (next: number): void => {
    setPage(next)
    setSelectedPath('')
  }
  return <section className={css.preview} aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>{t('forkPublishFiles', { count: String(preview.files.length) })}</h3>
    <p className={css.hint}>{t('forkPublishExactText')}</p>
    <label className={css.field}>
      <span>{t('forkPublishSearchFiles')}</span>
      <Input type="search" value={query} autoComplete="off" aria-describedby={`${id}-count`}
        onChange={(event) => { setQuery(event.target.value); setPage(0); setSelectedPath('') }} />
    </label>
    <div id={`${id}-count`} className={css.fileCount} aria-live="polite">
      <span>{t('forkPublishMatchingFiles', { count: String(matching.length) })}</span>
      <span>{t('forkPublishFileRange', { first: String(matching.length === 0 ? 0 : first + 1),
        last: String(Math.min(first + FILES_PER_PAGE, matching.length)), count: String(matching.length) })}</span>
    </div>
    <label className={css.field}>
      <span>{t('forkPublishFileList')}</span>
      <select size={8} className={css.fileList} value={selectedPath} aria-describedby={`${id}-count`}
        aria-controls={`${id}-detail`} onChange={(event) => { setSelectedPath(event.target.value) }}>
        <option value="">{t('forkPublishChooseFile')}</option>
        {visible.map(file => <option key={file.path} value={file.path}>
          {t('forkPublishFileOption', { name: file.path.slice(file.path.lastIndexOf('/') + 1),
            path: file.path, status: t(statusKey(file)) })}
        </option>)}
      </select>
    </label>
    <div className={css.filePager}>
      <Button variant="outline" disabled={page === 0} onClick={() => { changePage(page - 1) }}>
        {t('forkPublishPreviousFiles')}
      </Button>
      <Button variant="outline" disabled={first + FILES_PER_PAGE >= matching.length}
        onClick={() => { changePage(page + 1) }}>{t('forkPublishNextFiles')}</Button>
    </div>
    {matching.length === 0 ? <p className={css.hint} role="status">{t('forkPublishNoMatchingFiles')}</p> : null}
    <div id={`${id}-detail`}>
      {selected === undefined ? <p className={css.hint}>{t('forkPublishSelectFile')}</p>
        : <FileDetails key={selected.path} file={selected} t={t} />}
    </div>
  </section>
}

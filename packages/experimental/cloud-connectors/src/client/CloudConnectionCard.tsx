/** Cloud OAuth sign-in and explicit, per-tool approval on the Plugins page. */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudConnectionView } from '../types.ts'
import { AWS_MCP_REGIONS, type CloudProvider } from '../catalog.ts'
import { defaultToolSelection, permissionCategory } from '../consent.ts'
import { NS } from './locales.ts'
import css from './CloudConnectionCard.module.css'

/** Remote methods wrapped to keep credential payloads out of the browser. */
export interface CloudConnectionActions {
  readonly list: () => Promise<CloudConnectionView[]>
  readonly start: (provider: CloudProvider, region: string) => Promise<{ url: string }>
  readonly confirm: (provider: CloudProvider, tools: string[]) => Promise<CloudConnectionView[]>
  readonly disconnect: (provider: CloudProvider) => Promise<CloudConnectionView[]>
}

/** Face injected by the Host's Plugins-page contribution. */
export interface CloudConnectionFace {
  readonly provider: CloudProvider
  readonly actions: CloudConnectionActions
}

/** Props received from the Plugins renderer. */
export type CloudConnectionCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<typeof NS>
  & InjectFace<CloudConnectionFace>

/**
 * Render a connection which remains disabled until browser login AND tool approval.
 * Selecting all only checks tool boxes; it cannot extend provider-side permissions.
 */
export function CloudConnectionCard(props: CloudConnectionCardProps) {
  const { provider, actions, t } = props
  const [connection, setConnection] = useState<CloudConnectionView | undefined>()
  const [selected, setSelected] = useState<string[]>([])
  const [region, setRegion] = useState('us-east-1')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [pendingLink, setPendingLink] = useState('')
  const toolsKey = useRef('')
  const readSequence = useRef(0)
  const appliedSequence = useRef(0)
  const actionInFlight = useRef(false)

  useEffect(() => {
    let live = true
    const refresh = async () => {
      if (actionInFlight.current) return
      const sequence = ++readSequence.current
      try {
        const all = await actions.list()
        if (!live || sequence <= appliedSequence.current) return
        appliedSequence.current = sequence
        const current = all.find(item => item.provider === provider)
        if (current === undefined) return
        setConnection(current)
        if (current.status === 'choose-permissions') {
          const key = current.tools.map(item => item.name).join('\u0000')
          if (key !== toolsKey.current) {
            // All offered tools are checked by default only on initial discovery.
            toolsKey.current = key
            setSelected(defaultToolSelection(current.tools))
          }
        } else if (current.status !== 'connected') {
          toolsKey.current = ''
        }
      } catch {
        if (live && sequence > appliedSequence.current) {
          appliedSequence.current = sequence
          setError(t('loadError'))
        }
      }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 1500)
    return () => { live = false; clearInterval(interval) }
  }, [actions, provider, t])

  if (props.view === 'summary') return <span>{t(provider === 'aws' ? 'awsSummary' : 'supabaseSummary')}</span>

  const status = connection?.status ?? 'not-connected'
  const elevated = connection?.tools.filter(tool => permissionCategory(provider, tool.name) !== 'other') ?? []
  const elevatedNames = elevated.map(tool => tool.name)
  const elevatedEnabled = elevatedNames.every(name => selected.includes(name))
  const beginAction = () => {
    if (actionInFlight.current) return false
    actionInFlight.current = true
    // A command supersedes reads issued before it, including delayed failures.
    appliedSequence.current = ++readSequence.current
    setError('')
    setWorking(true)
    return true
  }
  const finishAction = () => {
    appliedSequence.current = ++readSequence.current
    actionInFlight.current = false
    setWorking(false)
  }
  const signIn = () => {
    if (!beginAction()) return
    toolsKey.current = ''
    // Reserve a Web popup in this gesture; Desktop deliberately denies blank tabs.
    const tab = window.open('about:blank', '_blank')
    if (tab !== null) tab.opener = null
    setPendingLink('')
    void actions.start(provider, region).then(({ url }) => {
      // The URL crosses the Host wire boundary before entering a browser surface.
      const target = new URL(url)
      if (target.protocol !== 'https:' || target.username || target.password) {
        throw new Error('Invalid authorization URL')
      }
      setPendingLink(url)
      if (tab !== null) {
        // A user-closed popup stays closed; the manual link remains available.
        if (!tab.closed) tab.location.replace(url)
      } else {
        // Desktop sends HTTP(S) window opens to its existing system-browser handler.
        // A Web popup blocker may also return null, so retain the manual link.
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    }).catch(() => {
      if (tab !== null && !tab.closed) tab.close()
      setError(t('connectError'))
    }).finally(finishAction)
  }
  const confirm = () => {
    if (!beginAction()) return
    void actions.confirm(provider, selected).then((all) => {
      setConnection(all.find(item => item.provider === provider))
      setPendingLink('')
    }).catch(() => { setError(t('confirmError')) }).finally(finishAction)
  }
  const disconnect = () => {
    if (!beginAction()) return
    void actions.disconnect(provider).then((all) => {
      setConnection(all.find(item => item.provider === provider))
      setPendingLink('')
      toolsKey.current = ''
      setSelected([])
    }).catch(() => { setError(t('disconnectError')) }).finally(finishAction)
  }

  return (
    <section className={css.card}>
      <p className={css.status} data-status={status}>{t(`status.${status}`)}</p>
      <p className={css.note}>{t('scopeNote')}</p>
      {provider === 'aws' && status === 'not-connected' && (
        <label className={css.field}>{t('awsRegion')}
          <select value={region} onChange={(event) => { setRegion(event.target.value) }}>
            {AWS_MCP_REGIONS.map(value => <option key={value} value={value}>{t(`region.${value}`)}</option>)}
          </select>
        </label>
      )}
      {status === 'not-connected' && (
        <button type="button" className={css.primary} disabled={working} onClick={signIn}>{t('connect')}</button>
      )}
      {status === 'authorizing' && <p>{t('browserHint')}</p>}
      {pendingLink && status === 'authorizing' && (
        <a href={pendingLink} target="_blank" rel="noopener noreferrer">{t('openBrowser')}</a>
      )}
      {status === 'choose-permissions' && (
        <div className={css.permissions}>
          <h3>{t('permissionsTitle')}</h3>
          <p>{t('permissionsHint')}</p>
          <p>{t(provider === 'aws' ? 'awsToolsHint' : 'supabaseToolsHint')}</p>
          {elevatedNames.length > 0 && (
            <label className={css.tool}>
              <input type="checkbox" checked={elevatedEnabled} onChange={(event) => {
                setSelected(current => event.target.checked
                  ? Array.from(new Set([...current, ...elevatedNames]))
                  : current.filter(name => !elevatedNames.includes(name)))
              }} />
              <strong>{t(provider === 'aws' ? 'iamGroup' : 'databaseGroup')}</strong>
            </label>
          )}
          {connection?.tools.length === 0 && <p>{t('noTools')}</p>}
          {connection?.tools.map(tool => (
            <label key={tool.name} className={css.tool}>
              <input type="checkbox" checked={selected.includes(tool.name)} onChange={(event) => {
                setSelected(old => event.target.checked
                  ? [...old, tool.name]
                  : old.filter(name => name !== tool.name))
              }} />
              <span><strong>{tool.name}{permissionCategory(provider, tool.name) !== 'other' &&
                <span className={css.badge}>{t(provider === 'aws' ? 'iamTag' : 'databaseTag')}</span>}</strong>
              {tool.description && <small>{tool.description}</small>}</span>
            </label>
          ))}
          <button type="button" className={css.primary} disabled={working} onClick={confirm}>{t('enableSelected')}</button>
        </div>
      )}
      {status === 'connected' && (
        <p>{t('enabledCount').replace('{count}', String(connection?.enabledTools.length ?? 0))}</p>
      )}
      {(status === 'connected' || status === 'choose-permissions' || status === 'failed') && (
        <button type="button" disabled={working} onClick={disconnect}>{t('disconnect')}</button>
      )}
      {status === 'failed' && <p className={css.error}>{connection?.error}</p>}
      {error && <p role="alert" className={css.error}>{error}</p>}
      {provider === 'aws' && <p className={css.note}>{t('awsAvailability')}</p>}
    </section>
  )
}

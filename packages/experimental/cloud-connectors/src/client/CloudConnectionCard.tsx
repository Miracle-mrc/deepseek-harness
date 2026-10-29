/** Cloud OAuth sign-in and explicit, per-tool approval on the Plugins page. */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudConnectionView } from '../types.ts'
import type { CloudProvider } from '../catalog.ts'
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
 * Selecting all only checks tool boxes; it cannot extend provider-side IAM/RLS.
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

  useEffect(() => {
    let live = true
    const refresh = async () => {
      try {
        const all = await actions.list()
        if (!live) return
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
        if (live) setError(t('loadError'))
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
  const signIn = () => {
    // Opening a blank tab in this user gesture avoids browser popup blocking.
    const tab = window.open('about:blank', '_blank')
    if (tab !== null) tab.opener = null
    setError('')
    setWorking(true)
    void actions.start(provider, region).then(({ url }) => {
      setPendingLink(url)
      if (tab !== null && !tab.closed) tab.location.replace(url)
    }).catch(() => {
      if (tab !== null && !tab.closed) tab.close()
      setError(t('connectError'))
    }).finally(() => { setWorking(false) })
  }
  const confirm = () => {
    setWorking(true)
    setError('')
    void actions.confirm(provider, selected).then((all) => {
      setConnection(all.find(item => item.provider === provider))
      setPendingLink('')
    }).catch(() => { setError(t('confirmError')) }).finally(() => { setWorking(false) })
  }
  const disconnect = () => {
    setWorking(true)
    setError('')
    void actions.disconnect(provider).then((all) => {
      setConnection(all.find(item => item.provider === provider))
      setPendingLink('')
      setSelected([])
    }).catch(() => { setError(t('disconnectError')) }).finally(() => { setWorking(false) })
  }

  return (
    <section className={css.card}>
      <p className={css.status} data-status={status}>{t(`status.${status}`)}</p>
      <p className={css.note}>{t('scopeNote')}</p>
      {provider === 'aws' && status === 'not-connected' && (
        <label className={css.field}>{t('awsRegion')}
          <select value={region} onChange={(event) => { setRegion(event.target.value) }}>
            <option value="us-east-1">US East (N. Virginia)</option>
            <option value="us-west-2">US West (Oregon)</option>
            <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
            <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
            <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
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

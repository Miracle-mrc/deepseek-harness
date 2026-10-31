/** Cloud browser sign-in and explicit, per-tool approval on the Plugins page. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AwsLoginMethod, CloudAttemptId, CloudConnectionView, CloudPromptId, CloudSignIn, CloudStartOptions } from '../types.ts'
import { AWS_MCP_REGIONS, type CloudProvider } from '../catalog.ts'
import { defaultToolSelection, permissionCategory } from '../consent.ts'
import { NS, type CloudConnectionLocaleKey } from './locales.ts'
import css from './CloudConnectionCard.module.css'

/** Connection actions; private browser responses go only to complete(). */
export interface CloudConnectionActions {
  readonly list: () => Promise<CloudConnectionView[]>
  readonly start: (provider: CloudProvider, region: string, options?: CloudStartOptions) => Promise<CloudSignIn>
  readonly complete: (provider: CloudProvider, prompt: CloudPromptId, response: string) => Promise<CloudConnectionView[]>
  readonly cancel: (provider: CloudProvider, attempt: CloudAttemptId) => Promise<CloudConnectionView[]>
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

type ActionKind = 'start' | 'complete' | 'confirm' | 'cancel' | 'disconnect'
type OperationErrorKey = Extract<CloudConnectionLocaleKey, `${string}Error`>

interface ConnectionAction {
  kind: ActionKind
}

interface BrowserAuthorization {
  admission: Promise<CloudSignIn>
  attemptId: CloudAttemptId | undefined
  popup: Window | null
  cancelled: boolean
  handedOff: boolean
}

/** Close only a blank popup still owned by the authorization hand-off. */
function closePopup(authorization: BrowserAuthorization): void {
  if (authorization.popup !== null && !authorization.popup.closed) authorization.popup.close()
  authorization.popup = null
}

/** Only HTTPS destinations without embedded credentials may enter browser navigation. */
function authorizationTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const target = new URL(value)
    return target.protocol === 'https:' && !target.username && !target.password ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Render a connection which remains disabled until sign-in and tool approval.
 * Selecting all only checks tool boxes; it cannot extend provider-side permissions.
 */
export function CloudConnectionCard(props: CloudConnectionCardProps) {
  const { provider, actions, t } = props
  const [connection, setConnection] = useState<CloudConnectionView | undefined>()
  const [selected, setSelected] = useState<string[]>([])
  const [region, setRegion] = useState('us-east-1')
  const [profile, setProfile] = useState<string>()
  const [method, setMethod] = useState<AwsLoginMethod>()
  const [working, setWorking] = useState<ActionKind>()
  const [editingPermissions, setEditingPermissions] = useState(false)
  const [error, setError] = useState<OperationErrorKey>()
  const [pendingLink, setPendingLink] = useState('')
  const offeredTools = useRef<string[]>()
  const responseInput = useRef<HTMLInputElement>(null)
  const readSequence = useRef(0)
  const appliedSequence = useRef(0)
  const actionInFlight = useRef<ConnectionAction>()
  const browserAuthorization = useRef<BrowserAuthorization>()
  const mounted = useRef(true)

  const handOff = useCallback((authorization: BrowserAuthorization, url: string) => {
    if (authorization.cancelled || authorization.handedOff) return
    const target = authorizationTarget(url)
    if (target === undefined) {
      closePopup(authorization)
      setError('connectError')
      return
    }
    authorization.handedOff = true
    setPendingLink(target)
    try {
      if (authorization.popup !== null) {
        // A user-closed popup stays closed; the manual link remains available.
        if (!authorization.popup.closed) authorization.popup.location.replace(target)
      } else {
        // Desktop sends HTTPS window opens to its existing system-browser handler.
        window.open(target, '_blank', 'noopener,noreferrer')
      }
      authorization.popup = null
    } catch {
      closePopup(authorization)
      setError('connectError')
    }
  }, [])

  const publish = useCallback((current: CloudConnectionView | undefined) => {
    const authorization = browserAuthorization.current
    if (authorization !== undefined && authorization.attemptId !== undefined) {
      if (current?.status !== 'authorizing' || current.attemptId !== authorization.attemptId) {
        closePopup(authorization)
        browserAuthorization.current = undefined
        setPendingLink('')
      } else if (current.authorizationUrl !== undefined) {
        handOff(authorization, current.authorizationUrl)
      }
    }
    setConnection(current)
    if (current?.status === 'choose-permissions' || current?.status === 'connected') {
      const names = current.tools.map(tool => tool.name)
      const previous = offeredTools.current
      if (previous === undefined) {
        setSelected(current.status === 'connected' ? current.enabledTools : defaultToolSelection(current.tools))
      } else {
        // Discovery changes preserve explicit unchecked choices for existing tools.
        setSelected(selected => [
          ...selected.filter(name => names.includes(name)),
          ...names.filter(name => !previous.includes(name)
            && (current.status === 'choose-permissions' || current.enabledTools.includes(name))),
        ])
      }
      offeredTools.current = names
    } else {
      offeredTools.current = undefined
      setSelected([])
    }
    if (current?.status !== 'connected') setEditingPermissions(false)
  }, [handOff])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const authorization = browserAuthorization.current
      if (authorization !== undefined) closePopup(authorization)
      browserAuthorization.current = undefined
      actionInFlight.current = undefined
    }
  }, [])

  useEffect(() => {
    let live = true
    const refresh = async () => {
      if (actionInFlight.current) return
      const sequence = ++readSequence.current
      try {
        const all = await actions.list()
        if (!live || sequence <= appliedSequence.current) return
        appliedSequence.current = sequence
        setError(current => current === 'loadError' ? undefined : current)
        const current = all.find(item => item.provider === provider)
        if (current === undefined) return
        publish(current)
      } catch {
        if (live && sequence > appliedSequence.current) {
          appliedSequence.current = sequence
          setError('loadError')
        }
      }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 1500)
    return () => { live = false; clearInterval(interval) }
  }, [actions, provider, publish])

  if (props.view === 'summary') return <span>{t(provider === 'aws' ? 'awsSummary' : 'supabaseSummary')}</span>

  const status = connection?.status ?? 'not-connected'
  const awsProfile = profile ?? connection?.awsProfile ?? ''
  const awsMethod = method ?? connection?.awsMethod ?? 'login'
  const checkingProfile = status === 'authorizing' && provider === 'aws' && awsMethod === 'existing'
  const canConnect = status === 'not-connected' || status === 'failed'
  const showPermissions = status === 'choose-permissions' || (status === 'connected' && editingPermissions)
  const link = working === 'cancel' ? undefined : authorizationTarget(connection?.authorizationUrl) ?? pendingLink
  const elevated = connection?.tools.filter(tool => permissionCategory(provider, tool.name) !== 'other') ?? []
  const elevatedNames = elevated.map(tool => tool.name)
  const elevatedEnabled = elevatedNames.every(name => selected.includes(name))
  const beginAction = (kind: ActionKind) => {
    const previous = actionInFlight.current
    if (previous !== undefined) {
      if (kind !== 'cancel' || (previous.kind !== 'start' && previous.kind !== 'complete')) return undefined
    }
    const action: ConnectionAction = { kind }
    actionInFlight.current = action
    // A command supersedes reads issued before it, including delayed failures.
    appliedSequence.current = ++readSequence.current
    setError(undefined)
    setWorking(kind)
    return action
  }
  const isCurrent = (action: ConnectionAction) => mounted.current && actionInFlight.current === action
  const finishAction = (action: ConnectionAction) => {
    if (!isCurrent(action)) return
    appliedSequence.current = ++readSequence.current
    actionInFlight.current = undefined
    setWorking(undefined)
  }
  const signIn = () => {
    const action = beginAction('start')
    if (action === undefined) return
    offeredTools.current = undefined
    // Reserve a Web popup in this gesture; Desktop deliberately denies blank tabs.
    const tab = window.open('about:blank', '_blank')
    if (tab !== null) tab.opener = null
    setPendingLink('')
    const options: CloudStartOptions = { awsMethod }
    if (awsProfile.trim()) options.awsProfile = awsProfile.trim()
    const request = provider === 'aws' ? actions.start(provider, region, options) : actions.start(provider, region)
    const authorization: BrowserAuthorization = {
      admission: request, attemptId: undefined, popup: tab, cancelled: false, handedOff: false,
    }
    browserAuthorization.current = authorization
    void request.then(({ attemptId, url }) => {
      if (!isCurrent(action)) return
      authorization.attemptId = attemptId
      publish({ provider, status: 'authorizing', attemptId, tools: [], enabledTools: [],
        ...(provider === 'aws' ? { awsProfile, awsMethod } : {}) })
      if (url !== undefined) handOff(authorization, url)
      else if (provider === 'aws' && awsMethod === 'existing') closePopup(authorization)
    }).catch(() => {
      if (!isCurrent(action)) return
      closePopup(authorization)
      browserAuthorization.current = undefined
      setError('connectError')
    }).finally(() => { finishAction(action) })
  }
  const confirm = () => {
    const action = beginAction('confirm')
    if (action === undefined) return
    void actions.confirm(provider, selected).then((all) => {
      if (!isCurrent(action)) return
      publish(all.find(item => item.provider === provider))
      setEditingPermissions(false)
      setPendingLink('')
    }).catch(() => { if (isCurrent(action)) setError('confirmError') }).finally(() => { finishAction(action) })
  }
  const complete = (choice?: 'yes' | 'no') => {
    const prompt = connection?.prompt
    const input = responseInput.current
    if (prompt === undefined) return
    let response: string
    if (prompt.kind === 'select') {
      if (choice === undefined) return
      response = choice
    } else {
      if (input === null || !input.value.trim()) return
      response = input.value.trim()
    }
    const action = beginAction('complete')
    if (action === undefined) return
    // The response remains only in this request; clear the field before awaiting it.
    if (input !== null) input.value = ''
    void actions.complete(provider, prompt.id, response).then((all) => {
      if (!isCurrent(action)) return
      publish(all.find(item => item.provider === provider))
    }).catch(() => { if (isCurrent(action)) setError('responseError') }).finally(() => { finishAction(action) })
  }
  const disconnect = () => {
    const action = beginAction('disconnect')
    if (action === undefined) return
    if (responseInput.current !== null) responseInput.current.value = ''
    setPendingLink('')
    void actions.disconnect(provider).then((all) => {
      if (!isCurrent(action)) return
      publish(all.find(item => item.provider === provider))
      offeredTools.current = undefined
      setSelected([])
    }).catch(() => { if (isCurrent(action)) setError('disconnectError') }).finally(() => { finishAction(action) })
  }
  const cancelAuthorization = () => {
    const authorization = browserAuthorization.current
    const attemptId = connection?.attemptId
    if (authorization === undefined && attemptId === undefined) return
    const action = beginAction('cancel')
    if (action === undefined) return
    if (authorization !== undefined) {
      authorization.cancelled = true
      closePopup(authorization)
    }
    if (responseInput.current !== null) responseInput.current.value = ''
    setPendingLink('')
    // If cancellation beats admission, wait for its ID before cancelling that attempt.
    let request: Promise<CloudConnectionView[]>
    if (authorization !== undefined) request = authorization.admission.then(result => actions.cancel(provider, result.attemptId))
    else if (attemptId !== undefined) request = actions.cancel(provider, attemptId)
    else return
    void request.then((all) => {
      if (!isCurrent(action)) return
      browserAuthorization.current = undefined
      publish(all.find(item => item.provider === provider))
    }).catch(() => { if (isCurrent(action)) setError('cancelError') }).finally(() => { finishAction(action) })
  }

  return (
    <section className={css.card}>
      <p className={css.status} data-status={status}>{t(checkingProfile ? 'checkingProfile' : `status.${status}`)}</p>
      <p className={css.note}>{t('scopeNote')}</p>
      {provider === 'aws' && canConnect && <>
        <label className={css.field}>{t('awsProfile')}
          <input value={awsProfile} disabled={working !== undefined} autoComplete="off" onChange={(event) => { setProfile(event.target.value) }} />
        </label>
        <p className={css.note}>{t('awsProfileHint')}</p>
        <label className={css.field}>{t('awsMethod')}
          <select value={awsMethod} disabled={working !== undefined} onChange={(event) => {
            const value = event.target.value
            if (value === 'login' || value === 'sso' || value === 'existing') setMethod(value)
          }}>
            <option value="login">{t('awsMethod.login')}</option>
            <option value="sso">{t('awsMethod.sso')}</option>
            <option value="existing">{t('awsMethod.existing')}</option>
          </select>
        </label>
        <p className={css.note}>{t(`awsMethodHint.${awsMethod}`)}</p>
        <label className={css.field}>{t('awsRegion')}
          <select value={region} disabled={working !== undefined} onChange={(event) => { setRegion(event.target.value) }}>
            {AWS_MCP_REGIONS.map(value => <option key={value} value={value}>{t(`region.${value}`)}</option>)}
          </select>
        </label>
      </>}
      {canConnect && (
        <button type="button" className={css.primary} disabled={working !== undefined} onClick={signIn}>{t(status === 'failed' ? 'retry' : 'connect')}</button>
      )}
      {status === 'authorizing' && !checkingProfile && <p>{t('browserHint')}</p>}
      {link && status === 'authorizing' && (
        <a className={css.authorizationLink} href={link} aria-label={t('openBrowser')} target="_blank" rel="noopener noreferrer">{t('openBrowser')}<small>{link}</small></a>
      )}
      {connection?.code && status === 'authorizing' && <p>{t('verificationCode')} <strong>{connection.code}</strong></p>}
      {connection?.prompt?.kind === 'secret' && status === 'authorizing' && (
        <form key={connection.prompt.id} className={css.response} onSubmit={(event) => { event.preventDefault(); complete() }}>
          <p className={css.note}>{t(provider === 'aws' ? 'awsResponseHint' : 'supabaseResponseHint')}</p>
          <label className={css.field}>{t(provider === 'aws' ? 'awsResponse' : 'supabaseResponse')}
            <input ref={responseInput} type="password" autoComplete="off" spellCheck={false} required disabled={working !== undefined} />
          </label>
          <button type="submit" className={css.primary} disabled={working !== undefined}>{t('submitResponse')}</button>
        </form>
      )}
      {connection?.prompt?.kind === 'select' && status === 'authorizing' && (
        <div className={css.response}>
          <p>{t('replaceAwsLogin')}</p>
          <button type="button" disabled={working !== undefined} onClick={() => { complete('yes') }}>{t('replaceAwsLoginYes')}</button>
          <button type="button" disabled={working !== undefined} onClick={() => { complete('no') }}>{t('replaceAwsLoginNo')}</button>
        </div>
      )}
      {(status === 'authorizing' || working === 'start') && (
        <button type="button" disabled={working === 'cancel'} onClick={cancelAuthorization}>{t('cancelAuthorization')}</button>
      )}
      {showPermissions && (
        <div className={css.permissions}>
          <h3>{t('permissionsTitle')}</h3>
          <p>{t('permissionsHint')}</p>
          <p>{t(provider === 'aws' ? 'awsToolsHint' : 'supabaseToolsHint')}</p>
          {elevatedNames.length > 0 && (
            <label className={css.tool}>
              <input type="checkbox" checked={elevatedEnabled} disabled={working !== undefined} onChange={(event) => {
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
              <input type="checkbox" checked={selected.includes(tool.name)} disabled={working !== undefined} onChange={(event) => {
                setSelected(old => event.target.checked
                  ? [...old, tool.name]
                  : old.filter(name => name !== tool.name))
              }} />
              <span><strong>{tool.name}{permissionCategory(provider, tool.name) !== 'other' &&
                <span className={css.badge}>{t(provider === 'aws' ? 'iamTag' : 'databaseTag')}</span>}</strong>
              {tool.description && <small>{tool.description}</small>}</span>
            </label>
          ))}
          <button type="button" className={css.primary} disabled={working !== undefined} onClick={confirm}>{t(status === 'connected' ? 'savePermissions' : 'enableSelected')}</button>
        </div>
      )}
      {status === 'connected' && (
        <p>{t('enabledCount').replace('{count}', String(connection?.enabledTools.length ?? 0))}</p>
      )}
      {status === 'connected' && !editingPermissions && (
        <button type="button" disabled={working !== undefined} onClick={() => {
          if (connection === undefined) return
          setSelected(connection.enabledTools)
          setEditingPermissions(true)
        }}>{t('editPermissions')}</button>
      )}
      {(status === 'connected' || status === 'choose-permissions' || status === 'failed') && (
        <button type="button" disabled={working !== undefined} onClick={disconnect}>{t('disconnect')}</button>
      )}
      {status === 'failed' && <p role="alert" className={css.error}>{t(`error.${connection?.errorCode ?? 'connection-failed'}`)}</p>}
      {provider === 'aws' && connection?.errorCode === 'aws-cli-required' && (
        <a href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" target="_blank" rel="noopener noreferrer">{t('awsCliInstall')}</a>
      )}
      {error !== undefined && <p role="alert" className={css.error}>{t(error)}</p>}
      {provider === 'aws' && <p className={css.note}>{t('awsAvailability')}</p>}
    </section>
  )
}

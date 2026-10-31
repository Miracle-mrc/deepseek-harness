/** Human command execution over the shared cloud connection service. */
import { setTimeout as wait } from 'node:timers/promises'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CloudConnections, CloudProvider } from '@deepseek-ai/dsh-experimental-cloud-connectors'
import type {
  CloudConnectionErrorCode, CloudConnectionPrompt, CloudConnectionView,
} from '@deepseek-ai/dsh-experimental-cloud-connectors/types'
import type { CloudInvocation } from './args.ts'
import { CloudCliError, readConfirmation, readSecret, type SecretInput } from './secret-input.ts'

/** The domain operations used by the CLI, shared with the Plugins page. */
export type CloudCommands = Pick<CloudConnections, 'list' | 'restore' | 'start' | 'cancel' | 'complete' | 'confirm' | 'disconnect'>

/** Streams and polling configuration owned by one CLI application. */
export interface CloudCliIo {
  /** Command-owned terminal or explicitly requested standard input. */
  stdin: SecretInput
  /** Credential-free command output. */
  stdout: { write(text: string): unknown }
  /** Fixed prompt text and diagnostics, without response values. */
  stderr: { write(text: string): unknown }
  /** Delay between reads while a login or prompt remains pending. */
  pollIntervalMs: number
}

/** Safe diagnostics for provider outcomes, independent of response bodies. */
const FAILURE_TEXT: Record<CloudConnectionErrorCode, string> = {
  'authorization-failed': 'Cloud sign-in failed. Retry login and check the provider authorization policy.',
  'connection-failed': 'The saved cloud connection could not be restored. Retry login.',
  'session-expired': 'The cloud session expired. Sign in again.',
  'aws-cli-required': 'Install the latest AWS CLI v2 (2.32.0 or newer) on the Harness Host and retry login.',
  'aws-login-failed': 'AWS CLI sign-in failed. Check the selected profile and retry login.',
  'aws-permission-required': 'The AWS identity needs permission to access AWS MCP. Check its sign-in and MCP permissions.',
}

/** Select one provider from the service's complete view. */
function connectionOf(views: readonly CloudConnectionView[], provider: CloudProvider): CloudConnectionView {
  const view = views.find(item => item.provider === provider)
  if (view === undefined) throw new CloudCliError('The selected cloud provider is unavailable in this profile.')
  return view
}

/** Render a credential-free one-line state. */
function statusLine(view: CloudConnectionView): string {
  return `${view.provider}: ${view.status}; ${view.enabledTools.length} tools enabled\n`
}

/** Reject terminal provider failures using their safe public code. */
function assertUsable(view: CloudConnectionView): void {
  if (view.status === 'failed') {
    throw new CloudCliError(view.errorCode === undefined ? 'The cloud connection failed. Retry login.' : FAILURE_TEXT[view.errorCode])
  }
}

/** Keep browser completion observable while a terminal response is pending. */
async function answerPrompt(
  service: CloudCommands, provider: CloudProvider, prompt: CloudConnectionPrompt,
  io: CloudCliIo, signal: AbortSignal, allowStdin: boolean,
): Promise<CloudConnectionView[]> {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  let response: Promise<string>
  switch (prompt.kind) {
    case 'secret':
      response = readSecret(io.stdin, io.stderr, active, allowStdin)
      break
    case 'select':
      response = readConfirmation(io.stdin, io.stderr, active, allowStdin)
      break
    default:
      assertNever(prompt)
  }
  const changed = (async () => {
    while (true) {
      await wait(io.pollIntervalMs, undefined, { signal: active })
      const views = await service.list()
      const current = connectionOf(views, provider)
      if (current.status !== 'authorizing' || current.prompt?.id !== prompt.id) return views
    }
  })()
  try {
    const next = await Promise.race([
      response.then(value => ({ kind: 'response' as const, value })),
      changed.then(views => ({ kind: 'changed' as const, views })),
    ])
    if (next.kind === 'changed') return next.views
    signal.throwIfAborted()
    let value = next.value
    try {
      const views = await service.complete(provider, prompt.id, value)
      if (prompt.kind === 'select' && value === 'no') throw new CloudCliError('Sign-in was cancelled.', 130)
      return views
    }
    finally { value = '' }
  } finally {
    lifetime.abort()
    await Promise.allSettled([response, changed])
  }
}

/** Complete one owned sign-in without enabling any tools. */
async function login(
  service: CloudCommands, invocation: Extract<CloudInvocation, { kind: 'login' }>, io: CloudCliIo, signal: AbortSignal,
): Promise<void> {
  let succeeded = false
  signal.throwIfAborted()
  const started = await service.start(invocation.provider, invocation.region, invocation.options)
  const attemptId = started.attemptId
  let cancellation: Promise<CloudConnectionView[]> | undefined
  const cancel = (): void => {
    cancellation ??= service.cancel(invocation.provider, attemptId)
    // The command awaits cancellation in finally even if input is still pending.
    void cancellation.catch(() => undefined)
  }
  const urls = new Set<string>()
  const codes = new Set<string>()
  const showUrl = (url: string | undefined): void => {
    if (url === undefined || urls.has(url)) return
    urls.add(url)
    io.stdout.write(`Open this URL to sign in:\n${url}\n`)
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    showUrl(started.url)
    let views = await service.list()
    while (true) {
      signal.throwIfAborted()
      const view = connectionOf(views, invocation.provider)
      if (view.attemptId !== undefined && view.attemptId !== attemptId) {
        throw new CloudCliError('This sign-in was replaced by another attempt. Review connection status.')
      }
      showUrl(view.authorizationUrl)
      if (view.code !== undefined && !codes.has(view.code)) {
        codes.add(view.code)
        io.stdout.write(`Authorization code: ${view.code}\n`)
      }
      assertUsable(view)
      if (view.status === 'choose-permissions' || view.status === 'connected') {
        succeeded = true
        io.stdout.write(`${invocation.provider}: signed in.\n`
          + `Review tools with: dsh cloud tools ${invocation.provider}\n`
          + 'Enable tools explicitly with --enable <names> or --all.\n')
        return
      }
      if (view.status !== 'authorizing') throw new CloudCliError('Sign-in ended without storing a connection. Retry login.')
      if (view.prompt?.kind === 'select' && io.stdin.isTTY !== true && !invocation.secretStdin) {
        throw new CloudCliError('Replacing an AWS CLI login requires a terminal or an explicit response through --secret-stdin.')
      }
      if (invocation.provider === 'aws' && view.prompt?.kind === 'secret'
        && io.stdin.isTTY !== true && !invocation.secretStdin) {
        throw new CloudCliError('This AWS CLI sign-in requires a browser response. Use a terminal or pass --secret-stdin.')
      }
      if (view.prompt !== undefined && (io.stdin.isTTY === true || invocation.secretStdin)) {
        views = await answerPrompt(service, invocation.provider, view.prompt, io, signal, invocation.secretStdin)
      } else {
        await wait(io.pollIntervalMs, undefined, { signal })
        views = await service.list()
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!succeeded) await (cancellation ?? service.cancel(invocation.provider, attemptId))
  }
}

/**
 * Execute an admitted human command without creating an Agent or Session.
 * @param service - shared Host cloud connection operations.
 * @param invocation - parsed command; login never implies tool confirmation.
 * @param io - streams and polling cadence for this application.
 * @param signal - application cancellation, propagated to pending input and waits.
 * @returns after the command and any owned sign-in cancellation settle.
 */
export async function runCloudCommand(
  service: CloudCommands, invocation: CloudInvocation, io: CloudCliIo, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  switch (invocation.kind) {
    case 'login':
      await login(service, invocation, io, signal)
      return
    case 'status': {
      const providers: CloudProvider[] = invocation.provider === undefined ? ['aws', 'supabase'] : [invocation.provider]
      for (const provider of providers) await service.restore(provider)
      for (const view of await service.list()) {
        if (invocation.provider !== undefined && view.provider !== invocation.provider) continue
        io.stdout.write(statusLine(view))
        if (view.errorCode !== undefined) io.stdout.write(`${FAILURE_TEXT[view.errorCode]}\n`)
      }
      return
    }
    case 'tools': {
      let view = connectionOf(await service.restore(invocation.provider), invocation.provider)
      assertUsable(view)
      if (view.status !== 'connected' && view.status !== 'choose-permissions') {
        throw new CloudCliError('Sign in before reviewing tool permissions.')
      }
      if (invocation.selection !== undefined) {
        const names = invocation.selection.kind === 'all' ? view.tools.map(tool => tool.name) : invocation.selection.names
        if (names.some(name => !view.tools.some(tool => tool.name === name))) {
          throw new CloudCliError('The selection includes an unavailable tool. Run tools without options to review current names.')
        }
        view = connectionOf(await service.confirm(invocation.provider, names), invocation.provider)
        io.stdout.write(`${invocation.provider}: saved ${names.length} allowed tools.\n`)
      }
      io.stdout.write(statusLine(view))
      for (const tool of view.tools) {
        io.stdout.write(`${view.enabledTools.includes(tool.name) ? '[enabled]' : '[disabled]'} ${tool.name}\n`)
      }
      return
    }
    case 'disconnect':
      await service.disconnect(invocation.provider)
      io.stdout.write(`${invocation.provider}: disconnected from this Harness home.\n`)
      return
    default:
      assertNever(invocation)
  }
}

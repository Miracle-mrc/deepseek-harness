/** Official AWS CLI browser sign-in and SigV4-backed managed MCP access tokens. */

import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { z } from 'zod'
import { AWS_MCP_REGIONS } from './catalog.ts'
import { CloudConnectionError } from './errors.ts'
import type { AwsLoginMethod, CloudConnectionErrorCode } from './types.ts'

/** Both CLI streams share this credential-retention and protocol parsing bound. */
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024
const PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]*$/
const tokenResponse = z.object({
  accessToken: z.string().min(1), tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive().max(3600),
})

/** Managed MCP bearer token, with its conservative expiry in Unix milliseconds. */
export interface AwsCliToken {
  accessToken: string
  expiresAt: number
}

/** Host-owned CLI selectors; named-profile credentials remain in the AWS CLI store. */
export interface AwsCliTokenOptions {
  executable: string
  profile: string
  region: string
  signal: AbortSignal
  commandTimeoutMs: number
}

/** Browser hand-off and private input supplied by the initiating authorization surface. */
export interface AwsCliAuthorizationOptions extends AwsCliTokenOptions {
  method: AwsLoginMethod
  notify: (notice: AuthorizationNotice) => void
  prompt: (request: AuthorizationPrompt) => Promise<string>
}

/** Trusted process creation; injection substitutes executables without changing fixed AWS argv. */
export type AwsCliSpawner = (
  executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

interface CommandOutput { stdout: string; stderr: string; exitCode: number | null }

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/KEY|SECRET|TOKEN|PASSWORD/i.test(name) && !/^AWS_ENDPOINT_URL(?:_|$)/i.test(name)) env[name] = value
  }
  return {
    ...env, AWS_CLI_AUTO_PROMPT: 'off', AWS_PAGER: '', PYTHONUNBUFFERED: '1',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
  }
}

function validateSelectors(options: AwsCliTokenOptions): void {
  if (!PROFILE_NAME.test(options.profile) || !(AWS_MCP_REGIONS as readonly string[]).includes(options.region)) {
    throw new CloudConnectionError('authorization-failed')
  }
}

function authorizationUrl(candidate: string, method: AwsLoginMethod): string | undefined {
  try {
    const url = new URL(candidate)
    if (url.username !== '' || url.password !== '' || url.port !== '') return undefined
    const host = url.hostname
    const approved = method === 'login'
      ? /^[a-z0-9-]+\.signin\.aws(?:\.amazon\.com)?$/.test(host) && url.pathname === '/v1/authorize'
      : /^device\.sso\.[a-z0-9-]+\.amazonaws\.com$/.test(host) || /^[a-z0-9-]+\.awsapps\.com$/.test(host)
    return approved ? url.href : undefined
  } catch (_error) {
    // CLI output can contain documentation links or incomplete URLs; neither starts authorization.
    return undefined
  }
}

function failureCode(output: CommandOutput, fallback: CloudConnectionErrorCode): CloudConnectionErrorCode {
  if (/Invalid choice|invalid choice|Unknown options:|not a valid command/.test(output.stderr)) return 'aws-cli-required'
  if (/AccessDenied|LoginInsufficientPermissions|not authorized to perform/i.test(output.stderr)) return 'aws-permission-required'
  return fallback
}

/** One child owns its prompts, bounded streams, cancellation, and awaited exit. */
async function runCommand(
  options: AwsCliTokenOptions, args: string[], fallback: CloudConnectionErrorCode,
  spawnProcess: AwsCliSpawner, interaction?: AwsCliAuthorizationOptions,
): Promise<CommandOutput> {
  const isCancelled = (): boolean => options.signal.aborted
  if (isCancelled()) throw new CloudConnectionError(fallback)
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess(options.executable, args, {
      shell: false, windowsHide: true, stdio: 'pipe', env: commandEnvironment(),
    })
  } catch (_error) {
    throw new CloudConnectionError('aws-cli-required')
  }
  const lifecycle = new AbortController()
  const closed = Promise.withResolvers<CommandOutput>()
  let failure: CloudConnectionError | undefined
  let stdout = ''
  let stderr = ''
  let transcript = ''
  let bytes = 0
  let notifiedUrl: string | undefined
  let notifiedCode: string | undefined
  let requestedCode = false
  let requestedReplacement = false
  let input = Promise.resolve()
  const stop = (error: CloudConnectionError): void => {
    failure ??= error
    lifecycle.abort()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const abort = (): void => { stop(new CloudConnectionError(fallback)) }
  // Browser interaction uses the initiating authorization deadline, rather than an API-call budget.
  const timeout = interaction === undefined ? setTimeout(abort, options.commandTimeoutMs) : undefined
  const requestInput = (
    authorization: AwsCliAuthorizationOptions, request: AuthorizationPrompt, convert: (answer: string) => string,
  ): void => {
    input = input.then(async () => {
      if (lifecycle.signal.aborted) return
      const cancelled = Promise.withResolvers<string>()
      const withdraw = (): void => { cancelled.reject(new CloudConnectionError(fallback)) }
      lifecycle.signal.addEventListener('abort', withdraw, { once: true })
      try {
        const answer = await Promise.race([
          authorization.prompt({ ...request, signal: lifecycle.signal }), cancelled.promise,
        ])
        lifecycle.signal.throwIfAborted()
        const response = convert(answer)
        if (response.length === 0 || response.length > 32_768 || /[\r\n\0]/.test(response)) {
          throw new CloudConnectionError('authorization-failed')
        }
        child.stdin.write(`${response}\n`)
      } finally {
        lifecycle.signal.removeEventListener('abort', withdraw)
      }
    }).catch((error: unknown) => {
      stop(error instanceof CloudConnectionError ? error : new CloudConnectionError(fallback))
    })
  }
  const inspectInteraction = (interaction: AwsCliAuthorizationOptions): void => {
    for (const match of transcript.matchAll(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g)) {
      const url = authorizationUrl(match[0], interaction.method)
      if (url !== undefined && notifiedUrl === undefined) {
        notifiedUrl = url
        interaction.notify({ message: 'Continue in your browser to sign in to AWS.', url })
      }
    }
    if (interaction.method === 'sso') {
      const code = /(?:Then enter the code:|user code:)\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/i.exec(transcript)?.[1]
      if (code !== undefined && code !== notifiedCode && notifiedUrl !== undefined) {
        notifiedCode = code
        interaction.notify({ message: 'Enter this verification code in your browser.', url: notifiedUrl, code })
      }
    }
    if (interaction.method === 'login' && !requestedCode
      && transcript.includes('Enter the authorization code displayed in your browser:')) {
      requestedCode = true
      requestInput(interaction, {
        kind: 'secret', message: 'Paste the authorization code displayed by AWS in your browser.',
      }, answer => answer.trim())
    }
    if (interaction.method === 'login' && !requestedReplacement
      && /Do you want to overwrite it[\s\S]*?\(y\/n\):/.test(transcript)) {
      requestedReplacement = true
      requestInput(interaction, {
        kind: 'select', message: 'Replace the different AWS sign-in session saved in the selected profile?',
        options: [{ id: 'yes', label: 'Replace session' }, { id: 'no', label: 'Cancel sign-in' }],
      }, (answer) => {
        if (answer !== 'yes') throw new CloudConnectionError('authorization-failed')
        return 'y'
      })
    }
  }
  const receive = (channel: 'stdout' | 'stderr', chunk: string): void => {
    if (failure !== undefined) return
    bytes += Buffer.byteLength(chunk)
    if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
      stop(new CloudConnectionError(fallback))
      return
    }
    if (channel === 'stdout') stdout += chunk
    else stderr += chunk
    if (interaction === undefined) return
    transcript += chunk
    try { inspectInteraction(interaction) } catch (_error) { stop(new CloudConnectionError(fallback)) }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { receive('stdout', chunk) })
  child.stderr.on('data', (chunk: string) => { receive('stderr', chunk) })
  child.stdin.on('error', () => { stop(new CloudConnectionError(fallback)) })
  child.once('error', () => { stop(new CloudConnectionError('aws-cli-required')) })
  child.once('close', (exitCode) => { closed.resolve({ stdout, stderr, exitCode }) })
  options.signal.addEventListener('abort', abort, { once: true })
  if (isCancelled()) abort()
  let output: CommandOutput
  try {
    output = await closed.promise
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    options.signal.removeEventListener('abort', abort)
    lifecycle.abort()
    await input
  }
  if (failure !== undefined) throw failure
  if (output.exitCode !== 0) throw new CloudConnectionError(failureCode(output, fallback))
  return output
}

function selectors(options: AwsCliTokenOptions): string[] {
  return ['--profile', options.profile, '--region', options.region, '--no-cli-pager', '--no-cli-auto-prompt']
}

async function checkVersion(options: AwsCliTokenOptions, spawnProcess: AwsCliSpawner): Promise<void> {
  const output = await runCommand(options, ['--version'], 'aws-cli-required', spawnProcess)
  const version = /\baws-cli\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(`${output.stdout}\n${output.stderr}`)
  if (version === null || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 32)) {
    throw new CloudConnectionError('aws-cli-required')
  }
}

async function requestToken(options: AwsCliTokenOptions, spawnProcess: AwsCliSpawner): Promise<AwsCliToken> {
  const startedAt = Date.now()
  const output = await runCommand(options, [
    'signin', 'create-o-auth2-token-with-iam', '--grant-type', 'client_credentials',
    '--resource', 'aws-mcp.amazonaws.com', '--output', 'json', ...selectors(options),
  ], 'session-expired', spawnProcess)
  let body: unknown
  try { body = JSON.parse(output.stdout) } catch (_error) { throw new CloudConnectionError('authorization-failed') }
  const parsed = tokenResponse.safeParse(body)
  if (!parsed.success) throw new CloudConnectionError('authorization-failed')
  const expiresAt = startedAt + parsed.data.expiresIn * 1000
  if (expiresAt <= Date.now() || options.signal.aborted) throw new CloudConnectionError('session-expired')
  return { accessToken: parsed.data.accessToken, expiresAt }
}

/**
 * Sign in using the official CLI and obtain a token scoped to AWS MCP.
 * @param options - Host executable, profile, region, bounded authorization signal, and UI callbacks;
 * commandTimeoutMs bounds only version and token commands.
 * @param spawnProcess - Trusted process creator; omitted to launch the configured executable directly.
 * @returns A managed MCP token after successful login; existing credentials skip browser sign-in.
 * @throws CloudConnectionError after the child exits; provider output and authorization responses never enter the error.
 */
export async function authorizeAwsCli(
  options: AwsCliAuthorizationOptions, spawnProcess: AwsCliSpawner = spawn,
): Promise<AwsCliToken> {
  validateSelectors(options)
  await checkVersion(options, spawnProcess)
  if (options.method !== 'existing') {
    const args = options.method === 'login' ? ['login', '--remote'] : ['sso', 'login', '--use-device-code', '--no-browser']
    await runCommand(options, [...args, ...selectors(options)], 'aws-login-failed', spawnProcess, options)
  }
  return await requestToken(options, spawnProcess)
}

/**
 * Refresh an AWS MCP token through the named CLI profile without starting browser authorization.
 * @param options - Host executable, named profile, managed MCP region, lifetime, and command budget.
 * @param spawnProcess - Trusted process creator; omitted to launch the configured executable directly.
 * @returns A new bearer token; the official CLI refreshes its own underlying short-term credentials.
 * @throws CloudConnectionError after child exit when the CLI, profile session, permission, or response is unusable.
 */
export async function refreshAwsCliToken(
  options: AwsCliTokenOptions, spawnProcess: AwsCliSpawner = spawn,
): Promise<AwsCliToken> {
  validateSelectors(options)
  await checkVersion(options, spawnProcess)
  return await requestToken(options, spawnProcess)
}

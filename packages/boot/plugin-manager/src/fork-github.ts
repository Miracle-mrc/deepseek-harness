/** Bounded GitHub API requests through the host GitHub CLI credential store, with sanitized failures. */
import { execa, type Options } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** A GitHub API failure that never retains command output, request contents, or credential details. */
export class ForkGithubError extends Error {
  override readonly name = 'ForkGithubError'

  constructor(readonly code:
    | 'auth-required' | 'permission-denied' | 'not-found' | 'conflict' | 'timeout'
    | 'unavailable' | 'invalid-response' | 'too-large' | 'network',
  ) {
    super(`GitHub request failed (${code})`)
  }
}

/** Resolved host executable and limits for one GitHub API request. */
export interface ForkGithubConfig {
  /** Host GitHub CLI executable name or absolute path. */
  readonly ghCommand: string
  /** Deadline in milliseconds for each invocation. */
  readonly timeoutMs: number
  /** Maximum captured bytes per output stream, including HTTP headers. */
  readonly outputBytes: number
}

function apiPath(path: string): boolean {
  if (!/^[a-z0-9]/iu.test(path) || /[:\\#{}\p{Cc}\p{Z}\uFEFF]/u.test(path)) return false
  const resource = path.split('?', 1)[0] as string
  let decoded: string
  try { decoded = decodeURIComponent(resource) }
  catch (_error) { return false }
  return !/[\\\p{Cc}]/u.test(decoded)
    && decoded.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function statusFailure(status: number): ForkGithubError {
  switch (status) {
    case 401: return new ForkGithubError('auth-required')
    case 403: return new ForkGithubError('permission-denied')
    case 404: return new ForkGithubError('not-found')
    case 408:
    case 504: return new ForkGithubError('timeout')
    case 409:
    case 422: return new ForkGithubError('conflict')
    case 413: return new ForkGithubError('too-large')
    default: return new ForkGithubError('unavailable')
  }
}

function processFailure(code: unknown): ForkGithubError {
  switch (code) {
    case 'ETIMEDOUT': return new ForkGithubError('timeout')
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EPIPE':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH': return new ForkGithubError('network')
    default: return new ForkGithubError('unavailable')
  }
}

/** GitHub.com API requests using host-managed authentication; mutations are never retried. */
export class ForkGithub {
  constructor(private readonly config: ForkGithubConfig) {}

  /**
   * Invoke one relative GitHub API endpoint with a JSON body on stdin. Only JSON syntax is interpreted here.
   * HTTP and subprocess failures contain no raw diagnostics; cancellation preserves the caller's reason.
   * A mutation can have committed remotely before a timeout, cancellation, or malformed response is reported.
   * @param method HTTP method; changing operations require explicit POST or PATCH.
   * @param path Literal relative API path without a host, dot segments, placeholders, or control characters.
   * @param body JSON request fields, or undefined for no body.
   * @param signal Cancellation of this invocation and its descendants.
   * @returns Parsed JSON, or undefined for HTTP 204; operation-specific response validation belongs to the caller.
   * @throws {ForkGithubError} For an API refusal, unusable response, or failed invocation.
   */
  async request(
    method: 'GET' | 'POST' | 'PATCH', path: string, body: Record<string, unknown> | undefined, signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (!apiPath(path)) throw new ForkGithubError('permission-denied')
    const args = ['api', '--hostname', 'github.com', '--method', method, path, '--include']
    if (body !== undefined) args.push('--input', '-')
    const env = Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([key]) => key.toUpperCase() !== 'GH_DEBUG'))
    const run = () => {
      const options = {
        env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0' },
        extendEnv: false, stdin: body === undefined ? 'ignore' : 'pipe',
        ...body === undefined ? {} : { input: JSON.stringify(body) },
        stdout: 'pipe', stderr: 'pipe', encoding: 'utf8', buffer: true, lines: false,
        reject: false, verbose: 'none', stripFinalNewline: false, timeout: this.config.timeoutMs, maxBuffer: this.config.outputBytes,
        cancelSignal: signal, killDescendants: true, killSignal: 'SIGKILL',
      } as const satisfies Options
      return execa(this.config.ghCommand, args, options)
    }
    let result: Awaited<ReturnType<typeof run>>
    try {
      result = await run()
    } catch (error) {
      signal.throwIfAborted()
      throw processFailure(error instanceof Error && 'code' in error ? error.code : undefined)
    }
    signal.throwIfAborted()
    if (result.timedOut) throw new ForkGithubError('timeout')
    if (result.isMaxBuffer) throw new ForkGithubError('too-large')
    if (result.exitCode === undefined) throw processFailure(result.code)
    const statusLine = /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5][0-9]{2})(?:[ \t][^\r\n]*)?\r?\n/u.exec(result.stdout)
    if (statusLine === null) {
      if (result.exitCode === 4) throw new ForkGithubError('auth-required')
      throw new ForkGithubError(result.exitCode === 0 ? 'invalid-response' : 'network')
    }
    const status = Number(statusLine[1])
    if (status < 200 || status >= 300) throw statusFailure(status)
    const delimiter = /\r?\n\r?\n/u.exec(result.stdout)
    if (delimiter === null) throw new ForkGithubError('invalid-response')
    const text = result.stdout.slice(delimiter.index + delimiter[0].length)
    if (status === 204 && text === '') return undefined
    try {
      const value: unknown = JSON.parse(text)
      return value
    }
    catch (_error) { throw new ForkGithubError('invalid-response') }
  }
}

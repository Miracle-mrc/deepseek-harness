/** GitHub API routing, host authentication isolation, and sanitized subprocess failures. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ForkGithub, ForkGithubError } from '../src/fork-github.ts'

const processHooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('execa', () => ({ execa: processHooks.run }))

const config = { ghCommand: 'test-gh', timeoutMs: 3000, outputBytes: 4096 }
const signal = (): AbortSignal => new AbortController().signal

interface InvocationOptions {
  env: Record<string, string>
  stdin: 'ignore' | 'pipe'
  reject: boolean
  extendEnv: boolean
  timeout: number
  maxBuffer: number
  stripFinalNewline: boolean
  cancelSignal: AbortSignal
  killDescendants: boolean
  verbose: string
  input?: string
}

function invocation() {
  const [command, args, options] = processHooks.run.mock.calls[0] as [string, string[], InvocationOptions]
  return { command, args, options }
}

function response(body: string, status = 200, protocol = 'HTTP/2.0') {
  return {
    exitCode: status >= 400 ? 1 : 0,
    stdout: `${protocol} ${String(status)} response\r\nContent-Type: application/json\r\n\r\n${body}`,
    stderr: '',
  }
}

async function failure(operation: Promise<unknown>, code: ForkGithubError['code']): Promise<ForkGithubError> {
  const error: unknown = await operation.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(ForkGithubError)
  if (!(error instanceof ForkGithubError)) throw new Error('expected a GitHub request failure')
  expect(error.code).toBe(code)
  expect(error.cause).toBeUndefined()
  return error
}

beforeEach(() => {
  processHooks.run.mockReset()
  processHooks.run.mockResolvedValue(response('{"id":7,"login":"person"}'))
})
afterEach(() => { vi.unstubAllEnvs() })

it('uses the pinned GitHub API host and the host credential store without forwarding secret or debug variables', async () => {
  vi.stubEnv('GH_TOKEN', 'do-not-forward-token')
  vi.stubEnv('GITHUB_TOKEN', 'do-not-forward-github-token')
  vi.stubEnv('DEEPSEEK_API_KEY', 'do-not-forward-key')
  vi.stubEnv('DSH_SESSION_ID', 'do-not-forward-session')
  vi.stubEnv('GH_DEBUG', 'api')
  const cancellation = signal()
  const github = new ForkGithub(config)

  expect(await github.request('GET', 'user', undefined, cancellation)).toEqual({ id: 7, login: 'person' })
  expect(processHooks.run).toHaveBeenCalledTimes(1)
  const { command, args, options } = invocation()
  expect(command).toBe('test-gh')
  expect(args).toEqual([
    'api', '--hostname', 'github.com', '--method', 'GET', 'user', '--include',
  ])
  expect({
    extendEnv: options.extendEnv, stdin: options.stdin, reject: options.reject, timeout: options.timeout,
    maxBuffer: options.maxBuffer, stripFinalNewline: options.stripFinalNewline,
    cancelSignal: options.cancelSignal, killDescendants: options.killDescendants, verbose: options.verbose,
  }).toEqual({
    extendEnv: false, stdin: 'ignore', reject: false, timeout: 3000, maxBuffer: 4096, stripFinalNewline: false,
    cancelSignal: cancellation, killDescendants: true, verbose: 'none',
  })
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'DSH_SESSION_ID']) {
    expect(Object.hasOwn(options.env, key)).toBe(false)
  }
  expect(options.env.GH_DEBUG).toBeUndefined()
  for (const [key, value] of Object.entries({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0' })) {
    expect(options.env[key]).toBe(value)
  }
})

it.each(['POST', 'PATCH'] as const)('sends an exact %s JSON body through stdin without placing source on argv', async (method) => {
  const body = { content: 'export const text = "sensitive-value"\n', parents: ['abcdef'], force: false }
  const github = new ForkGithub(config)
  processHooks.run.mockResolvedValue(response('{"sha":"created"}', 201))

  expect(await github.request(method, 'repos/person/harness-fork/git/commits', body, signal())).toEqual({ sha: 'created' })
  const { command, args, options } = invocation()
  expect(command).toBe('test-gh')
  expect(args).toEqual([
    'api', '--hostname', 'github.com', '--method', method, 'repos/person/harness-fork/git/commits', '--include', '--input', '-',
  ])
  expect(options.input).toBe(JSON.stringify(body))
  expect(options.extendEnv).toBe(false)
  expect(args.join(' ')).not.toContain('sensitive-value')
  expect(processHooks.run).toHaveBeenCalledTimes(1)
})

it.each([
  '', 'https://other.example/user', '//other.example/user', '/user', '--help', '../user',
  'repos/person/../other', 'repos/%2e%2e/user', 'user\n--verbose', 'repos\\person\\repo',
  'repos/{owner}/{repo}', 'user#fragment',
  'repos/person/%invalid',
])('refuses a nonliteral API path before starting gh: %j', async (path) => {
  await failure(new ForkGithub(config).request('GET', path, undefined, signal()), 'permission-denied')
  expect(processHooks.run).not.toHaveBeenCalled()
})

it.each(['HTTP/1.1', 'HTTP/2', 'HTTP/2.0', 'HTTP/3'])('reads a %s status separately from JSON diagnostic text', async (protocol) => {
  const body = { message: 'HTTP 401 is sample content', nested: { token: 'sensitive-value' } }
  processHooks.run.mockResolvedValue(response(JSON.stringify(body), 200, protocol))
  expect(await new ForkGithub(config).request('GET', 'user', undefined, signal())).toEqual(body)
})

it.each([
  [401, 'auth-required'], [403, 'permission-denied'], [404, 'not-found'], [408, 'timeout'],
  [409, 'conflict'], [413, 'too-large'], [422, 'conflict'], [429, 'unavailable'], [500, 'unavailable'], [504, 'timeout'],
] as const)('classifies HTTP %s without exposing server bodies or subprocess diagnostics', async (status, code) => {
  processHooks.run.mockResolvedValue({
    ...response('{"message":"sensitive-body-value"}', status),
    stderr: 'Authorization: Bearer sensitive-stderr-value',
  })
  const error = await failure(new ForkGithub(config).request('POST', 'repos/person/fork/git/refs', { ref: 'refs/heads/creator/test' }, signal()), code)
  expect(`${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`).not.toContain('sensitive')
  expect(processHooks.run).toHaveBeenCalledTimes(1)
})

it.each(([
  { status: 403, code: 'permission-denied' },
  { status: 422, code: 'conflict' },
  { status: 409, code: 'conflict' },
] as const).flatMap(result => [
  { policy: 'GH013', message: 'GH013: Repository rule violations found for refs/heads/creator/test.' },
  { policy: 'signed commits', message: 'Commits must have verified signatures.' },
  { policy: 'branch protection', message: 'Protected branch update failed for refs/heads/creator/test.' },
].map(policy => ({ ...result, ...policy }))))(
  'keeps a fixed HTTP $status failure for $policy without exposing its diagnostics or retrying the mutation',
  async ({ status, code, message }) => {
    const serverBody = {
      message,
      errors: [{ resource: 'Reference', code: 'custom', message: 'sensitive-policy-rule' }],
      details: { token: 'sensitive-policy-token', signature: 'sensitive-policy-signature' },
    }
    processHooks.run.mockResolvedValueOnce({
      ...response(JSON.stringify(serverBody), status),
      stderr: `${message}\nAuthorization: Bearer sensitive-policy-stderr`,
    }).mockResolvedValueOnce(response('{"sha":"unexpected-retry"}', 201))

    const error = await failure(new ForkGithub(config).request('POST', 'repos/person/fork/git/refs', {
      ref: 'refs/heads/creator/test', sha: 'a'.repeat(40),
    }, signal()), code)

    expect(error.message).toBe(`GitHub request failed (${code})`)
    const exposed = `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`
    expect(exposed).not.toContain(message)
    expect(exposed).not.toContain('sensitive-policy')
    expect(exposed).not.toContain('GH013')
    expect(processHooks.run).toHaveBeenCalledTimes(1)
    expect(invocation().args).toEqual([
      'api', '--hostname', 'github.com', '--method', 'POST', 'repos/person/fork/git/refs', '--include', '--input', '-',
    ])
  },
)

it.each([
  '{"id":7}', 'HTTP/2.0 200 OK\r\n\r\n{', 'HTTP/2.0 200 OK\r\nHeader: missing body delimiter',
  'HTTP/2.0 999 Unknown\r\n\r\n{}', 'sensitive-value\nHTTP/2.0 401 response\n\n{}',
])('refuses malformed successful API output without echoing it: %j', async (stdout) => {
  processHooks.run.mockResolvedValue({ exitCode: 0, stdout, stderr: 'sensitive-value' })
  const error = await failure(new ForkGithub(config).request('GET', 'user', undefined, signal()), 'invalid-response')
  expect(String(error)).not.toContain('sensitive-value')
})

it('accepts an empty HTTP 204 response', async () => {
  processHooks.run.mockResolvedValue(response('', 204))
  expect(await new ForkGithub(config).request('GET', 'user', undefined, signal())).toBeUndefined()
})

it('returns syntactically valid GraphQL error fields for their operation owner to interpret', async () => {
  const body = { data: null, errors: [{ type: 'STALE_DATA', message: 'head changed' }] }
  processHooks.run.mockResolvedValue({ ...response(JSON.stringify(body)), exitCode: 1 })
  expect(await new ForkGithub(config).request('POST', 'graphql', { query: 'mutation { commit }' }, signal())).toEqual(body)
})

it.each([
  [{ timedOut: true }, 'timeout'], [{ isMaxBuffer: true }, 'too-large'],
  [{ code: 'ENOENT' }, 'unavailable'], [{ code: 'ECONNRESET' }, 'network'],
  [{ code: 'EACCES' }, 'unavailable'], [{ code: 'ETIMEDOUT' }, 'timeout'],
  [{ exitCode: 1 }, 'network'], [{ exitCode: 4 }, 'auth-required'],
] as const)('classifies a process failure without retaining raw errors: %j', async (facts, code) => {
  processHooks.run.mockResolvedValue({ stdout: '', stderr: 'sensitive-process-value', shortMessage: 'sensitive-command-value', ...facts })
  const error = await failure(new ForkGithub(config).request('POST', 'graphql', { query: 'mutation { sensitiveSource }' }, signal()), code)
  expect(`${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`).not.toContain('sensitive')
  expect(processHooks.run).toHaveBeenCalledTimes(1)
})

it('contains an unexpected runner rejection without exposing its cause', async () => {
  processHooks.run.mockRejectedValue(new Error('sensitive rejected command'))
  const error = await failure(new ForkGithub(config).request('GET', 'user', undefined, signal()), 'unavailable')
  expect(String(error)).not.toContain('sensitive')
})

it('classifies a rejected connection by its error code without exposing its message', async () => {
  processHooks.run.mockRejectedValue(Object.assign(new Error('sensitive rejected connection'), { code: 'ECONNREFUSED' }))
  const error = await failure(new ForkGithub(config).request('GET', 'user', undefined, signal()), 'network')
  expect(String(error)).not.toContain('sensitive')
})

it('does not start a request after cancellation', async () => {
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  controller.abort(reason)
  await expect(new ForkGithub(config).request('GET', 'user', undefined, controller.signal)).rejects.toBe(reason)
  expect(processHooks.run).not.toHaveBeenCalled()
})

it('preserves cancellation during a request and waits for the runner to settle', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const reason = new Error('caller cancelled')
  processHooks.run.mockImplementation((_command: string, _args: string[], options: { cancelSignal: AbortSignal }) => {
    started.resolve(undefined)
    return new Promise((resolve) => {
      options.cancelSignal.addEventListener('abort', () => {
        stopped.promise.then(() => { resolve({ isCanceled: true, stdout: '', stderr: '' }) }, () => {})
      }, { once: true })
    })
  })
  const request = new ForkGithub(config).request('POST', 'graphql', {}, controller.signal)
  const rejection = expect(request).rejects.toBe(reason)
  await started.promise
  controller.abort(reason)
  stopped.resolve(undefined)
  await rejection
  expect(processHooks.run).toHaveBeenCalledTimes(1)
})

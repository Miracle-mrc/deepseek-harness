/** Official AWS CLI protocols exercised with real, account-free Node child processes. */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import {
  authorizeAwsCli, refreshAwsCliToken,
  type AwsCliAuthorizationOptions, type AwsCliSpawner, type AwsCliTokenOptions,
} from '../src/aws-cli.ts'
import { CloudConnectionError } from '../src/errors.ts'

const token = { accessToken: 'private-managed-mcp-bearer', tokenType: 'Bearer', expiresIn: 3600 }
const browserUrl = 'https://us-east-1.signin.aws/v1/authorize?state=public-state&code_challenge=public-challenge'
const browserCode = Buffer.from('state=public-state&code=private-authorization-code').toString('base64')
const children = new Set<ChildProcessWithoutNullStreams>()
const exited = new Set<ChildProcessWithoutNullStreams>()

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all([...children].map(async (child) => {
    if (exited.has(child)) return
    const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
    child.kill('SIGKILL')
    await closed
  }))
  children.clear()
  exited.clear()
})

function options(): AwsCliTokenOptions {
  return {
    executable: 'selected-aws-cli', profile: 'dsh-cloud', region: 'us-east-1',
    signal: new AbortController().signal, commandTimeoutMs: 5000,
  }
}

function authorization(overrides: Partial<AwsCliAuthorizationOptions> = {}): AwsCliAuthorizationOptions {
  return { ...options(), method: 'login', notify: vi.fn(), prompt: vi.fn().mockResolvedValue(browserCode), ...overrides }
}

function fixture(scripts: { version?: string; login?: string; token?: string } = {}) {
  const calls: Array<{ executable: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }> = []
  const runner: AwsCliSpawner = (executable, args, spawnOptions) => {
    calls.push({ executable, args, options: spawnOptions })
    const source = args[0] === '--version'
      ? scripts.version ?? 'console.log(\'aws-cli/2.42.0 Python/3.13 fixture\')'
      : args[0] === 'signin' ? scripts.token ?? `console.log(${JSON.stringify(JSON.stringify(token))})`
        : scripts.login ?? 'process.exit(0)'
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, '--', ...args], spawnOptions)
    children.add(child)
    child.once('close', () => { exited.add(child) })
    return child
  }
  return { runner, calls }
}

function remoteLogin(replace = false): string {
  return `
    import { createInterface } from 'node:readline';
    const reader = createInterface({ input: process.stdin });
    process.stdout.write(${JSON.stringify(`Open this URL:\n${browserUrl}\n\nEnter the authorization code displayed in your browser: `)});
    reader.once('line', answer => {
      if (answer !== ${JSON.stringify(browserCode)}) process.exit(7);
      if (!${String(replace)}) process.exit(0);
      process.stdout.write('Profile dsh-cloud is already configured to use session private-old-identity. Do you want to overwrite it to use private-new-identity instead? (y/n): ');
      reader.once('line', choice => process.exit(choice === 'y' ? 0 : 8));
    });
  `
}

function expectAllExited(): void {
  expect([...children].every(child => exited.has(child))).toBe(true)
}

describe('AWS CLI managed MCP authorization', () => {
  it('uses remote browser sign-in, private pasteback, a named profile, and the IAM token operation', async () => {
    const { runner, calls } = fixture({ login: remoteLogin() })
    const notices: AuthorizationNotice[] = []
    const prompts: AuthorizationPrompt[] = []
    const started = Date.now()
    const result = await authorizeAwsCli(authorization({
      notify: (notice) => { notices.push(notice) }, prompt: (request) => { prompts.push(request); return Promise.resolve(browserCode) },
    }), runner)
    expect(result.accessToken).toBe(token.accessToken)
    expect(result.expiresAt).toBeGreaterThanOrEqual(started + 3_600_000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
    expect(notices).toEqual([{ message: 'Continue in your browser to sign in to AWS.', url: browserUrl }])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ kind: 'secret' })
    expect(JSON.stringify(notices)).not.toContain('private-authorization-code')
    expect(JSON.stringify(notices)).not.toContain(token.accessToken)
    expect(calls.map(call => call.executable)).toEqual(['selected-aws-cli', 'selected-aws-cli', 'selected-aws-cli'])
    expect(calls.map(call => call.args)).toEqual([
      ['--version'],
      ['login', '--remote', '--profile', 'dsh-cloud', '--region', 'us-east-1', '--no-cli-pager', '--no-cli-auto-prompt'],
      ['signin', 'create-o-auth2-token-with-iam', '--grant-type', 'client_credentials', '--resource',
        'aws-mcp.amazonaws.com', '--output', 'json', '--profile', 'dsh-cloud', '--region', 'us-east-1',
        '--no-cli-pager', '--no-cli-auto-prompt'],
    ])
    expectAllExited()
  })

  it.each(['yes', 'no'])('requires an explicit %s choice before replacing a different profile session', async (answer) => {
    const { runner, calls } = fixture({ login: remoteLogin(true) })
    const prompts: AuthorizationPrompt[] = []
    const result = authorizeAwsCli(authorization({ prompt: (request) => {
      prompts.push(request)
      return Promise.resolve(request.kind === 'select' ? answer : browserCode)
    } }), runner)
    if (answer === 'yes') await expect(result).resolves.toMatchObject({ accessToken: token.accessToken })
    else await expect(result).rejects.toMatchObject({ code: 'authorization-failed' })
    expect(prompts[1]).toMatchObject({
      kind: 'select', options: [{ id: 'yes', label: 'Replace session' }, { id: 'no', label: 'Cancel sign-in' }],
    })
    expect(JSON.stringify(prompts)).not.toContain('private-old-identity')
    expect(calls.filter(call => call.args[0] === 'signin')).toHaveLength(answer === 'yes' ? 1 : 0)
    expectAllExited()
  })

  it('respects an existing IAM Identity Center profile with the no-browser device flow', async () => {
    const deviceUrl = 'https://device.sso.eu-west-1.amazonaws.com/'
    const { runner, calls } = fixture({ login: `console.log(${JSON.stringify(`Open:\n${deviceUrl}\nThen enter the code:\n\nABCD-EFGH\n`)})` })
    const notices: AuthorizationNotice[] = []
    const prompt = vi.fn()
    await authorizeAwsCli(authorization({ method: 'sso', profile: 'company.sso', notify: (notice) => { notices.push(notice) }, prompt }), runner)
    expect(calls[1]?.args).toEqual([
      'sso', 'login', '--use-device-code', '--no-browser', '--profile', 'company.sso', '--region', 'us-east-1',
      '--no-cli-pager', '--no-cli-auto-prompt',
    ])
    expect(notices).toContainEqual({ message: 'Enter this verification code in your browser.', url: deviceUrl, code: 'ABCD-EFGH' })
    expect(prompt).not.toHaveBeenCalled()
    expectAllExited()
  })

  it('reuses a selected profile and refreshes its MCP token without a browser or stdin prompt', async () => {
    const existing = fixture()
    const notify = vi.fn()
    const prompt = vi.fn()
    await authorizeAwsCli(authorization({ method: 'existing', notify, prompt }), existing.runner)
    expect(existing.calls.map(call => call.args[0])).toEqual(['--version', 'signin'])
    expect(notify).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    const refreshed = fixture()
    await expect(refreshAwsCliToken(options(), refreshed.runner)).resolves.toMatchObject({ accessToken: token.accessToken })
    expect(refreshed.calls.map(call => call.args[0])).toEqual(['--version', 'signin'])
    expectAllExited()
  })

  it('uses separate API-call and interactive authorization deadlines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const prompted = Promise.withResolvers<undefined>()
    const { runner, calls } = fixture({ login: remoteLogin() })
    const operation = authorizeAwsCli(authorization({ signal: controller.signal, commandTimeoutMs: 50,
      prompt: () => { prompted.resolve(undefined); return new Promise<string>(() => {}) },
    }), runner)
    const failure = expect(operation).rejects.toBeInstanceOf(CloudConnectionError)
    await prompted.promise
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(2)
    expect([...children].filter(child => !exited.has(child))).toHaveLength(1)
    controller.abort()
    await failure
    expectAllExited()
  })

  it('cancels a waiting private prompt and awaits CLI exit before returning', async () => {
    const controller = new AbortController()
    const { runner } = fixture({ login: remoteLogin() })
    let promptSignal: AbortSignal | undefined
    await expect(authorizeAwsCli(authorization({ signal: controller.signal,
      prompt: (request) => {
        promptSignal = request.signal
        controller.abort()
        return new Promise<string>(() => {})
      },
    }), runner)).rejects.toMatchObject({ code: 'aws-login-failed' })
    expect(promptSignal?.aborted).toBe(true)
    expectAllExited()
  })

  it.each(['notification', 'prompt'])('contains a failing %s callback and reaps the process', async (callback) => {
    const { runner } = fixture({ login: remoteLogin() })
    const fail = (): never => { throw new Error('private-callback-detail') }
    const settings = authorization(callback === 'notification' ? { notify: fail } : { prompt: fail })
    const error: unknown = await authorizeAwsCli(settings, runner).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CloudConnectionError)
    expect(String(error)).not.toContain('private-callback-detail')
    expectAllExited()
  })

  it('rejects a browser input containing another stdin command', async () => {
    const { runner, calls } = fixture({ login: remoteLogin() })
    await expect(authorizeAwsCli(authorization({ prompt: () => Promise.resolve(`${browserCode}\ny`) }), runner))
      .rejects.toMatchObject({ code: 'authorization-failed' })
    expect(calls).toHaveLength(2)
    expectAllExited()
  })

  it.each(['', 'x'.repeat(32_769)])('rejects an empty or oversized private browser response', async (answer) => {
    const { runner } = fixture({ login: remoteLogin() })
    await expect(authorizeAwsCli(authorization({ prompt: () => Promise.resolve(answer) }), runner))
      .rejects.toMatchObject({ code: 'authorization-failed' })
    expectAllExited()
  })

  it('does not write an authorization response if its prompt cancels the operation as it resolves', async () => {
    const controller = new AbortController()
    const { runner } = fixture({ login: remoteLogin() })
    await expect(authorizeAwsCli(authorization({ signal: controller.signal, prompt: () => {
      controller.abort()
      return Promise.resolve(browserCode)
    } }), runner)).rejects.toMatchObject({ code: 'aws-login-failed' })
    expectAllExited()
  })

  it('skips queued prompts when browser notification cancels the initiating operation', async () => {
    const controller = new AbortController()
    const { runner } = fixture({ login: remoteLogin() })
    const prompt = vi.fn()
    await expect(authorizeAwsCli(authorization({ signal: controller.signal,
      notify: () => { controller.abort() }, prompt,
    }), runner)).rejects.toMatchObject({ code: 'aws-login-failed' })
    expect(prompt).not.toHaveBeenCalled()
    expectAllExited()
  })

  it('contains a stdin stream error during a private prompt and awaits CLI exit', async () => {
    const base = fixture({ login: remoteLogin() })
    const login = Promise.withResolvers<ChildProcessWithoutNullStreams>()
    const stdinFailure = new Error('private-stdin-failure-detail')
    const stdinErrors: Error[] = []
    const runner: AwsCliSpawner = (executable, args, settings) => {
      const child = base.runner(executable, args, settings)
      if (args[0] === 'login') {
        child.stdin.once('error', (error) => { stdinErrors.push(error) })
        login.resolve(child)
      }
      return child
    }
    const prompt = vi.fn(async () => {
      const child = await login.promise
      child.stdin.destroy(stdinFailure)
      return browserCode
    })
    const error: unknown = await authorizeAwsCli(authorization({ prompt }), runner).catch((failure: unknown) => failure)
    expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'secret' }))
    expect(stdinErrors).toHaveLength(1)
    expect(stdinErrors[0]).toBe(stdinFailure)
    expect(error).toBeInstanceOf(CloudConnectionError)
    expect(error).toMatchObject({ code: 'aws-login-failed' })
    const publicFailure = `${String(error)} ${JSON.stringify(error)}`
    expect(publicFailure).not.toContain(stdinFailure.message)
    expect(publicFailure).not.toContain(browserCode)
    expect(base.calls.map(call => call.args[0])).toEqual(['--version', 'login'])
    expectAllExited()
  })

  it('does not announce malformed, credential-bearing, alternate-port, or unrelated browser links', async () => {
    const invalid = [
      'https://bad%hostname/v1/authorize',
      'https://user:private-password@us-east-1.signin.aws/v1/authorize',
      'https://:private-password@us-east-1.signin.aws/v1/authorize',
      'https://us-east-1.signin.aws:444/v1/authorize',
      'https://us-east-1.signin.aws/different',
    ]
    const { runner } = fixture({ login: `console.log(${JSON.stringify(`${invalid.join('\n')}\n`)}); ${remoteLogin()}` })
    const notify = vi.fn()
    await authorizeAwsCli(authorization({ notify }), runner)
    expect(notify).toHaveBeenCalledExactlyOnceWith({ message: 'Continue in your browser to sign in to AWS.', url: browserUrl })
    expectAllExited()
  })

  it('accepts an AWS Apps device URL and ignores repeated URL notices', async () => {
    const deviceUrl = 'https://company.awsapps.com/start/#/device'
    const { runner } = fixture({ login: `console.log(${JSON.stringify(`${deviceUrl}\n${deviceUrl}\nThen enter the code:\nABCD-EFGH\n`)})` })
    const notify = vi.fn()
    await authorizeAwsCli(authorization({ method: 'sso', notify }), runner)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith({
      message: 'Enter this verification code in your browser.', url: deviceUrl, code: 'ABCD-EFGH',
    })
    expectAllExited()
  })

  it('does not expose unrelated SSO links or invent a device code', async () => {
    const { runner } = fixture({ login: "console.log('Information: https://attacker.example/authorize')" })
    const notify = vi.fn()
    await authorizeAwsCli(authorization({ method: 'sso', notify }), runner)
    expect(notify).not.toHaveBeenCalled()
    expectAllExited()
  })

  it('drops pending CLI output after cancellation without publishing a browser URL', async () => {
    const controller = new AbortController()
    const base = fixture({ login: remoteLogin() })
    const runner: AwsCliSpawner = (executable, args, settings) => {
      const child = base.runner(executable, args, settings)
      if (args[0] === 'login') child.stdout.once('data', () => { controller.abort() })
      return child
    }
    const notify = vi.fn()
    const prompt = vi.fn()
    await expect(authorizeAwsCli(authorization({ signal: controller.signal, notify, prompt }), runner))
      .rejects.toMatchObject({ code: 'aws-login-failed' })
    expect(notify).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expectAllExited()
  })

  it('accepts a complete URL and prompt split across process writes without forwarding unrelated links', async () => {
    const source = remoteLogin().replace(
      `process.stdout.write(${JSON.stringify(`Open this URL:\n${browserUrl}\n\nEnter the authorization code displayed in your browser: `)});`,
      `process.stdout.write(${JSON.stringify('Documentation: https://attacker.example/authorize\n')});
       process.stdout.write(${JSON.stringify(browserUrl.slice(0, 30))});
       setImmediate(() => process.stdout.write(${JSON.stringify(`${browserUrl.slice(30)}\nEnter the authorization code displayed in your browser: `)}));`,
    )
    const { runner } = fixture({ login: source })
    const notices: AuthorizationNotice[] = []
    await authorizeAwsCli(authorization({ notify: (notice) => { notices.push(notice) } }), runner)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.url).toBe(browserUrl)
    expectAllExited()
  })
})

describe('AWS CLI failure and process isolation', () => {
  it.each(['1.42.0', '2.31.99', 'not-a-version'])('requires AWS CLI 2.32 or newer before authentication: %s', async (version) => {
    const { runner, calls } = fixture({ version: `console.error(${JSON.stringify(`aws-cli/${version} private-extra-detail`)})` })
    await expect(authorizeAwsCli(authorization(), runner)).rejects.toMatchObject({ code: 'aws-cli-required' })
    expect(calls).toHaveLength(1)
    expectAllExited()
  })

  it('accepts the minimum supported version printed on stderr', async () => {
    const { runner } = fixture({ version: 'console.error(\'aws-cli/2.32.0 Python/3.13 fixture\')' })
    await expect(refreshAwsCliToken(options(), runner)).resolves.toMatchObject({ accessToken: token.accessToken })
    expectAllExited()
  })

  it('accepts a newer major CLI version', async () => {
    const { runner } = fixture({ version: "console.log('aws-cli/3.0.0 fixture')" })
    await expect(refreshAwsCliToken(options(), runner)).resolves.toMatchObject({ accessToken: token.accessToken })
    expectAllExited()
  })

  it('reports a missing executable without leaking process errors', async () => {
    const executable = join(tmpdir(), randomUUID(), 'missing-aws')
    const error: unknown = await refreshAwsCliToken({ ...options(), executable }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'aws-cli-required' })
    expect(String(error)).not.toContain(executable)
  })

  it('contains synchronous process-creation failures', async () => {
    const runner: AwsCliSpawner = () => { throw new Error('private-launcher-details') }
    const error: unknown = await refreshAwsCliToken(options(), runner).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'aws-cli-required' })
    expect(String(error)).not.toContain('private-launcher-details')
  })

  it.each([
    ['AccessDeniedException: private-principal-detail', 'aws-permission-required'],
    ['argument operation: Invalid choice private-details', 'aws-cli-required'],
    ['Session expired: private-session-detail', 'session-expired'],
  ])('returns only a fixed failure category for provider stderr: %s', async (providerError, code) => {
    const { runner } = fixture({ token: `console.error(${JSON.stringify(providerError)}); process.exitCode = 1` })
    const error: unknown = await refreshAwsCliToken(options(), runner).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('private-')
    expectAllExited()
  })

  it.each([
    'private-unparseable-response',
    JSON.stringify({ ...token, tokenType: 'Basic' }),
    JSON.stringify({ ...token, accessToken: '' }),
    JSON.stringify({ ...token, expiresIn: '3600' }),
    JSON.stringify({ ...token, expiresIn: 0 }),
    JSON.stringify({ ...token, expiresIn: 3601 }),
    JSON.stringify({ ...token, expiresIn: 1.5 }),
    JSON.stringify({ access_token: 'private-token', token_type: 'Bearer', expires_in: 3600 }),
  ])('rejects an invalid token response without exposing its body: %s', async (body) => {
    const { runner } = fixture({ token: `console.log(${JSON.stringify(body)})` })
    const error: unknown = await refreshAwsCliToken(options(), runner).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'authorization-failed' })
    expect(String(error)).not.toContain('private-')
    expectAllExited()
  })

  it('bounds combined stdout and stderr bytes and awaits the killed child', async () => {
    const { runner } = fixture({ token: `
      await new Promise(resolve => process.stdout.write('x'.repeat(131073), resolve));
      await new Promise(resolve => process.stderr.write('x'.repeat(131072), resolve));
      setInterval(() => {}, 1000);
    ` })
    await expect(refreshAwsCliToken(options(), runner)).rejects.toMatchObject({ code: 'session-expired' })
    expectAllExited()
  })

  it('counts multibyte process output in bytes', async () => {
    const { runner } = fixture({ token: `
      await new Promise(resolve => process.stdout.write('😀'.repeat(65537), resolve));
      setInterval(() => {}, 1000);
    ` })
    await expect(refreshAwsCliToken(options(), runner)).rejects.toMatchObject({ code: 'session-expired' })
    expectAllExited()
  })

  it('times out token minting and awaits actual process exit', async () => {
    const { runner } = fixture({ token: 'setInterval(() => {}, 1000)' })
    await expect(refreshAwsCliToken({ ...options(), commandTimeoutMs: 500 }, runner))
      .rejects.toMatchObject({ code: 'session-expired' })
    expectAllExited()
  })

  it('does not spawn a command after its parent has been cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { runner, calls } = fixture()
    await expect(refreshAwsCliToken({ ...options(), signal: controller.signal }, runner)).rejects.toBeInstanceOf(CloudConnectionError)
    expect(calls).toHaveLength(0)
  })

  it('handles cancellation admitted while the process is being created', async () => {
    const controller = new AbortController()
    const base = fixture()
    const runner: AwsCliSpawner = (executable, args, settings) => {
      const child = base.runner(executable, args, settings)
      controller.abort()
      return child
    }
    await expect(refreshAwsCliToken({ ...options(), signal: controller.signal }, runner)).rejects.toBeInstanceOf(CloudConnectionError)
    expectAllExited()
  })

  it('discards a token whose lifetime elapsed while the command was running', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const base = fixture()
    const runner: AwsCliSpawner = (executable, args, settings) => {
      const child = base.runner(executable, args, settings)
      if (args[0] === 'signin') child.once('close', () => { now += 3_600_001 })
      return child
    }
    await expect(refreshAwsCliToken(options(), runner)).rejects.toMatchObject({ code: 'session-expired' })
    expectAllExited()
  })

  it('does not publish a token if cancellation wins after the child exited', async () => {
    const controller = new AbortController()
    const base = fixture()
    const runner: AwsCliSpawner = (executable, args, settings) => {
      const child = base.runner(executable, args, settings)
      if (args[0] === 'signin') child.stdout.once('end', () => {
        child.once('close', () => { queueMicrotask(() => { controller.abort() }) })
      })
      return child
    }
    await expect(refreshAwsCliToken({ ...options(), signal: controller.signal }, runner)).rejects.toMatchObject({ code: 'session-expired' })
    expectAllExited()
  })

  it.each(['--profile', 'other profile', 'name\nvalue', '$(private-command)'])('rejects an unsafe profile selector before spawning: %s', async (profile) => {
    const { runner, calls } = fixture()
    await expect(refreshAwsCliToken({ ...options(), profile }, runner)).rejects.toMatchObject({ code: 'authorization-failed' })
    expect(calls).toHaveLength(0)
  })

  it('rejects an unsupported MCP region before spawning', async () => {
    const { runner, calls } = fixture()
    await expect(refreshAwsCliToken({ ...options(), region: 'us-fake-9' }, runner)).rejects.toMatchObject({ code: 'authorization-failed' })
    expect(calls).toHaveLength(0)
  })

  it('uses fixed argv without a shell and removes ambient secrets and endpoint overrides', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'private-harness-secret')
    vi.stubEnv('UNRELATED_PASSWORD', 'private-password')
    vi.stubEnv('AWS_SESSION_TOKEN', 'private-ambient-session')
    vi.stubEnv('AWS_ENDPOINT_URL_SIGNIN', 'https://attacker.example')
    vi.stubEnv('AWS_CONFIG_FILE', join(tmpdir(), 'selected-config-location'))
    const { runner, calls } = fixture()
    await refreshAwsCliToken(options(), runner)
    for (const call of calls) {
      expect(call.options).toMatchObject({ shell: false, windowsHide: true, stdio: 'pipe' })
      expect(call.options.env).toMatchObject({
        AWS_CLI_AUTO_PROMPT: 'off', AWS_PAGER: '', PYTHONUNBUFFERED: '1',
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_CONFIG_FILE: join(tmpdir(), 'selected-config-location'),
      })
      expect(call.options.env).not.toHaveProperty('DEEPSEEK_API_KEY')
      expect(call.options.env).not.toHaveProperty('UNRELATED_PASSWORD')
      expect(call.options.env).not.toHaveProperty('AWS_SESSION_TOKEN')
      expect(call.options.env).not.toHaveProperty('AWS_ENDPOINT_URL_SIGNIN')
    }
    expectAllExited()
  })
})

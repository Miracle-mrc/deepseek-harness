/** Input faults, stale authorization state, and application shutdown remain private and bounded. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Authorization from '@deepseek-ai/dsh-authorization'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Cloud from '@deepseek-ai/dsh-experimental-cloud-connectors'
import type {
  CloudAttemptId, CloudConnectionView, CloudSignIn,
} from '@deepseek-ai/dsh-experimental-cloud-connectors/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as Cli from '../src/index.ts'
import { runCloudCommand, type CloudCliIo, type CloudCommands } from '../src/run.ts'
import { CloudCliError, readConfirmation, readSecret, type SecretInput } from '../src/secret-input.ts'

afterEach(() => { vi.restoreAllMocks() })

const attemptId = 'edge-owned-attempt' as CloudAttemptId
const signal = (): AbortSignal => new AbortController().signal

function commandFixture(initial: Partial<CloudConnectionView> = {}) {
  const input = new PassThrough()
  onTestFinished(() => { input.destroy() })
  let view: CloudConnectionView = { provider: 'aws', status: 'not-connected', tools: [], enabledTools: [], ...initial }
  let stdout = ''
  let stderr = ''
  const all = (): CloudConnectionView[] => [view]
  const service: CloudCommands = {
    list: vi.fn(async () => all()), restore: vi.fn(async () => all()),
    start: vi.fn(async () => ({ attemptId })), cancel: vi.fn(async () => all()),
    complete: vi.fn(async () => { view = { ...view, status: 'choose-permissions' }; delete view.prompt; return all() }),
    confirm: vi.fn(async () => all()), disconnect: vi.fn(async () => all()),
  }
  const io: CloudCliIo = {
    stdin: input, stdout: { write: (text) => { stdout += text } },
    stderr: { write: (text) => { stderr += text } }, pollIntervalMs: 10,
  }
  return { input, service, io, output: () => ({ stdout, stderr }) }
}

function inputFixture(options: { encoded?: boolean; raw?: boolean; flowing?: boolean } = {}) {
  const input: PassThrough & SecretInput = new PassThrough()
  onTestFinished(() => { input.destroy() })
  if (options.encoded) input.setEncoding('utf8')
  const setRawMode = vi.fn()
  if (options.raw) Object.assign(input, { isTTY: true, isRaw: true, setRawMode })
  if (options.flowing) input.resume()
  let output = ''
  const writer = { write: (text: string) => { output += text } }
  return { input, setRawMode, writer, output: () => output }
}

async function application(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cloud-cli-errors-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const ready = new Set<() => void>()
  const exited = Promise.withResolvers<number>()
  provideCmdline(ctx, { args, exit: (code) => { exited.resolve(code) }, ready: {
    onReady: (listener) => { ready.add(listener); return () => { ready.delete(listener) } },
  } })
  await ctx.plugin(Credentials, { path: join(directory, 'credentials.yml'), watch: false })
  await ctx.plugin(Authorization)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Cloud.CloudConnections, { restoreOnStart: false })
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output += String(chunk); return true })
  return {
    ctx, exited: exited.promise, output: () => output,
    mount: async () => { await ctx.plugin(Cli, { pollIntervalMs: 10 }) },
    ready: () => { for (const callback of ready) callback() },
    readyCount: () => ready.size,
  }
}

describe('terminal and private-stream faults', () => {
  it('refuses an already closed stream before acquiring terminal state', async () => {
    const f = inputFixture({ raw: true })
    f.input.destroy()
    await expect(readSecret(f.input, f.writer, signal(), true)).rejects.toThrow('Standard input ended')
    expect(f.setRawMode).not.toHaveBeenCalled()
  })

  it('refuses an empty supplied line without echoing it', async () => {
    const f = inputFixture()
    const result = readSecret(f.input, f.writer, signal(), true)
    f.input.end('\n')
    await expect(result).rejects.toThrow('No response was provided')
  })

  it('preserves an existing raw and flowing terminal mode and supports clearing a hidden draft', async () => {
    const f = inputFixture({ raw: true, flowing: true })
    const result = readSecret(f.input, f.writer, signal(), false)
    f.input.write('private-draft\u0015kept-response\n')
    await expect(result).resolves.toBe('kept-response')
    expect(f.setRawMode.mock.calls).toEqual([[true], [true]])
    expect(f.input.readableFlowing).toBe(true)
    expect(f.output()).not.toContain('private-draft')
    expect(f.output()).not.toContain('kept-response')
  })

  it.each([false, true])('preserves the next answer after a bare CR on an encoded=%s stream', async (encoded) => {
    const f = inputFixture({ encoded })
    f.input.end('yes\rprivate-next-response\n')
    await expect(readConfirmation(f.input, f.writer, signal(), true)).resolves.toBe('yes')
    await expect(readSecret(f.input, f.writer, signal(), true)).resolves.toBe('private-next-response')
    expect(f.output()).not.toContain('private-next-response')
  })

  it('reports an unsupported object-mode stream without rendering its values', async () => {
    const input = Readable.from([{ secret: 'private-object-input' }], { objectMode: true })
    onTestFinished(() => { input.destroy() })
    const writer = { write: vi.fn() }
    await expect(readSecret(input, writer, signal(), true)).rejects.toThrow('unsupported data')
    expect(writer.write.mock.calls.flat().join('')).not.toContain('private-object-input')
  })

  it('contains a synchronous stream read failure', async () => {
    const f = inputFixture()
    vi.spyOn(f.input, 'read').mockImplementation(() => { throw new Error('private-input-device-detail') })
    await expect(readSecret(f.input, f.writer, signal(), true)).rejects.toThrow('The secret input stream failed')
    expect(f.output()).not.toContain('private-input-device-detail')
    expect(f.input.listenerCount('readable')).toBe(0)
  })

  it('finishes an incomplete UTF-8 sequence at EOF without exposing bytes in output', async () => {
    const f = inputFixture()
    const result = readSecret(f.input, f.writer, signal(), true)
    f.input.end(Buffer.from([0xe2, 0x82]))
    await expect(result).resolves.toBe('\ufffd')
    expect(f.output()).not.toContain('\ufffd')
  })

  it('settles once when input failure and cancellation arrive in the same dispatch', async () => {
    const f = inputFixture()
    const controller = new AbortController()
    const cancelOnError = (): void => { controller.abort() }
    f.input.on('error', cancelOnError)
    const result = readSecret(f.input, f.writer, controller.signal, true)
    f.input.emit('error', new Error('private-input-error'))
    await expect(result).rejects.toThrow('Sign-in was cancelled')
    f.input.off('error', cancelOnError)
    expect(f.input.listenerCount('error')).toBe(0)
  })

  it('handles cancellation while the prompt is being displayed', async () => {
    const f = inputFixture({ raw: true })
    const controller = new AbortController()
    await expect(readSecret(f.input, { write: () => { controller.abort() } }, controller.signal, false))
      .rejects.toThrow('Sign-in was cancelled')
    expect(f.setRawMode).toHaveBeenLastCalledWith(true)
    expect(f.input.listenerCount('readable')).toBe(0)
  })

  it('ignores a queued EOF callback after input failure has already settled', async () => {
    const f = inputFixture()
    const failOnEnd = (): void => { f.input.emit('error', new Error('private-end-failure')) }
    f.input.on('end', failOnEnd)
    const result = readSecret(f.input, f.writer, signal(), true)
    f.input.end('private-unfinished-response')
    await expect(result).rejects.toThrow('The secret input stream failed')
    f.input.off('end', failOnEnd)
    expect(f.output()).not.toContain('private-unfinished-response')
  })
})

describe('terminal cloud-state failures', () => {
  it('refuses a provider missing from the current service view', async () => {
    const f = commandFixture()
    vi.mocked(f.service.restore).mockResolvedValueOnce([])
    await expect(runCloudCommand(f.service, { kind: 'tools', provider: 'aws' }, f.io, signal()))
      .rejects.toThrow('provider is unavailable')
    expect(f.service.confirm).not.toHaveBeenCalled()
  })

  it.each([undefined, 'session-expired'] as const)('reports a failed cloud connection with code=%s', async (errorCode) => {
    const f = commandFixture({ status: 'failed', ...errorCode === undefined ? {} : { errorCode } })
    await expect(runCloudCommand(f.service, { kind: 'tools', provider: 'aws' }, f.io, signal())).rejects.toBeInstanceOf(CloudCliError)
    expect(f.service.confirm).not.toHaveBeenCalled()
  })

  it('prints the safe failure category when displaying status', async () => {
    const f = commandFixture({ status: 'failed', errorCode: 'aws-cli-required' })
    await runCloudCommand(f.service, { kind: 'status' }, f.io, signal())
    expect(f.output().stdout).toContain('latest AWS CLI v2')
  })

  it('refuses tool selection before a connection exists', async () => {
    const f = commandFixture()
    await expect(runCloudCommand(f.service, { kind: 'tools', provider: 'aws' }, f.io, signal())).rejects.toThrow('Sign in before')
    expect(f.service.confirm).not.toHaveBeenCalled()
  })

  it('does not claim success for a sign-in replaced by another attempt', async () => {
    const f = commandFixture({ status: 'authorizing', attemptId: 'new-owner-attempt' as CloudAttemptId })
    await expect(runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, signal())).rejects.toThrow('replaced by another attempt')
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
    expect(f.service.disconnect).not.toHaveBeenCalled()
  })

  it('refuses a sign-in which ended without a saved connection', async () => {
    const f = commandFixture()
    await expect(runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, signal())).rejects.toThrow('without storing a connection')
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
  })

  it('cancels the admitted identity after interruption during start and observes cancellation failure', async () => {
    const f = commandFixture({ status: 'authorizing', attemptId })
    const controller = new AbortController()
    const admitted = Promise.withResolvers<CloudSignIn>()
    vi.mocked(f.service.start).mockReturnValueOnce(admitted.promise)
    vi.mocked(f.service.cancel).mockRejectedValueOnce(new Error('private-cancellation-failure'))
    const operation = runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, controller.signal)
    const rejected = expect(operation).rejects.toThrow()
    controller.abort()
    admitted.resolve({ attemptId })
    await rejected
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
    expect(JSON.stringify(f.output())).not.toContain('private-cancellation-failure')
  })

  it('refuses an unsupported command supplied by an untyped JavaScript caller', async () => {
    const f = commandFixture()
    await expect(Reflect.apply(runCloudCommand, undefined, [f.service, { kind: 'unknown-command' }, f.io, signal()])).rejects.toThrow()
    expect(f.service.start).not.toHaveBeenCalled()
    expect(f.service.confirm).not.toHaveBeenCalled()
  })

  it('refuses an unknown authorization prompt from an untyped service response', async () => {
    const f = commandFixture({ status: 'authorizing', attemptId })
    const untypedService = { ...f.service, list: async () => [{
      provider: 'aws', status: 'authorizing', attemptId, tools: [], enabledTools: [],
      prompt: { id: 'future-service-prompt', kind: 'future-prompt' },
    }] }
    await expect(Reflect.apply(runCloudCommand, undefined, [untypedService, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: true,
    }, f.io, signal()])).rejects.toThrow()
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.confirm).not.toHaveBeenCalled()
  })
})

describe('cloud command application lifecycle', () => {
  it('requires launcher readiness before mounting process listeners', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    provideCmdline(ctx, { args: ['status'], exit: vi.fn() })
    const before = process.listenerCount('SIGINT')
    expect(() => { Cli.apply(ctx, {}) }).toThrow('launcher must provide appReady')
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it.each([
    { failure: () => new CloudCliError('The requested cloud command was refused.', 9), code: 9, text: 'was refused' },
    { failure: () => new Cloud.CloudConnectionError('session-expired'), code: 1, text: 'session is no longer valid' },
    { failure: () => new Error('private-provider-error-body'), code: 1, text: 'Check connection status and retry' },
  ])('reports only safe command failure text and exit code $code', async ({ failure, code, text }) => {
    const f = await application(['status'])
    vi.spyOn(Cloud.CloudConnections.prototype, 'restore').mockRejectedValueOnce(failure())
    await f.mount()
    f.ready()
    await expect(f.exited).resolves.toBe(code)
    expect(f.output()).toContain(text)
    expect(f.output()).not.toContain('private-provider-error-body')
  })

  it('drains an interrupted admitted command before removing its own signal handlers', async () => {
    const before = new Set(process.listeners('SIGINT'))
    const f = await application(['login', 'aws'])
    const admitted = Promise.withResolvers<CloudSignIn>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(Cloud.CloudConnections.prototype, 'start').mockImplementation(() => { entered.resolve(undefined); return admitted.promise })
    const cancel = vi.spyOn(Cloud.CloudConnections.prototype, 'cancel').mockResolvedValue([])
    await f.mount()
    f.ready()
    await entered.promise
    const handlers = process.listeners('SIGINT').filter(listener => !before.has(listener))
    expect(handlers).toHaveLength(1)
    const handler = handlers[0]
    if (handler === undefined) throw new Error('The cloud command did not install its signal handler')
    handler('SIGINT')
    admitted.resolve({ attemptId })
    await expect(f.exited).resolves.toBe(130)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
    expect(f.output()).toContain('Cloud command cancelled')
    await f.ctx.fiber.dispose()
    expect(process.listeners('SIGINT')).toEqual([...before])
  })

  it('withdraws a command which has not reached successful application readiness', async () => {
    const f = await application(['status'])
    const restore = vi.spyOn(Cloud.CloudConnections.prototype, 'restore')
    await f.mount()
    expect(f.readyCount()).toBe(1)
    await f.ctx.fiber.dispose()
    expect(f.readyCount()).toBe(0)
    f.ready()
    expect(restore).not.toHaveBeenCalled()
  })
})

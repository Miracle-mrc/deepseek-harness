import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolvePythonBin } from '../src/index.ts'
import type { Duplex } from 'node:stream'
import type { ChildToHost } from '../src/protocol.ts'

const python = resolvePythonBin('python3') ?? 'python3'
const pyDir = fileURLToPath(new URL('../py', import.meta.url))
const bootstrap = fileURLToPath(new URL('../py/bootstrap.py', import.meta.url))

describe('Python bootstrap completion shutdown', () => {
  it.each([
    { verdict: 'success', rebind: false },
    { verdict: 'exception', rebind: false },
    { verdict: 'success', rebind: true },
  ] as const)('preserves $verdict with a backpressured reply (rebind=$rebind)', async ({ verdict, rebind }) => {
    const launcher = [
      'import runpy, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      `runpy.run_path(${JSON.stringify(bootstrap)}, run_name="__main__")`,
    ].join('\n')
    const child = spawn(python, ['-I', '-B', '-c', launcher], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    const proto = child.stdio[3] as Duplex
    const release = child.stdio[4] as Duplex
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      for (const stream of child.stdio) stream?.destroy()
      await closed
    })

    const errors: Error[] = []
    child.on('error', (error) => { errors.push(error) })
    proto.on('error', (error) => { errors.push(error) })
    release.on('error', (error) => { errors.push(error) })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const booted = Promise.withResolvers<ChildToHost>()
    const called = Promise.withResolvers<ChildToHost>()
    const done = Promise.withResolvers<ChildToHost>()
    let buffered = ''
    proto.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffered.slice(0, newline)) as ChildToHost
        buffered = buffered.slice(newline + 1)
        if (frame.type === 'boot-ack') booted.resolve(frame)
        if (frame.type === 'call') called.resolve(frame)
        if (frame.type === 'done') done.resolve(frame)
      }
    })
    const beforeClose = async <T>(expected: Promise<T>): Promise<T> => Promise.race([
      expected,
      closed.then(({ code, signal }) => {
        throw new Error(`Python closed before the expected protocol event (code=${String(code)}, signal=${String(signal)}): ${stderr}`)
      }),
    ])
    proto.write(`${JSON.stringify({
      type: 'boot', cpuSeconds: 10, addressSpaceBytes: 512 * 1024 * 1024,
      maxLogBytes: 32768, maxValueBytes: 65536,
      namespaces: [{ global: 'tools', names: ['chunk'] }],
    })}\n`)
    expect(await beforeClose(booted.promise)).toEqual({ type: 'boot-ack' })

    const program = [
      'import asyncio, os',
      ...rebind ? [
        'import __main__, types',
        'def forbidden_read(*args):',
        '    raise AssertionError("rebound reader must not run")',
        '__main__.os = types.SimpleNamespace(read=forbidden_read, write=os.write)',
        '__main__._READ_CHUNK_BYTES = 0',
        '__main__.ConnectionResetError = RuntimeError',
      ] : [],
      'started = asyncio.Event()',
      'async def pending_call():',
      '    started.set()',
      '    await tools.chunk({})',
      '    os.write(1, b"unexpected binding callback\\n")',
      'pending = asyncio.create_task(pending_call())',
      'await started.wait()',
      'os.read(4, 1)',
      verdict === 'exception' ? 'raise ValueError("fixture failure")' : 'return "done"',
    ].join('\n')
    proto.write(`${JSON.stringify({ type: 'run', program })}\n`)
    expect(await beforeClose(called.promise)).toEqual({
      type: 'call', id: 0, global: 'tools', name: 'chunk', args: {},
    })

    // fd 4 holds the program before return while the host's reply is blocked.
    // Keeping completion reads paused forces shutdown to preserve the duplex
    // until that write finishes; no scheduler delay stands in for readiness.
    proto.pause()
    const written = Promise.withResolvers<Error | null | undefined>()
    const accepted = proto.write(`${JSON.stringify({
      type: 'reply', id: 0, ok: true, value: 'A'.repeat(4 * 1024 * 1024),
    })}\n`, (error) => { written.resolve(error) })
    expect(accepted).toBe(false)
    release.end('x')
    const writeError = await beforeClose(written.promise)
    expect(writeError ?? undefined).toBeUndefined()

    proto.resume()
    expect(await beforeClose(done.promise)).toEqual(verdict === 'exception'
      ? { type: 'done', error: { kind: 'exception', message: expect.stringContaining('ValueError: fixture failure') } }
      : { type: 'done', value: 'done' })
    // EOF also releases the child if its host disappears without a signal.
    proto.end()
    expect(await closed).toEqual({ code: 0, signal: null })
    expect(stdout).toBe('')
    expect(stderr).toBe('')
    expect(errors).toEqual([])
  })
})

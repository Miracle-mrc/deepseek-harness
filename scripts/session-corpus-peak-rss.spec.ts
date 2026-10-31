/** Session corpus memory counters exclude inherited Linux peaks and retain the child's own lifetime peak. */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { readProcessPeakRssBytes } from '../benchmarks/session-corpus/process-peak-rss.ts'

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn(),
}))
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(), platform: vi.fn(() => 'linux'),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(readFile).mockReset()
  vi.mocked(platform).mockReturnValue('linux')
})

it('reads the Linux lifetime peak in bytes', async () => {
  vi.mocked(readFile).mockResolvedValue('Name:\tnode\nVmRSS:\t1024 kB\nVmHWM:\t 32768 kB\n')
  await expect(readProcessPeakRssBytes()).resolves.toBe(32 * 1024 * 1024)
})

it.each(['VmRSS: 1024 kB\n', 'VmHWM: 32 MB\n', 'VmHWM: -32 kB\n', 'VmHWM: 0 kB\n', 'VmHWM: 9007199254740992 kB\n'])(
  'refuses an unavailable or malformed Linux peak counter: %j', async (status) => {
    vi.mocked(readFile).mockResolvedValue(status)
    await expect(readProcessPeakRssBytes()).rejects.toThrow('must contain a positive VmHWM counter in kB')
  },
)

it('propagates failure to read the Linux counter', async () => {
  const failure = new Error('Linux process status is unreadable')
  vi.mocked(readFile).mockRejectedValue(failure)
  await expect(readProcessPeakRssBytes()).rejects.toBe(failure)
})

it('retains the native resource-usage counter outside Linux', async () => {
  vi.mocked(platform).mockReturnValue('darwin')
  vi.spyOn(process, 'resourceUsage').mockReturnValue({ ...process.resourceUsage(), maxRSS: 32768 })
  await expect(readProcessPeakRssBytes()).resolves.toBe(32 * 1024 * 1024)
  expect(readFile).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'linux')('excludes a real parent peak while retaining a released child allocation in the lifetime peak', async () => {
  const helper = new URL('../benchmarks/session-corpus/process-peak-rss.ts', import.meta.url).href
  const child = `
    import { Worker } from 'node:worker_threads';
    import { readProcessPeakRssBytes } from ${JSON.stringify(helper)};
    const measure = async () => ({ own: await readProcessPeakRssBytes(),
      inherited: process.resourceUsage().maxRSS * 1024, current: process.memoryUsage().rss });
    const baseline = await measure();
    const worker = new Worker(\`
      const { parentPort } = require('node:worker_threads');
      const held = Buffer.alloc(128 * 1024 * 1024, 0xa5);
      parentPort.on('message', () => held[0]);
      parentPort.postMessage('allocated');
    \`, { eval: true, execArgv: [] });
    let allocated;
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Allocation worker did not become ready')), 20_000);
        deadline.unref();
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Allocation worker exited before readiness')));
        worker.once('message', () => clearTimeout(deadline));
        worker.once('error', () => clearTimeout(deadline));
        worker.once('exit', () => clearTimeout(deadline));
      });
      allocated = await measure();
    }
    finally { await worker.terminate(); }
    console.log(JSON.stringify({ baseline, allocated, released: await measure() }));
  `
  const parent = `
    import { spawn } from 'node:child_process';
    const held = Buffer.alloc(256 * 1024 * 1024, 0xa5);
    const parentRss = process.memoryUsage().rss;
    const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '--eval', ${JSON.stringify(child)}],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.setEncoding('utf8').on('data', value => output += value);
    child.stderr.setEncoding('utf8').on('data', value => errors += value);
    let childTimedOut = false;
    const deadline = setTimeout(() => { childTimedOut = true; child.kill('SIGKILL'); }, 30_000);
    deadline.unref();
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    }).finally(() => clearTimeout(deadline));
    console.log(JSON.stringify({ parentRss, witness: held[0], childTimedOut, outcome, errors,
      child: output.trim() === '' ? null : JSON.parse(output) }));
  `
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  env.DSH_TELEMETRY_DISABLED = '1'
  delete env.NODE_OPTIONS
  delete env.TSX_TSCONFIG_PATH
  const processChild = spawn(process.execPath, ['--input-type=module', '--eval', parent], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  const terminate = (): void => {
    if (processChild.pid === undefined) return
    try { process.kill(-processChild.pid, 'SIGKILL') } catch (error) {
      // The private process group is already gone after normal parent and child exit.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; terminate() }, 60_000)
  deadline.unref()
  let spawnFailure: Error | undefined
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    processChild.once('error', (error) => { spawnFailure = error })
    processChild.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  onTestFinished(async () => {
    clearTimeout(deadline)
    terminate()
    await closed
  })
  let stdout = ''
  let stderr = ''
  processChild.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
  processChild.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
  const outcome = await closed
  expect(timedOut, stderr).toBe(false)
  expect(spawnFailure).toBeUndefined()
  expect(outcome, stderr).toEqual({ exitCode: 0, signal: null })
  const parsed: unknown = JSON.parse(stdout)
  expect(parsed).toHaveProperty('childTimedOut', false)
  expect(parsed).toMatchObject({ witness: 165, outcome: { exitCode: 0, signal: null }, errors: '' })
  const report = parsed as {
    parentRss: number
    child: Record<'baseline' | 'allocated' | 'released', { own: number; inherited: number; current: number }>
  }
  console.log(JSON.stringify({ counterRegression: parsed }))
  const mib = 1024 * 1024
  expect(report.parentRss).toBeGreaterThan(256 * mib)
  expect(report.child.baseline.own).toBeLessThan(report.parentRss - 128 * mib)
  expect(report.child.allocated.own).toBeGreaterThan(report.child.baseline.own + 96 * mib)
  expect(report.child.released.own).toBeGreaterThan(report.child.baseline.own + 96 * mib)
  expect(report.child.released.own).toBeGreaterThan(report.child.released.current + 64 * mib)
})

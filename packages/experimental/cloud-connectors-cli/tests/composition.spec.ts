/** The shipped bundle boots through Loader without model services or cloud requests. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Authorization from '@deepseek-ai/dsh-authorization'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Cloud from '@deepseek-ai/dsh-experimental-cloud-connectors'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as Cli from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

async function boot(args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-cli-composition-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const ready = new Set<() => void>()
  const exited = Promise.withResolvers<number>()
  provideCmdline(ctx, { args, exit: (code) => { exited.resolve(code) }, ready: {
    onReady(listener) { ready.add(listener); return () => { ready.delete(listener) } },
  } })
  ctx.baseUrl = pathToFileURL(`${dir}/`).href
  const patches = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{
    insert: Array<{ id: string; name: string; config?: Record<string, unknown> }>
  }>
  const aliases: Record<string, string> = {
    '@deepseek-ai/dsh-experimental-cloud-connectors-cli': 'cli',
    '@deepseek-ai/dsh-credentials-local': 'credentials',
    '@deepseek-ai/dsh-authorization': 'authorization',
    '@deepseek-ai/dsh-system-prompt': 'prompt',
    '@deepseek-ai/dsh-tools': 'tools',
    '@deepseek-ai/dsh-experimental-cloud-connectors': 'cloud',
  }
  const rows = patches.flatMap(patch => patch.insert).map(row => ({
    ...row, name: `cordis:${aliases[row.name]}`,
    ...row.id === 'credentials' ? { config: { path: join(dir, '.credentials.yaml'), watch: false } } : {},
  }))
  await writeFile(join(dir, 'cordis.yml'), JSON.stringify(rows))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, cli: Cli, credentials: Credentials,
    authorization: Authorization, prompt: SystemPrompt, tools: Tools, cloud: Cloud })
  await ctx.loader.root.update([{ id: 'fixture', name: 'cordis:include', config: { path: './cordis.yml' } }])
  await ctx.loader.await()
  for (const listener of ready) listener()
  return { ctx, code: await exited.promise }
}

it('runs status with the actual credential, authorization and cloud services, then releases its listeners', async () => {
  const input = process.stdin
  const tty = Object.getOwnPropertyDescriptor(input, 'isTTY')
  Object.defineProperty(input, 'isTTY', { value: true, configurable: true })
  onTestFinished(() => {
    if (tty === undefined) Reflect.deleteProperty(input, 'isTTY')
    else Object.defineProperty(input, 'isTTY', tty)
  })
  const pause = vi.spyOn(input, 'pause').mockReturnValue(input)
  const unref = vi.spyOn(input, 'unref').mockReturnValue(input)
  let output = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected cloud request'))
  const beforeSignals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  const { ctx, code } = await boot(['status'])
  stdout.mockRestore()
  expect(code).toBe(0)
  expect(output).toBe('aws: not-connected; 0 tools enabled\nsupabase: not-connected; 0 tools enabled\n')
  expect(fetch).not.toHaveBeenCalled()
  expect(await ctx.credentials.listRecords()).toEqual([])
  expect(ctx.get('agents')).toBeUndefined()
  expect(ctx.get('sessions')).toBeUndefined()
  expect(pause).not.toHaveBeenCalled()
  expect(unref).not.toHaveBeenCalled()
  await ctx.loader.resolve('fixture:cloud-cli').fiber!.dispose()
  expect(pause).toHaveBeenCalledOnce()
  expect(unref).toHaveBeenCalledOnce()
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(beforeSignals)
})

it('prints help without starting an authenticated operation', async () => {
  let output = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected cloud request'))
  const { code } = await boot(['--help'])
  stdout.mockRestore()
  expect(code).toBe(0)
  expect(output).toContain('Usage: dsh cloud')
  expect(fetch).not.toHaveBeenCalled()
})

/** Built Web profile: MCP reaches existing/new Creator sessions and survives a process restart. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type { ForkPreviewResult, ForkPublishResult, SourceExportResult } from '@deepseek-ai/dsh-plugin-manager'
import { startHttpMcpFixture } from '../../../../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { prepareCreatorExport } from '../../../../../../scripts/prepare-creator-export.ts'
import { pnpmInvocation } from '../../../../../../scripts/pnpm-invocation.ts'

interface Observation {
  forkRefusals: [ForkPreviewResult, ForkPublishResult]
  approvals: string[]
  permission: string
  before: string[]
  denied: { isError: boolean; content: unknown }
  afterDenied: string[]
  bundlesAfterDenied: { name: string }[]
  after: string[]
  other: string[]
  remaining: string[]
  result: unknown
  ping: unknown
  removed?: unknown
  sourceExport: SourceExportResult
  exportUnchanged: boolean
}

interface RestoredObservation {
  forkRefusals: [ForkPreviewResult, ForkPublishResult]
  before: string[]
  result: { name: string }[]
  ping: unknown
  restoredProbe: string
}

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))
const SAVED_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const FORK_REFUSALS = [
  { status: 'blocked', code: 'invalid-branch', effect: 'none' },
  { status: 'blocked', code: 'confirmation-required', effect: 'none' },
]

it('configures MCP, exports its reviewed source, and restores it on restart and in a fresh home', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'creator-manager-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const mcp = await startHttpMcpFixture()
  test.onTestFinished(mcp.close)
  await mkdir(join(root, 'workspace'))
  const bundle = join(root, 'demo-mcp')
  await mkdir(bundle)
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@test/creator-mcp', version: '1.0.0',
    peerDependencies: { '@creator-export-fixture/nonexistent-peer': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'demo',
    name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'streamable-http',
      url: mcp.url, failOnStartupError: true },
  }, { id: 'creator-export-source', name: './probe.mjs' }] }]))
  const probeSource = 'export function apply(ctx) { ctx.provide("creatorExportSourceProbe", "local source restored") }\n'
  await writeFile(join(bundle, 'probe.mjs'), probeSource)
  const patch = join(root, 'test.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'creator-manager-observer',
    name: new URL('./fixtures/creator-plugin-manager.mjs', import.meta.url).href, config: { bundle },
  }] }]))
  const environment = (home: string) => ({ ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls' })
  const start = async (home = join(root, 'home'), profile = 'web') => {
    const child = spawn(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', patch,
      '--port', '0', '--no-open'], { cwd: join(root, 'workspace'),
      env: environment(home),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    const completion = new Promise<void>((resolve, reject) => {
      child.once('close', () => { resolve() })
      child.once('error', reject)
    })
    const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion }
    test.onTestFinished(stop)
    for (const stream of [child.stdout, child.stderr]) stream!.on('data', (data) => { output = (output + String(data)).slice(-30_000) })
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(output)
      return output.includes('dsh web: http://')
    }, { timeout: 60_000 }).toBe(true)
    return { stop, request: <T = Observation>(phase: string): Promise<T> => new Promise((resolve, reject) => {
      child.once('message', (value: { result: T; error?: string }) => {
        if (value.error !== undefined) reject(new Error(value.error))
        else resolve(value.result)
      })
      child.send(phase)
    }) }
  }
  const first = await start()
  const initial = await first.request('initial')
  expect(initial.forkRefusals).toEqual(FORK_REFUSALS)
  expect(initial.before).toContain('plugin_manager')
  for (const retired of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'cordis_inspect_self']) {
    expect(initial.before).not.toContain(retired)
  }
  expect(initial.before).not.toContain('mcp__demo__ping')
  expect(initial.denied.isError).toBe(true)
  expect(JSON.stringify(initial.denied.content)).toContain('the user rejected escalating')
  expect(initial.afterDenied).toEqual(initial.before)
  expect(initial.bundlesAfterDenied.map(bundle => bundle.name)).not.toContain('@test/creator-mcp')
  expect(initial.approvals).toEqual(['rejected', 'allowed-once'])
  expect(initial.permission).toBe('workspace-write')
  expect(initial.result).toMatchObject({ application: 'applied', changed: true })
  expect(initial.after).toContain('mcp__demo__ping')
  expect(initial.other).toContain('mcp__demo__ping')
  expect(JSON.stringify(initial.ping)).toContain('pong')
  expect(initial.exportUnchanged).toBe(true)
  const exported = initial.sourceExport
  expect(exported).toMatchObject({ status: 'ready', repository: 'example/source-export-fixture', branch: 'creator/saved', profile: 'web', reviewRequired: true })
  if (exported.status !== 'ready') throw new Error(`Creator source export was refused: ${JSON.stringify(exported.issues)}`)
  expect(exported.files).toContainEqual({ path: 'profiles/saved/pnpm-workspace.yaml', content: SAVED_WORKSPACE })
  expect(exported.files).toContainEqual({ path: 'bundles/0/pnpm-workspace.yaml', content: SAVED_WORKSPACE })
  expect(exported.files).toContainEqual({ path: 'bundles/0/probe.mjs', content: probeSource })
  const ancestor = join(root, 'ancestor-workspace')
  await mkdir(ancestor)
  const ancestorFiles = [
    { path: 'package.json', content: '{"name":"creator-export-ancestor","private":true}\n' },
    { path: 'pnpm-workspace.yaml', content: 'packages:\n  - unrelated/*\n\nnodeLinker: isolated\nautoInstallPeers: true\n' },
    { path: 'pnpm-lock.yaml', content: "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n  .: {}\n" },
  ]
  for (const file of ancestorFiles) await writeFile(join(ancestor, file.path), file.content)
  const restoredHome = prepareCreatorExport(exported, join(ancestor, 'fork'))
  const restoredManifest = readProfileManifest('dsh', join(restoredHome, 'profiles/saved'))
  expect(restoredManifest.dependencies?.['@test/creator-mcp']).toBe('link:../../bundles/0')
  expect(await readFile(join(restoredHome, 'bundles/0/probe.mjs'), 'utf8')).toBe(probeSource)
  const saved = readProfileManifest('dsh', join(root, 'home/profiles/web'))
  expect(saved.dsh?.profile?.bundles).toContain('@test/creator-mcp')
  expect(saved.dependencies).toHaveProperty('@test/creator-mcp')
  await first.stop()
  const second = await start()
  const restarted = await second.request('restart')
  expect(restarted.forkRefusals).toEqual(FORK_REFUSALS)
  expect(restarted.result).toEqual(expect.arrayContaining([expect.objectContaining({ name: '@test/creator-mcp' })]))
  expect(restarted.approvals).toEqual(['rejected', 'allowed-once'])
  expect(restarted.permission).toBe('workspace-write')
  expect(restarted.before).toContain('mcp__demo__ping')
  expect(JSON.stringify(restarted.ping)).toContain('pong')
  expect(restarted.removed).toMatchObject({ application: 'applied', changed: true })
  expect(restarted.remaining).not.toContain('mcp__demo__ping')
  await second.stop()
  await rm(bundle, { recursive: true, force: true })
  const installDependencies = async (command: string, args: readonly string[], cwd: string) => {
    const install = spawn(command, args, { cwd, env: environment(restoredHome), stdio: ['ignore', 'pipe', 'pipe'] })
    let installOutput = ''
    for (const stream of [install.stdout, install.stderr]) stream.on('data', (data) => { installOutput = (installOutput + String(data)).slice(-30_000) })
    const installed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      install.once('error', reject)
      install.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    test.onTestFinished(async () => {
      if (install.exitCode === null && install.signalCode === null) install.kill('SIGTERM')
      await installed
    })
    const installation = await installed
    expect(installation.signal, installOutput).toBeNull()
    expect(installation.code, installOutput).toBe(0)
    for (const file of ancestorFiles) expect(await readFile(join(ancestor, file.path), 'utf8')).toBe(file.content)
  }
  const pnpm = pnpmInvocation(['install', '--offline', '--ignore-scripts'])
  await installDependencies(pnpm.command, pnpm.args, join(restoredHome, 'bundles/0'))
  await installDependencies(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), 'plugin', '--profile', 'saved',
    'install', '--offline', '--ignore-scripts'], join(root, 'workspace'))
  expect(await readFile(join(restoredHome, 'profiles/saved/pnpm-workspace.yaml'), 'utf8')).toBe(SAVED_WORKSPACE)
  const restored = await start(restoredHome, 'saved')
  const relocated = await restored.request<RestoredObservation>('restored')
  expect(relocated.forkRefusals).toEqual(FORK_REFUSALS)
  expect(relocated.before).toContain('mcp__demo__ping')
  expect(relocated.result.map(bundle => bundle.name)).toContain('@test/creator-mcp')
  expect(relocated.restoredProbe).toBe('local source restored')
  expect(JSON.stringify(relocated.ping)).toContain('pong')
  expect(mcp.calls).toEqual(['ping', 'ping', 'ping'])
  await restored.stop()
})

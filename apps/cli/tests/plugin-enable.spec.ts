/** Offline optional-bundle activation shares the profile writer lock with package operations. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { initProfile, readProfileManifest, resolveBundleDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { runPluginCommand, runProfilePnpm } from '@deepseek-ai/dsh-plugin-manager/operations'
import { expect, it, onTestFinished, vi } from 'vitest'
import { runPlugin } from '../src/plugin.ts'

const installation = vi.hoisted(() => ({ anchor: '' }))
vi.mock('../src/profile-boot.ts', () => ({ get INSTALL_ANCHOR() { return installation.anchor } }))
vi.mock('@deepseek-ai/dsh-plugin-manager/operations', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-plugin-manager/operations')>(),
  runPluginCommand: vi.fn(), runProfilePnpm: vi.fn(),
}))
vi.mock('@deepseek-ai/dsh-atomic-write', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) }
})

const cli = '@deepseek-ai/dsh-experimental-cloud-connectors-cli'
const cloud = '@deepseek-ai/dsh-experimental-cloud-connectors-bundle'
const nativeModule = createRequire(import.meta.url)('node:module') as { _initPaths(): void }

async function fixture() {
  const pending: Promise<unknown>[] = []
  const releases: Array<() => void> = []
  let closed = false
  const rootCreated = mkdtemp(join(tmpdir(), 'dsh-plugin-enable-'))
  onTestFinished(async () => {
    closed = true
    for (const release of releases) release()
    await Promise.allSettled([rootCreated, ...pending])
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.mocked(runPluginCommand).mockReset()
    vi.mocked(runProfilePnpm).mockReset()
    vi.mocked(withFileLock).mockClear()
    const root = await rootCreated.catch(() => undefined)
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  const own = async <T>(start: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error('The activation fixture was disposed before its operation started.')
    const operation = start()
    pending.push(operation)
    const result = await operation
    if (closed) throw new Error('The activation fixture was disposed before its operation completed.')
    return result
  }
  const root = await own(() => rootCreated)
  const home = join(root, 'home')
  const install = join(root, 'installation')
  const dir = join(home, 'profiles', 'cloud')
  vi.stubEnv('DSH_HOME', home)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  installation.anchor = join(install, 'package.json')
  const packageDir = (name: string) => join(install, 'node_modules', name)
  const packageManifest = (name: string, fields: Record<string, unknown> = {}, parent = install) => own(async () => {
    const path = join(parent, 'node_modules', name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({
      name, version: '0.2.2-alpha.2', exports: { './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml', ...name === cli ? { standalone: true } : {} } }, ...fields,
    }))
    await writeFile(join(path, 'cordis.patch.yml'), '[]\n')
  })
  await own(async () => {
    await mkdir(install, { recursive: true })
    await writeFile(installation.anchor, JSON.stringify({ name: 'fixture-installation', dependencies: { [cli]: '*', [cloud]: '*' } }))
    await packageManifest(cli)
    await packageManifest(cloud)
    await packageManifest('@deepseek-ai/dsh-base')
    await packageManifest('@deepseek-ai/dsh-web-app')
  })
  return {
    root, home, install, dir, stdout, stderr, packageDir, packageManifest, pending, releases,
    run: (profile: string, args: readonly string[]) => own(() => runPlugin(profile, args)),
    write: (path: string, text: string) => own(() => writeFile(path, text)),
    read: (path: string) => own(() => readFile(path, 'utf8')),
  }
}

it('activates a carried bundle in an empty custom profile without running pnpm', async () => {
  const f = await fixture()
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(0)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual([cli])
  expect(readProfileManifest('dsh', f.dir).dependencies).toEqual({})
  expect(f.stdout).toHaveBeenCalledWith(`dsh: enabled ${cli} in profile cloud\n`)
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('preserves existing layers, metadata and patch bytes when --empty is supplied again', async () => {
  const f = await fixture()
  await f.packageManifest('@example/first')
  await f.packageManifest('@example/second')
  initProfile(f.dir, ['@example/first', '@example/second'])
  const manifest = { ...readProfileManifest('dsh', f.dir), custom: { retained: true } }
  await f.write(join(f.dir, 'package.json'), JSON.stringify(manifest))
  const patch = '# keep the user patch\n[]\n'
  await f.write(join(f.dir, 'cordis.patch.yml'), patch)
  expect(await f.run('cloud', ['enable', cloud, '--empty'])).toBe(0)
  expect(await f.run('cloud', ['enable', cloud, '--empty'])).toBe(0)
  const after = JSON.parse(await f.read(join(f.dir, 'package.json'))) as typeof manifest
  expect(after.custom).toEqual({ retained: true })
  expect(after.dsh?.profile?.bundles).toEqual(['@example/first', '@example/second', cloud])
  expect(await f.read(join(f.dir, 'cordis.patch.yml'))).toBe(patch)
})

it.each([
  ['enable'], ['enable', '--empty', '@example/unknown'], ['enable', '@deepseek-ai/dsh-base'],
  ['enable', '--empty', '--empty', cli], ['enable', '--unknown', cli],
])('refuses an invalid activation without writing a profile: %j', async (...args) => {
  const f = await fixture()
  expect(await f.run('cloud', args)).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it('refuses a whitelisted bundle that this installation does not carry', async () => {
  const f = await fixture()
  await rm(f.packageDir(cli), { recursive: true })
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('refuses an ambient NODE_PATH bundle even though the general profile resolver can find it', async () => {
  const f = await fixture()
  const ambient = join(f.root, 'ambient')
  await rm(f.packageDir(cli), { recursive: true })
  await f.packageManifest(cli, {}, ambient)
  const originalNodePath = process.env.NODE_PATH
  const restoreNodePath = (): void => {
    if (originalNodePath === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = originalNodePath
    nativeModule._initPaths()
  }
  onTestFinished(restoreNodePath)
  process.env.NODE_PATH = join(ambient, 'node_modules')
  nativeModule._initPaths()
  try {
    expect(resolveBundleDir('dsh', cli, installation.anchor, f.install)).toBe(join(ambient, 'node_modules', cli))
    expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(1)
    expect(existsSync(f.dir)).toBe(false)
    expect(runPluginCommand).not.toHaveBeenCalled()
    expect(runProfilePnpm).not.toHaveBeenCalled()
  } finally { restoreNodePath() }
})

it('refuses an installed whitelisted bundle that the installation does not declare', async () => {
  const f = await fixture()
  await f.write(installation.anchor, JSON.stringify({ name: 'fixture-installation', dependencies: { [cloud]: '*' } }))
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(f.dir)).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('accepts a declared bundle hoisted into an ancestor installation node_modules', async () => {
  const f = await fixture()
  await rm(f.packageDir(cli), { recursive: true })
  await f.packageManifest(cli, {}, f.root)
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(0)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual([cli])
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it.each([[cloud, cli], [cli, cloud]])('refuses to combine %s with %s without changing the profile', async (existing, added) => {
  const f = await fixture()
  initProfile(f.dir, [existing])
  await f.write(join(f.dir, 'cordis.patch.yml'), '# preserve this profile\n[]\n')
  const manifest = await f.read(join(f.dir, 'package.json'))
  const patch = await f.read(join(f.dir, 'cordis.patch.yml'))
  expect(await f.run('cloud', ['enable', '--empty', added])).toBe(1)
  expect(await f.read(join(f.dir, 'package.json'))).toBe(manifest)
  expect(await f.read(join(f.dir, 'cordis.patch.yml'))).toBe(patch)
  expect(f.stderr).toHaveBeenCalledWith(expect.stringContaining('standalone bundles must be the only selected profile bundle'))
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('requires an empty new profile for a standalone bundle and keeps that selection idempotent', async () => {
  const f = await fixture()
  expect(await f.run('cloud', ['enable', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  expect(existsSync(join(f.dir, 'cordis.patch.yml'))).toBe(false)
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(0)
  const before = await f.read(join(f.dir, 'package.json'))
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(0)
  expect(await f.read(join(f.dir, 'package.json'))).toBe(before)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual([cli])
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('refuses incompatible or unsupported installed bundles before profile initialization', async () => {
  const f = await fixture()
  await f.packageManifest(cli, { engines: { dsh: '>=999.0.0' } })
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  await f.packageManifest(cli, { dsh: { bundle: { patch: './cordis.patch.yml', platforms: [process.platform === 'win32' ? 'linux' : 'win32'] } } })
  expect(await f.run('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
})

it('uses shipped Web defaults when the caller does not request an empty new profile', async () => {
  const f = await fixture()
  expect(await f.run('web', ['enable', cloud])).toBe(0)
  expect(readProfileManifest('dsh', join(f.home, 'profiles', 'web')).dsh?.profile?.bundles)
    .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', cloud])
})

it('reads layers after acquiring the shared lock so a concurrent writer is preserved', async () => {
  const f = await fixture()
  await f.packageManifest('@example/first')
  await f.packageManifest('@example/concurrent')
  initProfile(f.dir, ['@example/first'])
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.releases.push(() => { release.resolve(undefined) })
  const locked = withFileLock(join(f.dir, 'package.json'), async () => {
    entered.resolve(undefined)
    await release.promise
    writeProfileBundles(f.dir, readProfileManifest('dsh', f.dir), ['@example/first', '@example/concurrent'])
  })
  f.pending.push(locked)
  await entered.promise
  const before = vi.mocked(withFileLock).mock.calls.length
  const enabled = f.run('cloud', ['enable', '--empty', cloud])
  await vi.waitFor(() => { expect(vi.mocked(withFileLock).mock.calls.length).toBeGreaterThan(before) })
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual(['@example/first'])
  release.resolve(undefined)
  await locked
  expect(await enabled).toBe(0)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual(['@example/first', '@example/concurrent', cloud])
})

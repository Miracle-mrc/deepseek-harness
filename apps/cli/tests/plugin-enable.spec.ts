/** Offline optional-bundle activation shares the profile writer lock with package operations. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { initProfile, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-enable-'))
  const home = join(root, 'home')
  const install = join(root, 'installation')
  const dir = join(home, 'profiles', 'cloud')
  const pending: Promise<unknown>[] = []
  const releases: Array<() => void> = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.allSettled(pending)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.mocked(runPluginCommand).mockReset()
    vi.mocked(runProfilePnpm).mockReset()
    vi.mocked(withFileLock).mockClear()
    await rm(root, { recursive: true, force: true })
  })
  vi.stubEnv('DSH_HOME', home)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  installation.anchor = join(install, 'package.json')
  await mkdir(install, { recursive: true })
  await writeFile(installation.anchor, JSON.stringify({ name: 'fixture-installation', dependencies: { [cli]: '*', [cloud]: '*' } }))
  const packageDir = (name: string) => join(install, 'node_modules', name)
  const packageManifest = async (name: string, fields: Record<string, unknown> = {}) => {
    const path = packageDir(name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({
      name, version: '0.2.2-alpha.2', exports: { './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } }, ...fields,
    }))
    await writeFile(join(path, 'cordis.patch.yml'), '[]\n')
  }
  await packageManifest(cli)
  await packageManifest(cloud)
  return { root, home, dir, stdout, stderr, packageDir, packageManifest, pending, releases }
}

it('activates a carried bundle in an empty custom profile without running pnpm', async () => {
  const f = await fixture()
  expect(await runPlugin('cloud', ['enable', '--empty', cli])).toBe(0)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual([cli])
  expect(readProfileManifest('dsh', f.dir).dependencies).toEqual({})
  expect(f.stdout).toHaveBeenCalledWith(`dsh: enabled ${cli} in profile cloud\n`)
  expect(runPluginCommand).not.toHaveBeenCalled()
  expect(runProfilePnpm).not.toHaveBeenCalled()
})

it('preserves existing layers, metadata and patch bytes when --empty is supplied again', async () => {
  const f = await fixture()
  initProfile(f.dir, ['@example/first', '@example/second'])
  const manifest = { ...readProfileManifest('dsh', f.dir), custom: { retained: true } }
  await writeFile(join(f.dir, 'package.json'), JSON.stringify(manifest))
  const patch = '# keep the user patch\n[]\n'
  await writeFile(join(f.dir, 'cordis.patch.yml'), patch)
  expect(await runPlugin('cloud', ['enable', cli, '--empty'])).toBe(0)
  expect(await runPlugin('cloud', ['enable', cli, '--empty'])).toBe(0)
  const after = JSON.parse(await readFile(join(f.dir, 'package.json'), 'utf8')) as typeof manifest
  expect(after.custom).toEqual({ retained: true })
  expect(after.dsh?.profile?.bundles).toEqual(['@example/first', '@example/second', cli])
  expect(await readFile(join(f.dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
})

it.each([
  ['enable'], ['enable', '--empty', '@example/unknown'], ['enable', '@deepseek-ai/dsh-base'],
  ['enable', '--empty', '--empty', cli], ['enable', '--unknown', cli],
])('refuses an invalid activation without writing a profile: %j', async (...args) => {
  const f = await fixture()
  expect(await runPlugin('cloud', args)).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it('refuses a whitelisted bundle that this installation does not carry', async () => {
  const f = await fixture()
  await rm(f.packageDir(cli), { recursive: true })
  expect(await runPlugin('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it('refuses incompatible or unsupported installed bundles before profile initialization', async () => {
  const f = await fixture()
  await f.packageManifest(cli, { engines: { dsh: '>=999.0.0' } })
  expect(await runPlugin('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
  await f.packageManifest(cli, { dsh: { bundle: { patch: './cordis.patch.yml', platforms: [process.platform === 'win32' ? 'linux' : 'win32'] } } })
  expect(await runPlugin('cloud', ['enable', '--empty', cli])).toBe(1)
  expect(existsSync(join(f.dir, 'package.json'))).toBe(false)
})

it('uses shipped Web defaults when the caller does not request an empty new profile', async () => {
  const f = await fixture()
  expect(await runPlugin('web', ['enable', cloud])).toBe(0)
  expect(readProfileManifest('dsh', join(f.home, 'profiles', 'web')).dsh?.profile?.bundles)
    .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', cloud])
})

it('reads layers after acquiring the shared lock so a concurrent writer is preserved', async () => {
  const f = await fixture()
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
  const enabled = runPlugin('cloud', ['enable', '--empty', cli])
  f.pending.push(enabled)
  await vi.waitFor(() => { expect(vi.mocked(withFileLock).mock.calls.length).toBeGreaterThan(before) })
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual(['@example/first'])
  release.resolve(undefined)
  await locked
  expect(await enabled).toBe(0)
  expect(readProfileManifest('dsh', f.dir).dsh?.profile?.bundles).toEqual(['@example/first', '@example/concurrent', cli])
})

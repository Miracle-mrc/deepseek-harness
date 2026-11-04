/** Read-only source capture, secret refusal, and restoration through the real profile Loader. */
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, loadProfileDirectory, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '../src/index.ts'
import { exportProfileSource } from '../src/source-export.ts'

const request = { repository: 'person/harness-fork', branch: 'creator/saved-plugin' }

const filesystemHooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((filename: string) => Promise<void>) | undefined,
  afterOpen: undefined as ((filename: string, handle: import('node:fs/promises').FileHandle) => Promise<void>) | undefined,
  beforeStat: undefined as ((filename: string) => Promise<void>) | undefined,
  beforeDirectory: undefined as ((filename: string) => Promise<void>) | undefined,
  beforeRealpath: undefined as ((filename: string) => Promise<void>) | undefined,
  reverseDirectory: false,
  specialEntry: undefined as string | undefined,
  virtual: undefined as {
    directory: string
    names: string[]
    directories: Set<string>
    files: Set<string>
    fileInfo: Stats
    directoryInfo: Stats
    handle: import('node:fs/promises').FileHandle
    cursor: number
  } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await filesystemHooks.beforeOpen?.(String(args[0]))
      const virtual = filesystemHooks.virtual
      if (virtual?.files.has(String(args[0]))) {
        virtual.cursor = 0
        return virtual.handle
      }
      const handle = await actual.open(...args)
      await filesystemHooks.afterOpen?.(String(args[0]), handle)
      return handle
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await filesystemHooks.beforeStat?.(String(args[0]))
      const virtual = filesystemHooks.virtual
      if (virtual?.files.has(String(args[0]))) return virtual.fileInfo
      if (virtual?.directories.has(String(args[0]))) return virtual.directoryInfo
      return actual.lstat(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await filesystemHooks.beforeDirectory?.(String(args[0]))
      const virtual = filesystemHooks.virtual
      if (virtual?.directory === String(args[0])) {
        return virtual.names.map(name => Object.assign(new Dirent(), {
          name, parentPath: virtual.directory, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        }))
      }
      const entries = await actual.readdir(...args)
      for (const entry of entries) {
        if (typeof entry !== 'string' && !Buffer.isBuffer(entry) && String(entry.name) === filesystemHooks.specialEntry) {
          Object.assign(entry, { isDirectory: () => false, isFile: () => false })
        }
      }
      return filesystemHooks.reverseDirectory ? entries.reverse() : entries
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      await filesystemHooks.beforeRealpath?.(String(args[0]))
      const virtual = filesystemHooks.virtual
      if (virtual?.files.has(String(args[0])) || virtual?.directories.has(String(args[0]))) return String(args[0])
      return actual.realpath(...args)
    },
  }
})

afterEach(() => {
  filesystemHooks.beforeOpen = undefined
  filesystemHooks.afterOpen = undefined
  filesystemHooks.beforeStat = undefined
  filesystemHooks.beforeDirectory = undefined
  filesystemHooks.beforeRealpath = undefined
  filesystemHooks.reverseDirectory = false
  filesystemHooks.specialEntry = undefined
  filesystemHooks.virtual = undefined
  vi.restoreAllMocks()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'source-export-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'profiles', 'original')
  const local = join(root, 'custom')
  await mkdir(join(local, 'src'), { recursive: true })
  await mkdir(join(local, 'lib'), { recursive: true })
  await mkdir(join(local, 'locale'), { recursive: true })
  initProfile(dir, ['acme-plugin'])
  await writeFile(join(root, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(local, 'package.json'), JSON.stringify({
    name: 'acme-plugin', version: '1.0.0', type: 'module', main: './lib/index.js',
    exports: { '.': './lib/index.js', './locale/*.json': './locale/*.json' },
    dsh: { bundle: { patch: './plugin.patch.yml' } },
  }))
  const source = 'export function apply(ctx, config) { ctx.provide("restoredSourceProbe", config.color) }\n'
  await writeFile(join(local, 'lib', 'index.js'), source)
  await writeFile(join(local, 'src', 'index.ts'), source)
  await writeFile(join(local, 'locale', 'en.json'), '{"meta":{"title":"Source probe"}}\n')
  await writeFile(join(local, 'plugin.patch.yml'), '- insert:\n    - id: source-probe\n      name: ./lib/index.js\n      config:\n        color: blue\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'acme-plugin': 'link:../../custom' }, dsh: { profile: { bundles: ['acme-plugin'] } } }))
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: source-probe\n  config:\n    color: green\n')
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'original', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'), cwd: root,
    home: root, startedBundles: ['acme-plugin'], overlays: [], telemetryDisabledEnv: undefined,
  }
  return { root, dir, local, profile }
}

async function virtualDirectory(directory: string, names: string[], content: string, anchor: string) {
  const fs = await import('node:fs/promises')
  const canonical = await fs.realpath(directory)
  await writeFile(anchor, content)
  const handle = await fs.open(anchor, 'r')
  const close = handle.close.bind(handle)
  onTestFinished(close)
  const virtual = {
    directory: canonical, names, directories: new Set([canonical, join(canonical, '..')]),
    files: new Set(names.map(name => join(canonical, name))),
    fileInfo: await handle.stat(), directoryInfo: await fs.lstat(canonical), handle, cursor: 0,
  }
  const bytes = Buffer.from(content)
  Object.assign(handle, {
    stat: () => Promise.resolve(virtual.fileInfo),
    read: (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = bytes.copy(buffer, offset, virtual.cursor, virtual.cursor + length)
      virtual.cursor += bytesRead
      return Promise.resolve({ buffer, bytesRead })
    },
    close: () => Promise.resolve(),
  })
  filesystemHooks.virtual = virtual
  return canonical
}

it('captures local source and raw configuration without changing the profile, then restores through the Loader', async () => {
  const { root, dir, local, profile } = await fixture()
  filesystemHooks.reverseDirectory = true
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  TOKEN: do-not-export\n')
  await writeFile(join(root, 'cordis.patch.yml'), '- id: home-only\n  disabled: true\n')
  await writeFile(join(local, '.env'), 'TOKEN=do-not-export\n')
  await mkdir(join(local, 'node_modules'), { recursive: true })
  await writeFile(join(local, 'node_modules', 'ignored.txt'), 'do-not-export')
  const before = await Promise.all([readFile(join(dir, 'package.json'), 'utf8'), readFile(profile.patchPath, 'utf8'), readdir(dir)])
  const value = await exportProfileSource(profile, request)
  expect(value.status).toBe('ready')
  if (value.status !== 'ready') throw new Error('source export was refused')
  expect(value.reviewRequired).toBe(true)
  expect(value.files.map(file => file.path)).toContain('bundles/0/src/index.ts')
  expect(JSON.stringify(value)).not.toContain('do-not-export')
  expect(JSON.stringify(value)).not.toContain('home-only')
  expect(await Promise.all([readFile(join(dir, 'package.json'), 'utf8'), readFile(profile.patchPath, 'utf8'), readdir(dir)])).toEqual(before)
  const restoredHome = join(root, 'restored')
  for (const file of value.files) {
    const destination = join(restoredHome, ...file.path.split('/'))
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, file.content)
  }
  const restoredDir = join(restoredHome, 'profiles', 'saved')
  await writeFile(join(restoredDir, 'cordis.yml'), '[]\n')
  await mkdir(join(restoredDir, 'node_modules'), { recursive: true })
  // This is the filesystem result of installing the exported link dependency, without invoking a package manager.
  await symlink(join(restoredHome, 'bundles', '0'), join(restoredDir, 'node_modules', 'acme-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const restored: ProfileContext = { ...profile, name: 'saved', dir: restoredDir, home: restoredHome, patchPath: join(restoredDir, 'cordis.patch.yml') }
  const loaded = loadProfileDirectory('test', restoredDir, profile.installAnchor)
  expect(loaded.skippedBundles).toEqual([])
  const ctx = await boot('test', join(restoredDir, 'cordis.yml'), readProfilePatches('test', restored), (owner) => { owner.provide('profileContext', restored) })
  onTestFinished(() => ctx.fiber.dispose())
  expect(ctx.get('restoredSourceProbe')).toBe('green')
})

it('exports the shipped Creator decoration and MCP templates together without changing their source', async () => {
  const { root, dir, profile } = await fixture()
  const templates = new URL('../../../preset/agent-preset/skills/cordis-plugin-development/templates/', import.meta.url)
  await Promise.all([
    cp(new URL('decoration/', templates), join(root, 'decoration'), { recursive: true }),
    cp(new URL('mcp/', templates), join(root, 'mcp'), { recursive: true }),
  ])
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@local/my-decoration': 'link:../../decoration', '@local/demo-mcp': 'link:../../mcp' },
    dsh: { profile: { bundles: ['@local/my-decoration', '@local/demo-mcp'] } },
  }))
  await writeFile(profile.patchPath, '[]\n')
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error('shipped Creator templates were refused')
  const files = new Map(result.files.map(file => [file.path, file.content]))
  for (const path of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'locale/en.json']) {
    expect(files.get(`bundles/0/${path}`)).toBe(await readFile(new URL(`decoration/${path}`, templates), 'utf8'))
  }
  for (const path of ['package.json', 'cordis.patch.yml', 'icon.svg', 'locale/en.json']) {
    expect(files.get(`bundles/1/${path}`)).toBe(await readFile(new URL(`mcp/${path}`, templates), 'utf8'))
  }
  const decorationManifest: unknown = JSON.parse(files.get('bundles/0/package.json') ?? '')
  expect(decorationManifest).toMatchObject({
    exports: { '.': './index.js', './client': './client.js', './icon': './icon.svg', './locale/*.json': './locale/*.json' },
    dsh: { client: { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-conversation'] } },
  })
  expect(files.get('bundles/1/cordis.patch.yml')).toContain('@deepseek-ai/dsh-mcp-client')
  const savedManifest: unknown = JSON.parse(files.get('profiles/saved/package.json') ?? '')
  expect(savedManifest).toMatchObject({
    dependencies: { '@local/my-decoration': 'link:../../bundles/0', '@local/demo-mcp': 'link:../../bundles/1' },
    dsh: { profile: { bundles: ['@local/my-decoration', '@local/demo-mcp'] } },
  })
  expect(await exportProfileSource(profile, request)).toEqual(result)
})

it('keeps !!js inert and preserves its exact source bytes', async () => {
  const { profile } = await fixture()
  const patch = '- id: source-probe\n  config:\n    color: !!js "(() => { throw new Error(\'must not evaluate\') })()"\n'
  await writeFile(profile.patchPath, patch)
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('ready')
  if (result.status === 'ready') expect(result.files.find(file => file.path === 'profiles/saved/cordis.patch.yml')?.content).toBe(patch)
})

it.each([
  ['apiKey: secret-value', 'secret-suspected'],
  ['headers: { Authorization: Bearer abcdefghijk }', 'secret-suspected'],
  ['headers: { X-Api-Key: private-value }', 'secret-suspected'],
  ['api-key: private-value', 'secret-suspected'],
  ['private-key: private-value', 'secret-suspected'],
  ['env: { GITHUB_TOKEN: private-value }', 'secret-suspected'],
  ['url: https://example.com/mcp?access=private', 'secret-suspected'],
] as const)('refuses a credential-bearing MCP or plugin config without returning content: %s', async (config, code) => {
  const { profile } = await fixture()
  await writeFile(profile.patchPath, `- id: source-probe\n  config:\n    ${config}\n`)
  const result = await exportProfileSource(profile, request)
  expect(result).toEqual({ status: 'blocked', issues: [{ code, path: 'profiles/saved/cordis.patch.yml' }] })
  expect(JSON.stringify(result)).not.toContain('secret-value')
})

it('retains an environment credential reference without resolving it', async () => {
  const { profile } = await fixture()
  await writeFile(profile.patchPath, '- id: mcp\n  config:\n    headers:\n      Authorization: !!js process.env.MCP_AUTHORIZATION\n')
  expect((await exportProfileSource(profile, request)).status).toBe('ready')
})

it.each([
  ['../outside.yml', 'unsafe-path'],
  ['./missing.yml', 'source-unavailable'],
  ['./.env', 'source-unavailable'],
] as const)('refuses a bundle whose declared patch cannot be restored: %s', async (patch, code) => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0', dsh: { bundle: { patch } } }))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code, path: 'bundles/0/package.json' }] })
})

it('checks arbitrary declared patch filenames for escaping plugin modules', async () => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'plugin.patch.yml'), '- insert:\n    - id: escaping\n      name: ../outside.mjs\n')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'bundles/0/plugin.patch.yml' }] })
})

it.each(['../outside.js', './lib/missing.js'])('refuses a package whose runtime entry cannot be restored: %s', async (main) => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0', main }))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
})

it('refuses nested symlinks instead of copying outside the selected source root', async () => {
  const { root, local, profile } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), 'outside-source')
  await symlink(outside, join(local, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'bundles/0/linked' }] })
})

it('refuses local source with a nonportable dependency instead of dropping it', async () => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0', dependencies: { dependency: 'workspace:*' } }))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/package.json' }] })
})

it('refuses binary and oversized source files', async () => {
  const { local, profile } = await fixture()
  const file = join(local, 'src', 'binary.ts')
  await writeFile(file, Buffer.from([0xff]))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/src/binary.ts' }] })
  await writeFile(file, 'x'.repeat(1024 * 1024 + 1))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'too-large', path: 'bundles/0/src/binary.ts' }] })
})

it.each(['master', 'main', '@', 'feat\u0085branch', 'refs/heads/feature', '../secret', 'feature.lock', 'feature..branch'])('refuses an unsafe or default branch: %s', async (branch) => {
  const { profile } = await fixture()
  expect(await exportProfileSource(profile, { ...request, branch })).toEqual({ status: 'blocked', issues: [{ code: 'invalid-branch' }] })
})

it.each(['https://github.com/person/repo', 'person/repo?token=x', '/tmp/fork'])('refuses a destination outside the repository-slug format: %s', async (repository) => {
  const { profile } = await fixture()
  expect(await exportProfileSource(profile, { ...request, repository })).toEqual({ status: 'blocked', issues: [{ code: 'invalid-repository' }] })
})

it('exposes source capture on the profile manager without loading source plugins', async () => {
  const { dir, profile } = await fixture()
  const ctx = await boot('test', join(dir, 'cordis.yml'), [{ insert: [{ id: 'manager', name: 'cordis:manager' }] }], (owner) => {
    owner.provide('profileContext', profile)
    owner.loader.builtins.manager = PluginManager
  })
  onTestFinished(() => ctx.fiber.dispose())
  expect((await ctx.pluginManager.exportSource(request)).status).toBe('ready')
  expect(ctx.get('restoredSourceProbe')).toBeUndefined()
})

it('pins an installed registry dependency while preserving bundle order', async () => {
  const { dir, profile } = await fixture()
  const registry = join(dir, 'node_modules', 'registry-plugin')
  await mkdir(registry, { recursive: true })
  await writeFile(join(registry, 'package.json'), '{"name":"registry-plugin","version":"2.3.4"}\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'registry-plugin': '^2.0.0' }, dsh: { profile: { bundles: ['registry-plugin'] } } }))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('ready')
  if (result.status === 'ready') {
    const manifest = result.files.find(file => file.path === 'profiles/saved/package.json')!
    expect(JSON.parse(manifest.content)).toMatchObject({ dependencies: { 'registry-plugin': '2.3.4' }, dsh: { profile: { bundles: ['registry-plugin'] } } })
  }
})

it.each([undefined, 7, 'not-semver'])('refuses unavailable installed registry versions: %s', async (version) => {
  const { dir, profile } = await fixture()
  const registry = join(dir, 'node_modules', 'registry-plugin')
  await mkdir(registry, { recursive: true })
  await writeFile(join(registry, 'package.json'), JSON.stringify({ name: 'registry-plugin', version }))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'registry-plugin': '*' }, dsh: { profile: { bundles: ['registry-plugin'] } } }))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'profiles/saved/package.json' }] })
})

it.each([
  ['{', 'unsupported-source'],
  ['[]', 'unsupported-source'],
  ['{}', 'profile-unavailable'],
  ['{"dsh":{}}', 'profile-unavailable'],
  ['{"dsh":{"profile":{"bundles":3}}}', 'profile-unavailable'],
  ['{"dsh":{"profile":{"bundles":["../escape"]}}}', 'profile-unavailable'],
  ['{"dependencies":[],"dsh":{"profile":{"bundles":[]}}}', 'unsupported-source'],
  ['{"dependencies":{"Invalid":1},"dsh":{"profile":{"bundles":[]}}}', 'unsupported-source'],
  ['{"dependencies":{"git-plugin":"github:user/repo"},"dsh":{"profile":{"bundles":[]}}}', 'unsupported-source'],
] as const)('refuses malformed or nonportable profile metadata without content: %s', async (content, code) => {
  const { dir, profile } = await fixture()
  await writeFile(join(dir, 'package.json'), content)
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe(code)
})

it('captures a profile without external dependencies', async () => {
  const { dir, profile } = await fixture()
  await writeFile(join(dir, 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}\n')
  expect((await exportProfileSource(profile, request)).status).toBe('ready')
})

it.each(['- [', '{}'])('refuses malformed or non-list patch YAML: %s', async (content) => {
  const { profile } = await fixture()
  await writeFile(profile.patchPath, content)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'profiles/saved/cordis.patch.yml' }] })
})

it('bounds YAML alias expansion before traversing values', async () => {
  const { profile } = await fixture()
  const many = Array.from({ length: 101 }, () => '*entry').join(', ')
  await writeFile(profile.patchPath, `- id: one\n  config: { a: &entry value, b: [${many}] }\n`)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'profiles/saved/cordis.patch.yml' }] })
})

it('permits ordinary primitive configuration and credential-free URLs', async () => {
  const { profile } = await fixture()
  await writeFile(profile.patchPath, '- id: source-probe\n  config:\n    options: [null, 2, true, false]\n    token: null\n    url: https://example.com/mcp\n')
  expect((await exportProfileSource(profile, request)).status).toBe('ready')
})

it.each([
  '- insert: [{ id: local, name: ./private.js }]',
  '- insert: [{ id: file, name: file:///private.js }]',
  '- insert: [{ id: include, path: ../private.yml }]',
  '- insert: [{ id: include, path: /private.yml }]',
] as const)('refuses profile-local modules and escaping includes: %s', async (patch) => {
  const { profile } = await fixture()
  await writeFile(profile.patchPath, patch)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'profiles/saved/cordis.patch.yml' }] })
})

it('refuses literal secrets and authenticated URLs in plugin source', async () => {
  const { local, profile } = await fixture()
  const path = join(local, 'src', 'index.ts')
  for (const content of ['export const value = "sk-1234567890abcdef"', 'export const apiKey = "private-value"', 'export const url = "https://account:password@example.com/mcp"']) {
    await writeFile(path, content)
    expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'secret-suspected', path: 'bundles/0/src/index.ts' }] })
  }
})

it('refuses non-text entries and NUL bytes', async () => {
  const { local, profile } = await fixture()
  const path = join(local, 'src', 'image.png')
  await writeFile(path, 'not a text source format')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/src/image.png' }] })
  await rm(path)
  await writeFile(join(local, 'src', 'index.ts'), 'a\0b')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/src/index.ts' }] })
})

it.each([
  { main: false },
  { exports: './missing.js' },
  { exports: '/outside.js' },
  { exports: 4 },
  { exports: ['./lib/index.js', null] },
  { dsh: { bundle: { patch: 5 } } },
  { dsh: { bundle: { patch: ['./plugin.patch.yml', './missing.yml'] } } },
  { dsh: { bundle: { patch: './*.yml' } } },
] as const)('validates every declared runtime or patch target: %j', async (fields) => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0', ...fields }))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe(Array.isArray(Reflect.get(fields, 'exports')) ? 'ready' : 'blocked')
})

it('captures ordered patch files and optional package metadata', async () => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'acme-plugin', version: '1.0.0',
    dsh: { bundle: { patch: ['./plugin.patch.yml'] } }, exports: null }))
  expect((await exportProfileSource(profile, request)).status).toBe('ready')
})

it('refuses missing local package roots and manifests', async () => {
  const { local, dir, profile } = await fixture()
  await rm(join(local, 'package.json'))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'bundles/0/package.json' }] })
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"missing":"link:../../missing"},"dsh":{"profile":{"bundles":[]}}}')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'bundles/0/package.json' }] })
})

it('refuses unreadable source files without leaking diagnostics', async () => {
  const { local, profile } = await fixture()
  filesystemHooks.beforeOpen = async (filename) => {
    if (filename === join(local, 'src', 'index.ts')) throw new Error('secret filesystem diagnostic')
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'bundles/0/src/index.ts' }] })
})

it('refuses an unreadable directory and a disappearing source entry', async () => {
  const { local, profile } = await fixture()
  filesystemHooks.beforeDirectory = async (filename) => { if (filename === local) throw new Error('unreadable') }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'bundles/0' }] })
  filesystemHooks.beforeDirectory = undefined
  filesystemHooks.beforeRealpath = async (filename) => { if (filename === join(local, 'src', 'index.ts')) throw new Error('disappeared') }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'bundles/0/src/index.ts' }] })
})

it('refuses files changed or removed after capture', async () => {
  const { profile } = await fixture()
  let opens = 0
  filesystemHooks.beforeOpen = async (filename) => {
    if (filename === profile.patchPath && ++opens === 2) await writeFile(filename, '[]\n')
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed', path: 'profiles/saved/cordis.patch.yml' }] })
  opens = 0
  filesystemHooks.beforeOpen = async (filename) => { if (filename === profile.patchPath && ++opens === 2) throw new Error('disappeared') }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed', path: 'profiles/saved/cordis.patch.yml' }] })
})

it('refuses directory membership changes and failed verification reads', async () => {
  const { local, profile } = await fixture()
  let listings = 0
  filesystemHooks.beforeDirectory = async (filename) => {
    if (filename === local && ++listings === 2) await mkdir(join(local, 'new-directory'))
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed' }] })
  listings = 0
  filesystemHooks.beforeDirectory = async (filename) => { if (filename === local && ++listings === 2) throw new Error('unreadable') }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed' }] })
})

it('refuses a file replaced by a directory between the path check and opening', async () => {
  const { root, local, profile } = await fixture()
  const info = await import('node:fs/promises').then(fs => fs.lstat(root, { bigint: true }))
  filesystemHooks.afterOpen = async (filename, handle) => {
    if (filename === join(local, 'src', 'index.ts')) vi.spyOn(handle, 'stat').mockResolvedValue(info)
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'bundles/0/src/index.ts' }] })
})

it('refuses files that grow beyond the byte limit after their size check', async () => {
  const { local, profile } = await fixture()
  filesystemHooks.beforeOpen = async (filename) => {
    if (filename === join(local, 'src', 'index.ts')) await writeFile(filename, 'x'.repeat(1024 * 1024 + 1))
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'too-large', path: 'bundles/0/src/index.ts' }] })
})

it('refuses nonportable filenames and case-colliding source directories on a case-sensitive filesystem', async (context) => {
  const { local, profile } = await fixture()
  await mkdir(join(local, 'A'))
  try { await mkdir(join(local, 'a')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') context.skip()
    throw error
  }
  await writeFile(join(local, 'A', 'one.ts'), 'first')
  await writeFile(join(local, 'a', 'two.ts'), 'second')
  expect((await exportProfileSource(profile, request)).status).toBe('blocked')
  await writeFile(join(local, 'src', 'CON.txt'), 'reserved')
  expect((await exportProfileSource(profile, request)).status).toBe('blocked')
})

it.each([
  { names: ['A.ts', 'a.ts'], path: 'bundles/0/src/a.ts' },
  { names: ['CON.txt'], path: 'bundles/0/src/CON.txt' },
])('refuses nonportable virtual source names on every filesystem: $names', async ({ names, path }) => {
  const { dir, local, profile } = await fixture()
  await virtualDirectory(join(local, 'src'), names, '', join(dir, 'virtual-source'))
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path }] })
})

it('refuses absent or unreadable profile patch files', async () => {
  const { profile } = await fixture()
  await rm(profile.patchPath)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: 'profiles/saved/cordis.patch.yml' }] })
  filesystemHooks.beforeStat = async (filename) => { if (filename === profile.patchPath) throw new Error('unreadable') }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'profile-unavailable' }] })
})

it('screens secrets after JSON escape decoding', async () => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'encoded.json'), '{"value":"\\u0073\\u006b-1234567890abcdef"}')
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'secret-suspected', path: 'bundles/0/encoded.json' }] })
})

it.each(['repository', 'branch', 'profile'] as const)('refuses a known secret marker in export metadata without echoing it: %s', async (field) => {
  const { profile } = await fixture()
  const marker = 'ghp_' + 'x'.repeat(24)
  const destination = field === 'repository' ? { ...request, repository: `person/${marker}` }
    : field === 'branch' ? { ...request, branch: marker } : request
  const source = field === 'profile' ? { ...profile, name: marker } : profile
  const result = await exportProfileSource(source, destination)
  expect(result).toEqual({ status: 'blocked', issues: [{ code: 'secret-suspected' }] })
  expect(JSON.stringify(result)).not.toContain(marker)
})

it('refuses a safe-content file whose name contains a known secret marker without echoing it', async () => {
  const { local, profile } = await fixture()
  const marker = 'ghp_' + 'x'.repeat(24)
  await writeFile(join(local, 'src', `${marker}.ts`), 'export const ordinary = true\n')
  const result = await exportProfileSource(profile, request)
  expect(result).toEqual({ status: 'blocked', issues: [{ code: 'secret-suspected' }] })
  expect(JSON.stringify(result)).not.toContain(marker)
})

it.each(['read-failure', 'secret-content'] as const)('omits secret-bearing paths from an export refusal after %s', async (failure) => {
  const { local, profile } = await fixture()
  const marker = 'ghp_' + 'x'.repeat(24)
  const filename = join(local, 'src', `${marker}.ts`)
  const secret = 'sk-' + 'x'.repeat(20)
  await writeFile(filename, failure === 'secret-content' ? secret : 'ordinary source\n')
  filesystemHooks.beforeOpen = async (path) => {
    if (failure === 'read-failure' && path === filename) throw new Error('fixture read failed')
  }
  const result = await exportProfileSource(profile, request)
  const code = failure === 'read-failure' ? 'source-unavailable' : 'secret-suspected'
  expect(result).toEqual({ status: 'blocked', issues: [{ code }] })
  expect(JSON.stringify(result)).not.toContain(marker)
  expect(JSON.stringify(result)).not.toContain(secret)
})

it('refuses a profile patch replaced by a directory before capture or verification', async () => {
  const { profile } = await fixture()
  let stats = 0
  filesystemHooks.beforeStat = async (filename) => {
    if (filename === profile.patchPath && ++stats === 3) {
      await rm(filename)
      await mkdir(filename)
    }
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed', path: 'profiles/saved/cordis.patch.yml' }] })
  filesystemHooks.beforeStat = undefined
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'profiles/saved/cordis.patch.yml' }] })
})

it('refuses a directory that moves outside its source root after enumeration', async () => {
  const { root, local, profile } = await fixture()
  const outside = join(root, 'outside-directory')
  await mkdir(outside)
  filesystemHooks.beforeRealpath = async (filename) => {
    if (filename === join(local, 'src')) {
      await rm(filename, { recursive: true })
      await symlink(outside, filename, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'bundles/0/src' }] })
})

it('refuses special filesystem objects', async () => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'special'), '')
  filesystemHooks.specialEntry = 'special'
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/special' }] })
})

it('bounds the total retained file bytes', async () => {
  const { local, profile } = await fixture()
  const text = 'x'.repeat(1024 * 1024)
  await Promise.all(Array.from({ length: 11 }, (_, index) => writeFile(join(local, 'src', `${index}.ts`), text)))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe('too-large')
})

it('bounds the number of retained files', async () => {
  const { dir, local, profile } = await fixture()
  await virtualDirectory(join(local, 'src'), Array.from({ length: 2000 }, (_, index) => `${index}.ts`), '', join(dir, 'virtual-source'))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe('too-large')
})

it('bounds source traversal even when every entry is excluded', async () => {
  const { local, profile } = await fixture()
  for (let start = 0; start < 10001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10001 - start) }, (_, index) => mkdir(join(local, `.private-${start + index}`))))
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'too-large', path: 'bundles/0' }] })
})

it('replaces profile and bundle workspace configuration with isolated settings', async () => {
  const { dir, local, profile } = await fixture()
  const unsafe = 'packages:\n  - ../outside\nautoInstallPeers: true\nallowBuilds:\n  dependency: true\n'
  await writeFile(join(dir, 'pnpm-workspace.yaml'), unsafe)
  await writeFile(join(local, 'pnpm-workspace.yaml'), unsafe)
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error('workspace normalization was refused')
  const expected = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  expect(result.files.find(file => file.path === 'profiles/saved/pnpm-workspace.yaml')?.content).toBe(expected)
  expect(result.files.find(file => file.path === 'bundles/0/pnpm-workspace.yaml')?.content).toBe(expected)
  expect(result.files.find(file => file.path === '.gitignore')?.content).toContain('!/profiles/saved/pnpm-workspace.yaml\n')
  expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(unsafe)
  expect(await readFile(join(local, 'pnpm-workspace.yaml'), 'utf8')).toBe(unsafe)
})

it.each(['./.plugin.mjs', './tests/plugin.mjs'])('refuses a relative plugin module omitted from the export: %s', async (module) => {
  const { local, profile } = await fixture()
  await mkdir(join(local, 'tests'))
  await writeFile(join(local, module), 'export function apply() {}\n')
  await writeFile(join(local, 'plugin.patch.yml'), `- insert: [{ id: omitted-plugin, name: '${module}' }]\n`)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-unavailable', path: `bundles/0/${module.slice(2)}` }] })
})

it('resolves a relative plugin module beside its declared patch file', async () => {
  const { local, profile } = await fixture()
  await mkdir(join(local, 'config'))
  await writeFile(join(local, 'config', 'plugin.mjs'), 'export function apply() {}\n')
  await writeFile(join(local, 'config', 'rows.yml'), '- insert: [{ id: nested-plugin, name: ./plugin.mjs }]\n')
  await writeFile(join(local, 'package.json'), '{"name":"acme-plugin","version":"1.0.0","dsh":{"bundle":{"patch":"./config/rows.yml"}}}')
  expect((await exportProfileSource(profile, request)).status).toBe('ready')
})

it.each(['cordis:include', 'include', '@deepseek-ai/cordis-plugin-include'])('refuses include graphs outside the supported source template: %s', async (name) => {
  const { local, profile } = await fixture()
  await writeFile(join(local, 'plugin.patch.yml'), `- insert: [{ id: external-tree, name: '${name}', config: { path: 'file:///outside.yml' } }]\n`)
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsupported-source', path: 'bundles/0/plugin.patch.yml' }] })
})

it.each([false, true])('refuses a symlink ancestor introduced after the pre-open check (outside: %s)', async (outside) => {
  const { root, local, profile } = await fixture()
  const source = join(local, 'src')
  const moved = join(outside ? root : local, 'moved-source')
  filesystemHooks.beforeOpen = async (filename) => {
    if (filename === join(source, 'index.ts')) {
      await rename(source, moved)
      await symlink(moved, source, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'unsafe-path', path: 'bundles/0/src/index.ts' }] })
})

it.each([1, 2])('refuses an inode replaced between stat and open during capture phase %s', async (phase) => {
  const { local, profile } = await fixture()
  const source = join(local, 'src', 'index.ts')
  let opens = 0
  filesystemHooks.beforeOpen = async (filename) => {
    if (filename === source && ++opens === phase) {
      const replacement = join(local, 'replacement.ts')
      await writeFile(replacement, 'changed source')
      await rename(replacement, source)
    }
  }
  expect(await exportProfileSource(profile, request)).toEqual({ status: 'blocked', issues: [{ code: 'source-changed', path: 'bundles/0/src/index.ts' }] })
})

it('bounds the encoded JSON response, including content escaping', async () => {
  const { local, profile } = await fixture()
  const content = '\u0001'.repeat(1024 * 1024)
  await writeFile(join(local, 'src', 'escape-one.txt'), content)
  await writeFile(join(local, 'src', 'escape-two.txt'), content)
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe('too-large')
})

it('bounds response metadata before capturing any source', async () => {
  const { profile } = await fixture()
  expect(await exportProfileSource(profile, { ...request, branch: 'x'.repeat(10 * 1024 * 1024) })).toEqual({ status: 'blocked', issues: [{ code: 'too-large' }] })
})

it('bounds retained registry manifest bytes even when the output is small', async () => {
  const { dir, profile } = await fixture()
  const declared: Record<string, string> = {}
  const content = JSON.stringify({ version: '1.0.0', padding: 'x'.repeat(1024 * 1024 - 64) })
  for (let index = 0; index < 11; index += 1) {
    const name = `registry-${index}`
    declared[name] = '*'
    const root = join(dir, 'node_modules', name)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), content)
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: declared, dsh: { profile: { bundles: [] } } }))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe('too-large')
})

it('bounds the number of observed registry manifest reads', async () => {
  const { dir, profile } = await fixture()
  const installed = join(dir, 'registry-manifest')
  await mkdir(installed)
  await writeFile(join(installed, 'package.json'), '{"version":"1.0.0"}')
  // Virtual registry names share one real manifest so the read budget does not depend on thousands of fixture directories.
  const appBoot = await import('@deepseek-ai/dsh-app-boot')
  const canonical = await virtualDirectory(installed, ['package.json'], '{"version":"1.0.0"}', join(dir, 'virtual-source'))
  vi.spyOn(appBoot, 'resolveBundleDir').mockReturnValue(canonical)
  const declared = Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`registry-${index}`, '*']))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: declared, dsh: { profile: { bundles: [] } } }))
  const result = await exportProfileSource(profile, request)
  expect(result.status).toBe('blocked')
  if (result.status === 'blocked') expect(result.issues[0]?.code).toBe('too-large')
})

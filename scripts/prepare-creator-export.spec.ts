/** The standalone extractor treats downloaded JSON as untrusted input. */
import { spawnSync } from 'node:child_process'
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CreatorExportPreparationError, prepareCreatorExport, readCreatorExport, type CreatorExportFile } from './prepare-creator-export.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), writeFileSync: vi.fn(actual.writeFileSync), rmSync: vi.fn(actual.rmSync) }
})

const writeOriginal = vi.mocked(writeFileSync).getMockImplementation()!
const removeOriginal = vi.mocked(rmSync).getMockImplementation()!
const fstatOriginal = vi.mocked(fstatSync).getMockImplementation()!
afterEach(() => {
  vi.mocked(writeFileSync).mockReset().mockImplementation(writeOriginal)
  vi.mocked(rmSync).mockReset().mockImplementation(removeOriginal)
  vi.mocked(fstatSync).mockReset().mockImplementation(fstatOriginal)
})

const SOURCE_IGNORE = '/*\n!/.gitignore\n!/bundles/\n!/profiles/\n/profiles/*\n!/profiles/saved/\n/profiles/saved/*\n!/profiles/saved/package.json\n!/profiles/saved/cordis.patch.yml\n!/profiles/saved/pnpm-workspace.yaml\n**/node_modules/\n**/.env*\n**/.credentials*\n'
const PROFILE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const PROFILE_FILES = [
  { path: '.gitignore', content: SOURCE_IGNORE },
  { path: 'profiles/saved/package.json', content: '{"name":"saved","dsh":{"profile":{"bundles":[]}}}\n' },
  { path: 'profiles/saved/cordis.patch.yml', content: '[]\n' },
  { path: 'profiles/saved/pnpm-workspace.yaml', content: PROFILE_WORKSPACE },
]

function archive(files: readonly CreatorExportFile[] = PROFILE_FILES) {
  return { status: 'ready', formatVersion: 1, repository: 'owner/fork', branch: 'creator/my-sources', profile: 'web', reviewRequired: true, files }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'creator-export-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return { root, destination: join(root, 'prepared') }
}

function rejected(input: unknown, code: CreatorExportPreparationError['code'] = 'invalid-export') {
  const { destination } = fixture()
  expect(() => prepareCreatorExport(input, destination)).toThrow(expect.objectContaining({ code }))
  expect(existsSync(destination)).toBe(false)
}

it('writes exact reviewed text into a new private tree without executing source files', () => {
  const { root, destination } = fixture()
  const files = [...PROFILE_FILES,
    { path: 'bundles/0/package.json', content: '{"name":"local-bundle"}\n' },
    { path: 'bundles/0/pnpm-workspace.yaml', content: PROFILE_WORKSPACE },
    { path: 'bundles/0/src/空间 $module.ts', content: 'throw new Error("Sources must not execute while extracting")\n' },
  ]
  const input = archive(files)
  const before = JSON.stringify(input)
  expect(prepareCreatorExport(input, destination)).toBe(resolve(destination))
  for (const file of files) expect(readFileSync(join(destination, file.path), 'utf8')).toBe(file.content)
  expect(JSON.stringify(input)).toBe(before)
  expect(existsSync(join(root, 'profiles'))).toBe(false)
  if (process.platform !== 'win32') {
    expect(statSync(destination).mode & 0o777).toBe(0o700)
    expect(statSync(join(destination, 'profiles/saved/package.json')).mode & 0o777).toBe(0o600)
  }
})

it.each([
  null, [], {},
  { ...archive(), status: 'blocked', issues: [] },
  { ...archive(), formatVersion: 2 },
  { ...archive(), reviewRequired: false },
  { ...archive(), files: undefined },
  { ...archive(), files: [] },
  { ...archive(), files: [...PROFILE_FILES, null] },
  { ...archive(), files: [...PROFILE_FILES, { path: 'bundles/0/index.js', content: 1 }] },
  { ...archive(), files: [...PROFILE_FILES, { path: 1, content: '' }] },
  { ...archive(), profile: '' },
  { ...archive(), profile: 'web\nother' },
  { ...archive(), profile: null },
])('rejects unsupported or malformed downloaded data before creating files: %#', (input) => { rejected(input) })

it.each(['', '../fork', '/owner/fork', 'owner/fork/extra', 'https://github.com/owner/fork', 'owner/fork?token=secret', 'owner/..'])('rejects an invalid repository: %s', (repository) => {
  rejected({ ...archive(), repository })
})

it('rejects the reserved HEAD branch before creating or writing a destination', () => {
  const { destination } = fixture()
  expect(() => prepareCreatorExport({ ...archive(), branch: 'HEAD' }, destination))
    .toThrow(expect.objectContaining<{ code: CreatorExportPreparationError['code']; message: unknown }>({
      code: 'invalid-export', message: expect.stringContaining('HEAD, main, or master'),
    }))
  expect(existsSync(destination)).toBe(false)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each(['head', 'Head', 'creator/HEAD', 'HEAD/creator'])('extracts an ordinary branch with its exact reviewed files: %s', (branch) => {
  const { destination } = fixture()
  expect(prepareCreatorExport({ ...archive(), branch }, destination)).toBe(resolve(destination))
  for (const file of PROFILE_FILES) expect(readFileSync(join(destination, file.path), 'utf8')).toBe(file.content)
})

it.each(['', 'main', 'MAIN', 'master', 'MASTER', '@', '-option', 'refs/heads/creator', '/creator', 'creator/', 'creator.',
  ' HEAD ', ' head ', '\tHead\n',
  'creator//saved', 'creator..saved', 'creator@{saved', 'creator saved', 'creator\nsaved', 'creator~saved', 'creator^saved',
  'creator:saved', 'creator?saved', 'creator*saved', 'creator[saved', 'creator\\saved', 'creator/.saved', 'creator/saved.lock', 'creator/saved.LOCK',
])('rejects an unsafe or protected branch: %s', (branch) => {
  rejected({ ...archive(), branch })
})

it.each([
  '../outside', '/outside', 'C:/outside', '\\\\server\\outside', 'bundles/0/../outside', 'bundles/0/./index.ts', 'bundles/0//index.ts',
  'bundles/0\\index.ts', 'bundles/0/index.ts\u0000other', 'bundles/0/index\u007f.ts', 'bundles/0/name:stream', 'bundles/0/name?.ts',
  'bundles/0/name*.ts', 'bundles/0/name|.ts', 'bundles/0/<name>.ts', 'bundles/0/"name".ts', 'bundles/0/name.', 'bundles/0/name ',
  'bundles/0/CON', 'bundles/0/aux.txt', 'bundles/0/com1.js', 'bundles/0/LPT9.txt', 'bundles/0/COM¹', 'bundles/0/CONOUT$',
  'profiles/other/package.json', 'profiles/saved/settings.json', 'Profiles/saved/package.json', '.git/config', 'credentials/token',
  'bundles/00/index.ts', 'bundles/-1/index.ts', 'bundles/source/index.ts', 'bundles/0/',
  'bundles/0/.git/config', 'bundles/0/.env', 'bundles/0/src/.npmrc', 'bundles/0/node_modules/plugin/index.js',
  'bundles/0/credentials.json',
])('rejects unsafe paths before any safe file is written: %s', (path) => {
  rejected(archive([...PROFILE_FILES, { path, content: 'unsafe' }]), 'unsafe-path')
})

it('rejects binary contents in a tampered download before creating a destination', () => {
  rejected(archive([...PROFILE_FILES, { path: 'bundles/0/index.js', content: 'source\0binary' }]))
})

it('does not echo credentials embedded in rejected input paths', () => {
  const token = `ghp_${'a'.repeat(16)}`
  const { destination } = fixture()
  expect(() => prepareCreatorExport(archive([...PROFILE_FILES, { path: `../${token}`, content: '' }]), destination))
    .toThrow(expect.objectContaining<{ code: string; message: unknown }>({
      code: 'unsafe-path', message: expect.not.stringContaining(token),
    }))
  expect(existsSync(destination)).toBe(false)
})

it.each([
  ['bundles/0/index.ts', 'bundles/0/index.ts'],
  ['bundles/0/Index.ts', 'bundles/0/index.ts'],
  ['bundles/0/é.ts', 'bundles/0/é.ts'],
  ['bundles/0/Src/a.ts', 'bundles/0/src/b.ts'],
  ['bundles/0/src', 'bundles/0/src/index.ts'],
  ['bundles/0/src/index.ts', 'bundles/0/SRC'],
])('rejects duplicate or conflicting filesystem paths: %s / %s', (first, second) => {
  rejected(archive([...PROFILE_FILES, { path: first, content: 'first' }, { path: second, content: 'second' }]), 'unsafe-path')
})

it('requires the saved profile files and the exact source-only ignore policy', () => {
  for (const file of PROFILE_FILES) rejected(archive(PROFILE_FILES.filter(candidate => candidate !== file)))
  rejected(archive(PROFILE_FILES.map(file => file.path === '.gitignore' ? { ...file, content: '' } : file)))
})

it.each(['', 'packages:\n  - elsewhere/*\n', 'packages:\n  - .\n\nautoInstallPeers: true\n',
  `${PROFILE_WORKSPACE}\nallowBuilds:\n  unsafe-package: true\n`,
])('rejects changed workspace membership, peer installation, and build approvals: %#', (content) => {
  rejected(archive(PROFILE_FILES.map(file => file.path === 'profiles/saved/pnpm-workspace.yaml' ? { ...file, content } : file)))
})

it.each([
  { label: 'missing settings', content: undefined },
  { label: 'empty settings', content: '' },
  { label: 'peer installation', content: 'packages:\n  - .\n\nautoInstallPeers: true\n' },
  { label: 'build approvals', content: `${PROFILE_WORKSPACE}\nallowBuilds:\n  unsafe-package: true\n` },
])('requires isolated workspace settings for every exported local bundle: $label', ({ content }) => {
  const files = [...PROFILE_FILES, { path: 'bundles/0/package.json', content: '{"name":"local-bundle"}\n' }]
  if (content !== undefined) files.push({ path: 'bundles/0/pnpm-workspace.yaml', content })
  rejected(archive(files))
})

it('enforces file count, per-file UTF-8 bytes, and total UTF-8 bytes before extraction', () => {
  rejected(archive([...PROFILE_FILES, ...Array.from({ length: 1_997 }, (_, index) => ({ path: `bundles/0/${index}`, content: '' }))]))
  rejected(archive([...PROFILE_FILES, { path: 'bundles/0/large.txt', content: '😀'.repeat(262_145) }]))
  const content = 'x'.repeat(1_048_576)
  rejected(archive([...PROFILE_FILES, ...Array.from({ length: 10 }, (_, index) => ({ path: `bundles/0/${index}`, content }))]))
})

it.each(['directory', 'file', 'link'] as const)('leaves an existing destination %s untouched', (kind) => {
  const { root, destination } = fixture()
  const sentinel = 'Existing user data\n'
  let existing = destination
  if (kind === 'file') writeFileSync(destination, sentinel)
  else {
    if (kind === 'link') existing = join(root, 'existing')
    mkdirSync(existing)
    writeFileSync(join(existing, 'sentinel.txt'), sentinel)
    if (kind === 'link') symlinkSync(existing, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  expect(() => prepareCreatorExport(archive(), destination)).toThrow(expect.objectContaining({ code: 'destination-unavailable' }))
  expect(readFileSync(kind === 'file' ? existing : join(existing, 'sentinel.txt'), 'utf8')).toBe(sentinel)
  if (kind === 'link') expect(lstatSync(destination).isSymbolicLink()).toBe(true)
})

it('requires an existing parent without creating intermediate destination directories', () => {
  const { root } = fixture()
  expect(() => prepareCreatorExport(archive(), join(root, 'missing/child'))).toThrow(expect.objectContaining({ code: 'destination-unavailable' }))
  expect(existsSync(join(root, 'missing'))).toBe(false)
})

it('removes its newly created tree after a filesystem write fails', () => {
  const { root, destination } = fixture()
  writeFileSync(join(root, 'existing.txt'), 'Keep this file\n')
  const failure = Object.assign(new Error('Fixture disk is full'), { code: 'ENOSPC' })
  vi.mocked(writeFileSync).mockImplementationOnce(writeOriginal).mockImplementationOnce(() => { throw failure })
  expect(() => prepareCreatorExport(archive(), destination)).toThrow(expect.objectContaining({ code: 'extraction-failed', cause: failure }))
  expect(existsSync(destination)).toBe(false)
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('Keep this file\n')
})

it('reports an incomplete destination when cleanup itself fails', () => {
  const { destination } = fixture()
  vi.mocked(writeFileSync).mockImplementationOnce(writeOriginal).mockImplementationOnce(() => { throw new Error('Fixture write refused') })
  vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error('Fixture cleanup refused') })
  expect(() => prepareCreatorExport(archive(), destination)).toThrow(expect.objectContaining<{
    code: CreatorExportPreparationError['code']
    cause: unknown
  }>({ code: 'cleanup-failed', cause: expect.any(AggregateError) }))
  expect(readFileSync(join(destination, '.gitignore'), 'utf8')).toBe(SOURCE_IGNORE)
})

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'prepare-creator-export.ts'), ...args], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

it('runs directly under Node and prepares the same reviewed file map', () => {
  const { root, destination } = fixture()
  const download = join(root, 'dsh-source-export.json')
  writeFileSync(download, `${JSON.stringify(archive(), null, 2)}\n`)
  const result = runCli([download, destination])
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Prepared reviewed sources in')
  expect(result.stderr).toBe('')
  expect(readFileSync(join(destination, 'profiles/saved/package.json'), 'utf8')).toBe(PROFILE_FILES[1]!.content)
})

it('reports usage and malformed JSON without creating a destination', () => {
  const usage = runCli([])
  expect(usage.status).toBe(1)
  expect(usage.stderr).toContain('Usage: node scripts/prepare-creator-export.ts')
  const { root, destination } = fixture()
  const download = join(root, 'invalid.json')
  writeFileSync(download, '{secret-not-to-be-reported')
  const result = runCli([download, destination])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Creator export preparation failed')
  expect(result.stderr).not.toContain('secret-not-to-be-reported')
  expect(existsSync(destination)).toBe(false)
})

it('refuses a sparse oversized download before allocating its content', () => {
  const { root, destination } = fixture()
  const download = join(root, 'oversized.json')
  writeFileSync(download, '')
  truncateSync(download, 64 * 1_048_576 + 1)
  const result = runCli([download, destination])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('not a bounded JSON file')
  expect(existsSync(destination)).toBe(false)
})

it('refuses bytes beyond the file size observed before reading', () => {
  const { root } = fixture()
  const download = join(root, 'growing.json')
  writeFileSync(download, JSON.stringify(archive()))
  const stale = statSync(download)
  stale.size = 1
  vi.mocked(fstatSync).mockReturnValueOnce(stale)
  expect(() => readCreatorExport(download)).toThrow(expect.objectContaining<{
    code: CreatorExportPreparationError['code']
    message: unknown
  }>({ code: 'invalid-export', message: expect.stringContaining('changed while') }))
})

it('rejects invalid UTF-8 rather than changing downloaded source text', () => {
  const { root } = fixture()
  const download = join(root, 'invalid-encoding.json')
  writeFileSync(download, Buffer.from([0x22, 0xff, 0x22]))
  expect(() => readCreatorExport(download)).toThrow(expect.objectContaining({ code: 'invalid-export' }))
})

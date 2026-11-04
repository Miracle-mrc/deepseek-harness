import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { assertStagedBuildsApproved, deduplicateStagedWorkspacePackages, materializeStagedLinks, relocateStagedBuildApprovals } from './build-exe-for-python-sdk-staging.ts'

const temporaryDirectories: string[] = []
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(workspace)
  // File dependency identities use canonical paths even when the temp directory is an alias.
  return realpath(workspace)
}

/** List every symbolic link below a directory. */
async function listSymlinks(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return [path]
    if (entry.isDirectory()) return listSymlinks(path)
    return []
  }))
  return nested.flat()
}

it('drops the deploy root link that points back into the payload', async () => {
  const workspace = await fixture('dsh-python-staging-root-')
  const project = join(workspace, 'python', 'sdk-runtime')
  const staging = join(project, 'src', 'runtime', 'node')
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  await writeFile(join(project, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(project, join(staging, 'node_modules', 'dsh-python-runtime-closure'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', 'dsh-python-runtime-closure'))).toBe(false)
  await expect(readFile(join(project, 'package.json'), 'utf8')).resolves.toContain('dsh-python-runtime-closure')
})

it('copies workspace package links as files and removes command shims', async () => {
  const workspace = await fixture('dsh-python-staging-packages-')
  const staging = join(workspace, 'runtime', 'node')
  const packageDirectory = join(workspace, 'packages', 'dsh-base')
  await mkdir(join(packageDirectory, 'lib'), { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')
  await writeFile(join(packageDirectory, 'lib', 'index.js'), 'export {}\n')
  await mkdir(join(staging, 'node_modules', '@deepseek-ai'), { recursive: true })
  await mkdir(join(staging, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(staging, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(packageDirectory, join(staging, 'node_modules', '@deepseek-ai', 'dsh-base'), directoryLinkType)
  await symlink(packageDirectory, join(staging, 'node_modules', '.bin', 'dsh'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', '.bin'))).toBe(false)
  await expect(readFile(join(staging, 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js'), 'utf8'))
    .resolves.toBe('export {}\n')
  expect(await listSymlinks(staging)).toEqual([])
})

it('shares an identical workspace package while retaining different peers and third-party copies', async () => {
  const workspace = await fixture('dsh-python-staging-dedupe-')
  const staging = join(workspace, 'payload')
  const modules = join(staging, 'node_modules')
  const root = join(modules, '@fixture', 'tools')
  const duplicate = join(modules, 'app', 'node_modules', '@fixture', 'tools')
  const differentPeers = join(modules, 'other', 'node_modules', '@fixture', 'tools')
  const external = join(modules, 'external')
  const externalCopy = join(modules, 'app', 'node_modules', 'external')
  for (const directory of [root, duplicate, differentPeers, external, externalCopy]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.js'), 'exports.scheduler = Symbol("scheduler")\n')
  }
  const locations = (paths: string[]) => paths.map(path => relative(workspace, path))
  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({ hoistedLocations: {
    '@fixture/tools@file:packages/tools(peer@1)': locations([root, duplicate]),
    '@fixture/tools@file:packages/tools(peer@2)': locations([differentPeers]),
    'external@1.0.0(@fixture/tools@file:packages/tools)': locations([external, externalCopy]),
  } }))

  await deduplicateStagedWorkspacePackages(staging, workspace)

  expect(existsSync(duplicate)).toBe(false)
  for (const directory of [root, differentPeers, external, externalCopy]) {
    expect(existsSync(join(directory, 'index.js'))).toBe(true)
  }
  const fromRoot = createRequire(join(staging, 'entry.cjs'))
  const fromApp = createRequire(join(modules, 'app', 'entry.cjs'))
  const fromOther = createRequire(join(modules, 'other', 'entry.cjs'))
  expect(fromApp('@fixture/tools')).toBe(fromRoot('@fixture/tools'))
  expect(fromOther('@fixture/tools')).not.toBe(fromRoot('@fixture/tools'))
})

it('rejects invalid deployment metadata before removing any package', async () => {
  const workspace = await fixture('dsh-python-staging-metadata-')
  const staging = join(workspace, 'payload')
  const modules = join(staging, 'node_modules')
  const root = join(modules, 'tools')
  const duplicate = join(modules, 'app', 'node_modules', 'tools')
  const outside = join(workspace, 'source')
  for (const directory of [root, duplicate, outside]) await mkdir(directory, { recursive: true })
  const valid = { 'tools@file:packages/tools': [root, duplicate].map(path => relative(workspace, path)) }
  for (const invalid of [
    {},
    { hoistedLocations: { invalid: [42] } },
    { hoistedLocations: { ...valid, 'other@file:packages/other': [relative(workspace, outside)] } },
  ]) {
    await writeFile(join(modules, '.modules.yaml'), JSON.stringify(invalid))
    await expect(deduplicateStagedWorkspacePackages(staging, workspace)).rejects.toThrow('hoistedLocations')
    expect(existsSync(duplicate)).toBe(true)
    expect(existsSync(outside)).toBe(true)
  }
})

it('leaves a deployment with no build approvals unchanged', async () => {
  const workspace = await fixture('dsh-python-staging-no-build-approvals-')
  const content = 'packages: [.]\n'
  const file = join(workspace, 'pnpm-workspace.yaml')
  await writeFile(file, content)
  await relocateStagedBuildApprovals(workspace, workspace)
  expect(await readFile(file, 'utf8')).toBe(content)
})

it('rejects conflicting exact build selectors before replacing deployment settings', async () => {
  const workspace = await fixture('dsh-python-staging-build-conflict-')
  const source = join(workspace, 'source')
  await mkdir(source)
  const content = JSON.stringify({ allowBuilds: {
    'fixture@file:source': true,
    [`fixture@${pathToFileURL(source).href}`]: false,
  } })
  const file = join(workspace, 'pnpm-workspace.yaml')
  await writeFile(file, content)
  await expect(relocateStagedBuildApprovals(workspace, workspace)).rejects.toThrow('conflicting build approvals')
  expect(await readFile(file, 'utf8')).toBe(content)
})

it('preserves absolute build selectors and non-file decisions', async () => {
  const workspace = await fixture('dsh-python-staging-absolute-approvals-')
  const approvals = {
    'fixture@file:/unchanged/source': true,
    'windows@file:C:\\unchanged\\source': false,
    'url@file:///unchanged/source': true,
    'registry@1.0.0': false,
    annotation: 'reviewed separately',
  }
  const file = join(workspace, 'pnpm-workspace.yaml')
  await writeFile(file, JSON.stringify({ allowBuilds: approvals }))
  await relocateStagedBuildApprovals(workspace, workspace)
  expect(load(await readFile(file, 'utf8'))).toEqual({ allowBuilds: approvals })
})

it.each(['source(peer@1)', 'source#revision'])('refuses qualified file selectors before changing decisions: %s', async (path) => {
  const workspace = await fixture('dsh-python-staging-qualified-approvals-')
  const content = JSON.stringify({ allowBuilds: { [`fixture@file:${path}`]: true } })
  const file = join(workspace, 'pnpm-workspace.yaml')
  await writeFile(file, content)
  await expect(relocateStagedBuildApprovals(workspace, workspace)).rejects.toThrow('qualified file build selectors')
  expect(await readFile(file, 'utf8')).toBe(content)
})

it.each([null, [], { allowBuilds: null }, { allowBuilds: [] }, { allowBuilds: { fixture: 1 } }])('refuses malformed deployment approvals: %j', async (value) => {
  const workspace = await fixture('dsh-python-staging-invalid-build-approvals-')
  const content = JSON.stringify(value)
  const file = join(workspace, 'pnpm-workspace.yaml')
  await writeFile(file, content)
  await expect(relocateStagedBuildApprovals(workspace, workspace)).rejects.toThrow('pnpm-workspace.yaml')
  expect(await readFile(file, 'utf8')).toBe(content)
})

it.each([{}, { ignoredBuilds: [] }])('accepts pnpm metadata with no unapproved dependency builds: %j', async (value) => {
  const workspace = await fixture('dsh-python-staging-approved-builds-')
  await mkdir(join(workspace, 'node_modules'))
  await writeFile(join(workspace, 'node_modules', '.modules.yaml'), JSON.stringify(value))
  await expect(assertStagedBuildsApproved(workspace)).resolves.toBeUndefined()
})

it.each([null, [], { ignoredBuilds: null }, { ignoredBuilds: 'fixture' }, { ignoredBuilds: [1] }, { ignoredBuilds: [''] }])('rejects malformed dependency build metadata: %j', async (value) => {
  const workspace = await fixture('dsh-python-staging-invalid-builds-')
  await mkdir(join(workspace, 'node_modules'))
  await writeFile(join(workspace, 'node_modules', '.modules.yaml'), JSON.stringify(value))
  await expect(assertStagedBuildsApproved(workspace)).rejects.toThrow('.modules.yaml')
})

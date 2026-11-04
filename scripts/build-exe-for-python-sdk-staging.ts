/** Prepare a symlink-free executable runtime payload with shared workspace module instances. */
import { cp, lstat, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'

/**
 * Retain exact workspace build approvals after shared-lock deploy canonicalizes file dependency identities.
 * Only exact relative directory selectors change; absolute selectors remain as declared.
 * Missing approvals remain absent; conflicting or qualified selectors reject before writing.
 * @param staging - Shared-lock deployment whose scripts have not run.
 * @param workspace - Source workspace against which relative file selectors were declared.
 * @returns After the deployed approvals refer to the same source packages by canonical file URL.
 */
export async function relocateStagedBuildApprovals(staging: string, workspace: string): Promise<void> {
  const file = join(staging, 'pnpm-workspace.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${file}: deployment workspace settings must be a mapping`)
  }
  if (!('allowBuilds' in manifest)) return
  const approvals = manifest.allowBuilds
  if (typeof approvals !== 'object' || approvals === null || Array.isArray(approvals)) {
    throw new Error(`${file}: allowBuilds must be a mapping`)
  }
  const relocated: Record<string, boolean | string> = {}
  for (const [selector, decision] of Object.entries(approvals)) {
    if (typeof decision !== 'boolean' && typeof decision !== 'string') throw new Error(`${file}: invalid build approval decision`)
    const marker = selector.indexOf('@file:')
    const path = marker < 0 ? undefined : selector.slice(marker + 6)
    if (path !== undefined && /[()#]/u.test(path)) throw new Error(`${file}: qualified file build selectors are unsupported`)
    const key = path === undefined || isAbsolute(path) || win32.isAbsolute(path) ? selector
      : `${selector.slice(0, marker + 1)}${pathToFileURL(await realpath(resolve(workspace, path))).href}`
    if (Object.hasOwn(relocated, key) && relocated[key] !== decision) throw new Error(`${file}: conflicting build approvals for ${key}`)
    relocated[key] = decision
  }
  await writeFile(file, dump({ ...manifest, allowBuilds: relocated }))
}

/**
 * Reject scripts pnpm skipped for lack of an approval; explicitly denied scripts are not in this list.
 * pnpm omits `ignoredBuilds` when none remain. Malformed metadata rejects instead of accepting an unknown build state.
 * @param staging - Deployed payload after pnpm rebuild has settled.
 * @returns After pnpm reports no unapproved dependency builds.
 */
export async function assertStagedBuildsApproved(staging: string): Promise<void> {
  const file = join(staging, 'node_modules', '.modules.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${file}: dependency build metadata must be a mapping`)
  }
  if (!('ignoredBuilds' in manifest)) return
  const ignored = manifest.ignoredBuilds
  if (!Array.isArray(ignored) || ignored.some(value => typeof value !== 'string' || value === '')) {
    throw new Error(`${file}: ignoredBuilds must list unapproved dependency identities`)
  }
  if (ignored.length > 0) throw new Error(`${file}: unapproved dependency build scripts: ${ignored.join(', ')}`)
}

function isHoistedLocations(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(paths => Array.isArray(paths)
      && paths.every((path: unknown) => typeof path === 'string'))
}

/**
 * Share root workspace packages with nested consumers of the same pnpm dependency identity.
 * Different peer resolutions and third-party packages keep their installed locations.
 * All metadata paths are checked before deletion; the caller first materializes links.
 * @param staging - Symlink-free deployed payload root.
 * @param workspace - Directory relative to which pnpm records hoisted locations; shared-lock deployment uses the payload root.
 */
export async function deduplicateStagedWorkspacePackages(staging: string, workspace: string): Promise<void> {
  const modules = resolve(staging, 'node_modules')
  const file = join(modules, '.modules.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('hoistedLocations' in manifest)
    || !isHoistedLocations(manifest.hoistedLocations)) {
    throw new Error(`${file}: hoistedLocations must map dependency identities to path lists`)
  }
  const duplicates: string[] = []
  for (const [identity, locations] of Object.entries(manifest.hoistedLocations)) {
    const paths = locations.map((location) => {
      const path = resolve(workspace, location)
      const local = relative(modules, path)
      if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error(`${file}: hoistedLocations path is outside deployed node_modules: ${location}`)
      }
      return { path, parts: local.split(sep) }
    })
    if (!/^(?:@[^/]+\/)?[^@()]+@file:/.test(identity)) continue
    const root = paths.find(({ parts }) => parts.length === (parts[0]?.startsWith('@') === true ? 2 : 1))
    if (root === undefined) continue
    if (!(await lstat(root.path)).isDirectory()) {
      throw new Error(`${file}: hoistedLocations root package is not a directory: ${root.path}`)
    }
    duplicates.push(...paths.filter(({ path }) => path !== root.path).map(({ path }) => path))
  }
  for (const path of duplicates) await rm(path, { recursive: true, force: true })
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every deploy-time package link below the staged payload with real files.
 *
 * Legacy deploy links workspace packages into the target's `node_modules`, and
 * those links must survive packaging as files. One link is not a package: when
 * the deploy target sits inside the deployed project, pnpm links that project
 * into its own `node_modules`. Dereferencing it would copy the payload into
 * itself, and the packaged payload never carries the project source, so the
 * entry is dropped instead.
 * @param staging - Deployed payload root whose `node_modules` becomes symlink-free.
 */
export async function materializeStagedLinks(staging: string): Promise<void> {
  const payload = await realpath(staging)
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      const directory = join(nodeModules, ...segments.slice(0, binIndex + 1))
      if ((await lstat(directory)).isSymbolicLink()) await unlink(directory)
      else await rm(directory, { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    if (payload === source || payload.startsWith(source + sep)) {
      await unlink(destination)
      remaining = await findSymlink(nodeModules)
      continue
    }
    const nestedNodeModules = join(source, 'node_modules')
    await unlink(destination)
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

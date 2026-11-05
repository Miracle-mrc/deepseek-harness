/** Read-only capture of a portable profile and local plugin sources, without evaluating configuration or running packages. */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import semver from 'semver'
import { resolveBundleDir, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { SourceExportFile, SourceExportIssueCode, SourceExportRequest, SourceExportResult } from './types.ts'

// These admission bounds cap one response's retained source content and filesystem work.
const MAX_FILES = 2000
const MAX_SOURCE_READS = MAX_FILES * 2
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const EXPORT_GITIGNORE = '/*\n!/.gitignore\n!/bundles/\n!/profiles/\n/profiles/*\n!/profiles/saved/\n/profiles/saved/*\n!/profiles/saved/package.json\n!/profiles/saved/cordis.patch.yml\n!/profiles/saved/pnpm-workspace.yaml\n**/node_modules/\n**/.env*\n**/.credentials*\n'
const EXPORT_PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const OMITTED = /^(?:node_modules|\.git|\.svn|\.hg|coverage|\.cache|\.plugin-manager|test|tests|__tests__)$/i
const PRIVATE_FILE = new RegExp(
  String.raw`^(?:\..*|credentials?(?:\..*)?|pnpm-workspace\.yaml|`
  + String.raw`.*\.(?:pem|key|p12|pfx|keystore)|(?:package-lock|pnpm-lock|yarn)\.(?:json|yaml|lock))$`,
  'i',
)
const TEXT_FILE = /(?:\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|less|svg|html|md|txt|map)|^(?:LICENSE|NOTICE|COPYING))$/i
const SECRET_TEXT = new RegExp(
  String.raw`(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{12,}|`
  + String.raw`github_pat_[a-z0-9_]{12,}|glpat-[a-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b|\bBearer\s+[a-z0-9_.+\/-]{8,})`,
  'i',
)
const LITERAL_ASSIGNMENT = new RegExp(
  /(?<![a-z0-9_.$-])([a-z_$][a-z0-9_.$-]*)(?:["'`](?:\s*\])?)?\s*/.source
  + /(?::\s*[a-z_$][a-z0-9_$.<>[\]|,?]*(?:[ \t]+[a-z_$|][a-z0-9_$.<>[\]|,?]*)*\s*)?/.source
  + /[:=]\s*(?<quote>["'`])([^"'`\r\n]+)\k<quote>/.source,
  'giu',
)
const URI_PREFIX = /(?<![a-z0-9+.-])(?:(?:https?|ftp|wss?):[\\/]*|(?:[a-z][a-z0-9+.-]*:)?\/\/)/.source
const URI_TEXT = new RegExp(URI_PREFIX + /[^\s"'`<>]+/.source, 'giu')
const URI_USER_INFO = new RegExp(URI_PREFIX + /[^\s"'`<>\\/?#]+@/.source, 'iu')
// Unnamed URL credentials may still be recognizable as long opaque tokens, including JWTs and hex keys.
const OPAQUE_QUERY_VALUE = /^(?=.{40,}$)(?=.*[a-z])(?=.*[0-9])[a-z0-9._~+/-]+=*$/iu
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

class ExportRefusal extends Error {
  constructor(readonly code: SourceExportIssueCode, readonly path?: string) {
    super(code)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refuse(code: SourceExportIssueCode, path?: string): never { throw new ExportRefusal(code, path) }

function portablePath(path: string): boolean {
  return path !== '' && !/[\\\u0000-\u001f\u007f-\u009f<>:"|?*]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[. ]$/u.test(part) && !WINDOWS_DEVICE.test(part))
}

function repository(value: string): string | undefined {
  const text = value.trim()
  return /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(text) ? text : undefined
}

function branch(value: string): string | undefined {
  const text = value.trim()
  return text !== '' && !/^(?:master|main)$/i.test(text) && text !== '@' && !/^[-/]|^refs\//u.test(text)
    && !/[/.]$/u.test(text) && !/[\p{Cc}\p{Z}\uFEFF~^:?*\[\\]/u.test(text)
    && !text.includes('//') && !text.includes('..') && !text.includes('@{')
    && text.split('/').every(part => !part.startsWith('.') && !part.toLowerCase().endsWith('.lock')) ? text : undefined
}

function sensitiveName(name: string, query = false): boolean {
  const normalized = name.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return /(?:password|passwd|pwd|secret|token|apikey|accesskey|privatekey|authorization|cookie|credentials?|signature)$/u.test(normalized)
    || (query && /^(?:access|auth|key|sig|sas|session|sessionid)$/u.test(normalized))
}

function* parsedUrls(value: string): Generator<URL, void> {
  for (const match of value.matchAll(URI_TEXT)) {
    const uri = match[0]
    const absolute = uri.startsWith('//') ? `https:${uri}` : uri
    if (URL.canParse(absolute)) yield new URL(absolute)
  }
}

function suspectedUserInfo(value: string): boolean {
  for (const url of parsedUrls(value)) {
    if (url.username !== '' || url.password !== '') return true
  }
  return URI_USER_INFO.test(value)
}

function suspectedParameters(parameters: URLSearchParams): boolean {
  for (const [name, item] of parameters) {
    if (item !== '' && (sensitiveName(name, true) || SECRET_TEXT.test(item)
      || suspectedUserInfo(item) || OPAQUE_QUERY_VALUE.test(item))) return true
  }
  return false
}

function suspectedText(value: string): boolean {
  if (SECRET_TEXT.test(value)) return true
  for (const match of value.matchAll(LITERAL_ASSIGNMENT)) {
    if (sensitiveName(match[1] as string)) return true
  }
  for (const url of parsedUrls(value)) {
    if (url.username !== '' || url.password !== '') return true
    const fragment = url.hash.slice(1)
    if (suspectedParameters(url.searchParams) || suspectedParameters(new URLSearchParams(fragment))) return true
    const queryStart = fragment.indexOf('?')
    if (queryStart !== -1 && suspectedParameters(new URLSearchParams(fragment.slice(queryStart + 1)))) return true
  }
  // Malformed hosts and surrounding source text must not conceal user information that parsing cannot expose.
  return URI_USER_INFO.test(value)
}

function inspectSecrets(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (suspectedText(value)) refuse('secret-suspected', path)
    return
  }
  if (Array.isArray(value)) { value.forEach((item) => { inspectSecrets(item, path) }); return }
  if (!record(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (suspectedText(key)) refuse('secret-suspected', path)
    const reference = record(item) && Object.keys(item).length === 1 && typeof item.__jsExpr === 'string'
      && /^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/u.test(item.__jsExpr.trim())
    if (sensitiveName(key) && item !== undefined && item !== null && item !== '' && !reference) refuse('secret-suspected', path)
    inspectSecrets(item, path)
  }
}

function parseJson(content: string, path: string): unknown {
  try { return JSON.parse(content) }
  catch (_error) { refuse('unsupported-source', path) }
}

function parseManifest(content: string, path: string): Record<string, unknown> {
  const value = parseJson(content, path)
  if (!record(value)) refuse('unsupported-source', path)
  return value
}

function inspectYaml(content: string, path: string, patch: boolean): unknown {
  // !!js remains an inert marker; neither Loader interpolation nor plugin imports run during capture.
  const document = parseDocument(content, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (text: string) => ({ __jsExpr: text }) }],
  })
  if (document.errors.length > 0) refuse('unsupported-source', path)
  let value: unknown
  try { value = document.toJS({ maxAliasCount: 100 }) }
  catch (_error) { refuse('unsupported-source', path) }
  if (patch && !Array.isArray(value)) refuse('unsupported-source', path)
  inspectSecrets(value, path)
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!record(node)) return
    if (node.name === 'cordis:include' || node.name === '@deepseek-ai/cordis-plugin-include' || node.name === 'include') {
      refuse('unsupported-source', path)
    }
    // Profile-local modules have no package root to capture; package-local modules must stay in that package.
    if (typeof node.name === 'string' && (node.name.startsWith('.') || isAbsolute(node.name) || /^file:/i.test(node.name))) {
      if (path.startsWith('profiles/') || !node.name.startsWith('./') || !portablePath(node.name.slice(2))) refuse('unsafe-path', path)
    }
    if (typeof node.path === 'string' && (isAbsolute(node.path) || node.path.split(/[\\/]/u).includes('..'))) refuse('unsafe-path', path)
    Object.values(node).forEach(visit)
  }
  if (patch) visit(value)
  return value
}

interface Captured {
  readonly filename: string
  readonly content: string
  readonly path: string
  readonly root?: string
}

async function checkSourcePath(filename: string, root: string | undefined, path: string): Promise<void> {
  if (root === undefined) return
  const location = await realpath(filename)
  const inside = relative(root, location)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) refuse('unsafe-path', path)
  let parent = dirname(filename)
  for (;;) {
    if ((await lstat(parent)).isSymbolicLink()) refuse('unsafe-path', path)
    if (parent === root) return
    parent = dirname(parent)
  }
}

async function readBounded(handle: FileHandle, path: string): Promise<string> {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
  let length = 0
  while (length < bytes.byteLength) {
    const chunk = await handle.read(bytes, length, bytes.byteLength - length)
    if (chunk.bytesRead === 0) break
    length += chunk.bytesRead
  }
  if (length > MAX_FILE_BYTES) refuse('too-large', path)
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) }
  catch (_error) { refuse('unsupported-source', path) }
}

class Capture {
  readonly files: SourceExportFile[] = []
  readonly observed: Captured[] = []
  readonly directories = new Map<string, string>()
  readonly paths = new Map<string, string>()
  private bytes = 0
  private retainedBytes = 0
  entries = 0

  constructor(private readonly outputBytes: number) {}

  add(path: string, content: string): void {
    if (suspectedText(path)) refuse('secret-suspected')
    const parts = path.split('/')
    for (let length = 1; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('/')
      const key = prefix.normalize('NFC').toLowerCase()
      const existing = this.paths.get(key)
      if (existing !== undefined && existing !== prefix) refuse('unsafe-path', path)
      this.paths.set(key, prefix)
    }
    // Includes JSON escaping, file paths, and an array delimiter; envelope bytes are reserved by the caller.
    this.bytes += Buffer.byteLength(JSON.stringify({ path, content })) + 1
    if (this.files.length >= MAX_FILES || this.bytes > this.outputBytes) refuse('too-large', path)
    this.files.push({ path, content })
  }

  async read(filename: string, path: string, root?: string): Promise<string> {
    let handle: FileHandle | undefined
    try {
      if (this.observed.length >= MAX_SOURCE_READS) refuse('too-large', path)
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink()) refuse('unsafe-path', path)
      if (info.size > MAX_FILE_BYTES) refuse('too-large', path)
      await checkSourcePath(filename, root, path)
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = await handle.stat()
      if (!opened.isFile()) refuse('unsafe-path', path)
      if (opened.dev !== info.dev || opened.ino !== info.ino) refuse('source-changed', path)
      await checkSourcePath(filename, root, path)
      const content = await readBounded(handle, path)
      this.retainedBytes += Buffer.byteLength(content)
      if (this.retainedBytes > MAX_TOTAL_BYTES) refuse('too-large', path)
      if (content.includes('\0')) refuse('unsupported-source', path)
      if (suspectedText(content)) refuse('secret-suspected', path)
      if (/\.json$/i.test(path)) inspectSecrets(parseJson(content, path), path)
      if (/\.ya?ml$/i.test(path)) inspectYaml(content, path, /(?:^|\/)cordis(?:\.patch)?\.ya?ml$/i.test(path))
      this.observed.push({ filename, content, path, ...root === undefined ? {} : { root } })
      return content
    } catch (error) {
      if (error instanceof ExportRefusal) throw error
      throw new ExportRefusal('source-unavailable', path)
    } finally { await handle?.close() }
  }

  async verify(): Promise<void> {
    for (const file of this.observed) {
      let content: string
      try {
        const info = await lstat(file.filename)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) refuse('source-changed', file.path)
        await checkSourcePath(file.filename, file.root, file.path)
        const handle = await open(file.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (opened.dev !== info.dev || opened.ino !== info.ino) refuse('source-changed', file.path)
          await checkSourcePath(file.filename, file.root, file.path)
          content = await readBounded(handle, file.path)
        } finally { await handle.close() }
      } catch (_error) { refuse('source-changed', file.path) }
      if (content !== file.content) refuse('source-changed', file.path)
    }
    for (const [filename, listing] of this.directories) {
      let names: string[]
      try { names = await readdir(filename) }
      catch (_error) { refuse('source-changed') }
      if (JSON.stringify(names.sort()) !== listing) refuse('source-changed')
    }
  }
}

function dependencies(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {}
  if (!record(value)) refuse('unsupported-source', path)
  const result: Record<string, string> = {}
  for (const [name, spec] of Object.entries(value)) {
    if (!PACKAGE_NAME.test(name) || typeof spec !== 'string') refuse('unsupported-source', path)
    result[name] = spec
  }
  return result
}

function portableSpec(spec: string): boolean {
  return semver.validRange(spec) !== null && !/[\r\n]/u.test(spec)
}

function validatePackageFiles(capture: Capture, prefix: string): void {
  const manifestPath = `${prefix}/package.json`
  const captured = capture.files.find(file => file.path === manifestPath)
  if (captured === undefined) refuse('source-unavailable', manifestPath)
  const manifest = parseManifest(captured.content, manifestPath)
  const targetFiles = (value: unknown): SourceExportFile[] => {
    if (typeof value !== 'string') refuse('unsupported-source', manifestPath)
    const path = value.replace(/^\.\//u, '')
    if (!portablePath(path.replace(/\*/gu, 'x')) || isAbsolute(value) || path.includes('**')) refuse('unsafe-path', manifestPath)
    const pattern = new RegExp(`^${path.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u')
    const files = capture.files.filter(file => file.path.startsWith(`${prefix}/`) && pattern.test(file.path.slice(prefix.length + 1)))
    if (files.length === 0) refuse('source-unavailable', manifestPath)
    return files
  }
  const exports = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.startsWith('./')) refuse('unsafe-path', manifestPath)
      targetFiles(value)
    } else if (Array.isArray(value)) value.forEach(exports)
    else if (record(value)) Object.values(value).forEach(exports)
    else if (value !== null) refuse('unsupported-source', manifestPath)
  }
  for (const field of ['main', 'module', 'types', 'typings', 'icon']) {
    if (manifest[field] !== undefined) targetFiles(manifest[field])
  }
  if (manifest.exports !== undefined) exports(manifest.exports)
  const bundle = record(manifest.dsh) ? manifest.dsh.bundle : undefined
  if (record(bundle)) {
    const patches = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
    if (!Array.isArray(patches)) refuse('unsupported-source', manifestPath)
    for (const value of patches) {
      if (typeof value !== 'string' || value.includes('*')) refuse('unsafe-path', manifestPath)
      for (const file of targetFiles(value)) {
        const rows = inspectYaml(file.content, file.path, true)
        const modules = (node: unknown): void => {
          if (Array.isArray(node)) { node.forEach(modules); return }
          if (!record(node)) return
          if (typeof node.name === 'string' && node.name.startsWith('./')) {
            const path = posix.join(posix.dirname(file.path), node.name.slice(2))
            if (!capture.files.some(candidate => candidate.path === path)) refuse('source-unavailable', path)
          }
          Object.values(node).forEach(modules)
        }
        modules(rows)
      }
    }
  }
}

async function copyPackage(capture: Capture, root: string, prefix: string): Promise<void> {
  const canonical = await realpath(root).catch(() => refuse('source-unavailable', `${prefix}/package.json`))
  const visit = async (directory: string, suffix: string): Promise<void> => {
    let children
    try { children = await readdir(directory, { withFileTypes: true }) }
    catch (_error) { refuse('source-unavailable', prefix) }
    capture.directories.set(directory, JSON.stringify(children.map(child => child.name).sort()))
    for (const child of children.sort((left, right) => left.name < right.name ? -1 : 1)) {
      capture.entries += 1
      if (capture.entries > MAX_FILES * 5) refuse('too-large', prefix)
      if (OMITTED.test(child.name) || PRIVATE_FILE.test(child.name)) continue
      const file = join(directory, child.name)
      const path = `${prefix}/${suffix}${child.name}`
      if (!portablePath(path) || child.isSymbolicLink()) refuse('unsafe-path', path)
      const inside = relative(canonical, await realpath(file).catch(() => refuse('source-unavailable', path)))
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) refuse('unsafe-path', path)
      if (child.isDirectory()) await visit(file, `${suffix}${child.name}/`)
      else if (child.isFile()) {
        if (!TEXT_FILE.test(child.name)) refuse('unsupported-source', path)
        const content = await capture.read(file, path, canonical)
        if (child.name === 'package.json') {
          const manifest = parseManifest(content, path)
          for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
            if (Object.values(dependencies(manifest[section], path)).some(spec => !portableSpec(spec))) refuse('unsupported-source', path)
          }
        }
        capture.add(path, content)
      } else refuse('unsupported-source', path)
    }
  }
  await visit(canonical, '')
  capture.add(`${prefix}/pnpm-workspace.yaml`, EXPORT_PNPM_WORKSPACE)
  validatePackageFiles(capture, prefix)
}

/**
 * Capture profile files and local dependency source without filesystem mutations, network, imports, or subprocesses.
 * The returned text requires manual review before publication; refusals contain no captured content or secret excerpts.
 * @param profile Launcher-owned current profile locations; only its own patch and manifest are captured.
 * @param request Repository slug and a branch other than main or master, recorded as metadata without contacting either.
 * @returns A bounded UTF-8 file map, or one typed refusal without any source content.
 */
export async function exportProfileSource(profile: ProfileContext, request: SourceExportRequest): Promise<SourceExportResult> {
  const targetRepository = repository(request.repository)
  if (targetRepository === undefined) return { status: 'blocked', issues: [{ code: 'invalid-repository' }] }
  const targetBranch = branch(request.branch)
  if (targetBranch === undefined) return { status: 'blocked', issues: [{ code: 'invalid-branch' }] }
  try {
    if ([targetRepository, targetBranch, profile.name].some(suspectedText)) refuse('secret-suspected')
    const envelope = { status: 'ready' as const, formatVersion: 1 as const, repository: targetRepository,
      branch: targetBranch, profile: profile.name, files: [], reviewRequired: true as const }
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope))
    if (envelopeBytes >= MAX_TOTAL_BYTES) refuse('too-large')
    const capture = new Capture(MAX_TOTAL_BYTES - envelopeBytes)
    const manifestPath = 'profiles/saved/package.json'
    const manifest = parseManifest(await capture.read(join(profile.dir, 'package.json'), manifestPath), manifestPath)
    const dsh = manifest.dsh
    const declaration = record(dsh) ? dsh.profile : undefined
    const bundles = record(declaration) ? declaration.bundles : undefined
    if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string' && PACKAGE_NAME.test(name))) refuse('profile-unavailable')
    const saved: Record<string, string> = {}
    let localIndex = 0
    for (const [name, spec] of Object.entries(dependencies(manifest.dependencies, manifestPath))) {
      const local = /^(?:file|link):(.+)$/u.exec(spec)
      if (local !== null) {
        const root = resolve(profile.dir, local[1] as string)
        // A local dependency must be a package directory, not an archive or an arbitrary filesystem root.
        const prefix = `bundles/${localIndex++}`
        await copyPackage(capture, root, prefix)
        saved[name] = `link:../../${prefix}`
      } else {
        if (!portableSpec(spec)) refuse('unsupported-source', manifestPath)
        const root = resolveBundleDir('dsh', name, profile.installAnchor, profile.dir)
        const installedPath = `dependencies/${name}/package.json`
        const installed = parseManifest(await capture.read(join(root, 'package.json'), installedPath), installedPath)
        if (typeof installed.version !== 'string' || semver.valid(installed.version) === null) refuse('unsupported-source', manifestPath)
        saved[name] = installed.version
      }
    }
    capture.add(manifestPath, `${JSON.stringify({ name: 'dsh-profile-saved', private: true, type: 'module', dependencies: saved, dsh: { profile: { bundles } } }, undefined, 2)}\n`)
    const patchPath = 'profiles/saved/cordis.patch.yml'
    try { await lstat(profile.patchPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      refuse('source-unavailable', patchPath)
    }
    const patch = await capture.read(profile.patchPath, patchPath)
    inspectYaml(patch, patchPath, true)
    capture.add(patchPath, patch)
    capture.add('profiles/saved/pnpm-workspace.yaml', EXPORT_PNPM_WORKSPACE)
    capture.add('.gitignore', EXPORT_GITIGNORE)
    await capture.verify()
    return { ...envelope, files: capture.files }
  } catch (error) {
    if (error instanceof ExportRefusal) {
      const path = error.path
      const issue = path === undefined || suspectedText(path) ? { code: error.code } : { code: error.code, path }
      return { status: 'blocked', issues: [issue] }
    }
    return { status: 'blocked', issues: [{ code: 'profile-unavailable' }] }
  }
}

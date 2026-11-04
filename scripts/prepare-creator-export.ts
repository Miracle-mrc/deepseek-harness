/** Validate a reviewed Creator download and extract its sources without executing them. */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_FILES = 2_000
const MAX_FILE_BYTES = 1_048_576
const MAX_TOTAL_BYTES = 10 * MAX_FILE_BYTES
const MAX_DOWNLOAD_BYTES = 64 * MAX_FILE_BYTES
const PROFILE_FILES = ['profiles/saved/package.json', 'profiles/saved/cordis.patch.yml', 'profiles/saved/pnpm-workspace.yaml']
const PROFILE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const SOURCE_IGNORE = '/*\n!/.gitignore\n!/bundles/\n!/profiles/\n/profiles/*\n!/profiles/saved/\n/profiles/saved/*\n!/profiles/saved/package.json\n!/profiles/saved/cordis.patch.yml\n!/profiles/saved/pnpm-workspace.yaml\n**/node_modules/\n**/.env*\n**/.credentials*\n'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i

/** A text file carried by the reviewed download. */
export interface CreatorExportFile {
  readonly path: string
  readonly content: string
}

/** Validation or extraction failure; an existing destination is never removed. */
export class CreatorExportPreparationError extends Error {
  readonly code: 'invalid-export' | 'unsafe-path' | 'destination-unavailable' | 'extraction-failed' | 'cleanup-failed'

  /**
   * @param code - stable failure identity.
   * @param message - affected input and safe next action.
   * @param options - original failure when filesystem work fails.
   */
  constructor(code: CreatorExportPreparationError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CreatorExportPreparationError'
    this.code = code
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new CreatorExportPreparationError('invalid-export', `${message}. Download a fresh reviewed source export.`)
}

function unsafe(path: string): never {
  throw new CreatorExportPreparationError('unsafe-path', `Unsafe export path ${JSON.stringify(path)}. Download a fresh reviewed source export.`)
}

function validRepository(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)
}

function validBranch(value: string): boolean {
  return value !== '' && !['main', 'master', '@'].includes(value.toLowerCase()) && !value.startsWith('-') && !value.startsWith('refs/')
    && !value.endsWith('/') && !value.endsWith('.') && !value.includes('//') && !value.includes('..') && !value.includes('@{')
    && !/[\s~^:?*\[\\]/u.test(value) && !CONTROL_CHARACTERS.test(value)
    && value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.toLowerCase().endsWith('.lock'))
}

function validateFiles(archive: unknown): CreatorExportFile[] {
  if (!record(archive) || archive.status !== 'ready' || archive.formatVersion !== 1 || archive.reviewRequired !== true) {
    invalid('The download is not a supported ready source export')
  }
  if (typeof archive.repository !== 'string' || !validRepository(archive.repository)) invalid('The export repository is invalid')
  if (typeof archive.branch !== 'string' || !validBranch(archive.branch)) invalid('The export branch must name a branch other than main or master')
  if (typeof archive.profile !== 'string' || archive.profile.trim() === '' || CONTROL_CHARACTERS.test(archive.profile)) invalid('The source profile is invalid')
  if (!Array.isArray(archive.files) || archive.files.length < 4 || archive.files.length > MAX_FILES) invalid('The export file count is invalid')

  const files: CreatorExportFile[] = []
  const paths = new Set<string>()
  const directories = new Map<string, string>()
  const bundles = new Set<string>()
  let total = 0
  for (const file of archive.files) {
    if (!record(file) || typeof file.path !== 'string' || typeof file.content !== 'string') invalid('An export file is invalid')
    const path = file.path
    const parts = path.split('/')
    if (/[\\:<>"|?*]/u.test(path) || CONTROL_CHARACTERS.test(path)
      || parts.some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part) || RESERVED_WINDOWS_NAME.test(part))
      || (path !== '.gitignore' && !PROFILE_FILES.includes(path) && !/^bundles\/(?:0|[1-9][0-9]*)\/.+$/u.test(path))) unsafe(path)
    const folded = path.normalize('NFC').toLowerCase()
    if (paths.has(folded)) unsafe(path)
    paths.add(folded)
    if (parts[0] === 'bundles') bundles.add(parts.slice(0, 2).join('/'))
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/')
      const key = directory.normalize('NFC').toLowerCase()
      const previous = directories.get(key)
      if (previous !== undefined && previous !== directory) unsafe(path)
      directories.set(key, directory)
    }
    const bytes = Buffer.byteLength(file.content, 'utf8')
    total += bytes
    if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) invalid('The export exceeds the source size limits')
    files.push({ path, content: file.content })
  }
  for (const path of directories.keys()) if (paths.has(path)) unsafe(path)
  for (const path of PROFILE_FILES) if (!paths.has(path)) invalid(`The export is missing ${path}`)
  if (!files.some(file => file.path === 'profiles/saved/pnpm-workspace.yaml' && file.content === PROFILE_WORKSPACE)) {
    invalid('The export does not contain the isolated profile workspace settings')
  }
  for (const bundle of bundles) {
    if (!files.some(file => file.path === `${bundle}/pnpm-workspace.yaml` && file.content === PROFILE_WORKSPACE)) {
      invalid(`The export does not contain the isolated workspace settings for ${bundle}`)
    }
  }
  if (!files.some(file => file.path === '.gitignore' && file.content === SOURCE_IGNORE)) invalid('The export is missing its source-only .gitignore')
  return files
}

/**
 * Validate every file before creating a destination, then write only that new tree.
 * Files are created exclusively with owner-only POSIX modes; Windows inherits parent ACLs. A failed write removes
 * the new tree; cleanup failure identifies the incomplete destination for removal.
 * @param archive - parsed, untrusted downloaded JSON.
 * @param destination - nonexistent directory with an existing parent directory.
 * @returns absolute path of the prepared source tree.
 * @throws CreatorExportPreparationError for invalid input, unavailable destination, or failed extraction.
 */
export function prepareCreatorExport(archive: unknown, destination: string): string {
  const files = validateFiles(archive)
  const root = resolve(destination)
  try { mkdirSync(root, { mode: 0o700 }) } catch (error) {
    throw new CreatorExportPreparationError('destination-unavailable',
      `Cannot create ${JSON.stringify(root)}. Choose a destination that does not exist under an existing directory.`, { cause: error })
  }
  try {
    for (const file of files) {
      const path = join(root, ...file.path.split('/'))
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, file.content, { flag: 'wx', mode: 0o600 })
    }
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch (cleanupError) {
      throw new CreatorExportPreparationError('cleanup-failed',
        `The export is incomplete at ${JSON.stringify(root)}. Remove that new directory before retrying.`,
        { cause: new AggregateError([error, cleanupError], 'Writing and removing the new export directory failed') })
    }
    throw new CreatorExportPreparationError('extraction-failed',
      'Could not write the export; the new destination was removed. Check disk space and permissions before retrying.', { cause: error })
  }
  return root
}

/**
 * Read at most 64 MiB from a regular JSON file; a growing file is refused.
 * @param path - downloaded archive filename.
 * @returns parsed, untrusted JSON for {@link prepareCreatorExport} to validate.
 * @throws CreatorExportPreparationError for oversized, changing, or malformed downloads.
 */
export function readCreatorExport(path: string): unknown {
  const descriptor = openSync(path, 'r')
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES) invalid('The download is not a bounded JSON file')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.byteLength) {
      const count = readSync(descriptor, bytes, length, bytes.byteLength - length, null)
      if (count === 0) break
      length += count
    }
    if (length > stat.size) invalid('The download changed while it was being read')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) } catch (error) {
      throw new CreatorExportPreparationError('invalid-export', 'The download is not valid JSON. Download a fresh reviewed source export.', { cause: error })
    }
  } finally { closeSync(descriptor) }
}

if (import.meta.main) {
  try {
    const [archive, destination, extra] = process.argv.slice(2)
    if (archive === undefined || destination === undefined || extra !== undefined) {
      throw new Error('Usage: node scripts/prepare-creator-export.ts <download.json> <new-directory>')
    }
    const root = prepareCreatorExport(readCreatorExport(archive), destination)
    console.log(`Prepared reviewed sources in ${JSON.stringify(root)}.`)
  } catch (error) {
    console.error(`Creator export preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

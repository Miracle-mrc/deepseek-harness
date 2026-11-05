/** Reviewed GitHub writes through the publication service, with only the remote API simulated. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { boot, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import PluginManager from '../src/index.ts'
import { CreatorFork, type CreatorForkConfig } from '../src/creator-fork.ts'
import { ForkGithub, ForkGithubError } from '../src/fork-github.ts'
import type { ForkPreviewId } from '../src/fork-types.ts'

const parserHooks = vi.hoisted(() => ({ failText: undefined as string | undefined }))
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>()
  return { ...actual, parseDocument: (...args: Parameters<typeof actual.parseDocument>) => {
    if (parserHooks.failText !== undefined && args[0] === parserHooks.failText) throw new Error('private parser diagnostic')
    return actual.parseDocument(...args)
  } }
})

const UPSTREAM = 'deepseek-ai/deepseek-harness'
const REPOSITORY = 'person/harness-fork'
const BASE = 'a'.repeat(40)
const COMMIT = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)
const BASE_TREE = 'd'.repeat(40)
const TARGET = { repository: REPOSITORY, branch: 'creator/custom' }

interface GitEntry { path: string; type: string; mode: string; sha: string }
interface GitCommit { sha: string; tree: { sha: string }; message: string; parents: { sha: string }[] }
interface GithubRequest { method: string; path: string; body: Record<string, unknown> | undefined }

function blobId(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${String(content.byteLength)}\0`).update(content).digest('hex')
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Non-owner caller for direct publication authorization checks. */
    'creator-fork-test-guest': { readonly kind: 'creator-fork-test-guest' }
  }
}

function remoteContext(ctx: Context, principal: Principal): Context {
  const cancellation = new AbortController().signal
  const invocation: RemoteInvocation = {
    request: { namespace: 'creatorFork', method: 'publish', args: {} }, service: 'creatorFork', signal: cancellation,
    peer: { id: 'creator-test-peer' as PeerId, ctx, principal, signal: cancellation, interactions: 'none', dispose: async () => {} },
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation })
}

async function fixture(existing = false, options: { config?: CreatorForkConfig; loader?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'creator-fork-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'profiles', 'web')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  const profile: ProfileContext = { name: 'web', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'),
    cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const state = {
    user: { id: 7, login: 'person' }, owner: 7, ownerLogin: 'person', repositoryId: 2, upstreamId: 1,
    fork: true, sourceId: 1, writable: true, defaultBranch: 'main',
    masterHead: BASE, masterExists: true,
    head: existing ? BASE as string | null : null, pr: false, failPr: false, lostCommit: false, lostRef: false, lostPr: false,
    pullState: 'open' as 'open' | 'closed', pullNumber: 1,
    failCommit: null as ForkGithubError['code'] | null, failRef: null as ForkGithubError['code'] | null,
    malformedCommit: false, truncated: false, commitResponseSha: undefined as string | undefined,
    tree: [] as GitEntry[], requests: [] as GithubRequest[], trees: new Map<string, GitEntry[]>(), commits: new Map<string, GitCommit>(),
    blobs: new Map<string, Buffer>(),
    beforeRequest: undefined as ((request: GithubRequest, signal: AbortSignal) => Promise<void>) | undefined,
    overrideResponse: undefined as ((request: GithubRequest) => { value: unknown } | undefined) | undefined,
    message: '', parent: BASE,
  }
  function storeCommit(tree: string, message: string, parent: string): string {
    const sha = state.commits.size === 0 ? COMMIT : createHash('sha1').update(`${tree}:${message}:${parent}`).digest('hex')
    state.message = message
    state.parent = parent
    state.commits.set(sha, { sha, tree: { sha: tree }, message, parents: [{ sha: parent }] })
    return sha
  }
  function additions(tree: GitEntry[], files: { path: string; content: string }[]): string {
    const leaves = new Map(tree.map(entry => [entry.path, { ...entry }]))
    for (const file of files) {
      const content = Buffer.from(file.content)
      const sha = blobId(content)
      state.blobs.set(sha, content)
      leaves.set(file.path, { path: file.path, mode: '100644', type: 'blob', sha })
    }
    const entries = [...leaves.values()]
    const sha = createHash('sha1').update(JSON.stringify(entries)).digest('hex')
    state.trees.set(sha, entries)
    return sha
  }
  function pull() {
    return { number: state.pullNumber, html_url: `https://github.com/${REPOSITORY}/pull/${String(state.pullNumber)}`, state: state.pullState,
      head: { ref: TARGET.branch, sha: state.head, repo: { id: state.repositoryId } },
      base: { ref: 'master', repo: { id: state.repositoryId } } }
  }
  function finishMutation(body: Record<string, unknown> | undefined) {
    const variables = body?.variables as { input: {
      expectedHeadOid: string
      message: { headline: string }
      fileChanges: { additions: { path: string; contents: string }[] }
    } }
    if (variables.input.expectedHeadOid !== state.head) return { data: null, errors: [{ type: 'STALE_DATA', message: 'Expected head does not match' }] }
    const parent = state.head ?? BASE
    const baseTree = state.commits.get(parent)?.tree.sha ?? BASE_TREE
    const files = variables.input.fileChanges.additions.map(file => ({ path: file.path, content: Buffer.from(file.contents, 'base64').toString() }))
    const tree = additions(state.trees.get(baseTree) ?? state.tree, files)
    state.head = storeCommit(tree, variables.input.message.headline, parent)
    return { data: { createCommitOnBranch: { commit: { oid: state.head } } } }
  }
  const request = vi.spyOn(ForkGithub.prototype, 'request').mockImplementation(async (method, path, body, signal) => {
    state.requests.push({ method, path, body })
    await state.beforeRequest?.({ method, path, body }, signal)
    signal.throwIfAborted()
    const overridden = state.overrideResponse?.({ method, path, body })
    if (overridden !== undefined) return overridden.value
    const upstream = { id: state.upstreamId, full_name: UPSTREAM, default_branch: 'master', fork: false, owner: { id: 1, login: 'deepseek-ai' } }
    const repo = { id: state.repositoryId, full_name: REPOSITORY, default_branch: state.defaultBranch, fork: state.fork,
      owner: { id: state.owner, login: state.ownerLogin }, permissions: { push: state.writable },
      source: { id: state.sourceId, full_name: UPSTREAM }, parent: { id: 1, full_name: UPSTREAM } }
    if (path === 'user') return state.user
    if (path.startsWith('user/repos?')) return [repo]
    if (path === `repos/${UPSTREAM}`) return upstream
    if (path === `repos/${REPOSITORY}`) return repo
    if (path === `repos/${UPSTREAM}/branches/master`) return { commit: { sha: OTHER } }
    if (path === `repos/${REPOSITORY}/branches/master`) {
      if (!state.masterExists) throw new ForkGithubError('not-found')
      return { commit: { sha: state.masterHead } }
    }
    if (path.startsWith(`repos/${REPOSITORY}/git/ref/heads/`)) {
      if (state.head === null) throw new ForkGithubError('not-found')
      return { ref: `refs/heads/${TARGET.branch}`, object: { type: 'commit', sha: state.head } }
    }
    if (path.includes('/git/commits/') && method === 'GET') {
      const sha = path.split('/').at(-1) as string
      const commit = state.commits.get(sha) ?? { sha, tree: { sha: BASE_TREE }, message: 'Existing work', parents: [] }
      return { ...commit, sha: state.commitResponseSha ?? commit.sha }
    }
    if (path.includes('/git/trees/') && method === 'GET') {
      const sha = path.split('/git/trees/')[1]?.split('?')[0] as string
      return { sha, truncated: state.truncated, tree: state.trees.get(sha) ?? state.tree }
    }
    if (path.includes('/git/blobs/')) {
      const sha = path.split('/').at(-1) as string
      const content = state.blobs.get(sha) ?? Buffer.from('[]\n')
      return { encoding: 'base64', size: content.length, content: content.toString('base64') }
    }
    if (path.includes('/pulls?')) {
      const requestedState = new URL(`https://api.github.com/${path}`).searchParams.get('state')
      return state.pr && (requestedState === 'all' || requestedState === state.pullState) ? [pull()] : []
    }
    if (method === 'POST' && path === 'graphql') {
      if (state.failCommit !== null) { const code = state.failCommit; state.failCommit = null; throw new ForkGithubError(code) }
      const result = finishMutation(body)
      if (state.lostCommit) { state.lostCommit = false; throw new ForkGithubError('timeout') }
      if (state.malformedCommit) { state.malformedCommit = false; return { data: null } }
      return result
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      const tree = body?.tree as { path: string; content: string }[]
      return { sha: additions(state.trees.get(body?.base_tree as string) ?? state.tree, tree) }
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      return { sha: storeCommit(body?.tree as string, body?.message as string, (body?.parents as string[])[0] as string) }
    }
    if (method === 'POST' && path.endsWith('/git/refs')) {
      if (state.failRef !== null) { const code = state.failRef; state.failRef = null; throw new ForkGithubError(code) }
      if (state.head !== null) throw new ForkGithubError('conflict')
      state.head = body?.sha as string
      if (state.lostRef) { state.lostRef = false; throw new ForkGithubError('timeout') }
      return { ref: body?.ref, object: { type: 'commit', sha: state.head } }
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      if (state.failPr) throw new ForkGithubError('timeout')
      if (state.head === state.masterHead || (state.pr && state.pullState === 'open')) throw new ForkGithubError('conflict')
      if (state.pr) state.pullNumber += 1
      state.pr = true
      state.pullState = 'open'
      if (state.lostPr) { state.lostPr = false; throw new ForkGithubError('timeout') }
      return pull()
    }
    throw new Error(`unhandled fake GitHub endpoint: ${method} ${path}`)
  })
  onTestFinished(() => { request.mockRestore() })
  let ctx: Context
  if (options.loader === true) {
    const cordis = join(dir, 'cordis.yml')
    await writeFile(cordis, '[]\n')
    ctx = await boot('test', cordis, [{ insert: [{ id: 'manager', name: 'cordis:manager', config: { fork: options.config ?? {} } }] }], (owner) => {
      owner.provide('profileContext', profile)
      owner.loader.builtins.manager = PluginManager
    })
  } else {
    ctx = new Context()
    ctx.provide('profileContext', profile)
    await ctx.plugin(CreatorFork, { upstreamRepository: UPSTREAM, ...options.config })
  }
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, service: ctx.creatorFork, state, dir, profile, finishMutation }
}

it('does no GitHub work at construction and lists only an authenticated writable fork after an explicit action', async () => {
  const { service, state } = await fixture()
  expect(state.requests).toEqual([])
  expect(await service.repositories()).toEqual({ status: 'ready', account: 'person', upstream: UPSTREAM, base: 'master',
    repositories: [{ repository: REPOSITORY, defaultBranch: 'main' }] })
})

it('previews dedicated destinations without writing, requires explicit confirmation, and creates one complete branch and PR', async () => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  expect(preview.status).toBe('ready')
  if (preview.status !== 'ready') throw new Error('preview refused')
  expect(preview.files).toContainEqual({ path: 'creator-exports/saved/profiles/saved/cordis.patch.yml', before: null, after: '[]\n' })
  expect(state.requests.every(call => call.method === 'GET')).toBe(true)
  expect(await service.publish(preview.id, false)).toEqual({ status: 'blocked', code: 'confirmation-required', effect: 'none' })
  const saved = await service.publish(preview.id, true)
  expect(saved).toEqual({ status: 'saved', repository: REPOSITORY, branch: TARGET.branch, commit: COMMIT, pullRequestUrl: `https://github.com/${REPOSITORY}/pull/1` })
  const writes = state.requests.filter(call => call.method !== 'GET')
  expect(writes.map(call => call.path)).toEqual([`repos/${REPOSITORY}/git/trees`, `repos/${REPOSITORY}/git/commits`, `repos/${REPOSITORY}/git/refs`, `repos/${REPOSITORY}/pulls`])
  expect(writes.at(-1)?.body).toMatchObject({ base: 'master', head: `person:${TARGET.branch}` })
  expect(JSON.stringify(writes)).not.toContain('"force":true')
  expect(await service.publish(preview.id, true)).toEqual(saved)
  expect(state.requests.filter(call => call.method !== 'GET')).toEqual(writes)
})

it.each(['main', 'master', 'HEAD', '../escape', 'refs/heads/other'])('refuses unsafe branch %s before network', async (branch) => {
  const { service, state } = await fixture()
  expect((await service.preview({ ...TARGET, branch })).status).toBe('blocked')
  expect(state.requests).toEqual([])
})

it.each(['default', 'account', 'fork', 'head'] as const)('rechecks %s after preview and performs no writes when it changed', async (change) => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  if (change === 'default') state.defaultBranch = TARGET.branch
  if (change === 'account') state.user = { id: 8, login: 'other' }
  if (change === 'fork') state.sourceId = 99
  if (change === 'head') state.head = OTHER
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'none' })
  expect(state.requests.every(call => call.method === 'GET')).toBe(true)
})

it('does not recapture sources after preview and uses atomic expected-head updates for an existing branch', async () => {
  const { service, state, dir } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: changed\n')
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  const mutation = state.requests.find(call => call.path === 'graphql')
  expect(JSON.stringify(mutation?.body)).toContain('expectedHeadOid')
  expect(JSON.stringify(mutation?.body)).not.toContain('changed')
})

it('reconciles a lost commit response and retries only PR creation after a committed partial failure', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostCommit = true
  state.failPr = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'committed' })
  state.failPr = false
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.requests.filter(call => call.path === 'graphql')).toHaveLength(1)
})

it.each(['120000', '160000'])('rejects an existing %s destination ancestor without uploading source', async (mode) => {
  const { service, state } = await fixture()
  state.tree = [{ path: 'creator-exports', mode, type: 'blob', sha: BASE }]
  expect(await service.preview(TARGET)).toMatchObject({ status: 'blocked', code: 'unsafe-destination', effect: 'none' })
  expect(state.requests.every(call => call.method === 'GET')).toBe(true)
})

it('refuses credential-bearing source before any GitHub lookup', async () => {
  const { service, state, dir } = await fixture()
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: probe\n  config:\n    password: fake-sensitive-value\n')
  expect(await service.preview(TARGET)).toMatchObject({ status: 'blocked', code: 'secret-suspected', effect: 'none' })
  expect(state.requests).toEqual([])
})

it('publishes the exact reviewed source through the real Loader-mounted profile manager and withdraws the service on unload', async () => {
  const { ctx, service, state } = await fixture(false, { loader: true })
  expect(ctx.get('pluginManager')).toBeDefined()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const saved = await service.publish(preview.id, true)
  expect(saved).toMatchObject({ status: 'saved', commit: COMMIT })
  const mutations = state.requests.filter(request => request.method === 'POST')
  expect(await service.publish(preview.id, true)).toEqual(saved)
  expect(state.requests.filter(request => request.method === 'POST')).toEqual(mutations)
  const created = state.commits.get(COMMIT)
  expect(created).toBeDefined()
  const files = state.trees.get(created?.tree.sha ?? '') ?? []
  for (const file of preview.files) {
    expect(files.find(entry => entry.path === file.path)?.sha).toBe(blobId(Buffer.from(file.after)))
  }
  await ctx.fiber.dispose()
  expect(ctx.get('creatorFork')).toBeUndefined()
})

it('rejects every non-owner executor call even when wire data claims to be the owner', async () => {
  const { ctx, state } = await fixture()
  const guest = remoteContext(ctx, { kind: 'creator-fork-test-guest' }).creatorFork
  const spoofed = { ...TARGET, principal: { kind: 'owner' }, account: 'person' }
  expect(await guest.repositories()).toEqual({ status: 'blocked', code: 'permission-denied', effect: 'none' })
  expect(await guest.preview(spoofed)).toEqual({ status: 'blocked', code: 'permission-denied', effect: 'none' })
  expect(await guest.publish('invented-receipt' as ForkPreviewId, true)).toEqual({ status: 'blocked', code: 'permission-denied', effect: 'none' })
  expect(state.requests).toEqual([])
})

it.each(['owner-id', 'owner-login', 'write-permission', 'fork-network', 'not-fork'] as const)('refuses an unauthorized %s destination during preview', async (change) => {
  const { service, state } = await fixture()
  if (change === 'owner-id') state.owner = 8
  if (change === 'owner-login') state.ownerLogin = 'other'
  if (change === 'write-permission') state.writable = false
  if (change === 'fork-network') state.sourceId = 88
  if (change === 'not-fork') state.fork = false
  expect(await service.preview(TARGET)).toMatchObject({ status: 'blocked', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('uses retained source after the transported preview and local files are edited', async () => {
  const { service, state, dir } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const transported = structuredClone(preview)
  const supplied = transported.files[0] as { path: string; after: string }
  supplied.path = '../unapproved'
  supplied.after = 'unapproved sensitive payload'
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: unapproved-local-edit\n')
  expect((await service.publish(transported.id, true)).status).toBe('saved')
  const mutation = state.requests.find(request => request.path === 'graphql')
  const variables = mutation?.body?.variables as { input: { fileChanges: { additions: { path: string; contents: string }[] } } }
  expect(variables.input.fileChanges.additions).toEqual(preview.files.map(file => ({ path: file.path, contents: Buffer.from(file.after).toString('base64') })))
})

it.each(['default', 'identity', 'permissions', 'repository-id'] as const)('rechecks %s after preparing a new branch and refuses its ref mutation', async (change) => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.beforeRequest = async (request) => {
    if (request.method !== 'POST' || !request.path.endsWith('/git/commits')) return
    if (change === 'default') state.defaultBranch = TARGET.branch
    if (change === 'identity') { state.user = { id: 8, login: 'other' }; state.owner = 8; state.ownerLogin = 'other' }
    if (change === 'permissions') state.writable = false
    if (change === 'repository-id') state.repositoryId = 99
  }
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked' })
  expect(state.requests.filter(request => request.path.endsWith('/git/refs'))).toEqual([])
  expect(state.head).toBeNull()
  expect(state.pr).toBe(false)
})

it('rechecks a default branch changed during the final existing-head read', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.beforeRequest = async (request) => {
    if (request.path.includes('/git/ref/heads/')) state.defaultBranch = TARGET.branch
  }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'default-branch', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['Creator-Exports', 'creator-exports/Saved', 'CREATOR-EXPORTS/saved'])(
  'refuses the case-alias destination ancestor %s before any upload', async (path) => {
    const { service, state } = await fixture()
    state.tree = [{ path, mode: '040000', type: 'tree', sha: BASE_TREE }]
    expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'unsafe-destination', effect: 'none' })
    expect(state.requests.every(request => request.method === 'GET')).toBe(true)
  },
)

it.each([
  ['profiles/saved/cordis.patch.yml', 'password:\n  - sensitive-value\n', 'secret-suspected'],
  ['profiles/saved/package.json', '{"password":"sensitive-value"}', 'secret-suspected'],
  ['.gitignore', '\0not-text\n', 'unsupported-source'],
  ['.gitignore', 'x'.repeat(1024 * 1024 + 1), 'invalid-response'],
] as const)('refuses unsafe remote-before contents at %s without returning them', async (suffix, content, code) => {
  const { service, state } = await fixture(true)
  const bytes = Buffer.from(content)
  const sha = blobId(bytes)
  state.tree = [{ path: `creator-exports/saved/${suffix}`, mode: '100644', type: 'blob', sha }]
  state.blobs.set(sha, bytes)
  const result = await service.preview(TARGET)
  expect(result).toEqual({ status: 'blocked', code, effect: 'none' })
  expect(JSON.stringify(result)).not.toContain('sensitive-value')
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['truncated-tree', 'inconsistent-commit-id'] as const)('refuses an unreviewable %s response', async (change) => {
  const { service, state } = await fixture(true)
  if (change === 'truncated-tree') state.truncated = true
  else state.commitResponseSha = OTHER
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'invalid-response', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('requires a known unexpired preview before any publication lookup', async () => {
  const { service, state } = await fixture(false, { config: { previewLifetimeMs: 100 } })
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  onTestFinished(() => { now.mockRestore() })
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const reads = state.requests.length
  expect(await service.publish('unknown-receipt' as ForkPreviewId, true)).toEqual({ status: 'blocked', code: 'stale-preview', effect: 'none' })
  now.mockReturnValue(1101)
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'stale-preview', effect: 'none' })
  expect(state.requests).toHaveLength(reads)
})

it('keeps concurrent preview admission within the retained receipt limit', async () => {
  const { service, state } = await fixture(false, { config: { maxPreviews: 1 } })
  const firstEntered = Promise.withResolvers<undefined>()
  const secondProgress = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let arrivals = 0
  state.beforeRequest = async (request) => {
    if (request.method !== 'GET' || !request.path.includes('/git/trees/')) return
    arrivals += 1
    if (arrivals === 1) firstEntered.resolve(undefined)
    else secondProgress.resolve(undefined)
    await release.promise
  }
  const first = service.preview(TARGET)
  await firstEntered.promise
  const second = service.preview(TARGET)
  void second.then(() => { secondProgress.resolve(undefined) }, () => { secondProgress.resolve(undefined) })
  await secondProgress.promise
  release.resolve(undefined)
  const results = await Promise.all([first, second])
  expect(results.filter(result => result.status === 'ready')).toHaveLength(1)
  expect(results.filter(result => result.status === 'blocked')).toEqual([{ status: 'blocked', code: 'too-large', effect: 'none' }])
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('evicts a completed receipt to admit another save while old ids remain unable to mutate', async () => {
  const { service, state, dir } = await fixture(false, { config: { maxPreviews: 1 } })
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: next-save\n')
  expect((await service.preview(TARGET)).status).toBe('ready')
  const requests = state.requests.length
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'stale-preview', effect: 'none' })
  expect(state.requests).toHaveLength(requests)
})

it('retains an unresolved PR receipt instead of evicting its committed outcome', async () => {
  const { service, state, dir } = await fixture(true, { config: { maxPreviews: 1 } })
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.failPr = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'committed' })
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: next-save\n')
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'too-large', effect: 'none' })
  state.failPr = false
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.requests.filter(request => request.path === 'graphql')).toHaveLength(1)
})

it('releases a known closed-PR receipt for the next preview while preserving retries until then', async () => {
  const { service, state, dir } = await fixture(true, { config: { maxPreviews: 1 } })
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostPr = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'committed' })
  state.pullState = 'closed'
  const closed = await service.publish(preview.id, true)
  expect(closed).toMatchObject({ status: 'blocked', code: 'pull-request-closed', effect: 'committed' })
  expect(await service.publish(preview.id, true)).toEqual(closed)
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: next-save\n')
  expect((await service.preview(TARGET)).status).toBe('ready')
  const requests = state.requests.length
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'stale-preview', effect: 'none' })
  expect(state.requests).toHaveLength(requests)
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
})

it('retains an unknown branch-write receipt when the next preview needs its slot', async () => {
  const { service, state, dir } = await fixture(true, { config: { maxPreviews: 1 } })
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.failCommit = 'timeout'
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: next-save\n')
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'too-large', effect: 'none' })
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.commits.size).toBe(1)
})

it.each(['tree', 'extra-file', 'missing-file', 'mode', 'message', 'parent'] as const)(
  'refuses a forged lost-write commit with changed %s despite a known receipt marker', async (change) => {
    const { service, state } = await fixture(true)
    const preview = await service.preview(TARGET)
    if (preview.status !== 'ready') throw new Error('preview refused')
    state.lostCommit = true
    expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
    const commit = state.commits.get(COMMIT)
    if (commit === undefined) throw new Error('fake remote commit was not created')
    const leaves = state.trees.get(commit.tree.sha)
    if (leaves === undefined) throw new Error('fake remote tree was not created')
    if (change === 'message') commit.message = 'Different operation'
    else if (change === 'parent') commit.parents = [{ sha: OTHER }]
    else if (change === 'extra-file') leaves.push({ path: 'unapproved.txt', mode: '100644', type: 'blob', sha: OTHER })
    else if (change === 'missing-file') leaves.pop()
    else {
      const file = leaves[0]
      if (file === undefined) throw new Error('fake tree has no source file')
      if (change === 'mode') file.mode = '100755'
      else file.sha = OTHER
    }
    expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'unknown' })
    expect(state.requests.filter(request => request.path === 'graphql')).toHaveLength(1)
    expect(state.pr).toBe(false)
  },
)

it('recognizes an exclusive new-branch write after its response is lost without creating duplicate objects', async () => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostRef = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  for (const suffix of ['/git/trees', '/git/commits', '/git/refs']) {
    expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith(suffix))).toHaveLength(1)
  }
})

it('does not accept a different new-branch head that copied the exact approved marker and files', async () => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostRef = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  const original = state.commits.get(COMMIT)
  if (original === undefined) throw new Error('fake remote commit was not created')
  state.commits.set(OTHER, { ...original, sha: OTHER })
  state.head = OTHER
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'unknown' })
  expect(state.pr).toBe(false)
})

it.each([false, true])('retries a write that never reached GitHub using the same approved conditional operation (existing=%s)', async (existing) => {
  const { service, state } = await fixture(existing)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  if (existing) state.failCommit = 'timeout'
  else state.failRef = 'timeout'
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  expect(state.head).toBe(existing ? BASE : null)
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.commits.size).toBe(1)
  if (!existing) {
    expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/git/commits'))).toHaveLength(1)
  }
})

it('reconciles a malformed mutation response from exact committed contents', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.malformedCommit = true
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'invalid-response', effect: 'unknown' })
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.commits.size).toBe(1)
})

it.each(['auth-required', 'conflict'] as const)('reports a definitive %s mutation refusal without claiming an unknown commit', async (code) => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.failCommit = code
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code, effect: 'none' })
  expect(state.head).toBe(BASE)
  expect(state.commits.size).toBe(0)
})

it('refuses a GitHub expected-head conflict that arrives after final local checks', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.beforeRequest = async (request) => { if (request.path === 'graphql') state.head = OTHER }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'none' })
  expect(state.head).toBe(OTHER)
  expect(state.commits.size).toBe(0)
  expect(state.requests.filter(request => request.method === 'PATCH')).toEqual([])
  expect(state.pr).toBe(false)
})

it('retains an earlier unknown write after a later definitive rejection and recognizes its late commit', async () => {
  const { service, state, finishMutation } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  let queued: Record<string, unknown> | undefined
  state.beforeRequest = async (request) => {
    if (request.path !== 'graphql') return
    queued = request.body
    throw new ForkGithubError('timeout')
  }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'timeout', effect: 'unknown' })
  state.beforeRequest = undefined
  state.failCommit = 'auth-required'
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'auth-required', effect: 'unknown' })
  expect(state.head).toBe(BASE)
  finishMutation(queued)
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.commits.size).toBe(1)
  expect(state.requests.filter(request => request.path === 'graphql')).toHaveLength(2)
})

it.each(['default-branch', 'network'] as const)('retains an earlier unknown write when retry revalidation fails with %s', async (code) => {
  const { service, state, finishMutation } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  let queued: Record<string, unknown> | undefined
  state.beforeRequest = async (request) => {
    if (request.path !== 'graphql') return
    queued = request.body
    throw new ForkGithubError('timeout')
  }
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'unknown' })
  let identityReads = 0
  state.beforeRequest = async (request) => {
    if (request.path !== 'user' || ++identityReads !== 2) return
    if (code === 'network') throw new ForkGithubError('network')
    state.defaultBranch = TARGET.branch
  }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code, effect: 'unknown' })
  expect(state.requests.filter(request => request.path === 'graphql')).toHaveLength(1)
  state.beforeRequest = undefined
  state.defaultBranch = 'main'
  finishMutation(queued)
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.commits.size).toBe(1)
})

it('reuses an existing open PR for the approved fork branch and current commit', async () => {
  const { service, state } = await fixture(true)
  state.pr = true
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toEqual([])
})

it('finds an open PR after losing its creation response instead of opening another', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostPr = true
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'timeout', effect: 'committed' })
  expect(state.pr).toBe(true)
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
  expect(state.commits.size).toBe(1)
})

it.each(['closed', 'merged'] as const)('does not reopen publication after a lost PR response and external %s outcome', async (outcome) => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.lostPr = true
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'timeout', effect: 'committed' })
  state.pullState = 'closed'
  if (outcome === 'merged') state.masterHead = COMMIT
  const result = await service.publish(preview.id, true)
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
  expect(result).toEqual({ status: 'blocked', code: 'pull-request-closed', effect: 'committed',
    pullRequestUrl: `https://github.com/${REPOSITORY}/pull/1` })
  expect(await service.publish(preview.id, true)).toEqual(result)
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
  expect(state.pullNumber).toBe(1)
  expect(state.pullState).toBe('closed')
  expect(state.commits.size).toBe(1)
})

it('reports a PR closed before its creation response arrives and can reuse it after reopening', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.overrideResponse = (request) => {
    if (request.method !== 'POST' || !request.path.endsWith('/pulls')) return undefined
    state.pr = true
    state.pullState = 'closed'
    return { value: { number: 1, state: 'closed', head: { ref: TARGET.branch, sha: COMMIT, repo: { id: 2 } },
      base: { ref: 'master', repo: { id: 2 } } } }
  }
  const closed = { status: 'blocked', code: 'pull-request-closed', effect: 'committed',
    pullRequestUrl: `https://github.com/${REPOSITORY}/pull/1` }
  expect(await service.publish(preview.id, true)).toEqual(closed)
  expect(await service.publish(preview.id, true)).toEqual(closed)
  state.pullState = 'open'
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'saved', pullRequestUrl: closed.pullRequestUrl })
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
  expect(state.commits.size).toBe(1)
})

it('prefers a matching open PR when a matching closed PR is also listed', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const pull = { head: { ref: TARGET.branch, sha: COMMIT, repo: { id: 2 } }, base: { ref: 'master', repo: { id: 2 } } }
  state.overrideResponse = request => request.path.includes('/pulls?') ? { value: [
    { ...pull, number: 1, state: 'closed' }, { ...pull, number: 2, state: 'open' },
  ] } : undefined
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'saved', pullRequestUrl: `https://github.com/${REPOSITORY}/pull/2` })
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toEqual([])
})

it.each(['commit', 'head-repository', 'base-repository'] as const)('ignores a closed PR for a different %s', async (difference) => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const pull = { number: 9, state: 'closed', head: { ref: TARGET.branch, sha: COMMIT, repo: { id: 2 } },
    base: { ref: 'master', repo: { id: 2 } } }
  if (difference === 'commit') pull.head.sha = OTHER
  if (difference === 'head-repository') pull.head.repo.id = 99
  if (difference === 'base-repository') pull.base.repo.id = 99
  state.overrideResponse = request => request.path.includes('/pulls?') ? { value: [pull] } : undefined
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
})

it('refuses to create a PR when the bounded history page contains no approved match', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.overrideResponse = request => request.path.includes('/pulls?') ? { value: Array.from({ length: 100 }, (_, index) => ({
    number: index + 1, state: 'closed', head: { ref: TARGET.branch, sha: OTHER, repo: { id: 2 } },
    base: { ref: 'master', repo: { id: 2 } },
  })) } : undefined
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'too-large', effect: 'committed' })
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toEqual([])
  expect(state.commits.size).toBe(1)
})

it('shares one conditional mutation and PR across concurrent confirmations', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  state.beforeRequest = async (request) => {
    if (request.path === 'graphql') { entered.resolve(undefined); await release.promise }
  }
  const first = service.publish(preview.id, true)
  await entered.promise
  const second = service.publish(preview.id, true)
  release.resolve(undefined)
  const [one, two] = await Promise.all([first, second])
  expect(one.status).toBe('saved')
  expect(two).toEqual(one)
  expect(state.requests.filter(request => request.path === 'graphql')).toHaveLength(1)
  expect(state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls'))).toHaveLength(1)
})

it('waits for admitted GitHub work to settle during disposal and refuses later calls', async () => {
  const { ctx, service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  state.beforeRequest = async (request, signal) => {
    if (request.path !== 'graphql') return
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
  }
  const publishing = service.publish(preview.id, true)
  await entered.promise
  let disposed = false
  const disposal = ctx.fiber.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  release.resolve(undefined)
  expect(await publishing).toMatchObject({ status: 'blocked', effect: 'unknown' })
  await disposal
  expect(state.head).toBe(BASE)
  expect(state.commits.size).toBe(0)
  const requests = state.requests.length
  expect((await service.repositories()).status).toBe('blocked')
  expect(state.requests).toHaveLength(requests)
})

function repositoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 2, full_name: REPOSITORY, owner: { id: 7, login: 'person' }, default_branch: 'main', fork: true,
    permissions: { push: true }, source: { id: 1, full_name: UPSTREAM }, ...overrides }
}

it('allows an owner invocation with the call cancellation scope', async () => {
  const { ctx } = await fixture()
  expect((await remoteContext(ctx, { kind: 'owner' }).creatorFork.repositories()).status).toBe('ready')
})

it.each(['moved-slug', 'missing-network'] as const)('refuses inconsistent repository metadata: %s', async (kind) => {
  const { service, state } = await fixture()
  state.overrideResponse = request => request.path === `repos/${REPOSITORY}`
    ? { value: kind === 'moved-slug' ? repositoryRecord({ full_name: 'other/renamed' }) : repositoryRecord({ source: undefined }) }
    : undefined
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: kind === 'moved-slug' ? 'wrong-fork' : 'invalid-response', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('does not treat a failed head lookup as an absent branch', async () => {
  const { service, state } = await fixture()
  state.beforeRequest = async (request) => { if (request.path.includes('/git/ref/heads/')) throw new ForkGithubError('permission-denied') }
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'permission-denied', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['cached-owner', 'cached-permissions', 'cached-network'] as const)('filters a listed fork whose %s authorization changed', async (kind) => {
  const { service, state } = await fixture()
  state.overrideResponse = (request) => {
    if (request.path.startsWith('user/repos?')) return { value: [repositoryRecord()] }
    if (request.path !== `repos/${REPOSITORY}`) return undefined
    if (kind === 'cached-owner') return { value: repositoryRecord({ owner: { id: 8, login: 'other' } }) }
    if (kind === 'cached-permissions') return { value: repositoryRecord({ permissions: { push: false } }) }
    return { value: repositoryRecord({ source: { id: 88, full_name: 'other/project' } }) }
  }
  expect(await service.repositories()).toEqual({ status: 'ready', account: 'person', upstream: UPSTREAM, base: 'master', repositories: [] })
})

it('continues a full discovery page while filtering non-forks, other owners, missing permissions, and the upstream', async () => {
  const { service, state } = await fixture()
  const hidden = [repositoryRecord({ fork: false }), repositoryRecord({ owner: { id: 8, login: 'other' } }),
    repositoryRecord({ permissions: undefined }), repositoryRecord({ id: 1 })]
  state.overrideResponse = (request) => {
    if (!request.path.startsWith('user/repos?')) return undefined
    return { value: request.path.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => hidden[index % hidden.length]) : [repositoryRecord()] }
  }
  expect(await service.repositories()).toEqual({ status: 'ready', account: 'person', upstream: UPSTREAM, base: 'master',
    repositories: [{ repository: REPOSITORY, defaultBranch: 'main' }] })
  expect(state.requests.filter(request => request.path.startsWith('user/repos?'))).toHaveLength(2)
})

it('refuses discovery overflow instead of returning a partial account inventory', async () => {
  const { service, state } = await fixture()
  state.overrideResponse = request => request.path.startsWith('user/repos?')
    ? { value: Array.from({ length: 100 }, () => repositoryRecord({ fork: false })) } : undefined
  expect(await service.repositories()).toEqual({ status: 'blocked', code: 'too-large', effect: 'none' })
  expect(state.requests.filter(request => request.path.startsWith('user/repos?'))).toHaveLength(10)
})

it.each([
  { path: 'creator-exports', mode: '100755', type: 'tree' },
  { path: 'creator-exports/saved/.gitignore', mode: '100755', type: 'blob' },
  { path: 'creator-exports/saved/.gitignore', mode: '040000', type: 'tree' },
])('rejects incompatible Git entry $type:$mode at $path', async (entry) => {
  const { service, state } = await fixture()
  state.tree = [{ ...entry, sha: BASE }]
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'unsafe-destination', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['size', 'base64', 'blob-id', 'utf8'] as const)('refuses remote blob %s inconsistency before returning text', async (kind) => {
  const { service, state } = await fixture(true)
  const content = kind === 'utf8' ? Buffer.from([0xc0, 0xaf]) : Buffer.from('public destination\n')
  const sha = kind === 'blob-id' ? OTHER : blobId(content)
  state.tree = [{ path: 'creator-exports/saved/.gitignore', mode: '100644', type: 'blob', sha }]
  state.blobs.set(sha, content)
  if (kind === 'size' || kind === 'base64') {
    state.overrideResponse = request => request.path.includes('/git/blobs/') ? { value: {
      encoding: 'base64', size: kind === 'size' ? 0 : content.length,
      content: kind === 'base64' ? `${content.toString('base64')}%invalid` : content.toString('base64'),
    } } : undefined
  }
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: kind === 'utf8' ? 'unsupported-source' : 'invalid-response', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('contains an unexpected destination YAML parser failure without returning source or diagnostics', async () => {
  const { service, state } = await fixture(true)
  const content = 'destination: public-value\n'
  const bytes = Buffer.from(content)
  const sha = blobId(bytes)
  state.tree = [{ path: 'creator-exports/saved/profiles/saved/cordis.patch.yml', mode: '100644', type: 'blob', sha }]
  state.blobs.set(sha, bytes)
  parserHooks.failText = content
  onTestFinished(() => { parserHooks.failText = undefined })
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'unsupported-source', effect: 'none' })
})

it('reports no changes when the complete source is already stored at its destinations', async () => {
  const { service } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  expect((await service.publish(preview.id, true)).status).toBe('saved')
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'no-changes', effect: 'none' })
})

it('refuses a preview when the branch moves while destination blobs are being read', async () => {
  const { service, state } = await fixture(true)
  let heads = 0
  state.beforeRequest = async (request) => {
    if (request.path.includes('/git/ref/heads/') && ++heads === 2) state.head = OTHER
  }
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'conflict', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each(['account-id', 'repository-id', 'upstream-id'] as const)('refuses a coherent but changed %s at publication entry', async (kind) => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  if (kind === 'account-id') { state.user = { id: 8, login: 'other' }; state.owner = 8; state.ownerLogin = 'other' }
  if (kind === 'repository-id') state.repositoryId = 88
  if (kind === 'upstream-id') { state.upstreamId = 88; state.sourceId = 88 }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: kind === 'account-id' ? 'mixed-account' : 'wrong-fork', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('preserves a committed partial outcome when its branch advances before retry', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.failPr = true
  expect(await service.publish(preview.id, true)).toMatchObject({ status: 'blocked', effect: 'committed' })
  state.head = OTHER
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'committed' })
  expect(state.commits.size).toBe(1)
})

it('refuses to open a PR when its branch moves after the approved commit is created', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.beforeRequest = async (request) => {
    if (request.path.includes('/git/ref/heads/') && state.commits.size !== 0) state.head = OTHER
  }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'committed' })
  expect(state.pr).toBe(false)
})

it('rejects a created-ref response naming a different commit and retains an unknown outcome', async () => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.overrideResponse = request => request.method === 'POST' && request.path.endsWith('/git/refs')
    ? { value: { object: { type: 'commit', sha: OTHER } } } : undefined
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'invalid-response', effect: 'unknown' })
  expect(state.pr).toBe(false)
})

it('rejects a created-PR response that names a different repository', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.overrideResponse = request => request.method === 'POST' && request.path.endsWith('/pulls') ? { value: {
    number: 9, state: 'open', head: { ref: TARGET.branch, sha: COMMIT, repo: { id: 99 } }, base: { ref: 'master', repo: { id: 1 } },
  } } : undefined
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'invalid-response', effect: 'committed' })
  expect(state.commits.size).toBe(1)
})

it('bounds the complete operation while an API request is waiting and reports the deadline', async () => {
  const { service, state } = await fixture(false, { config: { operationTimeoutMs: 5 } })
  const entered = Promise.withResolvers<undefined>()
  state.beforeRequest = async (_request, signal) => {
    entered.resolve(undefined)
    await new Promise<void>((_resolve, reject) => {
      const rejectAborted = (): void => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error('GitHub request cancelled'))
      }
      signal.addEventListener('abort', rejectAborted, { once: true })
      if (signal.aborted) rejectAborted()
    })
  }
  const operation = service.repositories()
  await entered.promise
  expect(await operation).toEqual({ status: 'blocked', code: 'timeout', effect: 'none' })
  expect(state.requests).toHaveLength(1)
})

async function largeSource(profile: ProfileContext, dir: string): Promise<void> {
  const bundle = join(profile.home, 'size-probe')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), '{"name":"size-probe","version":"1.0.0","type":"module"}\n')
  await writeFile(join(dir, 'package.json'), '{"dependencies":{"size-probe":"link:../../size-probe"},"dsh":{"profile":{"bundles":[]}}}\n')
  await Promise.all(Array.from({ length: 9 }, (_, index) => writeFile(join(bundle, `data-${String(index)}.txt`), 'a'.repeat(800 * 1024))))
}

it('bounds the total preview including remote-before text across many supported files', async () => {
  const { service, state, profile, dir } = await fixture(true)
  await largeSource(profile, dir)
  const before = Buffer.from('b'.repeat(500 * 1024))
  const sha = blobId(before)
  state.blobs.set(sha, before)
  state.tree = Array.from({ length: 9 }, (_, index) => ({
    path: `creator-exports/saved/bundles/0/data-${String(index)}.txt`, type: 'blob', mode: '100644', sha,
  }))
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'too-large', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('applies the preview byte bound to the complete JSON envelope at one byte over the limit', async () => {
  const { service, state, profile, dir } = await fixture(true)
  await largeSource(profile, dir)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('large source preview refused')
  const files = preview.files.map(file => ({ ...file }))
  const large = files.filter(file => file.path.endsWith('.txt'))
  for (const file of large.slice(0, -1)) file.before = 'b'.repeat(300 * 1024)
  const last = large.at(-1)
  if (last === undefined) throw new Error('large source fixture has no file')
  last.before = ''
  const limit = 10 * 1024 * 1024
  const remaining = limit + 1 - Buffer.byteLength(JSON.stringify({ ...preview, files }))
  expect(remaining).toBeGreaterThan(0)
  expect(remaining).toBeLessThan(1024 * 1024)
  last.before = 'b'.repeat(remaining)
  expect(Buffer.byteLength(JSON.stringify({ ...preview, files }))).toBe(limit + 1)
  state.tree = large.map((file) => {
    const content = Buffer.from(file.before ?? '')
    const sha = blobId(content)
    state.blobs.set(sha, content)
    return { path: file.path, type: 'blob', mode: '100644', sha }
  })
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'too-large', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it.each([false, true])('keeps every mutation inside the selected fork and opens its PR against fork master (existing=%s)', async (existing) => {
  const { service, state } = await fixture(existing)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  const result = await service.publish(preview.id, true)
  const mutations = state.requests.filter(request => request.method !== 'GET')
  expect(mutations.every(request => request.path === 'graphql' || request.path.startsWith(`repos/${REPOSITORY}/`))).toBe(true)
  expect(state.requests.filter(request => request.path === `repos/${UPSTREAM}/branches/master`)).toEqual([])
  expect(mutations.find(request => request.path.endsWith('/pulls'))?.body).toMatchObject({ base: 'master', head: `person:${TARGET.branch}` })
  expect(state.commits.get(COMMIT)?.parents).toEqual([{ sha: BASE }])
  expect(result).toMatchObject({ status: 'saved', pullRequestUrl: `https://github.com/${REPOSITORY}/pull/1` })
})

it.each([false, true])('refuses a fork without its own master branch before uploading source (existing=%s)', async (existing) => {
  const { service, state } = await fixture(existing)
  state.masterExists = false
  expect(await service.preview(TARGET)).toEqual({ status: 'blocked', code: 'not-found', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
})

it('requires a new branch to use the reviewed fork-master commit before uploading source', async () => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.masterHead = OTHER
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'conflict', effect: 'none' })
  expect(state.requests.every(request => request.method === 'GET')).toBe(true)
  expect(state.head).toBeNull()
})

it.each(['moved', 'removed'] as const)('rechecks fork master after preparing Git objects when it was %s', async (change) => {
  const { service, state } = await fixture()
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.beforeRequest = async (request) => {
    if (request.method !== 'POST' || !request.path.endsWith('/git/commits')) return
    if (change === 'moved') state.masterHead = OTHER
    else state.masterExists = false
  }
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: change === 'moved' ? 'conflict' : 'not-found', effect: 'none' })
  expect(state.requests.filter(request => request.path.endsWith('/git/refs') || request.path.endsWith('/pulls'))).toEqual([])
  expect(state.head).toBeNull()
})

it('rejects a PR response that targets upstream master rather than selected-fork master', async () => {
  const { service, state } = await fixture(true)
  const preview = await service.preview(TARGET)
  if (preview.status !== 'ready') throw new Error('preview refused')
  state.overrideResponse = request => request.method === 'POST' && request.path.endsWith('/pulls') ? { value: {
    number: 9, state: 'open', head: { ref: TARGET.branch, sha: COMMIT, repo: { id: 2 } }, base: { ref: 'master', repo: { id: 1 } },
  } } : undefined
  expect(await service.publish(preview.id, true)).toEqual({ status: 'blocked', code: 'invalid-response', effect: 'committed' })
})

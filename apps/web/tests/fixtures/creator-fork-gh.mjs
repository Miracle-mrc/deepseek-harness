#!/usr/bin/env node
/** Test-owned GitHub API process; all state and request records stay beside this copied executable. */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const statePath = join(root, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
const methodIndex = args.indexOf('--method')
const method = args[methodIndex + 1]
const path = args[methodIndex + 2]
const body = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ method, path, body }) + '\n')

const BASE = 'a'.repeat(40)
const BASE_TREE = 'b'.repeat(40)
const COMMIT = 'c'.repeat(40)
const COMMIT_TREE = 'd'.repeat(40)
const REPOSITORY = 'alice/harness'
const UPSTREAM = 'deepseek-ai/deepseek-harness'
const SOURCE = 'creator-exports/saved/bundles/0/index.ts'

function save() { writeFileSync(statePath, JSON.stringify(state)) }
function blobId(text) {
  const bytes = Buffer.from(text)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
function reply(status, value) {
  process.stdout.write(`HTTP/1.1 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\n`)
  process.exitCode = status >= 400 ? 1 : 0
}
function pull() {
  return { number: 17, state: 'open', head: { ref: state.branch, sha: state.head, repo: { id: 2 } },
    base: { ref: 'master', repo: { id: 2 } } }
}
function repository() {
  return { id: 2, full_name: REPOSITORY, owner: { id: 7, login: 'alice' }, default_branch: 'main',
    fork: true, permissions: { push: true }, source: { id: 1, full_name: UPSTREAM }, parent: { id: 1, full_name: UPSTREAM } }
}

async function main() {
  if (args[0] !== 'api' || args[args.indexOf('--hostname') + 1] !== 'github.com') return reply(400, {})
  if (body !== undefined && Object.hasOwn(body, 'force')) return reply(400, {})
  if (method === 'GET' && path === 'user') return reply(200, { id: 7, login: 'alice' })
  if (method === 'GET' && path.startsWith('user/repos?')) return reply(200, [
    repository(),
    { ...repository(), id: 8, full_name: 'other/harness', owner: { id: 8, login: 'other' } },
    { ...repository(), id: 9, full_name: 'alice/regular', fork: false },
    { ...repository(), id: 10, full_name: 'alice/read-only', permissions: { push: false } },
  ])
  if (method === 'GET' && path === `repos/${UPSTREAM}`) return reply(200, {
    id: 1, full_name: UPSTREAM, owner: { id: 1, login: 'deepseek-ai' }, default_branch: 'master', fork: false,
  })
  if (method === 'GET' && path === `repos/${REPOSITORY}`) return reply(200, repository())
  if (method === 'GET' && path === `repos/${REPOSITORY}/branches/master`) return reply(200, { commit: { sha: BASE } })
  if (method === 'GET' && path === `repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(state.branch)}`) {
    return reply(200, { object: { type: 'commit', sha: state.head } })
  }
  if (method === 'GET' && path.startsWith(`repos/${REPOSITORY}/git/commits/`)) {
    const sha = path.split('/').at(-1)
    return reply(200, { sha, tree: { sha: sha === BASE ? BASE_TREE : COMMIT_TREE },
      message: sha === BASE ? 'Existing work' : state.message, parents: sha === BASE ? [] : [{ sha: BASE }] })
  }
  if (method === 'GET' && path.startsWith(`repos/${REPOSITORY}/git/trees/`)) {
    const files = path.includes(BASE_TREE) ? [{ path: SOURCE, content: state.before }] : state.files
    return reply(200, { truncated: false, tree: files.map(file => ({
      path: file.path, mode: '100644', type: 'blob', sha: blobId(file.content),
    })) })
  }
  if (method === 'GET' && path.startsWith(`repos/${REPOSITORY}/git/blobs/`)) {
    const sha = path.split('/').at(-1)
    const file = [{ content: state.before }, ...state.files].find(item => blobId(item.content) === sha)
    if (file === undefined) return reply(404, {})
    const bytes = Buffer.from(file.content)
    return reply(200, { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') })
  }
  if (method === 'POST' && path === 'graphql') {
    const input = body.variables.input
    if (input.branch?.repositoryNameWithOwner !== REPOSITORY || input.branch?.branchName !== state.branch
      || Object.keys(input.branch).sort().join(',') !== 'branchName,repositoryNameWithOwner'
      || Object.hasOwn(input, 'force') || input.fileChanges.deletions !== undefined) return reply(422, {})
    if (input.expectedHeadOid !== state.head) return reply(409, {})
    while (existsSync(join(root, 'hold-commit'))) await new Promise(resolve => setTimeout(resolve, 10))
    state.head = COMMIT
    state.message = input.message.headline
    state.files = input.fileChanges.additions.map(file => ({ path: file.path, content: Buffer.from(file.contents, 'base64').toString('utf8') }))
    save()
    return reply(200, { data: { createCommitOnBranch: { commit: { oid: COMMIT } } } })
  }
  if (method === 'GET' && path.startsWith(`repos/${REPOSITORY}/pulls?`)) {
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    if (query.get('state') !== 'all' || query.get('base') !== 'master'
      || query.get('head') !== `alice:${state.branch}`) return reply(422, {})
    return reply(200, state.pr ? [pull()] : [])
  }
  if (method === 'POST' && path === `repos/${REPOSITORY}/pulls`) {
    if (body.base !== 'master' || body.head !== `alice:${state.branch}` || body.head_repo !== 'harness'
      || body.maintainer_can_modify !== false) return reply(422, {})
    if (state.failPr) {
      state.failPr = false
      save()
      return reply(504, {})
    }
    state.pr = true
    save()
    return reply(201, pull())
  }
  return reply(500, { message: `Unscripted test request: ${method} ${path}` })
}

await main()

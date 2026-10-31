/** The normal launcher exposes cloud commands without credentials or a model. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const deadlineMs = 60_000

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-profile-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  const runDsh = async (args: string[], input = '') => {
    const launch = resolveExampleLaunch({
      srcBin: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm', tsconfigPath: join(repo, 'tsconfig.json'),
      configArgs: args,
      env: { DSH_HOME: home, DSH_AGENTS_HOME: join(dir, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: undefined },
    })
    const result = await execa(launch.command, launch.args, {
      env: launch.env, cwd: dir, input, timeout: deadlineMs, killSignal: 'SIGKILL', reject: false,
    })
    const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    expect(result.timedOut, diagnostic).toBe(false)
    expect(result.signal, diagnostic).toBeUndefined()
    return result
  }
  return {
    dir, home, runDsh,
    run: (args: string[], input = '') => runDsh(['cloud', ...args], input),
    async enable() {
      const result = await runDsh(['plugin', '--profile', 'cloud', 'enable', '--empty', '@deepseek-ai/dsh-experimental-cloud-connectors-cli'])
      expect(result.exitCode, result.stderr).toBe(0)
    },
  }
}

describe('optional cloud command profile', { retry: 0 }, () => {
  it('prints help and credential-free status through the public launcher', async () => {
    const f = await fixture()
    await f.enable()
    const help = await f.run(['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('Usage: dsh cloud')
    expect(help.stdout).toContain('disconnect')
    const loginHelp = await f.run(['login', '--help'])
    expect(loginHelp.exitCode).toBe(0)
    expect(loginHelp.stdout).toContain('--secret-stdin')
    const result = await f.run(['status'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout + '\n').toBe(await readFile(new URL('./expected/cloud-profile/status.txt', import.meta.url), 'utf8'))
    const supabaseStatus = await f.run(['status', 'supabase'])
    expect(supabaseStatus.exitCode).toBe(0)
    expect(supabaseStatus.stdout).toBe('supabase: not-connected; 0 tools enabled')
    expect(await readdir(f.home)).not.toContain('sessions')
    const profile = JSON.parse(await readFile(join(f.home, 'profiles/cloud/package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-experimental-cloud-connectors-cli'])
  })

  it('rejects invalid input and permits local disconnect without contacting a provider', async () => {
    const f = await fixture()
    await f.enable()
    const invalid = await f.run(['tools', 'supabase', '--all', '--none'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain('choose one of --enable, --all or --none')
    const unavailable = await f.run(['tools', 'supabase'])
    expect(unavailable.exitCode).toBe(1)
    expect(unavailable.stderr).toContain('Sign in before reviewing tool permissions')
    const disconnected = await f.run(['disconnect', 'supabase'])
    expect(disconnected.exitCode).toBe(0)
    expect(disconnected.stdout).toBe('supabase: disconnected from this Harness home.')
  })

  it('runs a login prompt through the real CLI and drains EOF without logging its input', async () => {
    const f = await fixture()
    await f.enable()
    const marker = join(f.dir, 'cancelled.txt')
    const provider = join(f.dir, 'cloud-prompt.mjs')
    // This fixture is an external-service stand-in mounted by the normal profile Loader.
    await writeFile(provider, [
      "import { writeFile } from 'node:fs/promises'",
      "export const name = 'cloud-prompt-fixture'",
      'export function apply(ctx) {',
      "  const view = { provider: 'supabase', status: 'authorizing', attemptId: 'owned-cli-attempt', tools: [], enabledTools: [],",
      "    prompt: { id: 'private-prompt', kind: 'secret' } }",
      '  ctx.provide(\'cloudConnections\', {',
      '    async list() { return [view] },',
      '    async start() { return { attemptId: view.attemptId, url: "https://supabase.example/authorize" } },',
      '    async cancel(provider, attemptId) {',
      "      if (provider !== 'supabase' || attemptId !== view.attemptId) throw new Error('wrong attempt')",
      `      await writeFile(${JSON.stringify(marker)}, 'cancelled')`,
      '      return []',
      '    },',
      "    async complete() { throw new Error('unexpected response') },",
      "    async restore() { return [view] }, async confirm() { throw new Error('unexpected consent') },",
      "    async disconnect() { throw new Error('unexpected global disconnect') },",
      '  })',
      '}',
    ].join('\n') + '\n')
    const patch = join(f.dir, 'prompt.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'cloud-connectors', disabled: true },
      { insert: [{ id: 'cloud-prompt-fixture', name: provider }] },
    ]) + '\n')
    const result = await f.run(['--patch', patch, 'login', 'supabase', '--secret-stdin'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('https://supabase.example/authorize')
    expect(result.stderr).toContain('Standard input ended before a secret was provided')
    expect(await readFile(marker, 'utf8')).toBe('cancelled')
  })

  it('keeps piped browser responses private and requires an explicit tool selection', async () => {
    const f = await fixture()
    await f.enable()
    const events = join(f.dir, 'operations.jsonl')
    const provider = join(f.dir, 'cloud-consent.mjs')
    await writeFile(provider, `
import { appendFile } from 'node:fs/promises'
export const name = 'cloud-consent-fixture'
export function apply(ctx) {
  const views = ['aws', 'supabase'].map(provider => ({
    provider, status: 'choose-permissions', enabledTools: [],
    tools: (provider === 'aws' ? ['search_docs', 'execute_cli'] : ['execute_sql', 'apply_migration']).map(name => ({ name, description: name })),
  }))
  const record = event => appendFile(${JSON.stringify(events)}, JSON.stringify(event) + '\\n')
  const selected = provider => views.find(view => view.provider === provider)
  ctx.provide('cloudConnections', {
    async list() { return views },
    async restore() { return views },
    async start(provider) {
      const view = selected(provider)
      Object.assign(view, { status: 'authorizing', attemptId: 'owned-cli-attempt',
        code: 'PUBLIC-CODE', prompt: { id: 'browser-response', kind: 'secret' } })
      return { attemptId: view.attemptId, url: 'https://aws.example/authorize' }
    },
    async complete(provider, promptId, response) {
      const view = selected(provider)
      if (promptId === 'browser-response') {
        if (response !== 'private-browser-response') throw new Error('incorrect browser response')
        view.prompt = { id: 'replace-profile', kind: 'select', purpose: 'replace-aws-login' }
      } else {
        if (promptId !== 'replace-profile' || response !== 'yes') throw new Error('incorrect explicit choice')
        delete view.prompt
        view.status = 'choose-permissions'
      }
      await record({ operation: 'complete', kind: promptId })
      return views
    },
    async cancel(provider, attemptId) {
      if (attemptId !== selected(provider).attemptId) throw new Error('wrong attempt')
      await record({ operation: 'cancel', provider })
      return views
    },
    async confirm(provider, names) {
      Object.assign(selected(provider), { status: 'connected', enabledTools: names })
      await record({ operation: 'confirm', provider, names })
      return views
    },
    async disconnect() { throw new Error('unexpected global disconnect') },
  })
}
`)
    const patch = join(f.dir, 'consent.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'cloud-connectors', disabled: true },
      { insert: [{ id: 'cloud-consent-fixture', name: provider }] },
    ]) + '\n')
    const login = await f.run(['--patch', patch, 'login', 'aws', '--secret-stdin'], 'private-browser-response\r\nyes\r\n')
    expect(login.exitCode, login.stderr).toBe(0)
    expect(login.stdout).toContain('Authorization code: PUBLIC-CODE')
    expect(login.stdout).toContain('aws: signed in.')
    expect(login.stdout + login.stderr).not.toContain('private-browser-response')
    expect((await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
      { operation: 'complete', kind: 'browser-response' },
      { operation: 'complete', kind: 'replace-profile' },
    ])
    const missingInput = await f.run(['--patch', patch, 'login', 'aws'])
    expect(missingInput.exitCode).toBe(1)
    expect(missingInput.stderr).toContain('Use a terminal or pass --secret-stdin')
    const review = await f.run(['--patch', patch, 'tools', 'supabase'])
    expect(review.exitCode).toBe(0)
    expect(review.stdout).toContain('[disabled] execute_sql')
    const exact = await f.run(['--patch', patch, 'tools', 'supabase', '--enable', 'execute_sql,apply_migration'])
    expect(exact.exitCode).toBe(0)
    expect(exact.stdout).toContain('supabase: saved 2 allowed tools.')
    expect(exact.stdout).toContain('[enabled] apply_migration')
    const all = await f.run(['--patch', patch, 'tools', 'aws', '--all'])
    expect(all.exitCode).toBe(0)
    expect(all.stdout).toContain('aws: saved 2 allowed tools.')
    const none = await f.run(['--patch', patch, 'tools', 'aws', '--none'])
    expect(none.exitCode).toBe(0)
    expect(none.stdout).toContain('aws: saved 0 allowed tools.')
    const operations = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(operations.slice(2)).toEqual([
      { operation: 'cancel', provider: 'aws' },
      { operation: 'confirm', provider: 'supabase', names: ['execute_sql', 'apply_migration'] },
      { operation: 'confirm', provider: 'aws', names: ['search_docs', 'execute_cli'] },
      { operation: 'confirm', provider: 'aws', names: [] },
    ])
  })
})

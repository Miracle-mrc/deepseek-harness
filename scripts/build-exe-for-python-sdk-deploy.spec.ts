/** Real pnpm deployment preserves locked archives and workspace peer instances. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { c as tar } from 'tar'
import { dump, load } from 'js-yaml'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { pnpmInvocation } from './executable-packaging.ts'
import { assertStagedBuildsApproved, deduplicateStagedWorkspacePackages, materializeStagedLinks, relocateStagedBuildApprovals } from './build-exe-for-python-sdk-staging.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, parseCoverageTestTimeout } from './coverage-partitions.ts'

// Multiple pnpm processes share one integration case; preserve a larger CI lane budget.
const integrationTimeout = Math.max(90_000, parseCoverageTestTimeout(process.env[COVERAGE_TEST_TIMEOUT_ENV]) ?? 0)

it('deploys the locked registry version and one workspace peer instance after a newer release appears', { timeout: integrationTimeout }, async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-python-locked-deploy-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const userConfig = join(root, 'user.npmrc')
  const globalConfig = join(root, 'global.npmrc')
  await writeFile(userConfig, '')
  await writeFile(globalConfig, '')
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm|pnpm)_config_/iu.test(key))),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
  }
  const archives = new Map<string, Buffer>()
  for (const version of ['1.0.0', '1.1.0']) {
    const directory = join(root, version, 'package')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'fixture-versioned', version, type: 'module', exports: './index.js',
    }))
    await writeFile(join(directory, 'index.js'), `export const version = '${version}'\n`)
    const archive = join(root, `${version}.tgz`)
    await tar({ cwd: join(root, version), file: archive, gzip: true }, ['package'])
    archives.set(version, await readFile(archive))
  }
  let latest = '1.0.0'
  let origin = ''
  const server = createServer((request, response) => {
    if (request.url === '/fixture-versioned') {
      const versions = Object.fromEntries([...archives]
        .filter(([version]) => latest === '1.1.0' || version === '1.0.0')
        .map(([version, bytes]) => [version, {
          name: 'fixture-versioned', version,
          dist: { tarball: `${origin}/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
        }]))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: 'fixture-versioned', 'dist-tags': { latest }, versions,
        time: { '1.0.0': '2000-01-01T00:00:00Z', '1.1.0': '2000-01-02T00:00:00Z' } }))
      return
    }
    const bytes = archives.get(request.url?.slice(1, -4) ?? '')
    response.statusCode = bytes === undefined ? 404 : 200
    response.end(bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  test.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture registry has no TCP address')
  origin = `http://127.0.0.1:${address.port}`

  const execute = async (command: string, args: string[], cwd: string): Promise<string> => {
    const controller = new AbortController()
    const child = execa(command, args, {
      cwd, env: environment, extendEnv: false, reject: false, all: true, stdin: 'ignore',
      timeout: 60_000, forceKillAfterDelay: 3_000, cancelSignal: controller.signal, maxBuffer: 1_048_576,
    })
    test.onTestFinished(async () => {
      controller.abort()
      await child
    })
    const result = await child
    const output = result.all ?? ''
    expect(result.timedOut, output).toBe(false)
    expect(result.isCanceled, output).toBe(false)
    expect(result.signal, output).toBeUndefined()
    expect(result.exitCode, output).toBe(0)
    return output
  }
  const cache = join(root, 'cache')
  const pnpm = async (args: string[]): Promise<string> => {
    const [command, invocation] = pnpmInvocation([...args, `--config.registry=${origin}`,
      `--store-dir=${join(root, 'store')}`, `--config.cache-dir=${cache}`])
    return execute(command, invocation, root)
  }
  await writeFile(join(root, 'package.json'), '{"private":true}\n')
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\nautoInstallPeers: true\nallowBuilds:\n  fixture-plugin@file:packages/fixture-plugin: true\n  fixture-denied@file:packages/fixture-denied: false\n')
  const packages = [
    { name: 'fixture-service', fields: {}, source: 'export const identity = {}\n' },
    { name: 'fixture-plugin', fields: { peerDependencies: { 'fixture-service': '*' }, devDependencies: { 'fixture-service': 'workspace:*' }, scripts: { postinstall: 'node install.cjs' } }, source: 'export { identity } from "fixture-service"\n' },
    { name: 'fixture-denied', fields: { scripts: { postinstall: 'node install.cjs' } }, source: 'export {}\n' },
    { name: 'fixture-unlisted', fields: { scripts: { postinstall: 'node install.cjs' } }, source: 'export {}\n' },
    { name: 'fixture-app', fields: { dependencies: { 'fixture-versioned': '^1.0.0', 'fixture-plugin': 'workspace:*', 'fixture-service': 'workspace:*', 'fixture-denied': 'workspace:*', 'fixture-unlisted': 'workspace:*' } },
      source: 'import { identity } from "fixture-service"; import { identity as peer } from "fixture-plugin"; import { version } from "fixture-versioned"; console.log(JSON.stringify({ singleton: identity === peer, version }))\n' },
  ]
  for (const { name, fields, source } of packages) {
    const directory = join(root, 'packages', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js', files: ['index.js', 'install.cjs'], ...fields }))
    await writeFile(join(directory, 'index.js'), source)
    await writeFile(join(directory, 'install.cjs'), 'require("node:fs").writeFileSync("built.txt", "built")\n')
  }
  await pnpm(['install', '--ignore-scripts'])
  const locked = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  latest = '1.1.0'
  await rm(cache, { recursive: true, force: true })
  const staging = join(root, 'payload')
  await pnpm(['--filter', 'fixture-app', 'deploy', '--prod', '--ignore-scripts',
    '--config.node-linker=hoisted', '--config.hoist-workspace-packages=false', staging])
  for (const name of ['fixture-plugin', 'fixture-denied', 'fixture-unlisted']) {
    await expect(readFile(join(staging, 'node_modules', name, 'built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await relocateStagedBuildApprovals(staging, root)
  const rebuildArgs = ['--dir', staging, '--config.node-linker=hoisted', 'rebuild']
  const rebuilt = await pnpm(rebuildArgs)
  await expect(readFile(join(staging, 'node_modules/fixture-plugin/built.txt'), 'utf8'), rebuilt).resolves.toBe('built')
  await expect(readFile(join(staging, 'node_modules/fixture-denied/built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(staging, 'node_modules/fixture-unlisted/built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(assertStagedBuildsApproved(staging)).rejects.toThrow('fixture-unlisted')
  const settingsPath = join(staging, 'pnpm-workspace.yaml')
  const settings: unknown = load(await readFile(settingsPath, 'utf8'))
  if (typeof settings !== 'object' || settings === null || !('allowBuilds' in settings)
    || typeof settings.allowBuilds !== 'object' || settings.allowBuilds === null) throw new Error('Fixture build approvals are missing')
  Reflect.set(settings.allowBuilds, `fixture-unlisted@${pathToFileURL(await realpath(join(root, 'packages/fixture-unlisted'))).href}`, false)
  await writeFile(settingsPath, dump(settings))
  await pnpm(rebuildArgs)
  await assertStagedBuildsApproved(staging)
  await expect(readFile(join(staging, 'node_modules/fixture-unlisted/built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await materializeStagedLinks(staging)
  await deduplicateStagedWorkspacePackages(staging, staging)
  expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(locked)
  const output = await execute(process.execPath, [resolve(staging, 'index.js')], staging)
  expect(JSON.parse(output)).toEqual({ singleton: true, version: '1.0.0' })
})

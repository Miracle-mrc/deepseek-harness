/** The installed main bundle retains lazy updater initialization without unshipped chunks. */

import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, matchesGlob } from 'node:path'
import { build, type UserConfig } from 'tsdown'
import { importWithError } from 'tsdown/internal'
import { expect, it, onTestFinished } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it('ships every main-process chunk and initializes updates only for a standard startup', async () => {
  const { default: configurations } = await importWithError<{ default: UserConfig[] }>(new URL('../tsdown.config.ts', import.meta.url).href)
  const config = configurations.find(config => Array.isArray(config.entry) && config.entry.includes('lib/types/main.js'))
  if (config === undefined) throw new Error('Desktop main bundle configuration is missing')
  const root = await mkdtemp(join(tmpdir(), 'desktop-main-bundle-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const output = join(root, 'output')
  const installed = join(root, 'installed')
  await mkdir(source)
  await mkdir(join(installed, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(installed, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(source, 'main.js'), `
export async function start(preview) {
  const UpdateCoordinator = preview ? undefined : (await import('./update-coordinator.js')).DesktopUpdateCoordinator
  return UpdateCoordinator === undefined ? 'preview' : new UpdateCoordinator().state
}
`)
  await writeFile(join(source, 'update-coordinator.js'), `
console.log('updater-service-initialized')
export class DesktopUpdateCoordinator { state = 'ready' }
`)
  await build({ ...config, config: false, entry: { main: join(source, 'main.js') }, outDir: output,
    plugins: [], onSuccess: () => {}, sourcemap: false, logLevel: 'silent' })
  const builder = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.main-bundle', DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  const chunks = (await readdir(output)).filter(file => file.endsWith('.js'))
  const shipped = chunks.filter(file => builder.files.some(pattern => typeof pattern === 'string' && matchesGlob(`lib/${file}`, pattern)))
  expect(shipped).toEqual(chunks)
  for (const file of shipped) await copyFile(join(output, file), join(installed, 'lib', file))
  expect(await readFile(join(installed, 'lib', 'main.js'), 'utf8')).toContain('updater-service-initialized')
  for (const preview of [true, false]) {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval',
      `import { start } from './lib/main.js'; console.log('runtime-loaded'); console.log(await start(${String(preview)}))`],
    { cwd: installed, windowsHide: true, encoding: 'utf8', timeout: 5000,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } })
    expect(stdout.trim().split(/\r?\n/u)).toEqual(preview
      ? ['runtime-loaded', 'preview'] : ['runtime-loaded', 'updater-service-initialized', 'ready'])
  }
})

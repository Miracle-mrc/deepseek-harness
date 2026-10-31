import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { initializeDesktopDistribution, resolveDesktopRuntimeDistribution, type DesktopDistributionApplication } from '../src/distribution.ts'
import { mergeLoginShellEnvironment } from '../src/login-shell-environment.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { SCHEME } from '../src/ipc.ts'
import { resolveDesktopDistributionIdentity } from '../scripts/desktop-distribution-identity.mjs'

function application(packaged = true) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-distribution-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return {
    isPackaged: packaged,
    getPath: vi.fn((_name: 'appData') => directory),
    setPath: vi.fn(),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
  } satisfies DesktopDistributionApplication
}

describe('desktop packaged distribution', () => {
  it('uses the same preview identity as installer metadata while retaining internal document origins', () => {
    const identity = resolveDesktopDistributionIdentity('fork-preview')
    expect(resolveDesktopRuntimeDistribution({ dshDistribution: identity.distribution }, true)).toEqual({
      kind: 'fork-preview', appId: identity.appId, packageName: identity.packageName,
      productName: identity.productName, protocol: identity.protocol, updatesEnabled: false,
    })
    expect(identity.protocol).not.toBe('dsh')
    expect(SCHEME).toBe('dsh-app')
  })

  it.each([undefined, null, {}, { dshDistribution: undefined }, { dshDistribution: 'preview' },
    { name: 'deepseek-harness-miracle-preview', productName: 'DeepSeek Harness Miracle Preview' }])(
    'keeps standard behavior without the explicit marker in packaged metadata %j', (manifest) => {
      const app = application()
      const environment = { DSH_DESKTOP_DISTRIBUTION: 'fork-preview' }
      expect(initializeDesktopDistribution(app, manifest, environment)).toEqual({
        kind: 'standard', protocol: 'dsh', productName: 'DeepSeek Harness', updatesEnabled: true,
      })
      expect(app.getPath).not.toHaveBeenCalled()
      expect(app.setPath).not.toHaveBeenCalled()
      expect(app.setName).not.toHaveBeenCalled()
      expect(app.setAppUserModelId).not.toHaveBeenCalled()
      expect(environment).toEqual({ DSH_DESKTOP_DISTRIBUTION: 'fork-preview' })
    },
  )

  it('ignores preview metadata in unpackaged development', () => {
    const app = application(false)
    const environment: NodeJS.ProcessEnv = {}
    expect(initializeDesktopDistribution(app, { dshDistribution: 'fork-preview' }, environment).kind).toBe('standard')
    expect(app.setPath).not.toHaveBeenCalled()
    expect(environment.DSH_HOME).toBeUndefined()
  })

  it.each([undefined, '', ' \t\n'])('defaults missing or blank home %j to a private profile and creates userData', (override) => {
    const app = application()
    const environment: NodeJS.ProcessEnv = override === undefined ? {} : { DSH_HOME: override }
    const userHome = join(tmpdir(), 'preview-test-account')
    initializeDesktopDistribution(app, { dshDistribution: 'fork-preview' }, environment, userHome)
    const userData = join(app.getPath('appData'), 'deepseek-harness-miracle-preview')
    expect(statSync(userData).isDirectory()).toBe(true)
    expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', userData)
    expect(app.setName).toHaveBeenCalledExactlyOnceWith('DeepSeek Harness Miracle Preview')
    expect(app.setAppUserModelId).toHaveBeenCalledExactlyOnceWith('io.github.miracle-mrc.deepseek-harness.preview')
    expect(environment.DSH_HOME).toBe(join(userHome, '.dsh-miracle-preview'))
    expect(resolveDesktopPaths(environment.DSH_HOME).profile).toBe(join(userHome, '.dsh-miracle-preview', 'profiles', 'desktop'))
    expect(resolveDesktopPaths(environment.DSH_HOME).profile).not.toBe(resolveDesktopPaths(join(userHome, '.dsh')).profile)
  })

  it.each(['/custom/home', ' /literal/home '])('preserves explicit home %j through login-shell and Host environment setup', (override) => {
    const app = application()
    const environment = { DSH_HOME: override, PATH: 'inherited-path' }
    initializeDesktopDistribution(app, { dshDistribution: 'fork-preview' }, environment)
    expect(environment.DSH_HOME).toBe(override)
    const merged = mergeLoginShellEnvironment(environment, { DSH_HOME: '/shell/official-home', PATH: 'login-shell-path' })
    expect(desktopNodeEnvironment('/electron', undefined, merged)).toMatchObject({
      DSH_HOME: override, PATH: 'login-shell-path', ELECTRON_RUN_AS_NODE: '1',
    })
  })
})

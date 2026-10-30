import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AppInfo, Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'
import { resolveDesktopDistributionIdentity } from '../scripts/desktop-distribution-identity.mjs'
import { forkPreviewPackageEnvironment, localMacOSPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const { verifyDesktopRuntime, writeMacOSAppUpdateConfig } = vi.hoisted(() => ({
  verifyDesktopRuntime: vi.fn(async () => undefined),
  writeMacOSAppUpdateConfig: vi.fn(async () => { throw new Error('fork-preview wrote updater configuration') }),
}))
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime }))
vi.mock('../scripts/macos-app-update-config.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/macos-app-update-config.mjs')>(), writeMacOSAppUpdateConfig,
}))
vi.mock('../scripts/windows-asar-unpack.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-asar-unpack.mjs')>(), verifyWindowsAsarUnpack: async () => undefined,
}))

const FORBIDDEN_SETTINGS = [
  'DSH_PACKAGING_PRESET', 'DSH_PACKAGING_CONFIG_DIR',
  'DSH_DESKTOP_AUTO_UPDATE_ENV', 'DSH_DESKTOP_UPDATE_CHANNEL',
  'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_MACOS_SIGNING_IDENTITY', 'DSH_DESKTOP_MACOS_TEAM_ID',
  'CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_KEYCHAIN_PROFILE',
  'DOWNLOAD_TEST_RELEASE_ID', 'DOWNLOAD_TEST_ORIGIN', 'DOWNLOAD_PROD_COS_SECRET_KEY',
] as const

function unreadableReleaseSettings(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of FORBIDDEN_SETTINGS) Object.defineProperty(environment, name, {
    enumerable: true,
    get: () => { throw new Error(`fork-preview read ${name}`) },
  })
  return environment
}

describe('fork-preview packaging', () => {
  it('uses distinct installer, application and external-protocol names while preserving the standard identity', () => {
    expect(resolveDesktopDistributionIdentity('fork-preview')).toEqual({
      appId: 'io.github.miracle-mrc.deepseek-harness.preview', packageName: 'deepseek-harness-miracle-preview',
      artifactNamePrefix: 'deepseek-harness-miracle-preview',
      productName: 'DeepSeek Harness Miracle Preview', protocol: 'dsh-miracle-preview', distribution: 'fork-preview',
    })
    expect(resolveDesktopDistributionIdentity()).toEqual({
      appId: 'com.deepseek.harness', packageName: '@deepseek-ai/dsh-desktop', artifactNamePrefix: 'deepseek-harness',
      productName: 'DeepSeek Harness', protocol: 'dsh', distribution: undefined,
    })
    for (const value of ['', 'official', 'other-preview']) expect(() => resolveDesktopDistributionIdentity(value)).toThrow('DSH_DESKTOP_DISTRIBUTION')
  })

  it('selects public settings without reading inherited credentials, machine presets, policy or updater values', () => {
    const parent = unreadableReleaseSettings({
      PATH: 'build-tools', HTTPS_PROXY: 'http://proxy.example:8080',
      DSH_DESKTOP_APP_ID: 'com.example.machine', DSH_DESKTOP_UNSIGNED: '0',
      DSH_DESKTOP_NPM_REGISTRY: 'https://private.example',
      PACKAGE_TEST_RELEASE_ID: 'invalid', PACKAGE_WINDOWS_COMPRESSION_LEVEL: 'invalid', PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL: 'invalid',
      dsh_desktop_windows_token_pin: 'case-insensitive-credential',
    })
    expect(forkPreviewPackageEnvironment(parent)).toEqual({
      PATH: 'build-tools', HTTPS_PROXY: 'http://proxy.example:8080',
      DSH_DESKTOP_DISTRIBUTION: 'fork-preview', DSH_DESKTOP_APP_ID: 'io.github.miracle-mrc.deepseek-harness.preview',
      DSH_DESKTOP_NPM_REGISTRY: 'https://registry.npmjs.org/', DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
    expect(parent.DSH_DESKTOP_APP_ID).toBe('com.example.machine')
    expect(parent.DSH_DESKTOP_UNSIGNED).toBe('0')
  })

  it.each(['win32', 'darwin'] as const)('validates unsigned %s without reading signing, policy or update settings', (platform) => {
    const environment = unreadableReleaseSettings(forkPreviewPackageEnvironment({}))
    expect(() => { validateDesktopPackageEnvironment(environment, { platform, arch: 'x64' }, { unsigned: true, forkPreview: true }) }).not.toThrow()
    for (const options of [{}, { unsigned: true, prepareOnly: true }, { unsigned: true, skipNotarization: true }]) {
      expect(() => { validateDesktopPackageEnvironment(environment, { platform, arch: 'x64' }, options) }).toThrow('fork-preview requires unsigned packaging')
    }
    expect(() => {
      validateDesktopPackageEnvironment(localMacOSPackageEnvironment({}), { platform, arch: 'x64' }, { unsigned: true, forkPreview: true })
    }).toThrow('fork-preview requires its public packaging environment')
  })

  it.each([
    ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'],
  ] as const)('creates isolated unsigned %s %s installers without update or signing configuration', async (platform, arch) => {
    verifyDesktopRuntime.mockClear()
    writeMacOSAppUpdateConfig.mockClear()
    const environment = unreadableReleaseSettings(forkPreviewPackageEnvironment({}))
    const config = createElectronBuilderConfig(environment, platform, arch)
    expect(config).toMatchObject({
      appId: 'io.github.miracle-mrc.deepseek-harness.preview', productName: 'DeepSeek Harness Miracle Preview',
      protocols: [{ name: 'DeepSeek Harness Miracle Preview', schemes: ['dsh-miracle-preview'] }],
      artifactName: 'deepseek-harness-miracle-preview-${version}-${os}-${arch}-unsigned.${ext}',
      extraMetadata: {
        name: 'deepseek-harness-miracle-preview', dshDistribution: 'fork-preview',
        dshDesktopAppId: 'io.github.miracle-mrc.deepseek-harness.preview',
      },
      publish: null, win: { forceCodeSigning: false, signtoolOptions: { sign: undefined, publisherName: undefined } },
      mac: { identity: '-', forceCodeSigning: false, notarize: false, target: ['dmg'] },
      dmg: { sign: false, writeUpdateInfo: false },
    })
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.extraMetadata).not.toHaveProperty('dshDesktopUpdateChannel')
    expect(config.directories.output).toMatch(/unsigned-artifacts$/u)
    const packager = new Packager({ projectDir: tmpdir() })
    const product: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof product !== 'object' || product === null) throw new Error('desktop package is not an object')
    Object.defineProperties(packager, { config: { value: config }, metadata: { value: { ...product, ...config.extraMetadata } } })
    const appInfo = new AppInfo(packager, undefined)
    expect(appInfo.name).toBe('deepseek-harness-miracle-preview')
    expect(appInfo.productFilename).toBe('DeepSeek Harness Miracle Preview')
    const context = { appOutDir: 'preview', electronPlatformName: platform, packager: { getResourcesDir: () => 'preview/resources' } }
    await config.afterPack(context as never)
    await config.afterSign(context as never)
    await config.artifactBuildCompleted({ file: 'preview.dmg' })
    expect(verifyDesktopRuntime).toHaveBeenCalledOnce()
    expect(writeMacOSAppUpdateConfig).not.toHaveBeenCalled()
  })

  it('rejects signed preview builder configuration and leaves ordinary unsigned Windows policy validation intact', () => {
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_DISTRIBUTION: 'fork-preview', DSH_DESKTOP_UNSIGNED: '0' }, 'darwin', 'arm64'))
      .toThrow('fork-preview requires unsigned packaging')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.release', DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64'))
      .toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
    const ordinary = createElectronBuilderConfig(localMacOSPackageEnvironment({}), 'darwin', 'arm64')
    expect(ordinary).toMatchObject({
      appId: 'com.deepseek.harness', productName: 'DeepSeek Harness', protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }],
      artifactName: 'deepseek-harness-${version}-${os}-${arch}-unsigned.${ext}',
    })
    expect(ordinary.extraMetadata).not.toHaveProperty('name')
    expect(ordinary.extraMetadata).not.toHaveProperty('dshDistribution')
    expect(ordinary.extraMetadata).toHaveProperty('dshDesktopUpdateChannel', 'nightly')
  })
})

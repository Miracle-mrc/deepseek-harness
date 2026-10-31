import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const { requireDesktopToolchain, loadDesktopPackageEnvironment, localMacOSPackageEnvironment } = vi.hoisted(() => ({
  requireDesktopToolchain: vi.fn(async () => undefined),
  loadDesktopPackageEnvironment: vi.fn(() => { throw new Error('fork-preview read release configuration') }),
  localMacOSPackageEnvironment: vi.fn(() => { throw new Error('fork-preview selected the standard identity') }),
}))
vi.mock('../scripts/desktop-package-environment.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-package-environment.mjs')>(),
  loadDesktopPackageEnvironment, localMacOSPackageEnvironment,
}))
vi.mock('../scripts/desktop-toolchain-preflight.ts', () => ({ requireDesktopToolchain }))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it.each([
  ['win-x64', 'win32', 'x64'], ['mac-arm64', 'darwin', 'arm64'], ['mac-x64', 'darwin', 'x64'],
] as const)('checks the public %s entry point without loading dotenv files, presets or signing files', async (target, platform, arch) => {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedArch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const savedArgv = process.argv
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubEnv('DSH_PACKAGING_PRESET', 'invalid-machine-preset')
  vi.stubEnv('DSH_PACKAGING_CONFIG_DIR', '/missing-machine-configuration')
  vi.stubEnv('DSH_DESKTOP_WINDOWS_CER_FILE', '/missing-machine-certificate')
  vi.stubEnv('APPLE_API_KEY', '/missing-apple-key')
  try {
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: platform })
    Object.defineProperty(process, 'arch', { ...savedArch, value: arch })
    process.argv = [process.execPath, fileURLToPath(new URL('../scripts/package-target.ts', import.meta.url)), target, '--fork-preview', '--check']
    vi.resetModules()
    await import('../scripts/package-target.ts')
    expect(loadDesktopPackageEnvironment).not.toHaveBeenCalled()
    expect(localMacOSPackageEnvironment).not.toHaveBeenCalled()
    expect(requireDesktopToolchain).toHaveBeenCalledExactlyOnceWith(platform, expect.objectContaining({
      DSH_DESKTOP_DISTRIBUTION: 'fork-preview', DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_APP_ID: 'io.github.miracle-mrc.deepseek-harness.preview',
    }))
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`${target} would publish`))
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform)
    Object.defineProperty(process, 'arch', savedArch)
    process.argv = savedArgv
    stdout.mockRestore()
  }
})

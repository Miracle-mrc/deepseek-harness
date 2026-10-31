import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'

const { smokePreparedRuntime, verifyWindowsCode, verifyDesktopRuntime } = vi.hoisted(() => ({
  smokePreparedRuntime: vi.fn(async () => undefined), verifyWindowsCode: vi.fn(async () => undefined),
  verifyDesktopRuntime: vi.fn(async () => 'verified-runtime'),
}))
vi.mock('../src/runtime-tree.ts', () => ({
  readDesktopRuntime: () => ({ release: { version: '0.2.2-alpha.2' } }), verifyDesktopRuntime,
}))
vi.mock('../scripts/smoke-prepared-runtime.ts', () => ({ smokePreparedRuntime }))
vi.mock('../scripts/windows-runtime-signature.mjs', () => ({ verifyWindowsCode }))
vi.mock('../scripts/package-target.ts', () => ({ resolveDesktopPackageTarget: vi.fn() }))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it.each([
  ['win-x64', 'win32', 'x64'], ['mac-arm64', 'darwin', 'arm64'], ['mac-x64', 'darwin', 'x64'],
] as const)('smokes the assembled %s executable under the selected distribution name', async (target, platform, arch) => {
  const savedArgv = process.argv
  vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', platform)
  vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', arch)
  try {
    for (const [distribution, name] of [[undefined, 'DeepSeek Harness'], ['fork-preview', 'DeepSeek Harness Miracle Preview']] as const) {
      vi.stubEnv('DSH_DESKTOP_DISTRIBUTION', distribution)
      process.argv = [process.execPath, 'smoke-packaged-runtime.ts', '--unsigned']
      vi.resetModules()
      await import('../scripts/smoke-packaged-runtime.ts')
      const paths = desktopTargetBuildPaths(target)
      const application = platform === 'win32' ? join(paths.unsignedArtifacts, 'win-unpacked')
        : join(paths.unsignedArtifacts, arch === 'arm64' ? 'mac-arm64' : 'mac', `${name}.app`, 'Contents')
      const resources = join(application, platform === 'win32' ? 'resources' : 'Resources')
      const executable = platform === 'win32' ? join(application, `${name}.exe`) : join(application, 'MacOS', name)
      expect(smokePreparedRuntime).toHaveBeenLastCalledWith(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), 'verified-runtime')
    }
    expect(verifyDesktopRuntime).toHaveBeenCalledTimes(2)
    expect(verifyWindowsCode).not.toHaveBeenCalled()
  } finally { process.argv = savedArgv }
})

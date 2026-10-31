/** Packaged distribution selection and data isolation before Electron startup reads. */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Runtime identity sealed by the packaged manifest; development always keeps the standard identity. */
export type DesktopRuntimeDistribution = {
  readonly kind: 'standard'
  readonly protocol: 'dsh'
  readonly productName: 'DeepSeek Harness'
  readonly updatesEnabled: true
} | {
  readonly kind: 'fork-preview'
  readonly appId: 'io.github.miracle-mrc.deepseek-harness.preview'
  readonly packageName: 'deepseek-harness-miracle-preview'
  readonly productName: 'DeepSeek Harness Miracle Preview'
  readonly protocol: 'dsh-miracle-preview'
  readonly updatesEnabled: false
}

/** Electron operations used before locale, logs, Chromium storage, and single-instance ownership. */
export interface DesktopDistributionApplication {
  readonly isPackaged: boolean
  getPath(name: 'appData'): string
  setPath(name: 'userData', path: string): void
  setName(name: string): void
  setAppUserModelId(appId: string): void
}

/**
 * Select preview behavior only from the explicit packaged distribution marker.
 * @param manifest - Parsed packaged manifest; absent or unrelated metadata selects standard behavior.
 * @param packaged - Whether Electron is running an installed package.
 * @returns Runtime identity and whether upstream update services may be created.
 */
export function resolveDesktopRuntimeDistribution(manifest: unknown, packaged: boolean): DesktopRuntimeDistribution {
  if (packaged && typeof manifest === 'object' && manifest !== null
    && 'dshDistribution' in manifest && manifest.dshDistribution === 'fork-preview') {
    return {
      kind: 'fork-preview',
      appId: 'io.github.miracle-mrc.deepseek-harness.preview',
      packageName: 'deepseek-harness-miracle-preview',
      productName: 'DeepSeek Harness Miracle Preview',
      protocol: 'dsh-miracle-preview',
      updatesEnabled: false,
    }
  }
  return { kind: 'standard', protocol: 'dsh', productName: 'DeepSeek Harness', updatesEnabled: true }
}

/**
 * Apply preview identity before the first userData read, log setup, or single-instance lock.
 * Standard builds leave Electron and the environment unchanged. Preview builds preserve an explicit
 * nonblank DSH_HOME and otherwise select a private Harness home, inherited by every Host process.
 * @param application - Electron application before ready.
 * @param manifest - Parsed packaged metadata; development metadata cannot activate preview behavior.
 * @param environment - Launcher environment updated only when a preview home default is needed.
 * @param userHome - User home directory; omitted callers use the operating-system account home.
 * @returns Selected runtime distribution after its startup identity has been applied.
 */
export function initializeDesktopDistribution(
  application: DesktopDistributionApplication,
  manifest: unknown,
  environment: NodeJS.ProcessEnv,
  userHome: string = homedir(),
): DesktopRuntimeDistribution {
  const distribution = resolveDesktopRuntimeDistribution(manifest, application.isPackaged)
  if (distribution.kind === 'standard') return distribution
  const userData = join(application.getPath('appData'), distribution.packageName)
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  application.setName(distribution.productName)
  application.setAppUserModelId(distribution.appId)
  application.setPath('userData', userData)
  if (environment.DSH_HOME === undefined || environment.DSH_HOME.trim() === '') {
    environment.DSH_HOME = join(userHome, '.dsh-miracle-preview')
  }
  return distribution
}

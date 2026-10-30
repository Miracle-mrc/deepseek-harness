/** Public names used by Desktop installers and packaged-runtime verification. */

/**
 * Resolve the standard product identity or the isolated Miracle fork preview.
 * Ordinary release environments may override the default application identifier.
 * @param {string | undefined} distribution Explicit packaging distribution; absent selects the standard product.
 * @returns {{ appId: string, packageName: string, artifactNamePrefix: string, productName: string, protocol: string, distribution: 'fork-preview' | undefined }} Installer and external-protocol identity.
 */
export function resolveDesktopDistributionIdentity(distribution = undefined) {
  if (distribution === 'fork-preview') return {
    appId: 'io.github.miracle-mrc.deepseek-harness.preview',
    packageName: 'deepseek-harness-miracle-preview',
    artifactNamePrefix: 'deepseek-harness-miracle-preview',
    productName: 'DeepSeek Harness Miracle Preview',
    protocol: 'dsh-miracle-preview',
    distribution,
  }
  if (distribution !== undefined) throw new Error('desktop package: DSH_DESKTOP_DISTRIBUTION must be fork-preview when set')
  return {
    appId: 'com.deepseek.harness',
    packageName: '@deepseek-ai/dsh-desktop',
    artifactNamePrefix: 'deepseek-harness',
    productName: 'DeepSeek Harness',
    protocol: 'dsh',
    distribution: undefined,
  }
}

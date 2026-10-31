/** Public names used by Desktop installers and packaged-runtime verification. */

/** Installer and external-protocol names for one supported Desktop distribution. */
export interface DesktopDistributionIdentity {
  readonly appId: string
  readonly packageName: string
  readonly artifactNamePrefix: string
  readonly productName: string
  readonly protocol: string
  readonly distribution: 'fork-preview' | undefined
}

/**
 * Resolve the standard product identity or the isolated Miracle fork preview.
 * Ordinary release environments may override the default application identifier.
 * @param distribution Explicit packaging distribution; absent selects the standard product.
 * @returns Installer and external-protocol identity.
 */
export function resolveDesktopDistributionIdentity(distribution?: string): DesktopDistributionIdentity

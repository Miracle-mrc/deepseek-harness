/** Bundle admission for complete applications that cannot share a profile stack. */

/** A standalone bundle was selected alongside another profile layer. */
export class UnsupportedBundleSelectionError extends Error {
  /** @param packageName - Complete application's bundle package name. */
  constructor(packageName: string) {
    super(`${packageName}: standalone bundles must be the only selected profile bundle`)
    this.name = 'UnsupportedBundleSelectionError'
  }
}

/**
 * Validate standalone metadata and reject a complete application mixed with another bundle.
 * @param packageName - Bundle package whose declaration is being admitted.
 * @param standalone - Optional raw `dsh.bundle.standalone` metadata; omission permits layering.
 * @param selectedNames - Complete proposed profile selection, including this bundle.
 * @throws When metadata is not boolean or a standalone bundle is not the sole selection.
 */
export function assertBundleSelection(packageName: string, standalone: unknown, selectedNames: readonly string[]): void {
  if (standalone !== undefined && typeof standalone !== 'boolean') {
    throw new Error(`${packageName}: dsh.bundle.standalone must be a boolean`)
  }
  if (standalone === true && (selectedNames.length !== 1 || selectedNames[0] !== packageName)) {
    throw new UnsupportedBundleSelectionError(packageName)
  }
}

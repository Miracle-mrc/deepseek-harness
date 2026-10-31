/** One process in a bounded observation of the smoke Host's tree; never includes arguments or environment. */
export interface OfficeSmokeProcess {
  readonly pid: number
  readonly parentPid: number
  readonly name: string
  readonly started: string
  readonly cpuMs: number
  readonly rssBytes: number
  readonly priority: string
}

/**
 * Select probe necessities with Windows case-insensitive matching and original spelling.
 * @param environment Host environment to filter; credential and unrelated fields are omitted.
 * @returns Filtered path, system, module and temporary-directory variables.
 */
export declare function officeSmokeProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/**
 * Inspect the current Host tree without changing processes; rejects when the bounded Windows probe fails.
 * @returns At most 32 observed process records, or undefined on non-Windows hosts.
 */
export declare function sampleOwnedOfficeProcesses(): Promise<readonly OfficeSmokeProcess[] | undefined>

/**
 * Log progress and join diagnostic probes without changing conversion results, errors, or deadlines.
 * @param label Fixed smoke operation identifier; must not contain document content or credentials.
 * @param conversion Real conversion whose result or original error is preserved.
 * @param sampler Windows process probe by default; an injected probe is awaited under the same lifecycle.
 * @returns The conversion result after any diagnostic probe settles.
 */
export declare function traceOfficeSmokeConversion<T>(
  label: string, conversion: () => Promise<T>, sampler?: () => Promise<readonly OfficeSmokeProcess[] | undefined>,
): Promise<T>

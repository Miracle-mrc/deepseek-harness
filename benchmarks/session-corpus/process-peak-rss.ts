/** Process-local lifetime peak RSS for the Session corpus worker. */

import { readFile } from 'node:fs/promises'
import { platform } from 'node:os'

/**
 * Read this process's lifetime peak resident bytes, excluding a Linux parent's pre-exec peak.
 * Linux uses its own memory map's VmHWM; other platforms retain Node's resource-usage counter.
 * @returns process-local peak resident bytes.
 * @throws If the Linux status file cannot be read or its VmHWM counter is unavailable or malformed.
 */
export async function readProcessPeakRssBytes(): Promise<number> {
  if (platform() !== 'linux') return process.resourceUsage().maxRSS * 1024
  const status = await readFile('/proc/self/status', 'utf8')
  const counter = /^VmHWM:[ \t]+([0-9]+)[ \t]+kB[ \t]*$/m.exec(status)
  const bytes = counter === null ? NaN : Number(counter[1]) * 1024
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('Linux process peak RSS is unavailable: /proc/self/status must contain a positive VmHWM counter in kB')
  }
  return bytes
}

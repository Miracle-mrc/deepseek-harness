/** Conversion-only smoke observations; diagnostic probes never change conversion outcomes. */
import { execFile } from 'node:child_process'
import { getPriority } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Preserve Windows spelling for only the probe's required environment variables.
 * @param environment Embedding Host environment.
 * @returns Required path/system/module/temp variables, excluding credentials.
 */
export function officeSmokeProbeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(?:PATH|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PSModulePath|TEMP|TMP)$/iu.test(key)))
}

/**
 * Sample only this Host's observed process tree without arguments or environment.
 * @returns At most 32 Windows process records; undefined on other platforms; rejects if the bounded probe fails.
 */
export async function sampleOwnedOfficeProcesses() {
  if (process.platform !== 'win32') return undefined
  const script = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name)
$owned = [Collections.Generic.HashSet[int]]::new()
$null = $owned.Add(${process.pid})
do {
  $added = $false
  foreach ($row in $rows) {
    if ($owned.Count -ge 32) { break }
    if ($row.ProcessId -ne $PID -and $owned.Contains([int]$row.ParentProcessId)) {
      if ($owned.Add([int]$row.ProcessId)) { $added = $true }
    }
  }
} while ($added -and $owned.Count -lt 32)
$sample = @(foreach ($row in $rows) {
  if (-not $owned.Contains([int]$row.ProcessId)) { continue }
  $item = $null
  try {
    $item = Get-Process -Id $row.ProcessId -ErrorAction Stop
    [ordered]@{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; name=$row.Name;
      started=$item.StartTime.ToUniversalTime().ToString('o'); cpuMs=$item.TotalProcessorTime.TotalMilliseconds;
      rssBytes=$item.WorkingSet64; priority=$item.PriorityClass.ToString() }
  } catch { continue } finally { if ($null -ne $item) { $item.Dispose() } }
})
ConvertTo-Json -InputObject $sample -Compress
`
  const { stdout } = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024,
    env: officeSmokeProbeEnvironment(process.env),
  })
  const rows = JSON.parse(stdout)
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('Invalid owned process sample')
  return rows.map(({ pid, parentPid, name, started, cpuMs, rssBytes, priority }) => {
    if (![pid, parentPid, cpuMs, rssBytes].every(Number.isFinite)
      || ![name, started, priority].every(value => typeof value === 'string')) throw new Error('Invalid process metadata')
    return { pid, parentPid, name, started, cpuMs, rssBytes, priority }
  })
}

/**
 * Trace a real conversion and join nonoverlapping probes without changing its outcome.
 * @param label Fixed operation identifier, never source content or credentials.
 * @param conversion Real conversion to observe.
 * @param sampler Bounded Windows probe by default, or an injected probe with the same lifecycle.
 * @returns The conversion result after probes settle; rejects with the original conversion error.
 */
export async function traceOfficeSmokeConversion(label, conversion, sampler = sampleOwnedOfficeProcesses) {
  const started = performance.now()
  const cpu = process.cpuUsage()
  const errorFacts = error => ({ errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
    ...(typeof error?.code === 'number' ? { exitCode: error.code } : {}),
    ...(typeof error?.signal === 'string' ? { signal: error.signal } : {}),
    ...(typeof error?.killed === 'boolean' ? { killed: error.killed } : {}) })
  const record = (phase, extra = {}) => {
    try {
      console.log(JSON.stringify({ event: 'desktop-office-smoke', label, phase, at: new Date().toISOString(), platform: process.platform,
        elapsedMs: Math.round(performance.now() - started), pid: process.pid, parentPid: process.ppid,
        hostCpuMicros: process.cpuUsage(cpu), hostRssBytes: process.memoryUsage().rss,
        hostPriority: getPriority(), ...extra }))
    } catch (_diagnosticOutputError) {
      // Closed diagnostic channels must not change the real conversion's outcome.
      try { process.stderr.write('desktop Office smoke diagnostic output unavailable\n') } catch (_stderrClosed) { /* Both channels closed. */ }
    }
  }
  let pending
  const sample = reason => pending ??= (async () => {
    try {
      const processes = await sampler()
      record(processes === undefined ? 'sample-unsupported' : 'processes', { reason, processes })
    }
    catch (error) { record('sample-unavailable', { reason, ...errorFacts(error) }) }
  })().finally(() => { pending = undefined })
  record('start')
  const timer = setInterval(() => { void sample('pending') }, 20_000)
  timer.unref()
  try {
    const result = await conversion()
    clearInterval(timer)
    record('end')
    await pending
    return result
  } catch (error) {
    clearInterval(timer)
    record('error', errorFacts(error))
    await sample('error')
    throw error
  } finally {
    clearInterval(timer)
    await pending
  }
}

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { officeSmokeProbeEnvironment, traceOfficeSmokeConversion } from '../scripts/office-smoke-diagnostics.mjs'

function records(): Record<string, unknown>[] {
  return vi.mocked(console.log).mock.calls.map(([value]) => {
    const parsed: unknown = JSON.parse(String(value))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Expected diagnostic record')
    return Object.fromEntries(Object.entries(parsed))
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function capture(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
}

describe('Office smoke conversion observations', () => {
  it('preserves Windows environment casing while excluding credentials and unrelated values', () => {
    expect(officeSmokeProbeEnvironment({ Path: 'tools', windir: 'windows', pSmOdUlEpAtH: 'modules',
      SystemRoot: 'system', TEMP: 'scratch', DEEPSEEK_API_KEY: 'private', GH_TOKEN: 'private', HOME: 'private' }))
      .toEqual({ Path: 'tools', windir: 'windows', pSmOdUlEpAtH: 'modules', SystemRoot: 'system', TEMP: 'scratch' })
  })

  it('reports the start before conversion settles and preserves its result', async () => {
    capture()
    const conversion = Promise.withResolvers<{ pdf: string }>()
    const result = traceOfficeSmokeConversion('service-docx', () => conversion.promise)
    const pdf = { pdf: 'fixture' }
    onTestFinished(async () => { conversion.resolve(pdf); await result })
    expect(records()).toMatchObject([{ label: 'service-docx', phase: 'start', pid: process.pid, parentPid: process.ppid }])
    await vi.advanceTimersByTimeAsync(12)
    conversion.resolve(pdf)
    await expect(result).resolves.toBe(pdf)
    expect(records().map(value => value.phase)).toEqual(['start', 'end'])
    expect(records()[1]).toMatchObject({ elapsedMs: 12 })
    expect(records()[1]).toHaveProperty('hostCpuMicros.user')
    expect(records()[1]).toHaveProperty('hostCpuMicros.system')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the original conversion failure when the process probe also fails', async () => {
    capture()
    const failure = Object.assign(new Error('private document text'), { code: 'timeout' })
    await expect(traceOfficeSmokeConversion('service-docx', () => Promise.reject(failure),
      () => Promise.reject(new Error('private probe output')))).rejects.toBe(failure)
    expect(records().map(value => value.phase)).toEqual(['start', 'error', 'sample-unavailable'])
    expect(records()[1]).toMatchObject({ errorName: 'Error', errorCode: 'timeout' })
    expect(JSON.stringify(records())).not.toMatch(/private document|private probe/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins one pending probe on success and leaves no timer or late diagnostic work', async () => {
    capture()
    const conversion = Promise.withResolvers<undefined>()
    const probe = Promise.withResolvers<[]>()
    const sampler = vi.fn(() => probe.promise)
    let settled = false
    const result = traceOfficeSmokeConversion('service-xlsx', () => conversion.promise, sampler)
      .then(() => { settled = true })
    onTestFinished(async () => { conversion.resolve(undefined); probe.resolve([]); await result })
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(sampler).toHaveBeenCalledTimes(1)
    conversion.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(records()[1]).toMatchObject({ phase: 'end', elapsedMs: 60_000 })
    probe.resolve([])
    await result
    expect(records().map(value => value.phase)).toEqual(['start', 'end', 'processes'])
    const count = records().length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(records()).toHaveLength(count)
    expect(sampler).toHaveBeenCalledTimes(1)
  })

  it('joins an already-running probe after failure without launching an overlapping probe', async () => {
    capture()
    const conversion = Promise.withResolvers<never>()
    const probe = Promise.withResolvers<[]>()
    const sampler = vi.fn(() => probe.promise)
    const failure = new Error('conversion failed')
    const result = traceOfficeSmokeConversion('service-pptx', () => conversion.promise, sampler).catch((error: unknown) => error)
    onTestFinished(async () => { conversion.reject(failure); probe.resolve([]); await result })
    await vi.advanceTimersByTimeAsync(20_000)
    conversion.reject(failure)
    await vi.advanceTimersByTimeAsync(0)
    expect(sampler).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    probe.resolve([])
    await expect(result).resolves.toBe(failure)
    expect(records().map(value => value.phase)).toEqual(['start', 'error', 'processes'])
  })

  it('reports an unavailable pending probe without changing a successful conversion', async () => {
    capture()
    const conversion = Promise.withResolvers<string>()
    const result = traceOfficeSmokeConversion('skill-cli-docx', () => conversion.promise,
      () => Promise.reject(new Error('probe unavailable')))
    onTestFinished(async () => { conversion.resolve('converted'); await result })
    await vi.advanceTimersByTimeAsync(20_000)
    conversion.resolve('converted')
    await expect(result).resolves.toBe('converted')
    expect(records().map(value => value.phase)).toEqual(['start', 'sample-unavailable', 'end'])
  })

  it('keeps the conversion error when its diagnostic output channel is closed', async () => {
    capture()
    vi.mocked(console.log).mockImplementation(() => { throw new Error('closed stdout') })
    const fallback = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const failure = new Error('conversion failed')
    await expect(traceOfficeSmokeConversion('service-docx', () => Promise.reject(failure),
      () => Promise.resolve([]))).rejects.toBe(failure)
    expect(fallback).toHaveBeenCalledWith('desktop Office smoke diagnostic output unavailable\n')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains real conversions and their existing service and HTTP deadlines', () => {
    const smoke = readFileSync(new URL('../scripts/smoke-runtime.ts', import.meta.url), 'utf8')
    const service = readFileSync(new URL('../../../packages/document/office-to-pdf/src/index.ts', import.meta.url), 'utf8')
    expect(smoke).toContain("const inputs = ['docx', 'xlsx', 'pptx']")
    expect(smoke).toContain("traceOfficeSmokeConversion('service-' + input.extension, () => ctx.officeToPdf.convert(")
    expect(smoke).toContain("traceOfficeSmokeConversion('skill-cli-docx'")
    expect(smoke).toContain('AbortSignal.timeout(120_000)')
    expect(service).toContain('timeoutMs: z.natural().min(1).max(2_147_483_647).default(60_000)')
    expect(smoke).toContain("endsWith('%%EOF')")
    expect(smoke).toContain('skill CLI did not return capabilities and a PDF')
  })
})

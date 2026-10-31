/** Input never echoes supplied bytes and releases terminal state on every outcome. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readConfirmation, readSecret, type SecretInput } from '../src/secret-input.ts'

function terminal() {
  const input: PassThrough & SecretInput = new PassThrough()
  const setRawMode = vi.fn()
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode })
  let output = ''
  return { input, setRawMode, output: () => output, writer: { write: (text: string) => { output += text } } }
}

describe('private cloud prompt input', () => {
  it('masks terminal input, supports backspace and restores the previous mode', async () => {
    const f = terminal()
    const result = readSecret(f.input, f.writer, new AbortController().signal, false)
    f.input.write('private-välueX\u007f\r')
    await expect(result).resolves.toBe('private-välue')
    expect(f.output()).toBe('Browser response or verification code (input hidden): \n')
    expect(f.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(f.input.listenerCount('data')).toBe(0)
    expect(f.input.listenerCount('end')).toBe(0)
    expect(f.input.isPaused()).toBe(true)
    f.input.destroy()
  })

  it('requires explicit non-terminal input and accepts a final line ending at EOF', async () => {
    const input = new PassThrough()
    const write = vi.fn()
    await expect(readSecret(input, { write }, new AbortController().signal, false)).rejects.toThrow('--secret-stdin')
    const result = readSecret(input, { write }, new AbortController().signal, true)
    input.end('private-stdin-token')
    await expect(result).resolves.toBe('private-stdin-token')
    expect(write.mock.calls.flat().join('')).not.toContain('private-stdin-token')
    expect(input.listenerCount('data')).toBe(0)
    input.destroy()
  })

  it.each(['\u0003', '\u0004'])('withdraws a terminal prompt on control input %j', async (key) => {
    const f = terminal()
    const result = readSecret(f.input, f.writer, new AbortController().signal, false)
    const refused = expect(result).rejects.toMatchObject({ exitCode: 130 })
    f.input.write(`private-draft${key}`)
    await refused
    expect(f.output()).not.toContain('private-draft')
    expect(f.setRawMode).toHaveBeenLastCalledWith(false)
    expect(f.input.listenerCount('data')).toBe(0)
    f.input.destroy()
  })

  it.each(['end', 'error', 'abort', 'oversized'] as const)('releases input after %s', async (outcome) => {
    const f = terminal()
    const controller = new AbortController()
    const result = readSecret(f.input, f.writer, controller.signal, false)
    const refused = expect(result).rejects.toThrow()
    if (outcome === 'end') f.input.end()
    else if (outcome === 'error') f.input.emit('error', new Error('private-error-details'))
    else if (outcome === 'abort') controller.abort()
    else f.input.write('é'.repeat(2049))
    await refused
    expect(f.output()).toBe('Browser response or verification code (input hidden): \n')
    expect(f.setRawMode).toHaveBeenLastCalledWith(false)
    for (const event of ['data', 'readable', 'end', 'error']) expect(f.input.listenerCount(event)).toBe(0)
    f.input.destroy()
  })

  it.each(['yes', 'no'] as const)('requires an explicit %s decision without changing terminal mode', async (choice) => {
    const f = terminal()
    const result = readConfirmation(f.input, f.writer, new AbortController().signal, false)
    f.input.write(`${choice}\n`)
    await expect(result).resolves.toBe(choice)
    expect(f.output()).toBe('Replace the existing AWS CLI profile login? Type yes or no: ')
    expect(f.setRawMode).not.toHaveBeenCalled()
    f.input.destroy()
  })

  it('refuses an ambiguous confirmation instead of treating it as approval', async () => {
    const input = new PassThrough()
    const result = readConfirmation(input, { write: vi.fn() }, new AbortController().signal, true)
    input.end('maybe\n')
    await expect(result).rejects.toThrow('Type yes or no')
    expect(input.listenerCount('data')).toBe(0)
    input.destroy()
  })

  it('preserves the next response when explicit stdin supplies more than one prompt', async () => {
    const input = new PassThrough()
    const output = { write: vi.fn() }
    input.end('yes\nprivate-next-code\n')
    await expect(readConfirmation(input, output, new AbortController().signal, true)).resolves.toBe('yes')
    await expect(readSecret(input, output, new AbortController().signal, true)).resolves.toBe('private-next-code')
    expect(output.write.mock.calls.flat().join('')).not.toContain('private-next-code')
    input.destroy()
  })

  it('consumes Windows CRLF as one delimiter between private and confirmation responses', async () => {
    const input = new PassThrough()
    const output = { write: vi.fn() }
    input.end('private-browser-response\r\nyes\r\n')
    await expect(readSecret(input, output, new AbortController().signal, true)).resolves.toBe('private-browser-response')
    await expect(readConfirmation(input, output, new AbortController().signal, true)).resolves.toBe('yes')
    expect(output.write.mock.calls.flat().join('')).not.toContain('private-browser-response')
    input.destroy()
  })

  it('preserves response framing when CR and LF arrive in different chunks', async () => {
    const input = new PassThrough()
    const output = { write: vi.fn() }
    const secret = readSecret(input, output, new AbortController().signal, true)
    input.write('private-browser-response\r')
    await vi.waitFor(() => { expect(input.readableLength).toBe(0) })
    input.write('\n')
    await expect(secret).resolves.toBe('private-browser-response')
    const confirmation = readConfirmation(input, output, new AbortController().signal, true)
    input.write('yes\r')
    await vi.waitFor(() => { expect(input.readableLength).toBe(0) })
    input.end('\n')
    await expect(confirmation).resolves.toBe('yes')
    expect(input.listenerCount('readable')).toBe(0)
    input.destroy()
  })

  it('restores terminal state if displaying the prompt fails', async () => {
    const f = terminal()
    await expect(readSecret(f.input, { write: () => { throw new Error('output unavailable') } }, new AbortController().signal, false))
      .rejects.toThrow('output unavailable')
    expect(f.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(f.input.listenerCount('readable')).toBe(0)
    expect(f.input.isPaused()).toBe(true)
    f.input.destroy()
  })

  it('does not acquire terminal state after prior cancellation', async () => {
    const f = terminal()
    const controller = new AbortController()
    controller.abort()
    await expect(readSecret(f.input, f.writer, controller.signal, false)).rejects.toThrow()
    expect(f.setRawMode).not.toHaveBeenCalled()
    expect(f.input.listenerCount('readable')).toBe(0)
    f.input.destroy()
  })
})

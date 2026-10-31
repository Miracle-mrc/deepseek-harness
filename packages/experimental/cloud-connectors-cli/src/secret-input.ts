/** Bounded, non-echoing secret input owned by one CLI request. */
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** Standard input operations used while a secret prompt is active. */
export type SecretInput = Readable & {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(enabled: boolean): unknown
}

/** Expected terminal and command failures whose text contains no supplied values. */
export class CloudCliError extends Error {
  /** @param message - fixed diagnostic without input values. @param exitCode - failed or interrupted process outcome. */
  constructor(message: string, readonly exitCode = 1) { super(message) }
}

/** A secret is bounded before retention, including input without a trailing newline. */
const MAX_SECRET_BYTES = 4096

/**
 * Read one secret without echoing it or accepting it in command arguments.
 * @param input - terminal or explicit standard-input stream.
 * @param output - stream receiving only the prompt and a trailing newline.
 * @param signal - cancellation of this CLI command.
 * @param allowStdin - whether --secret-stdin explicitly admits non-terminal input.
 * @returns the first supplied line, excluding its line ending.
 * @throws CloudCliError on missing input, EOF, interruption or an oversized value.
 */
export async function readSecret(
  input: SecretInput, output: { write(text: string): unknown }, signal: AbortSignal, allowStdin: boolean,
): Promise<string> {
  return await readResponse(input, output, signal, allowStdin, true)
}

/**
 * Read an explicit yes/no decision for replacing an AWS CLI profile's login.
 * @param input - terminal or explicitly admitted standard-input stream.
 * @param output - stream receiving the fixed confirmation question.
 * @param signal - cancellation of this CLI command or prompt.
 * @param allowStdin - whether standard-input responses were explicitly requested.
 * @returns exactly yes or no; empty or ambiguous answers are refused.
 */
export async function readConfirmation(
  input: SecretInput, output: { write(text: string): unknown }, signal: AbortSignal, allowStdin: boolean,
): Promise<'yes' | 'no'> {
  const response = (await readResponse(input, output, signal, allowStdin, false)).trim().toLowerCase()
  if (response !== 'yes' && response !== 'no') throw new CloudCliError('Type yes or no to decide whether to replace the AWS CLI login.')
  return response
}

/** Shared bounded input lifecycle; only secret terminal input enables raw mode. */
async function readResponse(
  input: SecretInput, output: { write(text: string): unknown }, signal: AbortSignal, allowStdin: boolean, secret: boolean,
): Promise<string> {
  signal.throwIfAborted()
  const setRawMode = secret && input.isTTY === true ? input.setRawMode?.bind(input) : undefined
  const terminal = input.isTTY === true && (!secret || setRawMode !== undefined)
  if (!terminal && !allowStdin) {
    throw new CloudCliError('This sign-in requires a response. Use a terminal or pass --secret-stdin with a private input stream.')
  }
  if (input.readableEnded || input.destroyed) throw new CloudCliError('Standard input ended before a secret was provided.')
  const wasPaused = input.readableFlowing !== true
  const wasRaw = input.isRaw === true
  const decoder = new StringDecoder('utf8')
  let value = ''
  let settled = false
  let carriageReturn = false
  const raw = setRawMode !== undefined
  if (setRawMode !== undefined) setRawMode(true)
  try {
    output.write(secret
      ? terminal ? 'Browser response or verification code (input hidden): ' : 'Reading the requested secret from standard input.\n'
      : 'Replace the existing AWS CLI profile login? Type yes or no: ')
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        const answer = value
        value = ''
        if (error !== undefined) reject(error)
        else if (answer.length === 0) reject(new CloudCliError('No response was provided.'))
        else resolve(answer)
      }
      const receive = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
        for (const character of text) {
          if (character === '\n') { finish(); return }
          if (character === '\r') {
            if (raw || wasRaw) finish()
            else carriageReturn = true
            return
          }
          if (raw && (character === '\u0003' || character === '\u0004')) {
            finish(new CloudCliError('Sign-in was cancelled before a secret was provided.', 130))
            return
          }
          if (raw && (character === '\b' || character === '\u007f')) value = Array.from(value).slice(0, -1).join('')
          else if (raw && character === '\u0015') value = ''
          else value += character
          if (Buffer.byteLength(value) > MAX_SECRET_BYTES) {
            finish(new CloudCliError('The supplied secret exceeds the input limit.'))
            return
          }
        }
      }
      const readAvailable = (): void => {
        try {
          while (!settled) {
            const chunk: unknown = input.read(1)
            if (chunk === null) return
            if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
              finish(new CloudCliError('The secret input stream returned unsupported data.'))
              return
            }
            if (carriageReturn) {
              if (typeof chunk === 'string' ? chunk !== '\n' : chunk[0] !== 10) input.unshift(chunk)
              finish()
              return
            }
            receive(chunk)
          }
        } catch { finish(new CloudCliError('The secret input stream failed.')) }
      }
      const ended = (): void => {
        const remainder = decoder.end()
        if (remainder) receive(remainder)
        if (!settled) finish(value.length === 0 ? new CloudCliError('Standard input ended before a secret was provided.') : undefined)
      }
      const failed = (): void => { finish(new CloudCliError('The secret input stream failed.')) }
      const aborted = (): void => { finish(new CloudCliError('Sign-in was cancelled.')) }
      const cleanup = (): void => {
        input.off('readable', readAvailable)
        input.off('end', ended)
        input.off('error', failed)
        signal.removeEventListener('abort', aborted)
      }
      input.on('readable', readAvailable)
      input.once('end', ended)
      input.once('error', failed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      else readAvailable()
    })
  } finally {
    value = ''
    try { if (setRawMode !== undefined) setRawMode(wasRaw) }
    finally {
      if (wasPaused) input.pause()
      else input.resume()
    }
    if (raw) output.write('\n')
  }
}

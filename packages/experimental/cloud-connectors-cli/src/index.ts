/** Human cloud commands launched through the shipped cloud profile. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import { CloudConnectionError } from '@deepseek-ai/dsh-experimental-cloud-connectors'
import { parseCloudInvocation } from './args.ts'
import { runCloudCommand } from './run.ts'
import { CloudCliError } from './secret-input.ts'

/** Stable Loader name for the cloud profile application. */
export const name = 'cloud-connectors-cli'
/** Argument parsing happens before waiting for the cloud service. */
export const inject = ['cmdlineArgs']

/** CLI display pacing; provider request deadlines belong to cloud-connectors. */
export interface Config {
  /** Delay between status reads while an owned sign-in is pending. */
  pollIntervalMs?: number
}

/** Validated CLI pacing. */
export const Config = Schema.object({ pollIntervalMs: Schema.number().min(10).max(60_000).default(500) })

/**
 * Parse a human command and run it only after the profile has committed startup.
 * @param ctx - launcher context with cmdlineArgs, appReady and appExit.
 * @param config - polling cadence for the terminal interaction.
 */
export function apply(ctx: Context, config: Config): void {
  const invocation = parseCloudInvocation(ctx)
  if (invocation === undefined) return
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('cloud CLI: the dsh launcher must provide appReady and appExit')
  const resolved = Config(config)
  ctx.inject(['cloudConnections'], (child) => {
    const controller = new AbortController()
    let running: Promise<void> | undefined
    const interrupted = (): void => { controller.abort() }
    process.on('SIGINT', interrupted)
    process.on('SIGTERM', interrupted)
    const cancelReady = ready.onReady(() => {
      running = runCloudCommand(child.cloudConnections, invocation, {
        stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, pollIntervalMs: resolved.pollIntervalMs,
      }, controller.signal).then(() => { exit(0) }, (error: unknown) => {
        const message = controller.signal.aborted ? 'Cloud command cancelled.'
          : error instanceof CloudCliError || error instanceof CloudConnectionError ? error.message
            : 'Cloud command failed. Check connection status and retry.'
        process.stderr.write(`dsh cloud: ${message}\n`)
        exit(controller.signal.aborted ? 130 : error instanceof CloudCliError ? error.exitCode : 1)
      })
    })
    child.effect(() => async () => {
      cancelReady()
      controller.abort()
      await running
      process.off('SIGINT', interrupted)
      process.off('SIGTERM', interrupted)
    }, 'cloud CLI: command lifetime')
  })
}

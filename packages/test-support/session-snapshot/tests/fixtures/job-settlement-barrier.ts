/** Order requested job cancellation before the next recorded model step. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'job-settlement-barrier'
export const inject = ['jobs', 'tools']

/** Observe settlement without consuming output or suppressing completion notices. */
async function waitForSettlement(ctx: Context, id: JobId, owner: SessionId, signal: AbortSignal): Promise<void> {
  let unsubscribe = (): void => {}
  let onAbort = (): void => {}
  try {
    await new Promise<void>((resolve, reject) => {
      unsubscribe = ctx.jobs.events.subscribe({ owner }, (event) => {
        if (event.type === 'settled' && event.job.id === id) resolve()
      })
      onAbort = () => { reject(new Error('snapshot job settlement wait aborted', { cause: signal.reason })) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      const job = ctx.jobs.get(id, owner)
      if (job.status !== 'running' && job.status !== 'stopping') resolve()
    })
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', onAbort)
    unsubscribe()
  }
}

/**
 * Preserve the recorded step order while real cancelled producers release their resources.
 * @param ctx - snapshot runtime carrying job lifecycle and step events.
 */
export function apply(ctx: Context): void {
  const pending = new Map<SessionId, Set<JobId>>()
  const waiting = new Set<Promise<void>>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('snapshot job settlement barrier disposed'))
    await Promise.allSettled(waiting)
    pending.clear()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name !== 'job_kill' || exec.agent === undefined || result.isError || lifetime.signal.aborted) return result
    const args = exec.arguments
    assert(args !== null && typeof args === 'object' && 'job_id' in args && typeof args.job_id === 'string')
    const job = ctx.jobs.get(JobId(args.job_id), exec.agent.id)
    if (job.owner !== exec.agent.id) return result
    const jobs = pending.get(exec.agent.id) ?? new Set<JobId>()
    jobs.add(job.id)
    pending.set(exec.agent.id, jobs)
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const jobs = pending.get(agent.id)
    if (jobs !== undefined) {
      pending.delete(agent.id)
      const waitSignal = AbortSignal.any([signal, lifetime.signal])
      const wait = Promise.all([...jobs].map(id => waitForSettlement(ctx, id, agent.id, waitSignal))).then(() => {})
      waiting.add(wait)
      try {
        await wait
      } finally {
        waiting.delete(wait)
      }
    }
    return next()
  })
}

/** Hold direct children until their root parent's first turn reaches idle. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

export const name = 'subagent-parent-idle-fence'
export const inject = ['agents']

/**
 * Preserve a recorded settlement turn without depending on parent/child execution speed.
 * @param ctx - snapshot runtime carrying live Agents and Session events.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const ended = new WeakSet<Session>()
    const waiting = new Set<Promise<void>>()
    const lifetime = new AbortController()
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession === undefined && event.type === 'turn/end' && event.data.turn === 1) {
        ended.add(session)
      }
    })

    const waitForIdle = async (parent: Agent, signal: AbortSignal): Promise<void> => {
      const ready = Promise.withResolvers<undefined>()
      const unsubscribe = ctx.root.on('agent/status', ({ agent, status }) => {
        if (agent === parent && status === 'idle' && ended.has(parent.session) && parent.status === 'idle') ready.resolve(undefined)
      })
      const onAbort = () => { ready.reject(new Error('snapshot parent-idle wait aborted', { cause: signal.reason })) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal.aborted) onAbort()
        else if (ended.has(parent.session) && parent.status === 'idle') ready.resolve(undefined)
        await ready.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        unsubscribe()
      }
    }

    const disposeStep = ctx.root.on('agent/pre-step', async ({ agent, signal }, next) => {
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) return next()
      lifetime.signal.throwIfAborted()
      const parent = ctx.agents.get(parentId)
      if (parent === undefined) throw new Error(`snapshot child has no live parent: ${parentId}`)
      if (parent.session.header.parentSession !== undefined) return next()
      const waitSignal = AbortSignal.any([signal, lifetime.signal])
      const wait = waitForIdle(parent, waitSignal)
      waiting.add(wait)
      try {
        await wait
        waitSignal.throwIfAborted()
      } finally {
        waiting.delete(wait)
      }
      return next()
    })
    return async () => {
      lifetime.abort(new Error('snapshot parent-idle fence disposed'))
      disposeStep()
      disposeSession()
      await Promise.allSettled(waiting)
    }
  }, 'subagent-parent-idle-fence.listeners')
}

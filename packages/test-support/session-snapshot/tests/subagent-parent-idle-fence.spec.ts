import { describe, expect, it, vi, type TestContext } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentCarrier, agentEvents, type Agent, type AgentStatus, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ParentIdleFence from './fixtures/subagent-parent-idle-fence.ts'

async function setup({ onTestFinished }: TestContext) {
  const ctx = new Context()
  const pending: Promise<PreStepDecision>[] = []
  onTestFinished(async () => {
    const settled = Promise.allSettled(pending)
    await ctx.fiber.dispose()
    await settled
  })
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const entering = new Map<Agent, (() => void)[]>()
  ctx.on('agent/pre-step', ({ agent }, next) => {
    entering.get(agent)?.shift()?.()
    return next()
  })
  const fiber = await ctx.plugin(ParentIdleFence)
  const create = async (id: string, parent?: Agent) => {
    const { agent } = await ctx.agents.create({
      sessionId: SessionId(id),
      agentOptions: { provider: 'test', model: 'test' },
      ...parent === undefined ? {} : {
        parentAgent: parent,
        meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
      },
    })
    let status: AgentStatus = 'idle'
    vi.spyOn(agent, 'status', 'get').mockImplementation(() => status)
    return {
      agent,
      status(value: AgentStatus) {
        status = value
        agentEvents(ctx, agent).emit('agent/status', { status })
      },
    }
  }
  const endTurn = (agent: Agent, turn = 1) => {
    agent.session.append('turn/start', { turn })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const step = (agent: Agent, signal = new AbortController().signal) => {
    const entered = Promise.withResolvers<undefined>()
    const queue = entering.get(agent) ?? []
    queue.push(() => { entered.resolve(undefined) })
    entering.set(agent, queue)
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }))
    const result = agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal, modelSelection: { provider: 'test', model: 'test' },
    }, next)
    pending.push(result)
    return { pending: result, next, entered: entered.promise }
  }
  const statusListeners = (agent: Agent) => ctx.events.dispatch('emit', [
    agentCarrier(agent), 'agent/status', { agent, status: 'idle' },
  ]).length
  return { ctx, fiber, create, endTurn, step, statusListeners }
}

describe('recorded subagent parent-idle fence', () => {
  it('holds children for their own root turn one and idle while ordinary root steps delegate', async (test) => {
    const h = await setup(test)
    const root = await h.create('root')
    const other = await h.create('other-root')
    const child = await h.create('child', root.agent)
    root.status('running')
    const baseline = h.statusListeners(root.agent)
    const step = h.step(child.agent)
    await step.entered

    root.status('idle')
    await h.step(root.agent).pending
    expect(step.next.mock.calls.length).toBe(0)
    expect(h.statusListeners(root.agent)).toBe(baseline + 1)
    root.status('running')
    h.endTurn(other.agent)
    other.status('idle')
    h.endTurn(child.agent)
    h.endTurn(root.agent, 2)
    await h.step(other.agent).pending
    expect(step.next.mock.calls.length).toBe(0)

    h.endTurn(root.agent)
    await h.step(root.agent).pending
    expect(step.next.mock.calls.length).toBe(0)
    root.status('idle')
    expect(await step.pending).toEqual({ kind: 'enter', messages: [] })
    expect(step.next).toHaveBeenCalledOnce()
    expect(h.statusListeners(root.agent)).toBe(baseline)
  })

  it('accepts its root becoming idle before the child reaches its first step', async (test) => {
    const h = await setup(test)
    const root = await h.create('already-idle-root')
    h.endTurn(root.agent)
    root.status('idle')
    const child = await h.create('late-child', root.agent)
    const baseline = h.statusListeners(root.agent)
    const step = h.step(child.agent)
    await step.pending
    expect(step.next).toHaveBeenCalledOnce()
    expect(h.statusListeners(root.agent)).toBe(baseline)
  })

  it('keeps waiting when an earlier idle listener has already woken the parent', async (test) => {
    const h = await setup(test)
    const root = await h.create('woken-root')
    const child = await h.create('waiting-child', root.agent)
    root.status('running')
    h.endTurn(root.agent)
    const stopWaking = h.ctx.on('agent/status', ({ agent, status }) => {
      if (agent === root.agent && status === 'idle') root.status('running')
    })
    const step = h.step(child.agent)
    await step.entered
    root.status('idle')
    await h.step(root.agent).pending
    expect(step.next.mock.calls.length).toBe(0)
    stopWaking()
    root.status('idle')
    await step.pending
    expect(step.next).toHaveBeenCalledOnce()
  })

  it('keeps simultaneous roots independent', async (test) => {
    const h = await setup(test)
    const first = await h.create('first-root')
    const second = await h.create('second-root')
    const a = await h.create('first-child', first.agent)
    const b = await h.create('second-child', second.agent)
    first.status('running')
    second.status('running')
    const aStep = h.step(a.agent)
    const bStep = h.step(b.agent)
    await Promise.all([aStep.entered, bStep.entered])
    h.endTurn(first.agent)
    first.status('idle')
    await aStep.pending
    expect(aStep.next).toHaveBeenCalledOnce()
    expect(bStep.next).not.toHaveBeenCalled()
    h.endTurn(second.agent)
    second.status('idle')
    await bStep.pending
    expect(bStep.next).toHaveBeenCalledOnce()
  })

  it('leaves deeper descendants outside the direct-root fixture', async (test) => {
    const h = await setup(test)
    const root = await h.create('ancestor')
    const parent = await h.create('nested-parent', root.agent)
    const child = await h.create('nested-child', parent.agent)
    const step = h.step(child.agent)
    await step.pending
    expect(step.next).toHaveBeenCalledOnce()
  })

  it('reports a missing live parent before admitting child work', async (test) => {
    const h = await setup(test)
    const root = await h.create('removed-root')
    const child = await h.create('orphan', root.agent)
    vi.spyOn(h.ctx.agents, 'get').mockReturnValueOnce(undefined)
    const step = h.step(child.agent)
    await expect(step.pending).rejects.toThrow('snapshot child has no live parent: removed-root')
    expect(step.next).not.toHaveBeenCalled()
  })

  it('rejects a step that was cancelled before waiting', async (test) => {
    const h = await setup(test)
    const root = await h.create('cancelled-root')
    const child = await h.create('cancelled-child', root.agent)
    const abort = new AbortController()
    abort.abort(new Error('turn already ended'))
    const baseline = h.statusListeners(root.agent)
    const step = h.step(child.agent, abort.signal)
    await expect(step.pending).rejects.toThrow('snapshot parent-idle wait aborted')
    expect(step.next).not.toHaveBeenCalled()
    expect(h.statusListeners(root.agent)).toBe(baseline)
  })

  it('removes a cancelled wait and never resumes it after later parent idle', async (test) => {
    const h = await setup(test)
    const root = await h.create('abort-root')
    const child = await h.create('abort-child', root.agent)
    root.status('running')
    const abort = new AbortController()
    const baseline = h.statusListeners(root.agent)
    const step = h.step(child.agent, abort.signal)
    const rejected = expect(step.pending).rejects.toThrow('snapshot parent-idle wait aborted')
    await step.entered
    abort.abort(new Error('turn cancelled'))
    await rejected
    expect(h.statusListeners(root.agent)).toBe(baseline)
    h.endTurn(root.agent)
    root.status('idle')
    await h.step(child.agent).pending
    expect(step.next).not.toHaveBeenCalled()
  })

  it('stops a released wait when cancellation wins before its continuation', async (test) => {
    const h = await setup(test)
    const root = await h.create('release-abort-root')
    const child = await h.create('release-abort-child', root.agent)
    root.status('running')
    h.endTurn(root.agent)
    const abort = new AbortController()
    const step = h.step(child.agent, abort.signal)
    const rejected = expect(step.pending).rejects.toThrow('cancelled after idle')
    await step.entered
    root.status('idle')
    abort.abort(new Error('cancelled after idle'))
    await rejected
    expect(step.next).not.toHaveBeenCalled()
  })

  it('drains pending waits and detaches the fixture on disposal', async (test) => {
    const h = await setup(test)
    const root = await h.create('disposed-root')
    const child = await h.create('disposed-child', root.agent)
    const baseline = h.statusListeners(root.agent)
    const step = h.step(child.agent)
    const rejected = expect(step.pending).rejects.toThrow('snapshot parent-idle wait aborted')
    await step.entered
    await h.fiber.dispose()
    await rejected
    expect(h.statusListeners(root.agent)).toBe(baseline)
    h.endTurn(root.agent)
    root.status('idle')
    const ordinary = h.step(child.agent)
    await ordinary.pending
    expect(ordinary.next).toHaveBeenCalledOnce()
    expect(step.next).not.toHaveBeenCalled()
  })

  it('prevents released child work when the fixture unloads before continuation', async (test) => {
    const h = await setup(test)
    const root = await h.create('release-dispose-root')
    const child = await h.create('release-dispose-child', root.agent)
    root.status('running')
    h.endTurn(root.agent)
    const step = h.step(child.agent)
    const rejected = expect(step.pending).rejects.toThrow('snapshot parent-idle fence disposed')
    await step.entered
    root.status('idle')
    await h.fiber.dispose()
    await rejected
    expect(step.next).not.toHaveBeenCalled()
  })

  it('rejects an already captured child callback after fixture disposal without new parent access', async (test) => {
    const h = await setup(test)
    const root = await h.create('captured-root')
    const child = await h.create('captured-child', root.agent)
    const captured = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    test.onTestFinished(() => { release.resolve(undefined) })
    h.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === child.agent) {
        captured.resolve(undefined)
        await release.promise
      }
      return next()
    }, { prepend: true })
    const step = h.step(child.agent)
    const rejected = expect(step.pending).rejects.toThrow('snapshot parent-idle fence disposed')
    try {
      await captured.promise
      await h.fiber.dispose()
      const lookup = vi.spyOn(h.ctx.agents, 'get')
      const listeners = h.statusListeners(root.agent)
      release.resolve(undefined)
      await rejected
      expect(lookup).not.toHaveBeenCalled()
      expect(h.statusListeners(root.agent)).toBe(listeners)
      expect(step.next).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([step.pending])
    }
  })
})

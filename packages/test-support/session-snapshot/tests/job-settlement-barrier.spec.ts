import { describe, expect, it, vi, type TestContext } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as JobSettlementBarrier from './fixtures/job-settlement-barrier.ts'

async function setup({ onTestFinished }: TestContext) {
  const ctx = new Context()
  const producers: ReturnType<typeof Promise.withResolvers<JobOutcome>>[] = []
  onTestFinished(async () => {
    for (const producer of producers) producer.resolve({ status: 'killed' })
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 1 })
  ctx.jobs.attachController('barrier-test')
  ctx.tools.register(defineContentToolFixture({
    name: 'job_kill',
    description: 'Request test producer cancellation.',
    parameters: { job_id: { type: 'string', required: true } },
    async execute(args, exec) {
      ctx.jobs.kill(JobId(args.job_id), exec.agent?.id)
      return [{ type: 'text', text: 'requested cancellation' }]
    },
  }))
  const fiber = await ctx.plugin(JobSettlementBarrier)
  const create = (id: string) => driver.create(SessionId(id))
  const start = (agent: Agent) => {
    const done = Promise.withResolvers<JobOutcome>()
    producers.push(done)
    const cancel = vi.fn()
    const id = ctx.jobs.start({
      kind: 'bash', label: 'held producer', owner: agent.id,
      run(job) {
        job.append('retained output')
        return { done: done.promise, cancel }
      },
    })
    return { id, done, cancel }
  }
  const kill = (agent: Agent, id: JobId) => executeModelToolFixture(ctx, {
    agent, callId: ToolCallId(`kill-${agent.id}`), name: 'job_kill', arguments: { job_id: id },
    signal: new AbortController().signal,
  })
  const step = (agent: Agent, signal = new AbortController().signal) => {
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }))
    const pending = agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 4, signal, modelSelection: { provider: 'test', model: 'test' },
    }, next)
    return { pending, next }
  }
  const subscriptions = new Set<symbol>()
  const subscribed: (() => void)[] = []
  const original = ctx.jobs.events
  vi.spyOn(ctx.jobs, 'events', 'get').mockReturnValue({
    subscribe(filter, listener) {
      const unsubscribe = original.subscribe(filter, listener)
      const token = Symbol()
      subscriptions.add(token)
      subscribed.shift()?.()
      return () => {
        subscriptions.delete(token)
        unsubscribe()
      }
    },
  })
  const nextSubscription = () => new Promise<void>((resolve) => { subscribed.push(resolve) })
  return { ctx, fiber, create, start, kill, step, subscriptions, nextSubscription }
}

describe('recorded job settlement barrier', () => {
  it('keeps the cancelled producer admitted until settlement and isolates simultaneous owners', async (test) => {
    const h = await setup(test)
    const first = await h.create('first-owner')
    const second = await h.create('second-owner')
    const unrelated = await h.create('unrelated-owner')
    const a = h.start(first)
    const b = h.start(second)
    await h.kill(first, a.id)
    await h.kill(second, b.id)
    expect(a.cancel).toHaveBeenCalledOnce()
    expect(h.ctx.jobs.get(a.id, first.id).status).toBe('stopping')

    const aSubscribed = h.nextSubscription()
    const aStep = h.step(first)
    await aSubscribed
    const bSubscribed = h.nextSubscription()
    const bStep = h.step(second)
    await bSubscribed
    const ordinaryStep = h.step(unrelated)
    await ordinaryStep.pending
    expect(ordinaryStep.next).toHaveBeenCalledOnce()
    expect(aStep.next.mock.calls.length).toBe(0)
    expect(bStep.next.mock.calls.length).toBe(0)
    const replacement = vi.fn(() => ({ done: Promise.resolve({ status: 'completed' as const }), cancel() {} }))
    expect(() => h.ctx.jobs.start({ kind: 'bash', label: 'replacement', owner: first.id, run: replacement }))
      .toThrow('background job limit reached')
    expect(replacement).not.toHaveBeenCalled()

    a.done.resolve({ status: 'killed', result: 'retained result' })
    await aStep.pending
    expect(aStep.next).toHaveBeenCalledOnce()
    expect(bStep.next.mock.calls.length).toBe(0)
    expect(h.subscriptions.size).toBe(1)
    expect(h.ctx.jobs.read(a.id, first.id)).toMatchObject({
      chunks: [{ text: 'retained output' }], result: 'retained result', job: { status: 'killed' },
    })
    h.ctx.jobs.start({ kind: 'bash', label: 'replacement', owner: first.id, run: replacement })
    expect(replacement).toHaveBeenCalledOnce()

    b.done.resolve({ status: 'killed' })
    await bStep.pending
    expect(bStep.next).toHaveBeenCalledOnce()
    expect(h.subscriptions.size).toBe(0)
  })

  it('accepts settlement that committed before the next step subscribed', async (test) => {
    const h = await setup(test)
    const agent = await h.create('already-settled')
    const producer = h.start(agent)
    await h.kill(agent, producer.id)
    producer.done.resolve({ status: 'killed' })
    await h.ctx.jobs.wait(producer.id, 5_000, agent.id)
    const step = h.step(agent)
    await step.pending
    expect(step.next).toHaveBeenCalledOnce()
    expect(h.subscriptions.size).toBe(0)
  })

  it('removes the settlement listener on turn abort and never resumes the aborted step', async (test) => {
    const h = await setup(test)
    const agent = await h.create('aborted-owner')
    const producer = h.start(agent)
    await h.kill(agent, producer.id)
    const abort = new AbortController()
    const subscribed = h.nextSubscription()
    const step = h.step(agent, abort.signal)
    const rejected = expect(step.pending).rejects.toThrow('snapshot job settlement wait aborted')
    await subscribed
    abort.abort(new Error('turn ended'))
    await rejected
    expect(h.subscriptions.size).toBe(0)
    producer.done.resolve({ status: 'killed' })
    await h.ctx.jobs.wait(producer.id, 5_000, agent.id)
    expect(step.next).not.toHaveBeenCalled()
    const next = h.step(agent)
    await next.pending
    expect(next.next).toHaveBeenCalledOnce()
  })

  it('awaits listener removal when the fixture unloads during settlement', async (test) => {
    const h = await setup(test)
    const agent = await h.create('disposed-owner')
    const producer = h.start(agent)
    await h.kill(agent, producer.id)
    const subscribed = h.nextSubscription()
    const step = h.step(agent)
    const rejected = expect(step.pending).rejects.toThrow('snapshot job settlement wait aborted')
    await subscribed
    await h.fiber.dispose()
    expect(h.subscriptions.size).toBe(0)
    await rejected
    producer.done.resolve({ status: 'killed' })
    await h.ctx.jobs.wait(producer.id, 5_000, agent.id)
    expect(step.next).not.toHaveBeenCalled()
    const next = h.step(agent)
    await next.pending
    expect(next.next).toHaveBeenCalledOnce()
  })
})

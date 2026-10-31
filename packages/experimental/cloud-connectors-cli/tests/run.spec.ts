/** Human commands preserve explicit consent and own only their admitted sign-in. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { CloudProvider } from '@deepseek-ai/dsh-experimental-cloud-connectors'
import type { CloudAttemptId, CloudConnectionView, CloudPromptId } from '@deepseek-ai/dsh-experimental-cloud-connectors/types'
import { runCloudCommand, type CloudCliIo, type CloudCommands } from '../src/run.ts'

const attemptId = 'fixture-attempt' as CloudAttemptId
const promptId = 'fixture-prompt' as CloudPromptId

function fixture(provider: CloudProvider = 'supabase') {
  let view: CloudConnectionView = {
    provider, status: 'choose-permissions', enabledTools: [],
    tools: [{ name: 'execute_sql', description: 'SQL' }, { name: 'apply_migration', description: 'Migration' }],
  }
  const all = (): CloudConnectionView[] => [
    { provider: provider === 'supabase' ? 'aws' : 'supabase', status: 'not-connected', tools: [], enabledTools: [] }, view,
  ]
  const service: CloudCommands = {
    list: vi.fn(async () => all()), restore: vi.fn(async () => all()),
    start: vi.fn(async () => ({ attemptId, url: 'https://supabase.example/authorize' })),
    cancel: vi.fn(async () => all()),
    complete: vi.fn(async () => { view = { ...view, status: 'choose-permissions' }; delete view.prompt; return all() }),
    confirm: vi.fn(async (_provider: string, names: string[]) => {
      view = { ...view, status: 'connected', enabledTools: names }
      return all()
    }),
    disconnect: vi.fn(async () => { view = { ...view, status: 'not-connected', tools: [], enabledTools: [] }; return all() }),
  }
  const input = new PassThrough()
  let stdout = ''
  let stderr = ''
  const io: CloudCliIo = {
    stdin: input, stdout: { write: (text) => { stdout += text } }, stderr: { write: (text) => { stderr += text } }, pollIntervalMs: 10,
  }
  return {
    service, input, io, output: () => ({ stdout, stderr }),
    setView: (next: Partial<CloudConnectionView>) => { view = { ...view, ...next } },
    browserCompleted: () => { view = { ...view, status: 'choose-permissions' }; delete view.prompt },
  }
}

describe('cloud human commands', () => {
  it('finishes login without enabling tools or printing the supplied secret', async () => {
    const f = fixture()
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' }, code: 'PUBLIC-CODE' })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: true,
    }, f.io, new AbortController().signal)
    f.input.end('fixture-private-token\n')
    await result
    expect(f.service.complete).toHaveBeenCalledExactlyOnceWith('supabase', promptId, 'fixture-private-token')
    expect(f.service.confirm).not.toHaveBeenCalled()
    expect(f.service.cancel).not.toHaveBeenCalled()
    expect(f.service.disconnect).not.toHaveBeenCalled()
    expect(f.output().stdout).toContain('https://supabase.example/authorize')
    expect(f.output().stdout).toContain('PUBLIC-CODE')
    expect(JSON.stringify(f.output())).not.toContain('fixture-private-token')
    expect(f.output().stdout).toContain('Enable tools explicitly')
    expect(f.input.listenerCount('data')).toBe(0)
  })

  it('lists permissions without changing them, then enables exactly the explicit selection', async () => {
    const f = fixture()
    await runCloudCommand(f.service, { kind: 'tools', provider: 'supabase' }, f.io, new AbortController().signal)
    expect(f.service.confirm).not.toHaveBeenCalled()
    expect(f.output().stdout).toContain('[disabled] execute_sql')
    await runCloudCommand(f.service, {
      kind: 'tools', provider: 'supabase', selection: { kind: 'names', names: ['execute_sql'] },
    }, f.io, new AbortController().signal)
    expect(f.service.confirm).toHaveBeenCalledExactlyOnceWith('supabase', ['execute_sql'])
    expect(f.output().stdout).toContain('[enabled] execute_sql')
    expect(f.output().stdout).toContain('[disabled] apply_migration')
    f.input.destroy()
  })

  it('finishes browser login while a terminal response is still pending', async () => {
    const f = fixture()
    Object.assign(f.input, { isTTY: true, isRaw: false, setRawMode: vi.fn() })
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' } })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, new AbortController().signal)
    await vi.waitFor(() => { expect(f.input.listenerCount('readable')).toBe(1) })
    f.browserCompleted()
    await result
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.cancel).not.toHaveBeenCalled()
    expect(f.input.listenerCount('data')).toBe(0)
    expect(f.output().stdout).toContain('supabase: signed in.')
    f.input.destroy()
  })

  it('waits for a browser callback on non-terminal input unless stdin responses were requested', async () => {
    const f = fixture()
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' } })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, new AbortController().signal)
    await vi.waitFor(() => { expect(f.service.list).toHaveBeenCalled() })
    f.browserCompleted()
    await result
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.cancel).not.toHaveBeenCalled()
    expect(f.output().stderr).toBe('')
    f.input.destroy()
  })

  it('returns only an explicit yes/no decision to the profile replacement prompt', async () => {
    const f = fixture('aws')
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'select', purpose: 'replace-aws-login' } })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: true,
    }, f.io, new AbortController().signal)
    const refused = expect(result).rejects.toMatchObject({ exitCode: 130 })
    f.input.end('no\n')
    await refused
    expect(f.service.complete).toHaveBeenCalledExactlyOnceWith('aws', promptId, 'no')
    expect(f.output().stderr).toContain('Replace the existing AWS CLI profile login?')
    expect(f.service.confirm).not.toHaveBeenCalled()
  })

  it('does not replace an AWS CLI login without an available explicit confirmation channel', async () => {
    const f = fixture('aws')
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'select', purpose: 'replace-aws-login' } })
    await expect(runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, new AbortController().signal)).rejects.toThrow('requires a terminal')
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
    f.input.destroy()
  })

  it('fails promptly when AWS remote login needs input without an explicit stdin channel', async () => {
    const f = fixture('aws')
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' } })
    f.input.end()
    await expect(runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, new AbortController().signal)).rejects.toThrow('--secret-stdin')
    expect(f.service.list).toHaveBeenCalledTimes(1)
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('aws', attemptId)
  })

  it('permits an AWS login that needs no terminal response', async () => {
    const f = fixture('aws')
    f.input.end()
    await runCloudCommand(f.service, {
      kind: 'login', provider: 'aws', region: 'us-east-1', options: { awsMethod: 'existing' }, secretStdin: false,
    }, f.io, new AbortController().signal)
    expect(f.service.complete).not.toHaveBeenCalled()
    expect(f.service.cancel).not.toHaveBeenCalled()
    expect(f.output().stdout).toContain('aws: signed in.')
  })

  it('permits all or no tools only through their explicit selections', async () => {
    const f = fixture()
    await runCloudCommand(f.service, {
      kind: 'tools', provider: 'supabase', selection: { kind: 'all' },
    }, f.io, new AbortController().signal)
    expect(f.service.confirm).toHaveBeenLastCalledWith('supabase', ['execute_sql', 'apply_migration'])
    await runCloudCommand(f.service, {
      kind: 'tools', provider: 'supabase', selection: { kind: 'names', names: [] },
    }, f.io, new AbortController().signal)
    expect(f.service.confirm).toHaveBeenLastCalledWith('supabase', [])
    f.input.destroy()
  })

  it('refuses unknown tool names before changing durable consent', async () => {
    const f = fixture()
    await expect(runCloudCommand(f.service, {
      kind: 'tools', provider: 'supabase', selection: { kind: 'names', names: ['unknown'] },
    }, f.io, new AbortController().signal)).rejects.toThrow('unavailable tool')
    expect(f.service.confirm).not.toHaveBeenCalled()
    f.input.destroy()
  })

  it('cancels and drains only the owned attempt after secret input reaches EOF', async () => {
    const f = fixture()
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' } })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: true,
    }, f.io, new AbortController().signal)
    const refused = expect(result).rejects.toThrow('Standard input ended')
    f.input.end()
    await refused
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('supabase', attemptId)
    expect(f.service.disconnect).not.toHaveBeenCalled()
    expect(f.input.listenerCount('data')).toBe(0)
  })

  it('does not cancel another attempt when admission was rejected', async () => {
    const f = fixture()
    vi.mocked(f.service.start).mockRejectedValueOnce(new Error('private provider payload'))
    await expect(runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: false,
    }, f.io, new AbortController().signal)).rejects.toThrow()
    expect(f.service.cancel).not.toHaveBeenCalled()
    expect(f.service.disconnect).not.toHaveBeenCalled()
    expect(JSON.stringify(f.output())).not.toContain('private provider payload')
    f.input.destroy()
  })

  it('awaits cancellation while restoring prompt listeners after an interrupt', async () => {
    const f = fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<CloudConnectionView[]>()
    f.setView({ status: 'authorizing', attemptId, prompt: { id: promptId, kind: 'secret' } })
    vi.mocked(f.service.cancel).mockImplementation(() => { entered.resolve(undefined); return released.promise })
    const result = runCloudCommand(f.service, {
      kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: true,
    }, f.io, controller.signal)
    const refused = expect(result).rejects.toThrow()
    await vi.waitFor(() => { expect(f.input.listenerCount('readable')).toBe(1) })
    controller.abort()
    await entered.promise
    expect(f.input.listenerCount('data')).toBe(0)
    let done = false
    void result.finally(() => { done = true }).catch(() => undefined)
    expect(done).toBe(false)
    released.resolve([])
    await refused
    expect(f.service.cancel).toHaveBeenCalledExactlyOnceWith('supabase', attemptId)
    expect(f.service.disconnect).not.toHaveBeenCalled()
    f.input.destroy()
  })

  it('restores only the requested status and disconnects only on that command', async () => {
    const f = fixture()
    await runCloudCommand(f.service, { kind: 'status', provider: 'supabase' }, f.io, new AbortController().signal)
    expect(f.service.restore).toHaveBeenCalledExactlyOnceWith('supabase')
    expect(f.output().stdout).not.toContain('aws:')
    await runCloudCommand(f.service, { kind: 'disconnect', provider: 'supabase' }, f.io, new AbortController().signal)
    expect(f.service.disconnect).toHaveBeenCalledExactlyOnceWith('supabase')
    f.input.destroy()
  })
})

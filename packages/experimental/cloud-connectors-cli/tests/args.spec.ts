/** The profile owns its grammar and never accepts a secret argument. */
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCloudInvocation } from '../src/args.ts'

const original = { stdout: internals.stdout, stderr: internals.stderr }
afterEach(() => { Object.assign(internals, original) })

function parse(args: string[]) {
  let stdout = ''
  let stderr = ''
  const exits: number[] = []
  internals.stdout = { write: (text) => { stdout += text } }
  internals.stderr = { write: (text) => { stderr += text } }
  const ctx = new Context()
  provideCmdline(ctx, { args, exit: (code) => { exits.push(code) } })
  return { invocation: parseCloudInvocation(ctx), stdout, stderr, exits }
}

describe('cloud command grammar', () => {
  it('selects browser login without implicitly selecting tools', () => {
    expect(parse(['login', 'supabase'])).toEqual({
      invocation: { kind: 'login', provider: 'supabase', region: 'us-east-1', options: {}, secretStdin: false },
      stdout: '', stderr: '', exits: [],
    })
    expect(parse(['login', 'aws', '--region', 'eu-west-1', '--aws-profile', 'work', '--aws-method', 'sso', '--secret-stdin']).invocation)
      .toEqual({
        kind: 'login', provider: 'aws', region: 'eu-west-1', options: { awsProfile: 'work', awsMethod: 'sso' }, secretStdin: true,
      })
  })

  it.each([
    ['status'], ['status', 'aws'], ['disconnect', 'supabase'], ['tools', 'supabase'],
  ])('parses a non-login command: %j', (...args) => {
    const result = parse(args)
    expect(result.exits).toEqual([])
    expect(result.invocation?.kind).toBe(args[0])
  })

  it('makes every change to tool consent explicit', () => {
    expect(parse(['tools', 'supabase', '--enable', 'execute_sql, apply_migration']).invocation)
      .toEqual({ kind: 'tools', provider: 'supabase', selection: { kind: 'names', names: ['execute_sql', 'apply_migration'] } })
    expect(parse(['tools', 'aws', '--all']).invocation).toEqual({ kind: 'tools', provider: 'aws', selection: { kind: 'all' } })
    expect(parse(['tools', 'aws', '--none']).invocation)
      .toEqual({ kind: 'tools', provider: 'aws', selection: { kind: 'names', names: [] } })
  })

  it.each([
    [], ['login', 'unknown'], ['login', 'aws', '--region', 'elsewhere'],
    ['login', 'supabase', '--aws-method', 'existing'], ['login', 'aws', '--aws-profile', ''],
    ['tools', 'aws', '--all', '--none'], ['tools', 'aws', '--enable', ','],
    ['tools', 'aws', '--enable', 'call_aws,call_aws'], ['login', 'supabase', '--token', 'fixture-private-token'],
  ])('rejects unsupported input without echoing secret values: %j', (...args) => {
    const result = parse(args)
    expect(result.invocation).toBeUndefined()
    expect(result.exits).toEqual([1])
    expect(result.stderr).not.toContain('fixture-private-token')
  })

  it('prints profile help without admitting a command', () => {
    const result = parse(['--help'])
    expect(result.invocation).toBeUndefined()
    expect(result.stdout).toContain('Usage: dsh cloud')
    expect(result.stdout).toContain('--all')
    expect(result.exits).toEqual([0])
  })
})

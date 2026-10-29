/** Cloud connector boundaries must work without an AWS/Supabase account. */

import { describe, expect, it } from 'vitest'
import { get } from 'node:http'
import { AWS_MCP_REGIONS, cloudMcpUrl } from '../src/catalog.ts'
import { parseCloudGrant } from '../src/oauth-provider.ts'
import { OAuthLoopback } from '../src/oauth-loopback.ts'
import { permissionCategory, defaultToolSelection } from '../src/consent.ts'

describe('cloud connector catalog and consent', () => {
  it('uses fixed public endpoints and rejects user-chosen AWS hosts', () => {
    expect(cloudMcpUrl('supabase')).toBe('https://mcp.supabase.com/mcp')
    expect(cloudMcpUrl('aws', 'ap-southeast-1')).toBe('https://aws-mcp.ap-southeast-1.api.aws/mcp')
    expect(() => cloudMcpUrl('aws', 'bad.region.com')).toThrow(/unsupported AWS region/)
  })

  it('supports every managed AWS MCP region, including Europe', () => {
    expect(AWS_MCP_REGIONS).toEqual([
      'us-east-1', 'us-west-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
      'eu-central-1', 'eu-west-1', 'eu-west-2',
    ])
    for (const region of AWS_MCP_REGIONS) {
      expect(cloudMcpUrl('aws', region)).toBe(`https://aws-mcp.${region}.api.aws/mcp`)
    }
  })

  it('refuses credentials whose endpoint is different from its fixed provider', () => {
    const grant = {
      grantId: '8f8935c8-028f-4d66-b1df-872c10b834ed', redirectUri: 'http://127.0.0.1:60432/oauth/callback',
      provider: 'supabase', endpoint: 'https://unexpected.example/mcp',
      tokens: { access_token: 'test-token', token_type: 'Bearer' },
      clientInformation: { client_id: 'client' }, confirmed: true, allowedTools: ['execute_sql'],
    }
    expect(parseCloudGrant('supabase', { kind: 'grant', payload: grant })).toBeUndefined()
    expect(parseCloudGrant('aws', { kind: 'grant', payload: { ...grant, endpoint: cloudMcpUrl('supabase') } })).toBeUndefined()
  })

  it('defaults every discovered tool on, including database write and IAM, without confirming', () => {
    expect(defaultToolSelection([{ name: 'execute_sql' }, { name: 'apply_migration' }, { name: 'other' }]))
      .toEqual(['execute_sql', 'apply_migration', 'other'])
    expect(permissionCategory('supabase', 'execute_sql')).toBe('database')
    expect(permissionCategory('supabase', 'apply_migration')).toBe('database')
    expect(permissionCategory('aws', 'iam_create_role')).toBe('iam')
    expect(permissionCategory('aws', 'aws___run_script')).toBe('iam')
    expect(permissionCategory('aws', 'call_aws')).toBe('iam')
    expect(permissionCategory('aws', 'aws___search_documentation')).toBe('other')
  })
})

describe('loopback OAuth callback', () => {
  // Test the Node HTTP listener using Node HTTP, independent of the test
  // environment's fetch interception and Undici connection pooling.
  const callbackRequest = async (url: string, path?: string): Promise<number | undefined> => await new Promise((resolve, reject) => {
    get(url, path === undefined ? {} : { path }, (response) => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode) })
      response.once('error', reject)
    }).once('error', reject)
  })

  it('rejects the wrong state, then accepts exactly one correct callback', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      expect(await callbackRequest(`${loopback.url}?state=incorrect&code=evil`)).toBe(400)
      expect(await callbackRequest(`${loopback.url}?state=${loopback.state}&code=one-time-code`)).toBe(200)
      await expect(loopback.result).resolves.toEqual({ code: 'one-time-code' })
      expect(await callbackRequest(`${loopback.url}?state=${loopback.state}&code=another-code`)).toBe(400)
    } finally {
      await loopback.close()
    }
  })

  it('rejects malformed and unexpected-origin targets without consuming the pending callback', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      expect(await callbackRequest(loopback.url, '//[')).toBe(400)
      expect(await callbackRequest(loopback.url,
        `http://unexpected.example/oauth/callback?state=${loopback.state}&code=wrong-origin-code`)).toBe(400)
      expect(await callbackRequest(`${loopback.url}?state=${loopback.state}&code=one-time-code`)).toBe(200)
      await expect(loopback.result).resolves.toEqual({ code: 'one-time-code' })
    } finally {
      await loopback.close()
    }
  })

  it('cancels an unfinished flow when the Host withdraws it', async () => {
    const controller = new AbortController()
    const loopback = await OAuthLoopback.listen(controller.signal)
    const result = expect(loopback.result).rejects.toThrow(/cancelled/)
    controller.abort()
    await result
    await loopback.close()
  })
})

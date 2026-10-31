/** External HTTP stand-ins; the cloud service, OAuth callback, consent, and native stdin remain real. */
const endpoint = 'https://mcp.supabase.com/mcp'
const issuer = 'https://identity.cloud-cli-pty.invalid'

export const name = 'cloud-oauth-http-fixture'

export function apply(ctx) {
  ctx.effect(() => {
    if (process.stdin.isTTY !== true) throw new Error('Cloud input fixture requires a native terminal')
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      request.signal.throwIfAborted()
      if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/')) {
        return Response.json({ resource: endpoint, authorization_servers: [issuer] })
      }
      if (url.origin === issuer && url.pathname.startsWith('/.well-known/')) {
        return Response.json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.href === `${issuer}/register`) {
        return Response.json({ ...await request.json(), client_id: 'fixture-client', client_secret: 'fixture-secret' }, { status: 201 })
      }
      if (url.href === `${issuer}/token`) {
        if (new URLSearchParams(await request.text()).get('grant_type') !== 'authorization_code') throw new Error('Unexpected fixture grant type')
        return Response.json({ access_token: 'fixture-private-access-token', refresh_token: 'fixture-private-refresh-token', token_type: 'Bearer' })
      }
      if (url.href !== endpoint) throw new Error('Unexpected fixture request')
      if (request.headers.get('authorization') !== 'Bearer fixture-private-access-token') throw new Error('Missing fixture authorization')
      if (request.method === 'GET') return new Response(null, { status: 405 })
      const rpc = await request.json()
      const result = value => Response.json({ jsonrpc: '2.0', id: rpc.id, result: value })
      switch (rpc.method) {
        case 'server/discover':
          return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
        case 'initialize':
          return result({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cloud-tty-fixture', version: '1.0.0' } })
        case 'notifications/initialized':
          return new Response(null, { status: 202 })
        case 'tools/list':
          return result({ tools: [{ name: 'execute_sql', description: 'Fixture SQL', inputSchema: { type: 'object' } }] })
        default:
          throw new Error('Unexpected fixture MCP method')
      }
    }
    return () => { globalThis.fetch = original }
  }, 'cloud CLI external OAuth and MCP fixture')
}

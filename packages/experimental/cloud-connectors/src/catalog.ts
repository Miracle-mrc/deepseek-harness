/** Provider identity and public MCP endpoint catalog for bundled cloud connections. */

/** Remote services users can connect to independently. */
export type CloudProvider = 'aws' | 'supabase'

/** AWS MCP Server regions supported by the managed endpoint. */
export const AWS_MCP_REGIONS = [
  'us-east-1', 'us-west-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2',
] as const

/**
 * A canonical managed MCP URL, with no user-controlled host or query injection.
 * @param provider - Cloud service to connect.
 * @param awsRegion - Supported managed-server region; ignored for Supabase.
 * @returns The fixed HTTPS MCP endpoint.
 * @throws If the AWS region is unsupported.
 */
export function cloudMcpUrl(provider: CloudProvider, awsRegion: string = 'us-east-1'): string {
  if (provider === 'supabase') return 'https://mcp.supabase.com/mcp'
  if (!(AWS_MCP_REGIONS as readonly string[]).includes(awsRegion)) {
    throw new Error(`Cloud connections: unsupported AWS region ${awsRegion}`)
  }
  return `https://aws-mcp.${awsRegion}.api.aws/mcp`
}

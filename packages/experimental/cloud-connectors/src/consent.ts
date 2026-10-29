/** Pure, platform-neutral tool-selection defaults and capability labels. */

import type { CloudProvider } from './catalog.ts'

/** Supabase MCP Database tools capable of reading, querying or modifying schemas. */
export const SUPABASE_DATABASE_TOOLS = new Set([
  'list_tables', 'list_extensions', 'list_migrations', 'apply_migration', 'execute_sql', 'generate_typescript_types',
])

/** Initial selection only: the user must still explicitly press Confirm. */
export function defaultToolSelection(tools: readonly { name: string }[]): string[] {
  return tools.map(tool => tool.name)
}

/** Capability label; the provider's account authorization still applies. */
export function permissionCategory(provider: CloudProvider, rawToolName: string): 'database' | 'iam' | 'other' {
  if (provider === 'supabase' && SUPABASE_DATABASE_TOOLS.has(rawToolName)) return 'database'
  if (provider === 'aws' && /(^|[_-])iam([_-]|$)|(^|[_-])(policy|policies|role|roles)([_-]|$)/i.test(rawToolName)) return 'iam'
  return 'other'
}

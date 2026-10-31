/** Pure, platform-neutral tool-selection defaults and capability labels. */

import type { CloudProvider } from './catalog.ts'

/** Supabase MCP Database tools capable of reading, querying or modifying schemas. */
export const SUPABASE_DATABASE_TOOLS = new Set([
  'list_tables', 'list_extensions', 'list_migrations', 'apply_migration', 'execute_sql', 'generate_typescript_types',
])

/**
 * Initial selection only: the user must still explicitly press Confirm.
 * @param tools - Tools offered by the connected provider.
 * @returns Every offered raw tool name, without enabling any tool.
 */
export function defaultToolSelection(tools: readonly { name: string }[]): string[] {
  return tools.map(tool => tool.name)
}

/**
 * Tool grouping only; generic AWS API and SQL tools can perform multiple kinds of operation.
 * @param provider - Provider which offered the tool.
 * @param rawToolName - Unmodified MCP tool name.
 * @returns The display group, not an operation-level permission policy.
 */
export function permissionCategory(provider: CloudProvider, rawToolName: string): 'database' | 'iam' | 'other' {
  if (provider === 'supabase' && SUPABASE_DATABASE_TOOLS.has(rawToolName)) return 'database'
  if (provider === 'aws' && /(^|[_-])(iam|policy|policies|role|roles|run_script|call_aws)([_-]|$)/i.test(rawToolName)) return 'iam'
  return 'other'
}

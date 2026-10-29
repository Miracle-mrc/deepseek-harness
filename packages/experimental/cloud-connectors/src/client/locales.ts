/** Small, browser-only copy for two official cloud connection cards. */

/** Namespace registered with the Plugins manager. */
export const NS = 'cloudConnections'

/** Translation keys for connection status, controls and consent. */
export type CloudConnectionLocaleKey =
  | 'awsTitle' | 'supabaseTitle' | 'awsSummary' | 'supabaseSummary'
  | 'status.not-connected' | 'status.authorizing' | 'status.choose-permissions' | 'status.connected' | 'status.failed'
  | 'scopeNote' | 'awsRegion' | 'connect' | 'browserHint' | 'openBrowser' | 'permissionsTitle'
  | 'permissionsHint' | 'noTools' | 'enableSelected' | 'enabledCount' | 'disconnect'
  | 'iamGroup' | 'databaseGroup' | 'iamTag' | 'databaseTag'
  | 'loadError' | 'connectError' | 'confirmError' | 'disconnectError' | 'awsAvailability'

/** All actionable English copy; other locale fallbacks are explicit until translations ship. */
export const en: Record<CloudConnectionLocaleKey, string> = {
  awsTitle: 'AWS', supabaseTitle: 'Supabase',
  awsSummary: 'Connect an AWS account to approved AWS MCP tools.',
  supabaseSummary: 'Connect a Supabase account to approved Supabase MCP tools.',
  'status.not-connected': 'Not connected',
  'status.authorizing': 'Waiting for browser sign-in…',
  'status.choose-permissions': 'Signed in · Select allowed MCP tools',
  'status.connected': 'Connected', 'status.failed': 'Connection failed',
  scopeNote: 'These switches control which MCP tools the agent can see. They do not grant AWS IAM roles, database permissions, or access to accounts outside your sign-in.',
  awsRegion: 'AWS MCP region', connect: 'Connect', browserHint: 'Complete sign-in in the browser window.',
  openBrowser: 'Open sign-in page', permissionsTitle: 'Choose tool permissions',
  permissionsHint: 'All available tools are checked initially. Review the list before enabling; deselect any tool you do not want this agent to use.',
  iamGroup: 'AWS IAM-related tools (all selected)',
  databaseGroup: 'Supabase database tools: read, SQL and migrations (all selected)',
  iamTag: 'IAM', databaseTag: 'Database',
  noTools: 'This connection did not offer any tools.', enableSelected: 'Enable selected tools',
  enabledCount: '{count} MCP tools enabled', disconnect: 'Disconnect this device',
  loadError: 'Could not read connection state.', connectError: 'Browser sign-in could not start.',
  confirmError: 'Could not save your tool permissions.', disconnectError: 'Could not remove this connection.',
  awsAvailability: 'AWS browser OAuth may require your MCP client to be approved for registration by AWS. If sign-in is denied, consult AWS support.',
}

/** Simplified Chinese copy for the currently supported Desktop locale. */
export const zh: Record<CloudConnectionLocaleKey, string> = {
  ...en,
  awsSummary: '连接 AWS 账户并启用经确认的 MCP 工具。',
  supabaseSummary: '连接 Supabase 账户并启用经确认的 MCP 工具。',
  'status.not-connected': '未连接',
  'status.authorizing': '等待浏览器登录…',
  'status.choose-permissions': '已登录 · 选择 MCP 工具权限',
  'status.connected': '已连接', 'status.failed': '连接失败',
  scopeNote: '这里控制代理可调用的 MCP 工具，不会授予 AWS IAM 权限或数据库权限。',
  awsRegion: 'AWS MCP 区域', connect: '连接', browserHint: '请在浏览器窗口中完成登录。',
  openBrowser: '打开登录页面', permissionsTitle: '选择工具权限',
  permissionsHint: '默认勾选全部可用工具。请在启用前检查并取消不需要的工具。',
  iamGroup: 'AWS IAM 相关工具（默认全部勾选）',
  databaseGroup: 'Supabase 数据库工具：读取、SQL、迁移（默认全部勾选）',
  iamTag: 'IAM', databaseTag: '数据库',
  noTools: '该连接没有返回工具。', enableSelected: '启用选中的工具',
  enabledCount: '已启用 {count} 个 MCP 工具', disconnect: '断开此设备连接',
  loadError: '无法读取连接状态。', connectError: '无法启动浏览器登录。',
  confirmError: '保存工具权限失败。', disconnectError: '无法移除连接。',
  awsAvailability: 'AWS 浏览器 OAuth 可能需要 AWS 预先批准客户端注册；如遇拒绝，请联系 AWS 支持。',
}

/** Fallbacks for the other six UI locales (not invented translations). */
export const ja = en
export const es = en
export const fr = en
export const de = en
export const ru = en
export const pt = en

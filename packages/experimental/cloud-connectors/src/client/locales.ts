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
  | 'awsToolsHint' | 'supabaseToolsHint'
  | 'region.us-east-1' | 'region.us-west-2' | 'region.ap-southeast-1' | 'region.ap-southeast-2'
  | 'region.ap-northeast-1' | 'region.eu-central-1' | 'region.eu-west-1' | 'region.eu-west-2'
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
  iamGroup: 'AWS API access, including IAM',
  databaseGroup: 'Supabase database tools: read, SQL and migrations',
  iamTag: 'AWS API / IAM', databaseTag: 'Database',
  awsToolsHint: 'General AWS API tools can also perform IAM operations allowed by your account. These checkboxes select whole tools, not individual IAM actions.',
  supabaseToolsHint: 'SQL tools can read or change data and schemas. Disabling the migration tool alone does not block schema changes through SQL.',
  'region.us-east-1': 'US East (N. Virginia)', 'region.us-west-2': 'US West (Oregon)',
  'region.ap-southeast-1': 'Asia Pacific (Singapore)', 'region.ap-southeast-2': 'Asia Pacific (Sydney)',
  'region.ap-northeast-1': 'Asia Pacific (Tokyo)', 'region.eu-central-1': 'Europe (Frankfurt)',
  'region.eu-west-1': 'Europe (Ireland)', 'region.eu-west-2': 'Europe (London)',
  noTools: 'This connection did not offer any tools.', enableSelected: 'Enable selected tools',
  enabledCount: '{count} MCP tools enabled', disconnect: 'Disconnect this device',
  loadError: 'Could not read connection state.', connectError: 'Browser sign-in could not start.',
  confirmError: 'Could not save your tool permissions.', disconnectError: 'Could not remove this connection.',
  awsAvailability: 'AWS sign-in requires OAuth permissions on your IAM identity. Authorization does not add AWS permissions. If registration or consent is denied, check the AWS error and your account policy.',
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
  iamGroup: 'AWS API 访问（包括 IAM）',
  databaseGroup: 'Supabase 数据库工具：读取、SQL、迁移',
  iamTag: 'AWS API / IAM', databaseTag: '数据库',
  awsToolsHint: '通用 AWS API 工具也可执行账户允许的 IAM 操作。这些复选框选择整个工具，而非单项 IAM 操作。',
  supabaseToolsHint: 'SQL 工具可读取或修改数据及表结构。仅禁用迁移工具不能阻止通过 SQL 修改表结构。',
  'region.us-east-1': '美国东部（弗吉尼亚北部）', 'region.us-west-2': '美国西部（俄勒冈）',
  'region.ap-southeast-1': '亚太地区（新加坡）', 'region.ap-southeast-2': '亚太地区（悉尼）',
  'region.ap-northeast-1': '亚太地区（东京）', 'region.eu-central-1': '欧洲（法兰克福）',
  'region.eu-west-1': '欧洲（爱尔兰）', 'region.eu-west-2': '欧洲（伦敦）',
  noTools: '该连接没有返回工具。', enableSelected: '启用选中的工具',
  enabledCount: '已启用 {count} 个 MCP 工具', disconnect: '断开此设备连接',
  loadError: '无法读取连接状态。', connectError: '无法启动浏览器登录。',
  confirmError: '保存工具权限失败。', disconnectError: '无法移除连接。',
  awsAvailability: 'AWS 登录要求 IAM 身份具备 OAuth 权限；授权不会增加 AWS 权限。如注册或授权被拒绝，请检查 AWS 错误及账户策略。',
}

/** English fallback for Japanese until translated copy is available. */
export const ja = en
/** English fallback for Spanish until translated copy is available. */
export const es = en
/** English fallback for French until translated copy is available. */
export const fr = en
/** English fallback for German until translated copy is available. */
export const de = en
/** English fallback for Russian until translated copy is available. */
export const ru = en
/** English fallback for Portuguese until translated copy is available. */
export const pt = en

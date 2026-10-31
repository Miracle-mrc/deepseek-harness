/** Command grammar for the standalone cloud profile. */
import { Command, Option } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { AWS_MCP_REGIONS } from '@deepseek-ai/dsh-experimental-cloud-connectors'
import type { CloudProvider } from '@deepseek-ai/dsh-experimental-cloud-connectors'
import type { CloudStartOptions } from '@deepseek-ai/dsh-experimental-cloud-connectors/types'

/** One command admitted by the cloud profile's parser. */
export type CloudInvocation =
  | { kind: 'login'; provider: CloudProvider; region: string; options: CloudStartOptions; secretStdin: boolean }
  | { kind: 'status'; provider?: CloudProvider }
  | { kind: 'tools'; provider: CloudProvider; selection?: { kind: 'all' } | { kind: 'names'; names: string[] } }
  | { kind: 'disconnect'; provider: CloudProvider }

/** Parsed login flags before provider-specific validation. */
interface LoginOptions {
  region: string
  awsProfile?: string
  awsMethod?: CloudStartOptions['awsMethod']
  secretStdin?: boolean
}

/** Reject unknown provider input without echoing command-line values. */
function providerOf(command: Command, value: string): CloudProvider {
  if (value === 'aws' || value === 'supabase') return value
  return command.error('error: select the aws or supabase provider')
}

/** Admit a comma-separated selection without accepting empty or duplicate names. */
function toolNames(command: Command, value: string): string[] {
  const names = value.split(',').map(name => name.trim())
  if (names.some(name => name.length === 0) || new Set(names).size !== names.length) {
    return command.error('error: --enable requires distinct, non-empty tool names separated by commas')
  }
  return names
}

/**
 * Parse this profile's arguments through the launcher's output and exit adapter.
 * @param ctx - launcher context with cmdlineArgs and appExit.
 * @returns the selected command, or undefined after help or a rejected invocation.
 */
export function parseCloudInvocation(ctx: Context): CloudInvocation | undefined {
  let invocation: CloudInvocation | undefined
  const program = new Command()
    .name('dsh cloud')
    .description('Manage local AWS and Supabase sign-ins and tool permissions.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Examples:
  dsh cloud login supabase                 sign in without enabling tools
  dsh cloud login aws --aws-profile dev    sign in with a named AWS CLI profile
  dsh cloud status                        inspect saved connections
  dsh cloud tools supabase                 review offered tools
  dsh cloud tools supabase --enable execute_sql,apply_migration
  dsh cloud tools aws --all                explicitly enable all offered tools
  dsh cloud disconnect supabase           remove the saved local connection
`)
  program.command('login')
    .description('Sign in to one provider; tool permissions remain a separate command.')
    .argument('<provider>', 'aws or supabase')
    .option('--region <region>', `AWS MCP region (${AWS_MCP_REGIONS.join(', ')})`, 'us-east-1')
    .option('--aws-profile <name>', 'named AWS CLI profile')
    .addOption(new Option('--aws-method <method>', 'AWS CLI authentication method').choices(['login', 'sso', 'existing']))
    .option('--secret-stdin', 'read requested private responses and confirmations from standard input')
    .action((rawProvider: string, options: LoginOptions, command: Command) => {
      const provider = providerOf(command, rawProvider)
      if (provider === 'supabase' && (command.getOptionValueSource('region') === 'cli'
        || options.awsProfile !== undefined || options.awsMethod !== undefined)) {
        command.error('error: --region, --aws-profile and --aws-method apply only to aws')
      }
      if (!(AWS_MCP_REGIONS as readonly string[]).includes(options.region)) {
        command.error('error: select a supported AWS MCP region; see dsh cloud login --help')
      }
      if (options.awsProfile !== undefined && (options.awsProfile.trim() === '' || /[\r\n\0]/.test(options.awsProfile))) {
        command.error('error: --aws-profile requires a non-empty profile name without line breaks')
      }
      invocation = {
        kind: 'login', provider, region: options.region,
        options: {
          ...options.awsProfile === undefined ? {} : { awsProfile: options.awsProfile },
          ...options.awsMethod === undefined ? {} : { awsMethod: options.awsMethod },
        },
        secretStdin: options.secretStdin === true,
      }
    })
  program.command('status')
    .description('Restore and inspect saved connections without changing tool permissions.')
    .argument('[provider]', 'aws or supabase; omit to inspect both')
    .action((rawProvider: string | undefined, _options: object, command: Command) => {
      invocation = { kind: 'status', ...rawProvider === undefined ? {} : { provider: providerOf(command, rawProvider) } }
    })
  program.command('tools')
    .description('List offered tools, or explicitly replace the allowed tool selection.')
    .argument('<provider>', 'aws or supabase')
    .option('--enable <names>', 'allow exactly these comma-separated raw MCP tool names')
    .option('--all', 'allow every currently offered tool')
    .option('--none', 'withdraw all tool permissions while keeping the sign-in')
    .action((rawProvider: string, options: { enable?: string; all?: boolean; none?: boolean }, command: Command) => {
      const provider = providerOf(command, rawProvider)
      if ([options.enable !== undefined, options.all === true, options.none === true].filter(Boolean).length > 1) {
        command.error('error: choose one of --enable, --all or --none')
      }
      const selection = options.all === true ? { kind: 'all' as const }
        : options.none === true ? { kind: 'names' as const, names: [] }
          : options.enable === undefined ? undefined : { kind: 'names' as const, names: toolNames(command, options.enable) }
      invocation = { kind: 'tools', provider, ...selection === undefined ? {} : { selection } }
    })
  program.command('disconnect')
    .description('Remove one saved local connection and its allowed tools.')
    .argument('<provider>', 'aws or supabase')
    .action((rawProvider: string, _options: object, command: Command) => {
      invocation = { kind: 'disconnect', provider: providerOf(command, rawProvider) }
    })
  program.action(() => { program.error('error: select login, status, tools or disconnect; see dsh cloud --help') })
  parseCmdline(ctx, program)
  return invocation
}

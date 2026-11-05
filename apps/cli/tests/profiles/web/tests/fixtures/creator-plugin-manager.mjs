/** Test-only IPC assertions over real Creator presets and profile management. */
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['agents', 'agentPresets', 'tools', 'pluginManager', 'permissionPresets', 'profileContext']

export function apply(ctx, config) {
  const receive = message => {
    if (message !== 'initial' && message !== 'restart' && message !== 'restored') return
    void inspect(message).then(result => process.send({ result }), error => process.send({ error: String(error.stack ?? error) }))
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
  async function inspect(phase) {
    const handles = []
    let activeSession
    let answer = 'rejected'
    const approvals = []
    const disposeApproval = ctx.on('approval/request', (request, next) => {
      if (request.toolName !== 'plugin_manager') return next()
      approvals.push(answer)
      return Promise.resolve(answer)
    }, { prepend: true })
    const make = async id => {
      const handle = await ctx.agents.create({ sessionId: id, cwd: process.cwd(),
        setup: scope => ctx.agentPresets.mount(scope, 'cordis').then(() => undefined) })
      handles.push(handle)
      return handle.agent
    }
    const names = agent => ctx.tools.schemas(agent).map(tool => tool.name)
    try {
      const first = await make(`${phase}-first`)
      const before = names(first)
      if (phase === 'restored') {
        const ping = await executeModelToolFixture(ctx, { name: 'mcp__demo__ping', arguments: {}, agent: first,
          callId: `${phase}-ping`, signal: new AbortController().signal })
        return { before, result: await ctx.pluginManager.listBundles(), ping, restoredProbe: ctx.get('creatorExportSourceProbe') }
      }
      const manage = args => executeModelToolFixture(ctx, { name: 'plugin_manager', arguments: args, agent: first,
        callId: `${phase}-manage`, signal: new AbortController().signal })
      ctx.permissionPresets.set(first.session, 'workspace-write')
      first.session.append('turn/start', { turn: 1 })
      activeSession = first.session
      const denied = await manage({ action: 'install_bundle', target: config.bundle })
      const afterDenied = names(first)
      const bundlesAfterDenied = await ctx.pluginManager.listBundles()
      answer = 'allowed-once'
      const result = phase === 'initial'
        ? JSON.parse((await manage({ action: 'install_bundle', target: config.bundle })).value)
        : await ctx.pluginManager.listBundles()
      const second = await make(`${phase}-second`)
      const after = names(first)
      const other = names(second)
      const ping = await executeModelToolFixture(ctx, { name: 'mcp__demo__ping', arguments: {}, agent: first,
        callId: `${phase}-ping`, signal: new AbortController().signal })
      const sources = [join(ctx.profileContext.dir, 'package.json'), ctx.profileContext.patchPath,
        ...['package.json', 'cordis.patch.yml', 'probe.mjs'].map(name => join(config.bundle, name))]
      const beforeExport = await Promise.all(sources.map(path => readFile(path, 'utf8')))
      const sourceExport = await ctx.pluginManager.exportSource({ repository: 'example/source-export-fixture', branch: 'creator/saved' })
      const afterExport = await Promise.all(sources.map(path => readFile(path, 'utf8')))
      const exportUnchanged = beforeExport.every((content, index) => content === afterExport[index])
      const removed = phase === 'restart'
        ? JSON.parse((await manage({ action: 'remove_bundle', target: '@test/creator-mcp' })).value) : undefined
      return { approvals, permission: ctx.permissionPresets.current(first.session), before, denied, afterDenied, bundlesAfterDenied, result, after, other, ping, sourceExport, exportUnchanged, removed, remaining: names(first) }
    } finally {
      disposeApproval()
      activeSession?.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await Promise.all(handles.map(handle => handle.dispose()))
    }
  }
}

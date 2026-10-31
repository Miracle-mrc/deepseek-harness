/** Plugins-page controls with private authorization responses sent only to the Host. */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-cloud-connectors/remote'
import type { CloudProvider } from '../catalog.ts'
import { CloudConnectionCard, type CloudConnectionActions } from './CloudConnectionCard.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type CloudConnectionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    cloudConnections: CloudConnectionLocaleKey
  }
}

/** Only local UI and Remote contributions are injected; neither provider connects on mount. */
export const inject = ['remote', 'slots', 'locale']

/** Unwrap a Remote reply; the card supplies localized, operation-specific errors. */
function unwrapCloudReply<T>(reply: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (reply.ok) return reply.value
  throw new Error(reply.error.message)
}

/** Register two official plugin cards, each explicitly connected by the user. */
function registerUi(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'cloud-connectors: locale')
  const actions: CloudConnectionActions = {
    list: async () => unwrapCloudReply(await ctx.remote.cloudConnections.list()),
    start: async (provider, region, options) => unwrapCloudReply(await ctx.remote.cloudConnections.start(provider, region, options)),
    complete: async (provider, prompt, response) =>
      unwrapCloudReply(await ctx.remote.cloudConnections.complete(provider, prompt, response)),
    cancel: async (provider, attempt) => unwrapCloudReply(await ctx.remote.cloudConnections.cancel(provider, attempt)),
    confirm: async (provider, tools) => unwrapCloudReply(await ctx.remote.cloudConnections.confirm(provider, tools)),
    disconnect: async provider => unwrapCloudReply(await ctx.remote.cloudConnections.disconnect(provider)),
  }
  for (const provider of ['aws', 'supabase'] as CloudProvider[]) {
    ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item', id: `cloud-${provider}`, order: provider === 'aws' ? 60 : 61,
      label: () => t(provider === 'aws' ? 'awsTitle' : 'supabaseTitle'),
      locale: NS, inject: () => ({ provider, actions }),
    }, CloudConnectionCard)), `cloud-connectors: ${provider} card`)
  }
}

/** Mount generated Remote methods before registering browser controls. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.cloudConnections', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}

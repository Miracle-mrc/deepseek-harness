/** JSON-only connection state transferred from Host to Plugins UI. */
import type { CloudProvider } from './catalog.ts'

/** No OAuth token, provider registration or authorization code can enter this value. */
export interface CloudConnectionView {
  provider: CloudProvider
  status: 'not-connected' | 'authorizing' | 'choose-permissions' | 'connected' | 'failed'
  tools: Array<{ name: string; description: string }>
  enabledTools: string[]
  error?: string
}

/** Browser hand-off for an authorization flow started on the Host. */
export interface CloudSignIn { url: string }

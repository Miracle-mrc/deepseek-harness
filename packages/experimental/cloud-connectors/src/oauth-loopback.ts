/** One-shot loopback redirect receiver for browser-based MCP OAuth. */

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/** Authorization response from a verified callback URL. */
export interface OAuthCallback {
  /** OAuth authorization code, sent only to the local Host. */
  code: string
  /** RFC 9207 issuer when supplied by the identity provider. */
  iss?: string
}

/** Bound, single-use local HTTP listener for one OAuth attempt. */
export class OAuthLoopback {
  /** Random state required before accepting a callback for this attempt. */
  readonly state = randomUUID()
  /** Exact loopback redirect URI to register with the OAuth provider. */
  readonly url: string
  /** One verified response; rejects on provider refusal or cancellation. */
  readonly result: Promise<OAuthCallback>
  private readonly server: Server
  private settle!: (callback: OAuthCallback) => void
  private fail!: (error: Error) => void
  private settled = false
  private closing: Promise<void> | undefined

  private constructor(server: Server, url: string) {
    this.server = server
    this.url = url
    this.result = new Promise((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
  }

  /**
   * Bind the callback on a random loopback port, never on a public interface.
   * @param signal - Cancels the unfinished callback and closes its listener.
   * @returns The bound callback receiver; the caller must await close during cleanup.
   * @throws If the local HTTP listener cannot be bound.
   */
  static async listen(signal: AbortSignal): Promise<OAuthLoopback> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`
    const callback = new OAuthLoopback(server, `${origin}/oauth/callback`)
    // The authorization flow may fail before it starts awaiting `result`;
    // install a rejection observer so early aborts never become unhandled.
    void callback.result.catch(() => undefined)
    server.on('request', (request, response) => {
      const url = URL.parse(request.url ?? '/', callback.url)
      // Invalid targets must not terminate or consume the pending sign-in.
      // Responses never echo the OAuth code, state, or identity-provider error.
      if (url === null || url.origin !== origin || request.method !== 'GET' || url.pathname !== '/oauth/callback'
        || url.searchParams.get('state') !== callback.state || callback.settled) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Invalid authorization callback')
        return
      }
      callback.settled = true
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error !== null || code === null || code.length === 0) {
        callback.fail(new Error('The identity provider declined or returned no authorization code'))
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Authorization was not completed. Return to DeepSeek Harness.')
        return
      }
      const issuer = url.searchParams.get('iss')
      callback.settle({ code, ...(issuer === null ? {} : { iss: issuer }) })
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Authorization received. Return to DeepSeek Harness.')
    })
    if (signal.aborted) void callback.close().catch(() => undefined)
    else signal.addEventListener('abort', () => { void callback.close().catch(() => undefined) }, { once: true })
    return callback
  }

  /** Stop listening and reject an unfinished attempt. */
  async close(): Promise<void> {
    if (this.closing !== undefined) {
      await this.closing
      return
    }
    if (!this.settled) {
      this.settled = true
      this.fail(new Error('Authorization was cancelled'))
    }
    // Await OS resource release: Windows can retain listening ports until
    // the close callback, even after cancellation was signaled.
    this.closing = new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await this.closing
  }
}

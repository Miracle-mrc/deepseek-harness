/** Manual and HTTP callbacks share one verified, single-use OAuth attempt. */

import { IncomingMessage, request, Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthLoopback } from '../src/oauth-loopback.ts'

afterEach(() => { vi.restoreAllMocks() })

async function callbackResponse(url: string, method = 'GET'): Promise<{ status: number | undefined; body: string }> {
  return await new Promise((resolve, reject) => {
    request(url, { method }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.once('end', () => { resolve({ status: response.statusCode, body }) })
      response.once('error', reject)
    }).once('error', reject).end()
  })
}

async function callbackStatus(url: string): Promise<number | undefined> {
  return (await callbackResponse(url)).status
}

describe('manual OAuth callback completion', () => {
  it('does not consume a POST, then settles an HTTP denial with a credential-free response', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      expect((await callbackResponse(`${loopback.url}?state=${loopback.state}&code=private-ignored-code`, 'POST')).status).toBe(400)
      const rejected = expect(loopback.result).rejects.toThrow('The identity provider declined or returned no authorization code')
      const response = await callbackResponse(`${loopback.url}?state=${loopback.state}&error=access_denied&error_description=private-provider-message`)
      expect(response).toEqual({ status: 200, body: 'Authorization was not completed. Return to DeepSeek Harness.' })
      expect(JSON.stringify(response)).not.toContain('private-')
      await rejected
    } finally {
      await loopback.close()
    }
  })

  it('refuses a request without an HTTP target while preserving the pending attempt', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    // oxlint-disable-next-line typescript/unbound-method -- retain native dispatch; call() supplies its Server receiver.
    const emit = EventEmitter.prototype.emit
    const intercepted = vi.spyOn(Server.prototype, 'emit').mockImplementation(
      function (this: Server, event: string | symbol, ...args: unknown[]) {
        if (event === 'request' && args[0] instanceof IncomingMessage) args[0].url = undefined
        return emit.call(this, event, ...args)
      },
    )
    try {
      expect(await callbackStatus(`${loopback.url}?state=${loopback.state}&code=missing-target-code`)).toBe(400)
      intercepted.mockRestore()
      expect(await callbackStatus(`${loopback.url}?state=${loopback.state}&code=valid-target-code`)).toBe(200)
      await expect(loopback.result).resolves.toEqual({ code: 'valid-target-code' })
    } finally {
      intercepted.mockRestore()
      await loopback.close()
    }
  })

  it('reports an OS bind refusal without returning a callback receiver', async () => {
    const failure = Object.assign(new Error('Loopback listening is unavailable'), { code: 'EACCES' })
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      this.emit('error', failure)
      return this
    })
    await expect(OAuthLoopback.listen(new AbortController().signal)).rejects.toBe(failure)
  })

  it.each([true, false])('settles cancellation and shares the OS close failure when already aborted is %s', async (alreadyAborted) => {
    // oxlint-disable-next-line typescript/unbound-method -- retain native OS cleanup; call() supplies its Server receiver.
    const nativeClose = Server.prototype.close
    const failure = new Error('Loopback close could not be confirmed')
    const close = vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (this: Server, callback) {
      return nativeClose.call(this, () => { callback?.(failure) })
    })
    const controller = new AbortController()
    if (alreadyAborted) controller.abort()
    const loopback = await OAuthLoopback.listen(controller.signal)
    const rejected = expect(loopback.result).rejects.toThrow('Authorization was cancelled')
    if (!alreadyAborted) controller.abort()
    await rejected
    await expect(loopback.close()).rejects.toBe(failure)
    await expect(loopback.close()).rejects.toBe(failure)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects unrelated pasted URLs without consuming the attempt, then retains the code and issuer', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      const query = `?state=${loopback.state}&code=one-time-code&iss=https%3A%2F%2Fidentity.example`
      const valid = `${loopback.url}${query}`
      for (const invalid of [
        'not-a-url', `/oauth/callback${query}`,
        `${loopback.url}?state=other-attempt&code=wrong-state`,
        `${loopback.url.replace('/oauth/callback', '/other')}${query}`,
        `${loopback.url.replace('127.0.0.1', 'localhost')}${query}`,
        `${loopback.url.replace('http:', 'https:')}${query}`,
        `${loopback.url.replace('127.0.0.1', 'user@127.0.0.1')}${query}`,
        `${valid}#fragment`,
      ]) expect(loopback.completeCallback(invalid)).toBe(false)

      expect(loopback.completeCallback(valid)).toBe(true)
      await expect(loopback.result).resolves.toEqual({ code: 'one-time-code', iss: 'https://identity.example' })
      expect(loopback.completeCallback(`${loopback.url}?state=${loopback.state}&code=second-code`)).toBe(false)
      expect(await callbackStatus(`${loopback.url}?state=${loopback.state}&code=http-code`)).toBe(400)
    } finally {
      await loopback.close()
    }
  })

  it('accepts the HTTP callback before a pasted callback and keeps the first response', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      expect(await callbackStatus(`${loopback.url}?state=${loopback.state}&code=http-code&iss=https%3A%2F%2Fidentity.example`)).toBe(200)
      expect(loopback.completeCallback(`${loopback.url}?state=${loopback.state}&code=pasted-code`)).toBe(false)
      await expect(loopback.result).resolves.toEqual({ code: 'http-code', iss: 'https://identity.example' })
    } finally {
      await loopback.close()
    }
  })

  it.each([
    '&error=access_denied&error_description=sensitive-provider-detail&code=ignored-code',
    '', '&code=',
  ])('settles a matching unsuccessful callback without exposing provider details: %s', async (query) => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    try {
      const rejected = expect(loopback.result).rejects.toThrow('The identity provider declined or returned no authorization code')
      expect(loopback.completeCallback(`${loopback.url}?state=${loopback.state}${query}`)).toBe(true)
      await rejected
      expect(loopback.completeCallback(`${loopback.url}?state=${loopback.state}&code=late-code`)).toBe(false)
    } finally {
      await loopback.close()
    }
  })

  it('rejects a pasted callback after cancellation', async () => {
    const loopback = await OAuthLoopback.listen(new AbortController().signal)
    const rejected = expect(loopback.result).rejects.toThrow('Authorization was cancelled')
    await loopback.close()
    await rejected
    expect(loopback.completeCallback(`${loopback.url}?state=${loopback.state}&code=cancelled-code`)).toBe(false)
  })
})

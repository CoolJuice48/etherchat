// Etherchat's emails, sign-in codes, invites, request news and allow
// requests, each with an HTML part and a plain-text part, and the mailers
// that send them. A port of go/adapters/mail.

import type { Logger } from '../../core/log.ts'

export {
  signInCode, inviteLink, invite, requestEmail, allowRequestEmail, allowCommandFor, previews, escapeHtml, safeUrl,
} from './templates.ts'
export type { InviteDetails, RequestNewsItem, RequestNews, AllowRequest } from './templates.ts'

/** One email. html is optional (''); text is always sent. */
export interface Message {
  to: string
  subject: string
  text: string
  html: string
}

/** Sends messages. */
export interface Mailer {
  /** Throws MailDisabledError when no provider is configured. */
  send(m: Message): Promise<void>
}

/** Thrown by send when no provider is configured (Go's ErrDisabled). */
export class MailDisabledError extends Error {
  constructor() {
    super('email is not configured')
    this.name = 'MailDisabledError'
  }
}

/** The mailer for provider: "resend", "log", or "" for none. */
export function newMailer(provider: '' | 'log' | 'resend', apiKey: string, from: string, log: Logger): Mailer {
  switch (provider) {
    case 'resend':
      return new Resend(apiKey, from)
    case 'log':
      return new LogMailer(log)
  }
  return new DisabledMailer()
}

/** Refuses to send. */
export class DisabledMailer implements Mailer {
  async send(_m: Message): Promise<void> {
    throw new MailDisabledError()
  }
}

/**
 * Writes messages to the server log instead of sending them. It exists for
 * local testing: the log then contains sign-in codes, so never use it on a
 * server other people sign in to.
 */
export class LogMailer implements Mailer {
  private readonly log: Logger

  constructor(log: Logger) {
    this.log = log
  }

  async send(m: Message): Promise<void> {
    this.log.warn('email not sent (mail.provider = log)', { to: m.to, subject: m.subject, text: m.text })
  }
}

/** Sends through Resend's HTTPS API. */
export class Resend implements Mailer {
  readonly apiKey: string
  readonly from: string
  /** Defaults to https://api.resend.com/emails. */
  endpoint = 'https://api.resend.com/emails'
  /** The whole request's time limit. */
  timeoutMs = 15_000

  constructor(apiKey: string, from: string, endpoint?: string) {
    this.apiKey = apiKey
    this.from = from
    if (endpoint) this.endpoint = endpoint
  }

  async send(m: Message): Promise<void> {
    // The keys in the order Go's encoding/json writes a map, with its
    // HTML-safe escaping, so the request body is the Go server's byte for byte.
    const payload: Record<string, unknown> = { from: this.from }
    if (m.html !== '') payload.html = m.html
    payload.subject = m.subject
    payload.text = m.text
    payload.to = [m.to]
    const body = JSON.stringify(payload).replace(/[<>&\u2028\u2029]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

    let resp: Response
    try {
      resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      throw new Error(`resend: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    if (Math.floor(resp.status / 100) !== 2) {
      const detail = (await readUpTo(resp, 2048)).trim()
      throw new Error(`resend: HTTP ${resp.status}: ${detail}`)
    }
    await resp.body?.cancel()
  }
}

/** Reads at most limit bytes of a response body as text. */
async function readUpTo(resp: Response, limit: number): Promise<string> {
  if (!resp.body) return ''
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value.subarray(0, limit - size))
      size += Math.min(value.length, limit - size)
    }
  } catch {
    // Keep what arrived.
  } finally {
    reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}

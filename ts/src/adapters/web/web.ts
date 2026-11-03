// The web view's shared machinery (go/adapters/web/web.go): configuration,
// rendering, errors, sessions, forms, redirects, and the security headers
// every page carries.

import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { isKind } from '../../core/errors.ts'
import { goUpper } from '../../core/ether/gofmt.ts'
import type { Account, EtherService } from '../../core/ether/index.ts'
import type { Logger } from '../../core/log.ts'
import { clientIp, RateLimiter } from '../../core/ratelimit.ts'
import type { AuthService } from '../auth/index.ts'
import type { Mailer } from '../mail/index.ts'
import type { OAuthServer } from '../oauth/index.ts'
import { OTP_JS, STYLE_CSS } from './assets.ts'
import { renderPage, type Funcs, type PageName, type View } from './templates.ts'
import { stamp, zone } from './time.ts'
import { cleanPath, parseQuery, type Values } from './urls.ts'

/** The browser session cookie. The __Host- prefix makes browsers require Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-ether_session'

export const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
export const DOWNLOAD_CSP = "default-src 'none'; sandbox"

/** What the web view needs. */
export interface WebConfig {
  ethers: EtherService
  auth: AuthService
  /** Leaving it out leaves out the OAuth consent page. */
  oauth?: OAuthServer
  /** Sends invites and requests to admins. */
  mailer: Mailer
  /** Like https://etherchat.example, for links in emails. */
  baseUrl: string
  log: Logger
  /** Serves /dev/mail, the emails rendered with sample data. Development only. */
  mailPreviews: boolean
  /** How an admin allows an address, shown in the email a member can send them; EMAIL stands for the address. */
  allowCommand: string
  /** The IANA time zone pages show times in ('' is UTC). */
  timeZone: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

/** The web view's state and helpers, shared by every handler. */
export class Web {
  readonly ethers: EtherService
  readonly auth: AuthService
  readonly oauth?: OAuthServer
  readonly mail: Mailer
  readonly baseUrl: string
  readonly log: Logger
  readonly allowCmd: string
  readonly timeZone: string
  /** Requests to admins, per account. */
  readonly limits = new RateLimiter()
  /** The stylesheet URL carries a hash of its content, so browsers can cache it and still pick up a new version. */
  readonly cssUrl: string
  /** The code page's CSP: the page CSP plus its one script, by hash. */
  readonly codeCsp: string
  readonly funcs: Funcs

  constructor(c: WebConfig) {
    this.ethers = c.ethers
    this.auth = c.auth
    this.oauth = c.oauth
    this.mail = c.mailer
    this.baseUrl = c.baseUrl.replace(/\/+$/, '')
    this.log = c.log
    this.allowCmd = c.allowCommand || 'etherd admin allow --email EMAIL'
    this.timeZone = c.timeZone || 'UTC'
    this.cssUrl = '/static/style.css?v=' + sha256(STYLE_CSS).subarray(0, 6).toString('hex')
    this.codeCsp = PAGE_CSP + "; script-src 'sha256-" + sha256(OTP_JS).toString('base64') + "'"
    this.funcs = {
      stamp: (t) => stamp(t, this.timeZone),
      zone: () => zone(this.timeZone),
      client: (id) => this.clientName(id),
      cssUrl: this.cssUrl,
      otpScript: OTP_JS,
    }
  }

  /** An MCP client by the name it registered, falling back to its ID (e.g. "dev"). */
  clientName(id: string): string {
    if (!this.oauth || id === '') return id
    return this.oauth.clientName(id)
  }

  /** The MCP address people add to their AI app. */
  connector(): string {
    return this.baseUrl + '/mcp'
  }

  render(status: number, name: PageName, v: View, headers: Record<string, string> = {}): Response {
    const h = new Headers(headers)
    if (name === 'code') h.set('Content-Security-Policy', this.codeCsp)
    h.set('Content-Type', 'text/html; charset=utf-8')
    let body: string
    try {
      body = renderPage(name, v, this.funcs)
    } catch (err) {
      // Go writes the status first, then logs a template failure.
      this.log.error('rendering page', { page: name, err })
      body = ''
    }
    return new Response(body, { status, headers: h })
  }

  /** An error page for a domain error. */
  fail(c: Context, acct: Account | undefined, err: unknown): Response {
    const v: View = { account: acct, title: 'Not found', status: 404, error: "That doesn't exist, or you aren't a member of its ether." }
    if (isKind(err, 'not_found')) {
      // as above
    } else if (isKind(err, 'invalid')) {
      Object.assign(v, { title: 'Bad request', status: 400, error: (err as Error).message })
    } else if (isKind(err, 'forbidden')) {
      Object.assign(v, { title: 'Not allowed', status: 403, error: (err as Error).message })
    } else {
      this.log.error('web request failed', { path: requestPath(c), err })
      Object.assign(v, { title: 'Something went wrong', status: 500, error: 'Something went wrong on the server.' })
    }
    return this.render(v.status as number, 'error', v)
  }

  /** The signed-in account, if the session cookie names a live session. */
  currentAccount(c: Context): Account | undefined {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    if (token === undefined) return undefined
    try {
      return this.auth.sessionAccount(token)
    } catch {
      return undefined
    }
  }

  /** The visitor's address: Cloudflare's CF-Connecting-IP, or the connection's. */
  clientIp(c: Context): string {
    return clientIp(c.req.raw.headers, remoteAddr(c))
  }
}

/** The request's path, decoded, as Go's r.URL.Path. */
export function requestPath(c: Context): string {
  return decodePath(new URL(c.req.url).pathname)
}

/** Go's r.URL.RequestURI(): the escaped path and the query. */
export function requestUri(c: Context): string {
  const u = new URL(c.req.url)
  return u.pathname + u.search
}

/** The URL's query, parsed as Go's r.URL.Query(). */
export function query(c: Context): Values {
  const u = c.req.url
  const q = u.indexOf('?')
  if (q < 0) return new Map()
  const h = u.indexOf('#', q)
  return parseQuery(u.slice(q + 1, h < 0 ? undefined : h))
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

// The connection's address on Node (@hono/node-server passes the request as env.incoming).
function remoteAddr(c: Context): string {
  type Bindings = { incoming?: { socket?: { remoteAddress?: string } } }
  const env = c.env as (Bindings & { server?: Bindings }) | undefined
  return (env?.server ?? env)?.incoming?.socket?.remoteAddress ?? ''
}

// Go's validCookieValueByte.
const cookieValue = /^[\x20\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/

/** The first cookie named name in a Cookie header, as Go's r.Cookie reads it. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (let part of (header ?? '').split(';')) {
    part = part.trim()
    if (part === '') continue
    const eq = part.indexOf('=')
    const k = (eq < 0 ? part : part.slice(0, eq)).trim()
    if (k !== name) continue
    let v = eq < 0 ? '' : part.slice(eq + 1).trim()
    if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (cookieValue.test(v)) return v
  }
  return undefined
}

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Go's http.TimeFormat ("Mon, 02 Jan 2006 15:04:05 GMT"). */
export function httpDate(t: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[t.getUTCDay()]}, ${p(t.getUTCDate())} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())} GMT`
}

/** The session cookie as Go's http.Cookie writes it. */
export function sessionCookie(token: string, expires: Date): string {
  const maxAge = Math.trunc((expires.getTime() - Date.now()) / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; Expires=${httpDate(expires)}` +
    (maxAge > 0 ? `; Max-Age=${maxAge}` : maxAge < 0 ? '; Max-Age=0' : '') + '; HttpOnly; Secure; SameSite=Lax'
}

/** The cookie that ends the session. */
export const CLEAR_SESSION = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

/** Keeps post-sign-in redirects on this site. */
export function safeNext(next: string): string {
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

// net/http's htmlEscape, for redirect bodies.
function goHtmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[c] as string)
}

const statusText: Record<number, string> = { 303: 'See Other', 307: 'Temporary Redirect' }
const utf8 = new TextEncoder()

// Go's hexEscapeNonASCII, plus its header writer's newline-to-space (and
// any other control character, which a Headers object would refuse).
function headerSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch.charCodeAt(0) >= 0x80) {
      for (const b of utf8.encode(ch)) out += '%' + b.toString(16)
    } else if (/[\x00-\x08\x0a-\x1f\x7f]/.test(ch)) out += ' '
    else out += ch
  }
  return out
}

// Whether url.Parse would give a URL with neither scheme nor host, and no error.
function relativeUrl(url: string): boolean | undefined {
  if (/[\x00-\x1f\x7f]/.test(url) || /%(?![0-9a-fA-F]{2})/.test(url.split('#')[0])) return undefined
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return false
  if (url.startsWith('//')) return false
  return true
}

/** Go's http.Redirect. */
export function redirect(c: Context, url: string, status = 303): Response {
  if (relativeUrl(url)) {
    if (url === '' || url[0] !== '/') {
      const old = new URL(c.req.url).pathname || '/'
      url = old.slice(0, old.lastIndexOf('/') + 1) + url
    }
    let q = ''
    const i = url.indexOf('?')
    if (i >= 0) {
      q = url.slice(i)
      url = url.slice(0, i)
    }
    const trailing = url.endsWith('/')
    url = cleanPath(url)
    if (trailing && !url.endsWith('/')) url += '/'
    url += q
  }
  const h = new Headers({ Location: headerSafe(url) })
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD') h.set('Content-Type', 'text/html; charset=utf-8')
  const body = method === 'GET' ? `<a href="${goHtmlEscape(url)}">${statusText[status]}</a>.\n\n` : null
  return new Response(body, { status, headers: h })
}

/** Go's http.Error: plain text and a newline. */
export function httpError(msg: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(msg + '\n', {
    status,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  })
}

/** Go's http.NotFound. */
export function notFound(): Response {
  return httpError('404 page not found', 404)
}

/** A request's form, read as Go's r.FormValue and r.PostForm do. */
export class Form {
  /** The body's fields (Go's PostForm). */
  readonly post: Values
  readonly query: Values
  /** Set when the body couldn't be read (Go's ParseForm error). */
  readonly err?: string

  constructor(post: Values, query: Values, err?: string) {
    this.post = post
    this.query = query
    this.err = err
  }

  /** Go's FormValue: the first value from the body, then the query. */
  get(key: string): string {
    return this.post.get(key)?.[0] ?? this.query.get(key)?.[0] ?? ''
  }

  /** Go's PostForm[key]. */
  all(key: string): string[] {
    return this.post.get(key) ?? []
  }
}

/** Go's limit on a url-encoded body. */
const maxFormBytes = 10 << 20

async function readLimited(req: Request, max: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
      await reader.cancel()
      return undefined
    }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Reads a POST's form fields, url-encoded or multipart, as Go's ParseMultipartForm does. */
export async function readForm(c: Context): Promise<Form> {
  const q = query(c)
  const method = c.req.method
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return new Form(new Map(), q)
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'application/x-www-form-urlencoded') {
    const body = await readLimited(c.req.raw, maxFormBytes)
    if (!body) return new Form(new Map(), q, 'http: POST too large')
    return new Form(parseQuery(new TextDecoder().decode(body)), q)
  }
  if (type === 'multipart/form-data') {
    try {
      const fd = await c.req.raw.formData()
      const post: Values = new Map()
      for (const [k, v] of fd) {
        if (typeof v !== 'string') continue
        const list = post.get(k)
        if (list) list.push(v)
        else post.set(k, [v])
      }
      return new Form(post, q)
    } catch (err) {
      return new Form(new Map(), q, (err as Error).message)
    }
  }
  return new Form(new Map(), q)
}

/**
 * The confirmations a redirect can ask for with ?n=. Only these fixed
 * sentences can appear, so a crafted link can't put words on the page.
 */
const notices: Record<string, string> = {
  created: 'Ether created. The invites are on their way.',
  solo: "Ether created. Invite people below whenever you're ready.",
  unsent: "Some invite emails couldn't be sent. Invite those people again below.",
  joined: "You're in.",
  invited: 'Invite sent.',
  revoked: 'Invite withdrawn.',
  removed: 'Member removed. Their files stay as history.',
  declined: 'Invite declined.',
  answered: 'Answer sent. The agents see it the next time they catch up.',
  asked: "Request sent to the server's admin. You can invite them once they've allowed it.",
  asklimit: "You've sent the admin enough requests for today. Try again tomorrow.",
  asknotsent: "The request couldn't be sent. Try again later.",
  saved: 'Saved.',
  renamed: "Your agent's name is saved.",
}

export function notice(c: Context): string {
  const n = query(c).get('n')?.[0] ?? ''
  return Object.hasOwn(notices, n) ? notices[n] : ''
}

const sentinels = ['invalid request', 'limit reached', 'already exists', 'not allowed', 'not allowed', 'not found']

/** Turns a service error into a sentence for the page. */
export function userMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err)
  for (const s of sentinels) {
    if (msg.startsWith(s + ': ')) {
      msg = msg.slice(s.length + 2)
      break
    }
  }
  const first = msg.codePointAt(0)
  msg = first === undefined ? '\uFFFD' : goUpper(String.fromCodePoint(first)) + msg.slice(String.fromCodePoint(first).length)
  if (!msg.endsWith('.')) msg += '.'
  return msg
}

/** Go's cleanPath for request paths: path.Clean, keeping a trailing slash. */
export function cleanRequestPath(p: string): string {
  if (p === '') return '/'
  if (p[0] !== '/') p = '/' + p
  let np = cleanPath(p)
  if (p.endsWith('/') && np !== '/') np += '/'
  return np
}

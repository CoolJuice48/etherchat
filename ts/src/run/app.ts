// The root HTTP app, a port of go/run/server: the health check, the MCP
// endpoint behind bearer tokens, the OAuth routes, the web app, Host checks,
// security headers, and request logging. On Workers it also serves the
// admin endpoints under /_admin/ when ADMIN_TOKEN is set. Node and Cloudflare serve the same
// app; on Cloudflare every request arrives through Cloudflare, so loopback
// hosts and the development token are never accepted there.

import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { Account, EtherService } from '../core/ether/index.ts'
import type { Logger } from '../core/log.ts'
import type { AuthService } from '../adapters/auth/index.ts'
import type { Mailer } from '../adapters/mail/index.ts'
import type { OAuthServer, TokenInfo } from '../adapters/oauth/index.ts'
import { createMcpHandler, SCOPE } from '../adapters/mcp/index.ts'
import { createWebApp } from '../adapters/web/index.ts'
import { EtherError } from '../core/errors.ts'
import { splitHostPort, type Config, type Platform } from './config.ts'
import * as admin from './admin.ts'

export const version = '0.2.0-dev'

export interface AppOptions {
  config: Config
  ethers: EtherService
  auth: AuthService
  oauth: OAuthServer
  mailer: Mailer
  log: Logger
  /** How an admin allows an address, for the emails asking them to (EMAIL is replaced). */
  allowCommand: string
  /** The clock for token expiry; real time by default. */
  now?: () => Date
}

/** Builds the root app. It throws if DEV_ACCOUNT can't be used. */
export function createApp(o: AppOptions): Hono {
  const { config: cfg, log } = o
  const now = o.now ?? (() => new Date())
  const viaCloudflare = (req: Request): boolean => cfg.platform === 'workers' || fromTunnel(req.headers)

  // Loopback names are accepted only on Node, for requests made on this
  // machine; behind the tunnel every request arrives on 127.0.0.1 carrying
  // the public Host.
  const local = new Set<string>()
  if (cfg.platform === 'node') {
    const port = splitHostPort(cfg.listen)?.port ?? ''
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) local.add(`${h}:${port}`)
  }

  // OAuth access tokens, plus the local-only development token if configured.
  const devVerify = devVerifier(cfg, o.ethers, viaCloudflare, now)
  const verify = (token: string, req: Request): TokenInfo | undefined => o.oauth.verify(token) ?? devVerify(token, req)

  const mcp = createMcpHandler({ ethers: o.ethers, mailer: o.mailer, baseUrl: o.oauth.issuer(), timeZone: cfg.timeZone, version, log })
  const web = createWebApp({
    ethers: o.ethers, auth: o.auth, oauth: o.oauth, mailer: o.mailer, baseUrl: cfg.baseUrl, log,
    mailPreviews: cfg.dev.token !== '', allowCommand: o.allowCommand, timeZone: cfg.timeZone,
  })

  const app = new Hono()
  app.onError((err, c) => {
    log.error('handler failed', { method: c.req.method, path: logPath(c.req.path), err })
    return httpError('Internal Server Error', 500)
  })
  app.use(logRequests(log, viaCloudflare))
  app.use(hostPolicy(cfg.domain, local, viaCloudflare, cfg.platform === 'workers'))
  app.use(securityHeaders)

  app.get('/healthz', () => new Response('ok\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  }))
  app.all('/mcp', requireBearerToken(verify, o.oauth.resourceMetadataUrl(), now, mcp))
  o.oauth.routes(app)
  if (cfg.adminToken) app.route('/_admin', adminRoutes(cfg, o.ethers))
  // The web app last, as a whole app with its own not-found and error pages.
  app.all('*', (c) => web.fetch(c.req.raw, c.env, executionCtx(c)))
  return app
}

/**
 * The command an admin runs to allow an address, for the emails asking them
 * to; EMAIL stands for the address. On Node it's this script and .env file,
 * run as the user the server runs as. On Workers it's a call to /_admin/allow.
 */
export function allowCommand(o: {
  platform: Platform
  baseUrl?: string
  envFile?: string // absolute
  script?: string // absolute path of node.ts
  node?: string // the node binary
  user?: string
}): string {
  if (o.platform === 'workers') {
    return `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode email=EMAIL ${o.baseUrl}/_admin/allow`
  }
  if (!o.envFile || !o.script) return 'node src/run/node.ts admin allow --email EMAIL'
  const sudo = o.user ? `sudo -u ${o.user} ` : ''
  return `${sudo}${o.node ?? 'node'} ${o.script} admin --env ${o.envFile} allow --email EMAIL`
}

/**
 * Whether a request came through Cloudflare (the tunnel). Cloudflare always
 * sets these headers, so a remote client can't strip them.
 */
export function fromTunnel(headers: Headers): boolean {
  return (headers.get('cf-connecting-ip') ?? '') !== '' || (headers.get('cf-ray') ?? '') !== ''
}

/** Compares secrets without leaking where they differ, or their lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Go's http.Error: plain text, a trailing newline, nosniff. */
export function httpError(msg: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(msg + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

// The development token from the config, accepted only for requests made on
// this machine. With no token configured, every token is rejected.
function devVerifier(cfg: Config, ethers: EtherService, viaCloudflare: (req: Request) => boolean, now: () => Date):
  (token: string, req: Request) => TokenInfo | undefined {
  if (cfg.dev.token === '') return () => undefined
  let acct: Account
  try {
    acct = ethers.ensureAccount(cfg.dev.account, false)
  } catch (err) {
    throw new Error(`DEV_ACCOUNT ${cfg.dev.account}: ${(err as Error).message}`, { cause: err })
  }
  const want = cfg.dev.token
  return (token, req) => {
    if (viaCloudflare(req) || !constantTimeEqual(token, want)) return undefined
    let current: Account
    try {
      current = ethers.accountById(acct.id)
    } catch {
      return undefined
    }
    if (current.disabled) return undefined
    return { userId: acct.id, clientId: 'dev', scopes: [SCOPE], expiresAt: new Date(now().getTime() + 60 * 60 * 1000) }
  }
}

// The MCP SDK's RequireBearerToken, as the Go server uses it: a 401 (or 403
// for a missing scope) carries the RFC 9728 resource_metadata URL and the
// scope, so clients can discover how to get a token.
function requireBearerToken(
  verify: (token: string, req: Request) => TokenInfo | undefined,
  metadataUrl: string,
  now: () => Date,
  next: (req: Request, token: TokenInfo) => Promise<Response>,
): (c: Context) => Promise<Response> {
  const challenge = { 'WWW-Authenticate': `Bearer resource_metadata=${JSON.stringify(metadataUrl)}, scope=${JSON.stringify(SCOPE)}` }
  return async (c) => {
    const fields = (c.req.header('authorization') ?? '').trim().split(/\s+/)
    if (fields.length !== 2 || fields[0].toLowerCase() !== 'bearer') return httpError('no bearer token', 401, challenge)
    const info = verify(fields[1], c.req.raw)
    if (!info) return httpError('invalid token', 401, challenge)
    if (!info.scopes.includes(SCOPE)) return httpError('insufficient scope', 403, challenge)
    const exp = info.expiresAt instanceof Date ? info.expiresAt.getTime() : NaN
    if (Number.isNaN(exp)) return httpError('token missing expiration', 401, challenge)
    if (exp < now().getTime()) return httpError('token expired', 401, challenge)
    return next(c.req.raw, info)
  }
}

// Accepts the public domain, and loopback names only for requests that
// didn't come through Cloudflare. On Node the host is the Host header, as in
// Go. On Workers it's the request URL's host, which is what Cloudflare routed
// on (inside the runtime the Host header can name a local proxy instead).
function hostPolicy(domain: string, local: Set<string>, viaCloudflare: (req: Request) => boolean, fromUrl: boolean): MiddlewareHandler {
  return async (c, next) => {
    const host = (fromUrl ? new URL(c.req.url).host : c.req.header('host') ?? '').toLowerCase()
    let ok = domain !== '' && host === domain
    if (!ok && !viaCloudflare(c.req.raw)) ok = local.has(host)
    if (!ok) return httpError('unknown host', 421)
    await next()
  }
}

// Defaults every response gets; a handler that sets its own keeps it.
const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  for (const [k, v] of [['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer']]) {
    if (c.res.headers.has(k)) continue
    try {
      c.res.headers.set(k, v)
    } catch {
      // Immutable headers (a fetched response): copy it.
      const res = new Response(c.res.body, c.res)
      res.headers.set(k, v)
      c.res = res
    }
  }
}

/** The path as logged: invite codes travel in the URL, so they're left out. */
export function logPath(path: string): string {
  return path.startsWith('/invite/') ? '/invite/…' : path
}

/** Logs method, path, status and duration. Never headers, bodies, or tokens. */
export function logRequests(log: Logger, viaCloudflare: (req: Request) => boolean): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now()
    await next()
    const status = c.res.status
    const fields = { method: c.req.method, path: logPath(c.req.path), status, ms: Date.now() - start, tunnel: viaCloudflare(c.req.raw) }
    if (status >= 500) log.error('request', fields)
    else log.info('request', fields)
  }
}

function executionCtx(c: Context): Context['executionCtx'] | undefined {
  try {
    return c.executionCtx
  } catch {
    return undefined // Node has none
  }
}

/**
 * The admin endpoints, mounted at /_admin when ADMIN_TOKEN is set (without
 * it they don't exist: 404). Each takes the bearer token and parameters as
 * a form, JSON, or the query string, and answers with the CLI's text:
 *
 *	POST /_admin/allow      email, note, admin (true to make it a server admin)
 *	POST /_admin/disallow   email
 *	GET  /_admin/list-allowed
 *	GET  /_admin/list-accounts
 *
 * For example:
 *
 *	curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
 *	  --data-urlencode email=sam@example.com -d admin=true https://etherchat.example/_admin/allow
 */
function adminRoutes(cfg: Config, ethers: EtherService): Hono {
  const a = new Hono()
  a.use(async (c, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')
    if (!m || !constantTimeEqual(m[1], cfg.adminToken)) {
      return httpError('unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="etherchat-admin"', 'Cache-Control': 'no-store' })
    }
    await next()
  })
  a.post('/allow', (c) => respond(c, (p) => admin.allow(ethers, p.email ?? '', p.note ?? '', truthy(p.admin))))
  a.post('/disallow', (c) => respond(c, (p) => admin.disallow(ethers, p.email ?? '')))
  a.get('/list-allowed', (c) => respond(c, () => admin.listAllowed(ethers, cfg.timeZone)))
  a.get('/list-accounts', (c) => respond(c, () => admin.listAccounts(ethers, cfg.timeZone)))
  return a
}

async function respond(c: Context, fn: (p: Record<string, string>) => string): Promise<Response> {
  const text = (body: string, status: number) => new Response(body, {
    status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
  let p: Record<string, string>
  try {
    p = await params(c)
  } catch {
    return text('bad request body\n', 400)
  }
  try {
    return text(fn(p), 200)
  } catch (err) {
    if (err instanceof admin.UsageError) return text(err.message.replace(/--(\w+)/g, '$1') + '\n', 400)
    if (err instanceof EtherError) return text(err.message + '\n', err.kind === 'not_found' ? 404 : 400)
    throw err
  }
}

// The query string, then a form or JSON body over it.
async function params(c: Context): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...c.req.query() }
  if (c.req.method === 'GET') return out
  const type = c.req.header('content-type') ?? ''
  if (type.startsWith('application/json')) {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not a JSON object')
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') out[k] = String(v)
    }
  } else if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    for (const [k, v] of Object.entries(await c.req.parseBody())) {
      if (typeof v === 'string') out[k] = v
    }
  }
  return out
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

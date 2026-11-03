// Etherchat's OAuth 2.1 authorization server for MCP clients: discovery
// metadata, client registration (DCR and Client ID Metadata Documents),
// authorization codes with PKCE, rotating refresh tokens, revocation, and
// access-token checks for /mcp. A port of go/adapters/oauth.
//
// The browser half of /oauth/authorize (sign-in and consent) lives in the web
// adapter; this module validates requests and issues codes for it.
//
// Fetching Client ID Metadata Documents is the runtime's job: pass a
// NodeMetadataFetcher (./cimd-node.ts) or a WorkerMetadataFetcher
// (./cimd-worker.ts). Neither is imported here, so a Worker bundle doesn't
// pull in node:https.

import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import type { SqlDatabase } from '../../core/db.ts'
import type { EtherService } from '../../core/ether/index.ts'
import type { Logger } from '../../core/log.ts'
import { RateLimiter, clientIp } from '../../core/ratelimit.ts'
import { checkCimdUrl, clientFromDocument, isCimd } from './cimd.ts'
import { checkRedirectUri, cleanName, redirectAllowed, type Client } from './clients.ts'
import {
  basicAuth, byteLen, constantTimeEqual, decodeStruct, fields, firstJsonValue, get, goJson, goQuote,
  maxBodyBytes, parsePostForm, queryUnescape, readLimited, trimRightSlash, utf8,
} from './compat.ts'
import { encodeValues, parseUrl, type GoUrl, type Values } from './gourl.ts'

export type { Client } from './clients.ts'
export { checkRedirectUri, redirectAllowed } from './clients.ts'
export { checkCimdUrl, publicAddr, CIMD_MAX_BYTES, CIMD_TIMEOUT_MS } from './cimd.ts'

/** The only scope: read and write the caller's ethers. */
export const SCOPE = 'ether'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

/** Token lifetimes. */
export const CODE_TTL_MS = 5 * minute
export const ACCESS_TTL_MS = hour
export const REFRESH_TTL_MS = 30 * day

/** Prefixes of the secrets this server hands out. */
export const ACCESS_PREFIX = 'eth_at_'
export const REFRESH_PREFIX = 'eth_rt_'
export const CODE_PREFIX = 'eth_ac_'
export const CLIENT_PREFIX = 'eth_c_'
export const SECRET_PREFIX = 'eth_cs_'

/** A valid access token's grant (Go: the MCP SDK's TokenInfo, with the client ID in Extra). */
export interface TokenInfo {
  userId: string
  clientId: string
  scopes: string[]
  expiresAt: Date
}

/**
 * Downloads a Client ID Metadata Document and returns it parsed. It throws
 * (any Error) when the URL isn't https, the fetch fails or isn't allowed,
 * the status isn't 200, the body is over 64 KB, or it isn't JSON.
 */
export interface MetadataFetcher {
  fetchJson(url: string): Promise<unknown>
}

/**
 * RequestError is a problem with an authorization request. It's shown on an
 * error page rather than sent back to the client, so a malformed request
 * can't bounce the browser to an arbitrary site. message is the text to show.
 */
export class RequestError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'RequestError'
  }

  /** Go's RequestError.Msg. */
  get msg(): string {
    return this.message
  }
}

/** A validated authorization request (Go: AuthRequest). */
export class AuthorizeRequest {
  client: Client
  redirectUri: string
  state: string
  codeChallenge = ''
  scope = ''
  resource = ''
  /** The original query parameters, re-sent by the consent form. */
  params: URLSearchParams

  constructor(client: Client, redirectUri: string, state: string, params: URLSearchParams) {
    this.client = client
    this.redirectUri = redirectUri
    this.state = state
    this.params = params
  }

  /**
   * Where the browser goes after consent, shown on the consent page because
   * client names are self-declared.
   */
  redirectHost(): string {
    let u: GoUrl
    try {
      u = parseUrl(this.redirectUri)
    } catch {
      return this.redirectUri
    }
    return u.host !== '' ? u.host : u.scheme + ':'
  }

  /**
   * The redirect URI's origin, for the consent page's CSP form-action
   * (browsers apply it to the redirect after the form posts).
   */
  redirectOrigin(): string {
    let u: GoUrl
    try {
      u = parseUrl(this.redirectUri)
    } catch {
      return ''
    }
    if (u.scheme === 'http' || u.scheme === 'https') return u.scheme + '://' + u.host
    return u.scheme + ':'
  }
}

// An RFC 6749 §5.2 error response.
class OAuthError extends Error {
  readonly status: number
  readonly code: string
  readonly desc: string

  constructor(status: number, code: string, desc: string) {
    super(code + ': ' + desc)
    this.status = status
    this.code = code
    this.desc = desc
  }

  body(): { error: string; error_description?: string } {
    return { error: this.code, error_description: this.desc === '' ? undefined : this.desc }
  }
}

function invalidGrant(desc: string): OAuthError {
  return new OAuthError(400, 'invalid_grant', desc)
}

class UnknownClientError extends Error {
  constructor() {
    super('unknown app')
  }
}

// A client as stored, with its secret's hash (empty for public clients).
type StoredClient = Client & { secretHash: string }

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

function randomToken(prefix: string, n: number): string {
  return prefix + randomBytes(n).toString('base64url')
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex')
}

// cors allows browser-based MCP clients to call the JSON endpoints. They use
// no cookies, so a wildcard origin is safe.
function cors(h: Headers): void {
  h.set('Access-Control-Allow-Origin', '*')
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version')
}

// Go's json.Encoder output: a trailing newline.
function writeJson(status: number, v: unknown, h: Headers): Response {
  h.set('Content-Type', 'application/json')
  h.set('Cache-Control', 'no-store')
  return new Response(goJson(v) + '\n', { status, headers: h })
}

function writeError(err: unknown, h: Headers): Response {
  const oe = err instanceof OAuthError ? err : new OAuthError(500, 'server_error', 'internal error')
  if (oe.code === 'invalid_client') h.set('WWW-Authenticate', 'Basic realm="etherchat"')
  return writeJson(oe.status, oe.body(), h)
}

// The connection's address under @hono/node-server (Workers always send
// CF-Connecting-IP, which clientIp prefers).
function remoteAddr(c: Context): string {
  type Bindings = { incoming?: { socket?: { remoteAddress?: string } } }
  const env = c.env as (Bindings & { server?: Bindings }) | undefined
  return (env?.server ?? env)?.incoming?.socket?.remoteAddress ?? ''
}

function isBase64Url(s: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(s)
}

// pkceOk checks an RFC 7636 S256 code verifier against its challenge.
function pkceOk(verifier: string, challenge: string): boolean {
  const n = byteLen(verifier)
  if (n < 43 || n > 128 || !/^[A-Za-z0-9._~-]*$/.test(verifier)) return false
  const got = createHash('sha256').update(verifier).digest('base64url')
  return constantTimeEqual(got, challenge)
}

function resourceOk(requested: string[], granted: string): boolean {
  return requested.every((r) => trimRightSlash(r) === granted)
}

const registrationSpec = {
  redirect_uris: 'strings',
  client_name: 'string',
  token_endpoint_auth_method: 'string',
  grant_types: 'strings',
  response_types: 'strings',
  application_type: 'string',
  scope: 'string',
  client_uri: 'string',
  logo_uri: 'string',
  software_id: 'string',
  software_version: 'string',
} as const

const authMethods = ['none', 'client_secret_basic', 'client_secret_post']

interface ClientRow {
  client_id: string
  kind: string
  name: string
  redirect_uris: string
  token_auth_method: string
  secret_hash: string | null
  fetched_at: number | null
}

/** The authorization server. */
export class OAuthServer {
  private readonly db: SqlDatabase
  private readonly accounts: EtherService
  private readonly iss: string
  private readonly res: string
  private readonly fetcher: MetadataFetcher
  private readonly log: Logger
  private now: () => Date = () => new Date()
  private readonly limiter: RateLimiter

  /**
   * baseUrl (scheme and host, no trailing slash) is both the issuer and the
   * MCP resource's origin.
   */
  constructor(db: SqlDatabase, ethers: EtherService, baseUrl: string, fetcher: MetadataFetcher, log: Logger) {
    this.db = db
    this.accounts = ethers
    this.iss = trimRightSlash(baseUrl)
    this.res = this.iss + '/mcp'
    this.fetcher = fetcher
    this.log = log
    this.limiter = new RateLimiter(() => this.now().getTime())
  }

  /** Replaces the clock, for tests. */
  setClock(now: () => Date): void {
    this.now = now
  }

  /** The authorization server's identifier. */
  issuer(): string {
    return this.iss
  }

  /** The MCP endpoint's canonical URI. */
  resource(): string {
    return this.res
  }

  /** Where clients discover the authorization server. */
  resourceMetadataUrl(): string {
    return this.iss + '/.well-known/oauth-protected-resource/mcp'
  }

  /**
   * Registers the JSON endpoints: discovery metadata, /oauth/register,
   * /oauth/token and /oauth/revoke. /oauth/authorize belongs to the web
   * adapter, which owns sign-in and the consent page.
   */
  routes(app: Hono<any, any, any>): void {
    const prm = (c: Context): Response => this.protectedResourceMetadata(c)
    app.all('/.well-known/oauth-protected-resource', prm)
    app.all('/.well-known/oauth-protected-resource/mcp', prm)
    app.all('/.well-known/oauth-authorization-server', (c: Context) => this.metadata(c))
    app.all('/oauth/register', (c: Context) => this.preflight(c, (h) => this.register(c, h)))
    app.all('/oauth/token', (c: Context) => this.preflight(c, (h) => this.token(c, h)))
    app.all('/oauth/revoke', (c: Context) => this.preflight(c, (h) => this.revoke(c, h)))
  }

  // RFC 9728 metadata, exactly as the Go MCP SDK's
  // ProtectedResourceMetadataHandler serves it.
  private protectedResourceMetadata(c: Context): Response {
    const h = new Headers()
    h.set('Access-Control-Allow-Origin', '*')
    h.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    h.set('Access-Control-Allow-Headers', 'Content-Type')
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
    if (c.req.method !== 'GET') {
      h.set('Content-Type', 'text/plain; charset=utf-8')
      h.set('X-Content-Type-Options', 'nosniff')
      return new Response('Method not allowed\n', { status: 405, headers: h })
    }
    h.set('Content-Type', 'application/json')
    const body = {
      resource: this.res,
      authorization_servers: [this.iss],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Etherchat',
    }
    return new Response(goJson(body) + '\n', { status: 200, headers: h })
  }

  // RFC 8414 metadata. Keys are sorted, as Go encodes a map.
  private metadata(c: Context): Response {
    const h = new Headers()
    cors(h)
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
    const i = this.iss
    return writeJson(200, {
      authorization_endpoint: i + '/oauth/authorize',
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: i,
      registration_endpoint: i + '/oauth/register',
      response_modes_supported: ['query'],
      response_types_supported: ['code'],
      revocation_endpoint: i + '/oauth/revoke',
      revocation_endpoint_auth_methods_supported: authMethods,
      scopes_supported: [SCOPE],
      service_documentation: i + '/',
      token_endpoint: i + '/oauth/token',
      token_endpoint_auth_methods_supported: authMethods,
    }, h)
  }

  // preflight answers CORS preflights and allows only POST.
  private async preflight(c: Context, next: (h: Headers) => Promise<Response>): Promise<Response> {
    const h = new Headers()
    cors(h)
    switch (c.req.method) {
      case 'OPTIONS':
        return new Response(null, { status: 204, headers: h })
      case 'POST':
        return next(h)
      default:
        h.set('Allow', 'POST, OPTIONS')
        return writeJson(405, new OAuthError(0, 'invalid_request', 'use POST').body(), h)
    }
  }

  // register is RFC 7591 dynamic client registration. The current MCP spec
  // prefers CIMD, but many clients still register this way.
  private async register(c: Context, h: Headers): Promise<Response> {
    if (!this.limiter.allow('register:' + clientIp(c.req.raw.headers, remoteAddr(c)), 20, hour)) {
      return writeError(new OAuthError(429, 'invalid_request', 'too many registrations; try again later'), h)
    }
    let reg
    try {
      const { bytes } = await readLimited(c.req.raw, maxBodyBytes)
      reg = decodeStruct(firstJsonValue(utf8(bytes)), registrationSpec)
    } catch {
      return writeError(new OAuthError(400, 'invalid_client_metadata', 'body must be a JSON client registration of at most 16 KB'), h)
    }
    const redirectUris = reg.redirect_uris ?? []
    if (redirectUris.length === 0 || redirectUris.length > 10) {
      return writeError(new OAuthError(400, 'invalid_redirect_uri', 'register between 1 and 10 redirect_uris'), h)
    }
    for (const u of redirectUris) {
      try {
        checkRedirectUri(u)
      } catch (err) {
        return writeError(new OAuthError(400, 'invalid_redirect_uri', (err as Error).message + ': ' + u), h)
      }
    }
    const method = reg.token_endpoint_auth_method || 'client_secret_basic' // RFC 7591 §2 default
    if (!authMethods.includes(method)) {
      return writeError(new OAuthError(400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_basic or client_secret_post'), h)
    }
    const grantTypes = reg.grant_types?.length ? reg.grant_types : ['authorization_code']
    for (const g of grantTypes) {
      if (g !== 'authorization_code' && g !== 'refresh_token') {
        return writeError(new OAuthError(400, 'invalid_client_metadata', 'unsupported grant type ' + g), h)
      }
    }
    const responseTypes = reg.response_types?.length ? reg.response_types : ['code']
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      return writeError(new OAuthError(400, 'invalid_client_metadata', 'response_types must be ["code"]'), h)
    }
    const name = cleanName(reg.client_name ?? '') || 'Unnamed app'

    const clientId = randomToken(CLIENT_PREFIX, 16)
    let secret = ''
    let secretHash: string | null = null
    if (method !== 'none') {
      secret = randomToken(SECRET_PREFIX, 32)
      secretHash = hashToken(secret)
    }
    // The stored registration, as Go marshals its struct (omitempty fields).
    const omit = (s: string | undefined): string | undefined => (s ? s : undefined)
    const meta = goJson({
      redirect_uris: redirectUris,
      client_name: name,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: responseTypes,
      application_type: omit(reg.application_type),
      scope: omit(reg.scope),
      client_uri: omit(reg.client_uri),
      logo_uri: omit(reg.logo_uri),
      software_id: omit(reg.software_id),
      software_version: omit(reg.software_version),
    })
    const now = this.now()
    try {
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_auth_method, secret_hash, metadata, created_at)
           VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?)`,
          clientId, name, goJson(redirectUris), method, secretHash, meta, now.getTime())
      })
    } catch (err) {
      this.log.error('registering client', { err })
      return writeError(err, h)
    }
    this.log.info('client registered', { client_id: clientId, name, auth: method })

    return writeJson(201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: name,
      client_secret: secret !== '' ? secret : undefined,
      client_secret_expires_at: secret !== '' ? 0 : undefined,
      grant_types: grantTypes,
      redirect_uris: redirectUris,
      response_types: responseTypes,
      token_endpoint_auth_method: method,
    }, h)
  }

  // client loads a client: DCR clients from the database, CIMD clients from
  // their metadata document (cached for 24 hours).
  private async client(clientId: string): Promise<StoredClient> {
    if (clientId === '' || byteLen(clientId) > 2048) throw new UnknownClientError()
    const row = this.db.get<ClientRow>(
      `SELECT client_id, kind, name, redirect_uris, token_auth_method, secret_hash, fetched_at
       FROM oauth_clients WHERE client_id = ?`, clientId)
    if (!row) {
      if (isCimd(clientId)) return this.fetchCimd(clientId)
      throw new UnknownClientError()
    }
    const c: StoredClient = {
      id: row.client_id,
      kind: row.kind as Client['kind'],
      name: row.name,
      redirectUris: JSON.parse(row.redirect_uris) ?? [],
      authMethod: row.token_auth_method,
      secretHash: row.secret_hash ?? '',
    }
    if (c.kind === 'cimd' && this.now().getTime() - Number(row.fetched_at ?? 0) > day) return this.fetchCimd(clientId)
    return c
  }

  private async fetchCimd(clientId: string): Promise<StoredClient> {
    let c: Client
    let meta: string
    try {
      checkCimdUrl(clientId)
      const doc = await this.fetcher.fetchJson(clientId)
      c = clientFromDocument(clientId, doc)
      meta = JSON.stringify(doc)
    } catch (err) {
      this.log.warn('client metadata document rejected', { client_id: clientId, err })
      throw new UnknownClientError()
    }
    const now = this.now().getTime()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_auth_method, metadata, fetched_at, created_at)
         VALUES (?, 'cimd', ?, ?, 'none', ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
           metadata = excluded.metadata, fetched_at = excluded.fetched_at`,
        c.id, c.name, goJson(c.redirectUris), meta, now, now)
    })
    return { ...c, secretHash: '' }
  }

  // authenticate identifies the client calling the token or revocation
  // endpoint, using the method it registered.
  private async authenticate(headers: Headers, form: Values): Promise<StoredClient> {
    const bad = new OAuthError(401, 'invalid_client', 'client authentication failed')
    const basic = basicAuth(headers)
    let id: string
    let secret: string
    if (basic) {
      try {
        id = queryUnescape(basic.username)
        secret = queryUnescape(basic.password)
      } catch {
        throw bad
      }
      const formId = get(form, 'client_id')
      if (formId !== '' && formId !== id) throw bad
    } else {
      id = get(form, 'client_id')
      secret = get(form, 'client_secret')
    }
    let c: StoredClient
    try {
      c = await this.client(id)
    } catch (err) {
      if (err instanceof UnknownClientError) throw bad
      throw err
    }
    switch (c.authMethod) {
      case 'none':
        if (basic || secret !== '') throw bad
        break
      case 'client_secret_basic':
      case 'client_secret_post':
        if ((c.authMethod === 'client_secret_basic') !== !!basic) throw bad
        if (secret === '' || !constantTimeEqual(hashToken(secret), c.secretHash)) throw bad
        break
      default:
        throw bad
    }
    return c
  }

  /** Validates an authorization request's parameters; throws RequestError. */
  async parseAuthorize(q: URLSearchParams): Promise<AuthorizeRequest> {
    let stored: StoredClient
    try {
      stored = await this.client(q.get('client_id') ?? '')
    } catch (err) {
      if (err instanceof UnknownClientError) {
        throw new RequestError("This app isn't registered with Etherchat, or its registration couldn't be read.")
      }
      throw err
    }
    const { secretHash: _, ...client } = stored
    const req = new AuthorizeRequest(client, q.get('redirect_uri') ?? '', q.get('state') ?? '', q)
    if (req.redirectUri === '' || !redirectAllowed(client.redirectUris, req.redirectUri)) {
      throw new RequestError("The app asked to send you back to an address it didn't register.")
    }
    if (q.get('response_type') !== 'code') throw new RequestError('Only response_type=code is supported.')
    req.codeChallenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || byteLen(req.codeChallenge) !== 43 || !isBase64Url(req.codeChallenge)) {
      throw new RequestError('The app must use PKCE with code_challenge_method=S256.')
    }
    if (byteLen(req.state) > 2048) throw new RequestError('The state parameter is too long.')

    // The only scope is "ether". An empty request means it; requests that
    // include it get it; anything else is refused.
    const scopes = fields(q.get('scope') ?? '')
    if (scopes.length > 0 && !scopes.includes(SCOPE)) {
      throw new RequestError(`The app asked for permissions Etherchat doesn't have (scope ${goQuote(q.get('scope') ?? '')}).`)
    }
    req.scope = SCOPE

    req.resource = this.res
    for (const r of q.getAll('resource')) {
      if (trimRightSlash(r) !== this.res) {
        throw new RequestError(`The app asked for access to ${goQuote(r)}, which isn't this server's MCP endpoint.`)
      }
    }
    return req
  }

  /**
   * Creates an authorization code for an approved request and returns the
   * URL to send the browser to.
   */
  issueCode(req: AuthorizeRequest, accountId: string): string {
    const code = randomToken(CODE_PREFIX, 32)
    const now = this.now().getTime()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, resource, scope, family_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        hashToken(code), req.client.id, accountId, req.redirectUri, req.codeChallenge, req.resource, req.scope,
        randomToken('', 12), now, now + CODE_TTL_MS)
    })
    this.log.info('authorization code issued', { client_id: req.client.id, account: accountId })
    return this.redirect(req, { code })
  }

  /** Where to send the browser when the person declines. */
  denyUrl(req: AuthorizeRequest): string {
    return this.redirect(req, { error: 'access_denied', error_description: 'The request was declined.' })
  }

  // redirect adds params, state, and iss (RFC 9207) to the redirect URI,
  // keeping any query it already has.
  private redirect(req: AuthorizeRequest, params: Record<string, string>): string {
    const u = parseUrl(req.redirectUri)
    const q = u.query()
    for (const [k, v] of Object.entries(params)) q.set(k, [v])
    if (req.state !== '') q.set('state', [req.state])
    q.set('iss', [this.iss])
    u.rawQuery = encodeValues(q)
    return u.toString()
  }

  private async token(c: Context, h: Headers): Promise<Response> {
    h.set('Pragma', 'no-cache')
    const { form, ok } = await parsePostForm(c.req.raw)
    if (!ok) return writeError(new OAuthError(400, 'invalid_request', 'form body required'), h)
    let client: StoredClient
    try {
      client = await this.authenticate(c.req.raw.headers, form)
    } catch (err) {
      return writeError(err, h)
    }
    let resp: TokenResponse
    try {
      switch (get(form, 'grant_type')) {
        case 'authorization_code':
          resp = this.exchangeCode(client, form)
          break
        case 'refresh_token':
          resp = this.refresh(client, form)
          break
        default:
          throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
      }
    } catch (err) {
      if (err instanceof OAuthError) {
        this.log.info('token request refused', { client_id: client.id, error: err.code, detail: err.desc })
      } else {
        this.log.error('token endpoint', { err })
      }
      return writeError(err, h)
    }
    return writeJson(200, resp, h)
  }

  private accountActive(accountId: string): boolean {
    try {
      const acct = this.accounts.accountById(accountId)
      return !!acct && !acct.disabled
    } catch {
      return false
    }
  }

  private revokeFamily(family: string, now: number): void {
    this.db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', now, family)
  }

  // exchangeCode redeems an authorization code. A code used twice revokes
  // every token issued from it, since one of the two uses was an attacker.
  // Refusals commit (the code is spent either way), so they're returned
  // from the transaction and thrown after it.
  private exchangeCode(c: StoredClient, form: Values): TokenResponse {
    const code = get(form, 'code')
    if (code === '') throw new OAuthError(400, 'invalid_request', 'code is required')
    const out = this.db.transaction((): TokenResponse | OAuthError => {
      const now = this.now().getTime()
      const row = this.db.get<{
        client_id: string; account_id: string; redirect_uri: string; code_challenge: string; resource: string
        scope: string; family_id: string; expires_at: number; consumed_at: number | null
      }>(
        `SELECT client_id, account_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at, consumed_at
         FROM oauth_codes WHERE code_hash = ?`, hashToken(code))
      if (!row) return invalidGrant('unknown authorization code')
      let refusal: OAuthError | undefined
      if (row.consumed_at !== null) {
        this.revokeFamily(row.family_id, now)
        this.log.warn('authorization code reused; revoked its tokens', { client_id: row.client_id, account: row.account_id })
        refusal = invalidGrant('authorization code already used')
      } else if (Number(row.expires_at) <= now) {
        refusal = invalidGrant('authorization code expired')
      } else if (row.client_id !== c.id) {
        refusal = invalidGrant('authorization code was issued to another client')
      } else if (get(form, 'redirect_uri') !== row.redirect_uri) {
        refusal = invalidGrant("redirect_uri doesn't match the authorization request")
      } else if (!pkceOk(get(form, 'code_verifier'), row.code_challenge)) {
        refusal = invalidGrant("code_verifier doesn't match the code_challenge")
      } else if (!resourceOk(form.get('resource') ?? [], row.resource)) {
        refusal = new OAuthError(400, 'invalid_target', "resource doesn't match the authorization request")
      }
      this.db.run('UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL', now, hashToken(code))
      if (refusal) return refusal
      if (!this.accountActive(row.account_id)) return invalidGrant('account is disabled')
      return this.issueTokens(row.family_id, c.id, row.account_id, row.scope, row.resource)
    })
    if (out instanceof OAuthError) throw out
    return out
  }

  // refresh rotates a refresh token. Presenting one that was already rotated
  // means it was copied, so the whole token family is revoked.
  private refresh(c: StoredClient, form: Values): TokenResponse {
    const rt = get(form, 'refresh_token')
    if (!rt.startsWith(REFRESH_PREFIX)) throw invalidGrant('unknown refresh token')
    const out = this.db.transaction((): TokenResponse | OAuthError => {
      const now = this.now().getTime()
      const row = this.db.get<{
        client_id: string; account_id: string; scope: string; resource: string; family_id: string
        expires_at: number; revoked_at: number | null; replaced_by: string | null
      }>(
        `SELECT client_id, account_id, scope, resource, family_id, expires_at, revoked_at, replaced_by
         FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, hashToken(rt))
      if (!row) return invalidGrant('unknown refresh token')
      if (row.client_id !== c.id) return invalidGrant('refresh token was issued to another client')
      if (row.replaced_by !== null) {
        this.revokeFamily(row.family_id, now)
        this.log.warn('refresh token reused; revoked its family', { client_id: row.client_id, account: row.account_id })
        return invalidGrant('refresh token already used')
      }
      if (row.revoked_at !== null) return invalidGrant('refresh token revoked')
      if (Number(row.expires_at) <= now) return invalidGrant('refresh token expired')
      if (!resourceOk(form.get('resource') ?? [], row.resource)) {
        return new OAuthError(400, 'invalid_target', "resource doesn't match the original grant")
      }
      const req = fields(get(form, 'scope'))
      if (req.length > 0 && (req.length !== 1 || req[0] !== row.scope)) {
        return new OAuthError(400, 'invalid_scope', 'scope can only stay the same')
      }
      if (!this.accountActive(row.account_id)) return invalidGrant('account is disabled')
      const resp = this.issueTokens(row.family_id, c.id, row.account_id, row.scope, row.resource)
      this.db.run('UPDATE oauth_tokens SET revoked_at = ?, replaced_by = ? WHERE token_hash = ?',
        now, hashToken(resp.refresh_token), hashToken(rt))
      return resp
    })
    if (out instanceof OAuthError) throw out
    return out
  }

  private issueTokens(family: string, clientId: string, accountId: string, scope: string, resource: string): TokenResponse {
    const now = this.now().getTime()
    const access = randomToken(ACCESS_PREFIX, 32)
    const refresh = randomToken(REFRESH_PREFIX, 32)
    for (const [kind, token, expires] of [['access', access, now + ACCESS_TTL_MS], ['refresh', refresh, now + REFRESH_TTL_MS]] as const) {
      this.db.run(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, account_id, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        hashToken(token), kind, family, clientId, accountId, scope, resource, now, expires)
    }
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope }
  }

  // revoke is RFC 7009 token revocation. Revoking a refresh token revokes its
  // whole family. It answers 200 for unknown tokens, as the RFC requires.
  private async revoke(c: Context, h: Headers): Promise<Response> {
    const { form, ok } = await parsePostForm(c.req.raw)
    if (!ok) return writeError(new OAuthError(400, 'invalid_request', 'form body required'), h)
    let client: StoredClient
    try {
      client = await this.authenticate(c.req.raw.headers, form)
    } catch (err) {
      return writeError(err, h)
    }
    const token = get(form, 'token')
    try {
      this.db.transaction(() => {
        const row = this.db.get<{ kind: string; family_id: string; client_id: string }>(
          'SELECT kind, family_id, client_id FROM oauth_tokens WHERE token_hash = ?', hashToken(token))
        if (!row || row.client_id !== client.id) return
        const now = this.now().getTime()
        if (row.kind === 'refresh') {
          this.revokeFamily(row.family_id, now)
        } else {
          this.db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now, hashToken(token))
        }
      })
    } catch (err) {
      return writeError(err, h)
    }
    return writeJson(200, {}, h)
  }

  /**
   * Checks an access token presented to /mcp: its grant, or undefined when
   * it's unknown, expired, revoked, for another resource, or its account is
   * disabled. (The MCP layer answers undefined with 401 and
   * WWW-Authenticate pointing at resourceMetadataUrl().)
   */
  verify(token: string): TokenInfo | undefined {
    if (!token.startsWith(ACCESS_PREFIX)) return undefined
    const row = this.db.get<{
      client_id: string; account_id: string; scope: string; resource: string; expires_at: number; revoked_at: number | null
    }>(
      `SELECT client_id, account_id, scope, resource, expires_at, revoked_at
       FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`, hashToken(token))
    if (!row) return undefined
    const expires = Number(row.expires_at)
    if (row.revoked_at !== null || expires <= this.now().getTime() || row.resource !== this.res) return undefined
    if (!this.accountActive(row.account_id)) return undefined
    return { userId: row.account_id, clientId: row.client_id, scopes: fields(row.scope), expiresAt: new Date(expires) }
  }

  /**
   * A client's self-declared name, for display. Clients choose their own
   * names, so pages that show one also show where it redirects.
   */
  clientName(clientId: string): string {
    const row = this.db.get<{ name: string }>('SELECT name FROM oauth_clients WHERE client_id = ?', clientId)
    if (row && row.name !== '') return row.name
    try {
      const u = parseUrl(clientId)
      if (u.scheme === 'https' && u.host !== '') return u.host
    } catch {
      // not a URL
    }
    return clientId
  }

  /** Revokes every token an account holds, for the admin CLI; returns how many. */
  revokeAccount(accountId: string): number {
    return this.db.transaction(() => this.db.run(
      'UPDATE oauth_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
      this.now().getTime(), accountId).changes)
  }

  /**
   * Deletes authorization codes and tokens that expired more than a week
   * ago, returning how many. Expired refresh tokens fail either way; keeping
   * them a week longer lets reuse of a recently rotated one still trip
   * family revocation.
   */
  sweep(): number {
    const cutoff = this.now().getTime() - 7 * day
    return this.db.transaction(() => {
      let n = 0
      for (const q of ['DELETE FROM oauth_codes WHERE expires_at < ?', 'DELETE FROM oauth_tokens WHERE expires_at < ?']) {
        n += this.db.run(q, cutoff).changes
      }
      return n
    })
  }
}

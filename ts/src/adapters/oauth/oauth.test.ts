// A port of go/adapters/oauth/oauth_test.go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { discardLogger } from '../../core/log.ts'
import { newTestService, type TestService } from '../../core/ether/testing.ts'
import type { Account } from '../../core/ether/index.ts'
import { encodeValues, queryEscape } from './gourl.ts'
import { NodeMetadataFetcher } from './cimd-node.ts'
import {
  ACCESS_TTL_MS, CLIENT_PREFIX, CODE_TTL_MS, OAuthServer, RequestError, SECRET_PREFIX,
  checkCimdUrl, checkRedirectUri, publicAddr, redirectAllowed, type MetadataFetcher,
} from './index.ts'

const issuer = 'https://etherchat.example'
const redirect = 'http://127.0.0.1:9999/callback'

/** Serves documents from a map, standing in for the network. */
class FakeFetcher implements MetadataFetcher {
  docs = new Map<string, string>()
  calls = 0

  async fetchJson(url: string): Promise<unknown> {
    this.calls++
    const body = this.docs.get(url)
    if (body === undefined) throw new Error('metadata document returned HTTP 404')
    return JSON.parse(body)
  }
}

interface Env {
  t: TestService
  s: OAuthServer
  app: Hono
  acct: Account
  fetcher: FakeFetcher
}

function newEnv(): Env {
  const t = newTestService()
  t.svc.allow('alice@example.com', '')
  const acct = t.svc.ensureAccount('alice@example.com', true)
  const fetcher = new FakeFetcher()
  const s = new OAuthServer(t.db, t.svc, issuer, fetcher, discardLogger)
  s.setClock(t.clock)
  const app = new Hono()
  s.routes(app)
  return { t, s, app, acct, fetcher }
}

type Json = Record<string, unknown>

async function decode(resp: Response): Promise<Json> {
  const text = await resp.text()
  return text === '' ? {} : JSON.parse(text)
}

async function postJson(e: Env, path: string, body: unknown): Promise<[Response, Json]> {
  const resp = await e.app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return [resp, await decode(resp)]
}

async function postForm(e: Env, path: string, form: Record<string, string | string[]>, basicUser = '', basicPass = ''): Promise<[Response, Json]> {
  const values = new Map(Object.entries(form).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (basicUser !== '') {
    headers.Authorization = 'Basic ' + btoa(queryEscape(basicUser) + ':' + queryEscape(basicPass))
  }
  const resp = await e.app.request(path, { method: 'POST', headers, body: encodeValues(values) })
  return [resp, await decode(resp)]
}

/** Registers a client with the given auth method and returns id and secret. */
async function register(e: Env, method: string): Promise<[string, string]> {
  const [resp, m] = await postJson(e, '/oauth/register', {
    redirect_uris: [redirect], client_name: 'Test App', token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'],
  })
  assert.equal(resp.status, 201, JSON.stringify(m))
  return [m.client_id as string, (m.client_secret as string | undefined) ?? '']
}

function pkce(): [string, string] {
  const verifier = 'v'.repeat(50)
  return [verifier, createHash('sha256').update(verifier).digest('base64url')]
}

/** Runs parseAuthorize and issueCode and returns the code. */
async function authorize(e: Env, clientId: string, challenge: string): Promise<string> {
  const req = await e.s.parseAuthorize(new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'ether', resource: issuer + '/mcp',
  }))
  const to = e.s.issueCode(req, e.acct.id)
  const u = new URL(to)
  assert.ok(u.searchParams.get('state') === 'xyz' && u.searchParams.get('iss') === issuer && to.startsWith(redirect + '?'), `redirect = ${to}`)
  return u.searchParams.get('code')!
}

function exchange(e: Env, clientId: string, code: string, verifier: string): Promise<[Response, Json]> {
  return postForm(e, '/oauth/token', {
    grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier,
    client_id: clientId, resource: issuer + '/mcp',
  })
}

function valid(e: Env, access: string): boolean {
  return e.s.verify(access) !== undefined
}

test('metadata', async () => {
  const e = newEnv()
  const resp = await e.app.request('/.well-known/oauth-authorization-server')
  const m = await decode(resp)
  assert.equal(m.issuer, issuer)
  assert.equal(m.token_endpoint, issuer + '/oauth/token')
  assert.equal(m.client_id_metadata_document_supported, true)
  assert.equal(m.authorization_response_iss_parameter_supported, true)
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*')
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const m = await decode(await e.app.request(p))
    assert.equal(m.resource, issuer + '/mcp', p)
    assert.deepEqual(m.authorization_servers, [issuer], p)
  }
  assert.equal(e.s.resourceMetadataUrl(), issuer + '/.well-known/oauth-protected-resource/mcp')
})

test('metadata wire format matches the Go server', async () => {
  const e = newEnv()
  let resp = await e.app.request('/.well-known/oauth-protected-resource/mcp')
  assert.equal(await resp.text(), '{"resource":"https://etherchat.example/mcp","authorization_servers":["https://etherchat.example"],' +
    '"scopes_supported":["ether"],"bearer_methods_supported":["header"],"resource_name":"Etherchat"}\n')
  assert.equal(resp.headers.get('Content-Type'), 'application/json')
  assert.equal(resp.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS')
  resp = await e.app.request('/.well-known/oauth-protected-resource', { method: 'POST' })
  assert.equal(resp.status, 405)
  assert.equal(await resp.text(), 'Method not allowed\n')

  resp = await e.app.request('/.well-known/oauth-authorization-server')
  assert.equal(await resp.text(), '{"authorization_endpoint":"https://etherchat.example/oauth/authorize",' +
    '"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":true,' +
    '"code_challenge_methods_supported":["S256"],"grant_types_supported":["authorization_code","refresh_token"],' +
    '"issuer":"https://etherchat.example","registration_endpoint":"https://etherchat.example/oauth/register",' +
    '"response_modes_supported":["query"],"response_types_supported":["code"],' +
    '"revocation_endpoint":"https://etherchat.example/oauth/revoke",' +
    '"revocation_endpoint_auth_methods_supported":["none","client_secret_basic","client_secret_post"],' +
    '"scopes_supported":["ether"],"service_documentation":"https://etherchat.example/",' +
    '"token_endpoint":"https://etherchat.example/oauth/token",' +
    '"token_endpoint_auth_methods_supported":["none","client_secret_basic","client_secret_post"]}\n')
  assert.equal(resp.headers.get('Cache-Control'), 'no-store')

  resp = await e.app.request('/oauth/token', { method: 'OPTIONS' })
  assert.equal(resp.status, 204)
  assert.equal(resp.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type, Mcp-Protocol-Version')
  resp = await e.app.request('/oauth/token')
  assert.equal(resp.status, 405)
  assert.equal(resp.headers.get('Allow'), 'POST, OPTIONS')
  assert.equal(await resp.text(), '{"error":"invalid_request","error_description":"use POST"}\n')
})

test('registration', async () => {
  const e = newEnv()
  const [id, secret] = await register(e, 'none')
  assert.ok(id.startsWith(CLIENT_PREFIX) && secret === '', `public client: ${id} ${secret}`)
  const [, secret2] = await register(e, '')
  assert.ok(secret2.startsWith(SECRET_PREFIX), `default auth method should be client_secret_basic with a secret, got ${secret2}`)
  for (const bad of ['http://example.com/cb', 'javascript:alert(1)', 'https://example.com/cb#frag', 'data:text/html,x', 'relative/path']) {
    const [resp, m] = await postJson(e, '/oauth/register', { redirect_uris: [bad] })
    assert.ok(resp.status === 400 && m.error === 'invalid_redirect_uri', `redirect ${bad}: ${resp.status} ${JSON.stringify(m)}`)
  }
  let [resp, m] = await postJson(e, '/oauth/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'private_key_jwt' })
  assert.ok(resp.status === 400 && m.error === 'invalid_client_metadata', `unsupported auth method: ${resp.status}`)
  ;[resp, m] = await postJson(e, '/oauth/register', {
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    client_name: 'ChatGPT‮\n', token_endpoint_auth_method: 'none',
  })
  assert.ok(resp.status === 201 && m.client_name === 'ChatGPT', `name cleaning: ${JSON.stringify(m)}`)
})

test('registration body handling matches Go', async () => {
  const e = newEnv()
  const post = async (body: string): Promise<[Response, Json]> => {
    const resp = await e.app.request('/oauth/register', { method: 'POST', body })
    return [resp, await decode(resp)]
  }
  // Keys match case-insensitively, and anything after the JSON value is ignored.
  let [resp, m] = await post(`{"REDIRECT_URIS":["${redirect}"],"Token_Endpoint_Auth_Method":"none"} trailing`)
  assert.equal(resp.status, 201, JSON.stringify(m))
  assert.equal(m.token_endpoint_auth_method, 'none')
  assert.equal(m.client_name, 'Unnamed app')
  assert.deepEqual(Object.keys(m), ['client_id', 'client_id_issued_at', 'client_name', 'grant_types', 'redirect_uris', 'response_types', 'token_endpoint_auth_method'])
  for (const bad of ['', '[]', `{"redirect_uris":"${redirect}"}`, `{"redirect_uris":[1]}`, '{"redirect_uris":[']) {
    ;[resp, m] = await post(bad)
    assert.ok(resp.status === 400 && m.error === 'invalid_client_metadata', `body ${bad}: ${resp.status} ${JSON.stringify(m)}`)
  }
  ;[resp, m] = await post('null')
  assert.ok(resp.status === 400 && m.error === 'invalid_redirect_uri', `null body: ${JSON.stringify(m)}`)
  ;[resp, m] = await post(`{"redirect_uris":["${redirect}"],"pad":"${'x'.repeat(17 << 10)}"}`)
  assert.ok(resp.status === 400 && m.error === 'invalid_client_metadata', `oversized: ${resp.status}`)
})

test('registration is rate limited per address', async () => {
  const e = newEnv()
  const body = JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
  const from = (ip: string) => e.app.request('/oauth/register', { method: 'POST', body, headers: { 'CF-Connecting-IP': ip } })
  for (let i = 0; i < 20; i++) assert.equal((await from('203.0.113.1')).status, 201)
  const resp = await from('203.0.113.1')
  assert.equal(resp.status, 429)
  assert.equal((await decode(resp)).error, 'invalid_request')
  assert.equal((await from('203.0.113.2')).status, 201)
})

test('redirect rules', () => {
  const ok = ['https://chatgpt.com/connector_platform_oauth_redirect', 'http://127.0.0.1:33418/callback', 'http://localhost/cb',
    'http://[::1]:8080/cb', 'cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth']
  for (const u of ok) assert.doesNotThrow(() => checkRedirectUri(u), u)
  // Loopback redirects match on any port (RFC 8252 §7.3); nothing else does.
  const reg = ['http://127.0.0.1/callback', 'https://app.example/cb']
  const cases: Record<string, boolean> = {
    'http://127.0.0.1:51234/callback': true, 'http://127.0.0.1/callback': true, 'https://app.example/cb': true,
    'https://app.example:444/cb': false, 'http://127.0.0.1:5/other': false, 'http://localhost:5/callback': false,
  }
  for (const [u, want] of Object.entries(cases)) assert.equal(redirectAllowed(reg, u), want, u)
})

test('authorize validation', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [, challenge] = pkce()
  const base: Record<string, string> = {
    client_id: id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
  }
  const withParam = (k: string, v: string): URLSearchParams => {
    const q = new URLSearchParams(base)
    if (v === '') q.delete(k)
    else q.set(k, v)
    return q
  }
  await e.s.parseAuthorize(new URLSearchParams(base))
  const cases: Record<string, URLSearchParams> = {
    'unknown client': withParam('client_id', 'eth_c_nope'),
    'unregistered redirect': withParam('redirect_uri', 'http://127.0.0.1:9999/other'),
    'missing redirect': withParam('redirect_uri', ''),
    'token response type': withParam('response_type', 'token'),
    'plain PKCE': withParam('code_challenge_method', 'plain'),
    'no PKCE': withParam('code_challenge', ''),
    'other resource': withParam('resource', 'https://evil.example/mcp'),
    'unknown scope only': withParam('scope', 'admin'),
  }
  for (const [name, q] of Object.entries(cases)) {
    await assert.rejects(e.s.parseAuthorize(q), RequestError, name)
  }
  const req = await e.s.parseAuthorize(withParam('scope', 'ether offline_access'))
  assert.equal(req.scope, 'ether')
  await assert.rejects(e.s.parseAuthorize(withParam('scope', 'admin')),
    { message: 'The app asked for permissions Etherchat doesn\'t have (scope "admin").' })
  await assert.rejects(e.s.parseAuthorize(withParam('resource', 'https://evil.example/mcp')),
    { message: 'The app asked for access to "https://evil.example/mcp", which isn\'t this server\'s MCP endpoint.' })
})

test('consent helpers and deny URL', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [, challenge] = pkce()
  const req = await e.s.parseAuthorize(new URLSearchParams({
    client_id: id, redirect_uri: 'http://127.0.0.1:4321/callback', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'a b~*',
  }))
  assert.equal(req.client.name, 'Test App')
  assert.equal(req.client.kind, 'dcr')
  assert.ok(!('secretHash' in req.client))
  assert.equal(req.redirectHost(), '127.0.0.1:4321')
  assert.equal(req.redirectOrigin(), 'http://127.0.0.1:4321')
  assert.equal(req.resource, issuer + '/mcp')
  // Go's Values.Encode: sorted keys, spaces as +, ~ kept, * escaped.
  assert.equal(e.s.denyUrl(req), 'http://127.0.0.1:4321/callback?error=access_denied' +
    '&error_description=The+request+was+declined.&iss=https%3A%2F%2Fetherchat.example&state=a+b~%2A')
  assert.equal(e.s.clientName(id), 'Test App')
  assert.equal(e.s.clientName('https://unknown.example/c.json'), 'unknown.example')
  assert.equal(e.s.clientName('eth_c_nope'), 'eth_c_nope')
})

test('code flow', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [verifier, challenge] = pkce()
  const code = await authorize(e, id, challenge)

  let [resp, m] = await exchange(e, id, code, verifier)
  assert.ok(resp.status === 200 && m.token_type === 'Bearer' && m.scope === 'ether' && resp.headers.get('Cache-Control') === 'no-store',
    `exchange: ${resp.status} ${JSON.stringify(m)}`)
  assert.equal(resp.headers.get('Pragma'), 'no-cache')
  assert.equal(m.expires_in, 3600)
  assert.deepEqual(Object.keys(m), ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope'])
  const access = m.access_token as string
  const refresh = m.refresh_token as string
  const ti = e.s.verify(access)
  assert.ok(ti && ti.userId === e.acct.id && ti.clientId === id, `verify: ${JSON.stringify(ti)}`)
  assert.deepEqual(ti.scopes, ['ether'])
  assert.equal(ti.expiresAt.getTime(), e.t.now().getTime() + ACCESS_TTL_MS)
  assert.ok(!valid(e, refresh), 'a refresh token was accepted as an access token')

  // Reusing the code fails and revokes what it issued.
  ;[resp, m] = await exchange(e, id, code, verifier)
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `code reuse: ${resp.status} ${JSON.stringify(m)}`)
  assert.ok(!valid(e, access), 'tokens survived authorization code reuse')
})

test('code rejections', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [other] = await register(e, 'none')
  const [verifier, challenge] = pkce()

  // A wrong verifier burns the code.
  let code = await authorize(e, id, challenge)
  let [resp, m] = await exchange(e, id, code, 'w'.repeat(50))
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `wrong verifier: ${resp.status}`)
  ;[resp] = await exchange(e, id, code, verifier)
  assert.equal(resp.status, 400, 'code still worked after a wrong verifier')

  code = await authorize(e, id, challenge)
  ;[resp, m] = await exchange(e, other, code, verifier)
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `another client's code: ${resp.status}`)

  code = await authorize(e, id, challenge)
  ;[resp, m] = await postForm(e, '/oauth/token', {
    grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9999/elsewhere', code_verifier: verifier, client_id: id,
  })
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `redirect mismatch: ${resp.status}`)
  assert.equal(m.error_description, "redirect_uri doesn't match the authorization request")

  code = await authorize(e, id, challenge)
  e.t.advance(CODE_TTL_MS + 1000)
  ;[resp, m] = await exchange(e, id, code, verifier)
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `expired code: ${resp.status}`)

  ;[resp, m] = await postForm(e, '/oauth/token', { grant_type: 'password', client_id: id })
  assert.ok(resp.status === 400 && m.error === 'unsupported_grant_type', `password grant: ${resp.status}`)

  ;[resp, m] = await postForm(e, '/oauth/token', { grant_type: 'authorization_code', client_id: id })
  assert.ok(resp.status === 400 && m.error === 'invalid_request' && m.error_description === 'code is required')

  code = await authorize(e, id, challenge)
  ;[resp, m] = await postForm(e, '/oauth/token', {
    grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: id,
    resource: 'https://evil.example/mcp',
  })
  assert.ok(resp.status === 400 && m.error === 'invalid_target', `other resource: ${resp.status} ${JSON.stringify(m)}`)

  // A malformed form body is refused before anything else.
  resp = await e.app.request('/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'client_id=%zz',
  })
  m = await decode(resp)
  assert.ok(resp.status === 400 && m.error === 'invalid_request' && m.error_description === 'form body required')
})

test('refresh rotation', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [verifier, challenge] = pkce()
  let [, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  const access1 = m.access_token as string
  const refresh1 = m.refresh_token as string

  const refresh = (rt: string, extra: Record<string, string> = {}) =>
    postForm(e, '/oauth/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: id, ...extra })
  let resp: Response
  ;[resp, m] = await refresh(refresh1)
  assert.equal(resp.status, 200, JSON.stringify(m))
  const access2 = m.access_token as string
  const refresh2 = m.refresh_token as string
  assert.ok(refresh2 !== refresh1 && valid(e, access2), "refresh didn't rotate")

  // Presenting the old refresh token again revokes the whole family.
  ;[resp, m] = await refresh(refresh1)
  assert.ok(resp.status === 400 && m.error === 'invalid_grant', `refresh reuse: ${resp.status}`)
  assert.ok(!valid(e, access1) && !valid(e, access2), 'family survived refresh-token reuse')
  ;[resp] = await refresh(refresh2)
  assert.equal(resp.status, 400, 'newest refresh token survived reuse detection')

  // Scope can only stay the same.
  ;[, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  ;[resp, m] = await refresh(m.refresh_token as string, { scope: 'ether admin' })
  assert.ok(resp.status === 400 && m.error === 'invalid_scope', `scope change: ${resp.status}`)

  // Access tokens expire after an hour.
  ;[, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  const access3 = m.access_token as string
  e.t.advance(ACCESS_TTL_MS + 1000)
  assert.ok(!valid(e, access3), 'access token outlived its hour')
})

test('confidential clients', async () => {
  const e = newEnv()
  const [id, secret] = await register(e, 'client_secret_basic')
  const [verifier, challenge] = pkce()
  const form = (code: string): Record<string, string> =>
    ({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier })
  let [resp, m] = await postForm(e, '/oauth/token', form(await authorize(e, id, challenge)), id, 'wrong')
  assert.ok(resp.status === 401 && m.error === 'invalid_client', `wrong secret: ${resp.status}`)
  assert.equal(resp.headers.get('WWW-Authenticate'), 'Basic realm="etherchat"')
  const f = { ...form(await authorize(e, id, challenge)), client_id: id, client_secret: secret }
  ;[resp] = await postForm(e, '/oauth/token', f)
  assert.equal(resp.status, 401, 'client_secret_post accepted for a client_secret_basic client')
  ;[resp, m] = await postForm(e, '/oauth/token', form(await authorize(e, id, challenge)), id, secret)
  assert.equal(resp.status, 200, `basic auth: ${JSON.stringify(m)}`)

  // A client_secret_post client authenticates in the form, not with Basic.
  const [pid, psecret] = await register(e, 'client_secret_post')
  ;[resp] = await postForm(e, '/oauth/token', form(await authorize(e, pid, challenge)), pid, psecret)
  assert.equal(resp.status, 401, 'basic accepted for a client_secret_post client')
  ;[resp, m] = await postForm(e, '/oauth/token', { ...form(await authorize(e, pid, challenge)), client_id: pid, client_secret: psecret })
  assert.equal(resp.status, 200, `post auth: ${JSON.stringify(m)}`)

  // A public client must not present a secret.
  const [nid] = await register(e, 'none')
  ;[resp] = await postForm(e, '/oauth/token', { ...form(await authorize(e, nid, challenge)), client_id: nid, client_secret: 'x' })
  assert.equal(resp.status, 401)
})

test('revocation and disabled accounts', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [verifier, challenge] = pkce()
  let [, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  let access = m.access_token as string
  const refresh = m.refresh_token as string
  let [resp] = await postForm(e, '/oauth/revoke', { token: refresh, client_id: id })
  assert.equal(resp.status, 200, 'revoke failed')
  assert.ok(!valid(e, access), 'revoking the refresh token should revoke its family')
  ;[resp, m] = await postForm(e, '/oauth/revoke', { token: 'eth_rt_unknown', client_id: id })
  assert.equal(resp.status, 200, 'unknown tokens must still get 200')
  assert.deepEqual(m, {})

  // Revoking an access token revokes only that token.
  ;[, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  access = m.access_token as string
  ;[resp] = await postForm(e, '/oauth/revoke', { token: access, client_id: id })
  assert.ok(resp.status === 200 && !valid(e, access))
  ;[resp] = await postForm(e, '/oauth/token', { grant_type: 'refresh_token', refresh_token: m.refresh_token as string, client_id: id })
  assert.equal(resp.status, 200, 'the refresh token should survive revoking its access token')

  ;[, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  access = m.access_token as string
  e.t.svc.disallow('alice@example.com')
  assert.ok(!valid(e, access), 'token of a disabled account still works')
})

test('revokeAccount and sweep', async () => {
  const e = newEnv()
  const [id] = await register(e, 'none')
  const [verifier, challenge] = pkce()
  const [, m] = await exchange(e, id, await authorize(e, id, challenge), verifier)
  assert.equal(e.s.revokeAccount(e.acct.id), 2)
  assert.ok(!valid(e, m.access_token as string))
  assert.equal(e.s.revokeAccount(e.acct.id), 0)
  await authorize(e, id, challenge)
  assert.equal(e.s.sweep(), 0)
  e.t.advance(31 * 24 * 3600_000 + 7 * 24 * 3600_000)
  assert.equal(e.s.sweep(), 4) // two codes, an access token and a refresh token
})

test('CIMD', async () => {
  const urlCases: Record<string, boolean> = {
    'https://chatgpt.com/oauth/client.json': true,
    'https://chatgpt.com': false,
    'https://chatgpt.com/': false,
    'http://chatgpt.com/client.json': false,
    'https://user:pw@chatgpt.com/c.json': false,
    'https://chatgpt.com/a/../c.json': false,
    'https://chatgpt.com/c.json#x': false,
  }
  for (const [raw, ok] of Object.entries(urlCases)) {
    let got = true
    try {
      checkCimdUrl(raw)
    } catch {
      got = false
    }
    assert.equal(got, ok, `checkCimdUrl(${raw})`)
  }
  const ipCases: Record<string, boolean> = {
    '8.8.8.8': true, '2606:4700::1111': true, '127.0.0.1': false, '10.0.0.5': false, '192.168.1.1': false,
    '172.16.0.1': false, '169.254.169.254': false, '100.64.1.1': false, '::1': false, 'fd00::1': false,
    '0.0.0.0': false, '::ffff:192.168.1.1': false, '64:ff9b::a00:1': false,
  }
  for (const [ip, pub] of Object.entries(ipCases)) assert.equal(publicAddr(ip), pub, `publicAddr(${ip})`)

  // The real fetcher refuses loopback, by address and by name.
  const real = new NodeMetadataFetcher()
  await assert.rejects(real.fetchJson('https://127.0.0.1:9/client.json'), /non-public/)
  await assert.rejects(real.fetchJson('https://localhost:9/client.json'), /non-public/)

  // A fetcher that can reach the document exercises validation.
  const docUrl = 'https://client.example/client.json'
  const e = newEnv()
  e.fetcher.docs.set(docUrl, JSON.stringify({ client_id: docUrl, client_name: 'Doc App', redirect_uris: [redirect] }))
  const [, challenge] = pkce()
  const q = new URLSearchParams({
    client_id: docUrl, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
  })
  const req = await e.s.parseAuthorize(q)
  assert.ok(req.client.name === 'Doc App' && req.client.kind === 'cimd', JSON.stringify(req.client))
  assert.equal(e.s.clientName(docUrl), 'Doc App', 'CIMD client not cached')

  // Cached for a day, then fetched again.
  await e.s.parseAuthorize(q)
  assert.equal(e.fetcher.calls, 1)
  e.t.advance(24 * 3600_000 + 1)
  await e.s.parseAuthorize(q)
  assert.equal(e.fetcher.calls, 2)

  const e2 = newEnv()
  const docs: Record<string, string> = {
    'mismatched client_id': JSON.stringify({ client_id: 'https://other.example/c.json', redirect_uris: [redirect] }),
    'secret auth': JSON.stringify({ client_id: docUrl, redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_basic' }),
    'bad redirect': JSON.stringify({ client_id: docUrl, redirect_uris: ['http://evil.example/cb'] }),
    'wrong type': JSON.stringify({ client_id: docUrl, redirect_uris: redirect }),
  }
  for (const [name, doc] of Object.entries(docs)) {
    e2.fetcher.docs.set(docUrl, doc)
    await assert.rejects(e2.s.parseAuthorize(q), RequestError, name)
  }

  // A metadata-document client with no name is shown by its host.
  e2.fetcher.docs.set(docUrl, JSON.stringify({ client_id: docUrl, redirect_uris: [redirect] }))
  assert.equal((await e2.s.parseAuthorize(q)).client.name, 'client.example')

  // The token endpoint loads it the same way; it's a public client.
  const e3 = newEnv()
  e3.fetcher.docs.set(docUrl, JSON.stringify({ client_id: docUrl, client_name: 'Doc App', redirect_uris: [redirect] }))
  const [verifier] = pkce()
  const code = await authorize(e3, docUrl, challenge)
  const [resp, m] = await exchange(e3, docUrl, code, verifier)
  assert.equal(resp.status, 200, JSON.stringify(m))
})

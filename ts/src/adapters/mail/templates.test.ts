import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  signInCode, invite, inviteLink, requestEmail, allowRequestEmail, previews, safeUrl, escapeHtml,
  type Message, type InviteDetails, type RequestNews, type AllowRequest,
} from './index.ts'

test('sign-in code email', () => {
  const m = signInCode('a@example.com', '359569')
  assert.equal(m.to, 'a@example.com')
  assert.equal(m.subject, 'Your Etherchat sign-in code')
  assert.ok(m.text.includes('    359569\n'))
  assert.ok(m.html.includes('359 569'))
  // The code stays out of the subject and preview line, which phones show
  // on the lock screen.
  assert.ok(!m.subject.includes('359'))
  assert.ok(!m.html.slice(0, m.html.indexOf('sign-in code</p>')).includes('359'), 'code appears before the body')
})

test('invite email', () => {
  const m = invite({
    to: 'sam@example.com', fromEmail: 'you@example.com', etherName: '<b>Notes</b> & "drafts"',
    link: inviteLink('https://etherchat.example/', 'ABCD-EFGH-IJKL-MNOP'), expiresAt: new Date(Date.UTC(2026, 9, 16, 12)),
    timeZone: 'UTC',
  })
  const link = 'https://etherchat.example/invite/ABCD-EFGH-IJKL-MNOP'
  assert.ok(m.text.includes('you@example.com invited you to their ether [<b>Notes</b> & "drafts"].'), m.text)
  assert.ok(m.text.includes(link))
  assert.ok(m.text.includes('until October 16, 2026'))
  // Names are escaped in the HTML part; the link appears as the button and as text.
  assert.ok(!m.html.includes('<b>Notes'))
  assert.ok(m.html.includes('&lt;b&gt;Notes&lt;/b&gt; &amp; &#34;drafts&#34;'))
  assert.equal(m.html.split(link).length - 1, 2)
})

test('invite date is in the given time zone', () => {
  const d = { to: 'a@b.c', fromEmail: 'f@b.c', etherName: 'E', link: 'https://e.example/invite/X' }
  const late = new Date(Date.UTC(2026, 9, 17, 2)) // 10pm on the 16th in New York
  assert.ok(invite({ ...d, expiresAt: late, timeZone: 'America/New_York' }).text.includes('until October 16, 2026'))
  assert.ok(invite({ ...d, expiresAt: late, timeZone: 'UTC' }).text.includes('until October 17, 2026'))
})

test('request email subjects', () => {
  const base = { to: 'a@example.com', link: 'https://e.example/', settingsLink: 'https://e.example/account' }
  const ask = { who: 'sam', etherName: 'E', link: 'https://e.example/e/1' }
  const ans = { answered: true, who: 'kim', etherName: 'E', link: 'https://e.example/e/1/comms#r-1' }
  const subject = (items: RequestNews['items']) => requestEmail({ ...base, items }).subject
  assert.equal(subject([{ ...ask, self: true }]), 'Your agent asked you something on Etherchat')
  assert.equal(subject([ask]), "@sam's agent asked you something on Etherchat")
  assert.equal(subject([ans]), '@kim answered your agent on Etherchat')
  assert.equal(subject([ask, ask]), '2 requests are waiting for you on Etherchat')
  assert.equal(subject([ans, ans]), "2 answers to your agents' requests on Etherchat")
  assert.equal(subject([ask, ans]), 'Etherchat: 1 request for you, 1 answer for your agents')
  assert.equal(subject([ask, ask, ans, ans]), 'Etherchat: 2 requests for you, 2 answers for your agents')
  const m = requestEmail({ ...base, items: [ask] })
  assert.ok(m.text.includes('https://e.example/account'))
  assert.ok(m.html.includes('href="https://e.example/e/1"'))
})

test('allow request email', () => {
  const m = allowRequestEmail({ to: 'admin@example.com', fromEmail: 'you@example.com', fromHandle: 'you',
    emails: ['lee@example.org'], command: 'etherchat allow --email EMAIL # for EMAIL' })
  assert.equal(m.subject, '@you asked to allow 1 address on Etherchat')
  assert.ok(m.text.includes('\n  etherchat allow --email lee@example.org # for lee@example.org\n'))
  assert.ok(m.text.includes('wants to invite someone who'))
})

test('html/template escaping', () => {
  assert.equal(escapeHtml(`<a href="x">'&+</a>\0`), '&lt;a href=&#34;x&#34;&gt;&#39;&amp;&#43;&lt;/a&gt;\uFFFD')
  assert.equal(safeUrl('javascript:alert(1)'), '#ZgotmplZ')
  assert.equal(safeUrl('HTTPS://e.example/a b?x=1&y=2#f+'), 'HTTPS://e.example/a%20b?x=1&amp;y=2#f&#43;')
  assert.equal(safeUrl('/relative:path'), '/relative:path')
  assert.equal(safeUrl('https://e.example/%41%zz/é'), 'https://e.example/%41%25zz/%c3%a9')
})

test('previews', () => {
  const p = previews('http://127.0.0.1:18080')
  for (const name of ['signin.html', 'signin.txt', 'invite.html', 'invite.txt', 'requests.html', 'requests.txt', 'allow.html', 'allow.txt']) {
    assert.ok(p[name], `no preview for ${name}`)
  }
  assert.ok(p['invite.txt'].startsWith('Subject: you@example.com invited you'))
})

// The Go templates are the specification. When the Go toolchain is
// installed, render tricky inputs with go/adapters/mail and compare every
// byte. Without Go (or its module cache), the test is skipped.
test('matches the Go templates byte for byte', (t) => {
  const goModule = resolve(import.meta.dirname, '../../../../go')
  const dir = mkdtempSync(join(tmpdir(), 'etherchat-mail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'go.mod'), `module goref\n\ngo 1.27\n\nrequire github.com/CoolJuice48/etherchat/go v0.0.0\n\nreplace github.com/CoolJuice48/etherchat/go => ${goModule}\n`)
  copyFileSync(join(goModule, 'go.sum'), join(dir, 'go.sum'))
  writeFileSync(join(dir, 'main.go'), goRenderer)

  const zone = 'America/New_York'
  const signins: [string, string][] = [['a@example.com', '359569'], ['x+y@example.com', '12<34>']]
  const invites: InviteDetails[] = [
    { to: 'sam@example.com', fromEmail: 'you@example.com', etherName: `<b>Notes</b> & "drafts" + 'x' \0 é`,
      link: 'https://etherchat.example/invite/ABCD-EFGH-IJKL-MNOP', expiresAt: new Date(1792152000000), timeZone: 'UTC' },
    { to: "o'brien+tag@example.com", fromEmail: 'a&b@example.com', etherName: 'Atlas', link: 'javascript:alert(1)',
      expiresAt: new Date(1792123200000), timeZone: zone },
    { to: 't@example.com', fromEmail: 'f@example.com', etherName: 'Ünïcode ✓',
      link: `http://127.0.0.1:18080/invite/a b'c"d<e>%41%zz%4é?x=1&y=2#frag+`, expiresAt: new Date(1792152000000), timeZone: 'Asia/Tokyo' },
  ]
  const item = (o: object) => ({ who: 'bob', etherName: 'E', link: 'https://e.example/e/1', ...o })
  const news: RequestNews[] = [
    [item({ etherName: 'Atlas: <research> & notes' }), item({ self: true, who: 'you' }), item({ answered: true, link: 'https://e.example/e/1/comms#r-x' })],
    [item({ self: true })], [item({})], [item({ answered: true })], [item({}), item({ who: 'c' })],
    [item({ answered: true }), item({ answered: true })], [],
  ].map((items) => ({ to: 'a@example.com', link: 'https://e.example/', settingsLink: 'https://e.example/account', items }))
  const allows: AllowRequest[] = [
    { to: 'admin@example.com', fromEmail: 'you@example.com', fromHandle: 'you', emails: ['lee@example.org', 'kim+$&@example.com'],
      command: "sudo -u etherchat etherd admin --config '/etc/x y.toml' allow --email EMAIL" },
    { to: 'admin@example.com', fromEmail: 'you@example.com', fromHandle: 'you', emails: ['lee@example.org'], command: 'allow EMAIL' },
  ]
  const input = JSON.stringify({
    Signin: signins.map(([To, Code]) => ({ To, Code })),
    Invite: invites.map((d) => ({ To: d.to, FromEmail: d.fromEmail, EtherName: d.etherName, Link: d.link,
      ExpiresAtMs: d.expiresAt.getTime(), TimeZone: d.timeZone })),
    Requests: news.map((n) => ({ To: n.to, Link: n.link, SettingsLink: n.settingsLink,
      Items: n.items.map((i) => ({ Answered: !!i.answered, Self: !!i.self, Who: i.who, EtherName: i.etherName, Link: i.link })) })),
    Allow: allows.map((a) => ({ To: a.to, FromEmail: a.fromEmail, FromHandle: a.fromHandle, Emails: a.emails, Command: a.command })),
  })

  let out: string
  try {
    out = execFileSync('go', ['run', '.'], {
      cwd: dir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
      env: { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off', GOWORK: 'off' },
    })
  } catch (err) {
    t.skip(`Go reference unavailable: ${(err as Error).message.split('\n')[0]}`)
    return
  }
  const want = JSON.parse(out) as { To: string; Subject: string; Text: string; HTML: string }[]
  const got: Message[] = [
    ...signins.map(([to, code]) => signInCode(to, code)),
    ...invites.map(invite),
    ...news.map(requestEmail),
    ...allows.map(allowRequestEmail),
  ]
  assert.equal(got.length, want.length)
  want.forEach((w, i) => {
    assert.deepEqual(got[i], { to: w.To, subject: w.Subject, text: w.Text, html: w.HTML }, `message ${i}`)
  })
})

const goRenderer = `package main

import (
	"encoding/json"
	"os"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/mail"
)

type input struct {
	Signin []struct{ To, Code string }
	Invite []struct {
		To, FromEmail, EtherName, Link string
		ExpiresAtMs                    int64
		TimeZone                       string
	}
	Requests []mail.RequestNews
	Allow    []mail.AllowRequest
}

func main() {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		panic(err)
	}
	out := []mail.Message{}
	add := func(m mail.Message, err error) {
		if err != nil {
			panic(err)
		}
		out = append(out, m)
	}
	for _, s := range in.Signin {
		add(mail.SignInCode(s.To, s.Code))
	}
	for _, d := range in.Invite {
		loc, err := time.LoadLocation(d.TimeZone)
		if err != nil {
			panic(err)
		}
		add(mail.Invite(mail.InviteDetails{To: d.To, FromEmail: d.FromEmail, EtherName: d.EtherName, Link: d.Link,
			ExpiresAt: time.UnixMilli(d.ExpiresAtMs).In(loc)}))
	}
	for _, n := range in.Requests {
		add(mail.RequestEmail(n))
	}
	for _, a := range in.Allow {
		add(mail.AllowRequestEmail(a))
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}
`

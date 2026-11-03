// Go's auth package has no tests of its own; these port the service-level
// checks of go/adapters/web/web_test.go (TestSignInFlow,
// TestSignInDoesNotRevealAccounts, TestCodeLimits,
// TestDisabledAccountLosesSession) and cover the rest of the service.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isKind } from '../../core/errors.ts'
import { newTestService, type TestService } from '../../core/ether/testing.ts'
import type { Logger } from '../../core/log.ts'
import { MailDisabledError, type Mailer, type Message } from '../mail/index.ts'
import {
  AuthService, BadCodeError, CODES_PER_EMAIL_PER_HOUR, MAX_ATTEMPTS, RateLimitedError, REQUESTS_PER_IP_PER_HOUR,
  SESSION_PREFIX, SESSION_TTL_MS, VERIFIES_PER_IP_PER_HOUR,
} from './index.ts'

class CaptureMailer implements Mailer {
  sent: Message[] = []
  fail = false

  async send(m: Message): Promise<void> {
    if (this.fail) throw new MailDisabledError()
    this.sent.push(m)
  }

  lastCode(): string {
    assert.ok(this.sent.length > 0, 'no email sent')
    const m = /\b(\d{6})\b/.exec(this.sent[this.sent.length - 1].text)
    assert.ok(m, `no code in ${this.sent[this.sent.length - 1].text}`)
    return m[1]
  }
}

interface Site {
  t: TestService
  auth: AuthService
  mail: CaptureMailer
  logged: string[]
}

const ip = '203.0.113.7'
const minute = 60_000

function newSite(): Site {
  const t = newTestService()
  const mail = new CaptureMailer()
  const logged: string[] = []
  const log: Logger = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) }
  const auth = new AuthService(t.db, t.svc, mail, t.pepper, log)
  auth.setClock(t.clock)
  return { t, auth, mail, logged }
}

function wrong(code: string): string {
  return code === '000000' ? '000001' : '000000'
}

test('sign-in flow', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')

  await s.auth.requestCode('Alice@Example.com', ip)
  assert.equal(s.mail.sent.length, 1)
  const m = s.mail.sent[0]
  assert.equal(m.to, 'alice@example.com')
  assert.ok(m.text.includes('never asks for this code') && m.html.includes('never asks for this code'))
  const code = s.mail.lastCode()

  // Spaces in the code are fine.
  const acct = s.auth.verifyCode('alice@example.com', ` ${code.slice(0, 3)} ${code.slice(3)} `, ip)
  assert.equal(acct.email, 'alice@example.com')
  assert.equal(acct.handle, 'alice')
  assert.ok(acct.verified)

  const { token, expires } = s.auth.newSession(acct.id)
  assert.ok(token.startsWith(SESSION_PREFIX))
  assert.equal(expires.getTime(), s.t.now().getTime() + SESSION_TTL_MS)
  assert.equal(s.auth.sessionAccount(token)?.id, acct.id)
  // Only the hash is stored.
  const row = s.t.db.get<{ token_hash: string }>('SELECT token_hash FROM web_sessions')
  assert.equal(row?.token_hash, createHash('sha256').update(token).digest('hex'))

  // A code works once.
  assert.throws(() => s.auth.verifyCode('alice@example.com', code, ip), BadCodeError)

  s.auth.endSession(token)
  assert.equal(s.auth.sessionAccount(token), undefined)
})

test('sign-in does not reveal accounts', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  await s.auth.requestCode('alice@example.com', ip)
  await s.auth.requestCode('stranger@example.com', ip)
  assert.equal(s.mail.sent.length, 1, 'emails sent to the stranger')
  await assert.rejects(s.auth.requestCode('not an email', ip), (err) => isKind(err, 'invalid'))

  // Disabled accounts get nothing either.
  s.t.svc.ensureAccount('alice@example.com', true)
  s.t.svc.disableAccount('alice@example.com')
  await s.auth.requestCode('alice@example.com', ip)
  assert.equal(s.mail.sent.length, 1)
})

test('code limits', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const verify = (code: string) => s.auth.verifyCode('alice@example.com', code, ip)

  // Five wrong guesses lock the code, even the right one fails after.
  await s.auth.requestCode('alice@example.com', ip)
  let code = s.mail.lastCode()
  for (let i = 0; i < MAX_ATTEMPTS; i++) assert.throws(() => verify(wrong(code)), BadCodeError, `wrong guess ${i}`)
  assert.throws(() => verify(code), BadCodeError, 'correct code after lockout')

  // Codes expire after 10 minutes.
  await s.auth.requestCode('alice@example.com', ip)
  code = s.mail.lastCode()
  s.t.advance(11 * minute)
  assert.throws(() => verify(code), BadCodeError, 'expired code')

  // A new code supersedes the previous one.
  await s.auth.requestCode('alice@example.com', ip)
  const first = s.mail.lastCode()
  await s.auth.requestCode('alice@example.com', ip)
  const second = s.mail.lastCode()
  if (first !== second) assert.throws(() => verify(first), BadCodeError, 'superseded code')
  assert.equal(verify(second).email, 'alice@example.com')

  // At most five codes per email per hour; further requests send nothing.
  s.t.advance(2 * 60 * minute)
  const before = s.mail.sent.length
  for (let i = 0; i < CODES_PER_EMAIL_PER_HOUR + 2; i++) await s.auth.requestCode('alice@example.com', `198.51.100.${i}`)
  assert.equal(s.mail.sent.length - before, CODES_PER_EMAIL_PER_HOUR)
  assert.ok(s.logged.includes('sign-in code limit reached'))
})

test('malformed codes and addresses are bad codes', () => {
  const s = newSite()
  for (const [email, code] of [['alice@example.com', '12345'], ['alice@example.com', '1234567'], ['alice@example.com', '12a456'],
    ['alice@example.com', '１２３４５６'], ['not an email', '123456']]) {
    assert.throws(() => s.auth.verifyCode(email, code, ip), BadCodeError, `${email} ${code}`)
  }
  // No code was ever sent, so a well-formed one is still wrong.
  assert.throws(() => s.auth.verifyCode('alice@example.com', '123456', ip), BadCodeError)
  assert.equal(new BadCodeError().message, "that code didn't work; check it, or request a new one")
})

test('per-address limits', async () => {
  const s = newSite()
  for (let i = 0; i < REQUESTS_PER_IP_PER_HOUR; i++) await s.auth.requestCode(`p${i}@example.com`, ip)
  await assert.rejects(s.auth.requestCode('alice@example.com', ip), RateLimitedError)
  await s.auth.requestCode('alice@example.com', '198.51.100.1')
  assert.equal(new RateLimitedError().message, 'too many attempts; wait a while and try again')

  for (let i = 0; i < VERIFIES_PER_IP_PER_HOUR; i++) {
    assert.throws(() => s.auth.verifyCode('alice@example.com', '000000', ip), BadCodeError)
  }
  assert.throws(() => s.auth.verifyCode('alice@example.com', '000000', ip), RateLimitedError)
  // Malformed codes are refused before they count.
  assert.throws(() => s.auth.verifyCode('alice@example.com', 'abc', ip), BadCodeError)

  // The windows slide.
  s.t.advance(60 * minute + 1)
  assert.throws(() => s.auth.verifyCode('alice@example.com', '000000', ip), BadCodeError)
  await s.auth.requestCode('alice@example.com', ip)
})

test('an address removed after its code was sent cannot sign in', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  await s.auth.requestCode('alice@example.com', ip)
  const code = s.mail.lastCode()
  s.t.svc.disallow('alice@example.com')
  assert.throws(() => s.auth.verifyCode('alice@example.com', code, ip), BadCodeError)
})

test('a failed send is logged, not thrown', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  s.mail.fail = true
  await s.auth.requestCode('alice@example.com', ip)
  assert.ok(s.logged.includes('sending sign-in code failed'))
})

test('disabled account loses its session', () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const acct = s.t.svc.ensureAccount('alice@example.com', true)
  const { token } = s.auth.newSession(acct.id)
  assert.ok(s.auth.sessionAccount(token))
  s.t.svc.disallow('alice@example.com')
  assert.equal(s.auth.sessionAccount(token), undefined, 'disabled account still signed in')
})

test('sessions expire, record activity, and are swept', () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  const acct = s.t.svc.ensureAccount('alice@example.com', true)
  const { token } = s.auth.newSession(acct.id)
  const lastSeen = () => s.t.db.get<{ t: number }>('SELECT last_seen_at AS t FROM web_sessions')?.t
  const start = s.t.now().getTime()

  s.t.advance(30_000)
  s.auth.sessionAccount(token)
  assert.equal(lastSeen(), start, 'last_seen_at moved within a minute')
  s.t.advance(31_000)
  s.auth.sessionAccount(token)
  assert.equal(lastSeen(), start + 61_000)

  assert.equal(s.auth.sessionAccount('eth_ws_nope'), undefined)
  assert.equal(s.auth.sessionAccount('not-a-session'), undefined)

  s.t.set(new Date(start + SESSION_TTL_MS))
  assert.equal(s.auth.sessionAccount(token), undefined, 'session outlived 30 days')
  assert.equal(s.auth.sweep(), 0)
  s.t.advance(7 * 24 * 60 * minute + 1)
  assert.equal(s.auth.sweep(), 1)
})

test('sweep removes old sign-in codes', async () => {
  const s = newSite()
  s.t.svc.allow('alice@example.com', '')
  await s.auth.requestCode('alice@example.com', ip)
  await s.auth.requestCode('alice@example.com', ip)
  assert.equal(s.auth.sweep(), 0)
  s.t.advance(7 * 24 * 60 * minute + 11 * minute)
  assert.equal(s.auth.sweep(), 2)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newTestService } from '../core/ether/testing.ts'
import { REQUEST_EMAIL_GAP_MS } from '../core/ether/index.ts'
import { discardLogger } from '../core/log.ts'
import { AuthService } from '../adapters/auth/index.ts'
import { OAuthServer } from '../adapters/oauth/index.ts'
import { DisabledMailer, MailDisabledError, type Mailer, type Message } from '../adapters/mail/index.ts'
import { listBackups, runBackup } from './backup.ts'
import { Jobs, type JobsState } from './jobs.ts'

const noFetch = { fetchJson: async (): Promise<unknown> => { throw new Error('no fetching in tests') } }

class CaptureMailer implements Mailer {
  sent: Message[] = []
  async send(m: Message): Promise<void> {
    this.sent.push(m)
  }
}

function services(t: ReturnType<typeof newTestService>) {
  const auth = new AuthService(t.db, t.svc, new DisabledMailer(), t.pepper, discardLogger)
  auth.setClock(t.clock)
  const oauth = new OAuthServer(t.db, t.svc, 'https://etherchat.example', noFetch, discardLogger)
  oauth.setClock(t.clock)
  return { auth, oauth }
}

test('tick publishes due posts and backs up once a day', async (tt) => {
  const t = newTestService({ start: new Date() })
  const dir = mkdtempSync(join(tmpdir(), 'etherchat-jobs-'))
  tt.after(() => rmSync(dir, { recursive: true, force: true }))
  const backupDir = join(dir, 'backups')

  const a = t.account('a@example.com')
  const e = t.svc.createEther(a, 'E')
  t.svc.postMessage(a, e.id, { intent: 'update', body: '4pm update', sendAt: new Date(t.now().getTime() + 10 * 60_000) })

  const jobs = new Jobs({
    ethers: t.svc, ...services(t), baseUrl: 'https://etherchat.example', log: discardLogger, now: t.clock,
    backups: { list: () => listBackups(backupDir), run: (now) => runBackup(t.db, backupDir, 14, now) },
  })

  await jobs.tick()
  assert.equal(listBackups(backupDir).length, 1, 'first tick should back up')
  assert.equal(t.svc.readBoard(a, e.id).length, 0, 'scheduled post published early')

  t.advance(11 * 60_000)
  await jobs.tick()
  assert.equal(t.svc.readBoard(a, e.id).length, 1, 'scheduled post not published when due')
  assert.equal(listBackups(backupDir).length, 1, 'backed up again within a day')

  t.advance(25 * 3600_000)
  await jobs.tick()
  assert.equal(listBackups(backupDir).length, 2, 'no backup after a day')
})

test('maintenance runs hourly, remembered in the state', async () => {
  const t = newTestService()
  const { auth, oauth } = services(t)
  let sweeps = 0
  const counting = Object.create(auth) as AuthService
  counting.sweep = () => { sweeps++; return 0 }
  const store = new Map<string, unknown>()
  const state: JobsState = { get: (k) => store.get(k), put: (k, v) => { store.set(k, v) } }
  const opts = { ethers: t.svc, auth: counting, oauth, baseUrl: 'https://e.example', log: discardLogger, now: t.clock, state }

  await new Jobs(opts).tick()
  assert.equal(sweeps, 1)
  assert.equal(store.get('lastHourly'), t.now().getTime())
  t.advance(30 * 60_000)
  // A new Jobs (a Durable Object woken again) still knows the last run.
  await new Jobs(opts).tick()
  assert.equal(sweeps, 1)
  t.advance(30 * 60_000)
  await new Jobs(opts).tick()
  assert.equal(sweeps, 2)
})

// A request emails the person asked, without the agent's words, and the
// next one waits for the hour.
test('request emails', async () => {
  const t = newTestService({ start: new Date() })
  const owner = t.account('owner@example.com', 'app')
  const sam = t.account('sam@example.com', 'app')
  const e = t.svc.createEther(owner, 'Atlas')
  t.join(owner, sam, e.id, 'sam@example.com')

  const m = new CaptureMailer()
  const jobs = new Jobs({ ethers: t.svc, ...services(t), mailer: m, baseUrl: 'https://etherchat.example', log: discardLogger, now: t.clock })
  t.svc.ask(owner, e.id, { to: ['sam'], title: 'Click https://evil.example now', body: 'Your account is locked.' })
  await jobs.sendRequestEmails()
  assert.equal(m.sent.length, 1)
  const got = m.sent[0]
  assert.equal(got.to, 'sam@example.com')
  assert.equal(got.subject, "@owner's agent asked you something on Etherchat")
  assert.ok(got.text.includes('https://etherchat.example/e/' + e.id))
  assert.ok(got.text.includes('https://etherchat.example/account'))
  for (const part of [got.subject, got.text, got.html]) {
    assert.ok(!part.includes('evil') && !part.includes('locked'), "the agent's words reached the email")
  }

  t.svc.ask(owner, e.id, { to: ['sam'], title: 'Second' })
  await jobs.sendRequestEmails()
  assert.equal(m.sent.length, 1, 'second email within the hour')
  t.advance(REQUEST_EMAIL_GAP_MS)
  await jobs.sendRequestEmails()
  assert.equal(m.sent.length, 2)
  assert.ok(m.sent[1].subject.includes('asked you something'))
})

test('request emails: failures are retried; with mail off they are only marked', async () => {
  const t = newTestService({ start: new Date() })
  const owner = t.account('owner@example.com', 'app')
  const sam = t.account('sam@example.com', 'app')
  const e = t.svc.createEther(owner, 'Atlas')
  t.join(owner, sam, e.id, 'sam@example.com')
  t.svc.ask(owner, e.id, { to: ['sam'], title: 'Q' })

  let attempts = 0
  const flaky: Mailer = { send: async () => { attempts++; throw new Error('resend: HTTP 500: down') } }
  const errors: string[] = []
  const log = { ...discardLogger, error: (msg: string) => { errors.push(msg) } }
  await new Jobs({ ethers: t.svc, ...services(t), mailer: flaky, baseUrl: 'https://e.example', log, now: t.clock }).sendRequestEmails()
  await new Jobs({ ethers: t.svc, ...services(t), mailer: flaky, baseUrl: 'https://e.example', log, now: t.clock }).sendRequestEmails()
  assert.equal(attempts, 2, 'a failed send is retried on the next tick')
  assert.deepEqual(errors, ['sending request email', 'sending request email'])

  const off: Mailer = { send: async () => { attempts++; throw new MailDisabledError() } }
  const jobs = new Jobs({ ethers: t.svc, ...services(t), mailer: off, baseUrl: 'https://e.example', log, now: t.clock })
  await jobs.sendRequestEmails()
  await jobs.sendRequestEmails()
  assert.equal(attempts, 3, 'with mail off the request is marked, not retried')
})

// Port of go/core/ether/requests_test.go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EtherError } from '../errors.ts'
import { MAX_OPEN_REQUESTS, REQUEST_EMAIL_GAP_MS, REQUEST_TTL_MS, type Actor, type AskInput, type RequestStatus } from './index.ts'
import { newTestService } from './testing.ts'

const minute = 60_000
const second = 1000

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof EtherError ? err.kind : String(err)
  }
}

/** An owner's ether "Team" with sam as a member. */
function team() {
  const t = newTestService()
  const owner = t.account('owner@example.com')
  const sam = t.account('sam@example.com')
  const e = t.svc.createEther(owner, 'Team')
  t.join(owner, sam, e.id, 'sam@example.com')
  return { t, s: t.svc, owner, sam, id: e.id }
}

test('requests', () => {
  const { t, s, owner, sam, id } = team()
  const outsider = t.account('x@example.com')

  // Bad requests are refused before anything is stored.
  const bad: AskInput[] = [
    { to: ['nobody'], title: 'Q' },
    { to: ['sam'], title: '' },
    { to: ['sam'], title: 'two\nlines' },
    { to: ['sam'], title: 'Q', choices: ['only one'] },
    { to: ['sam'], title: 'Q', choices: ['a', 'b', 'c', 'd', 'e'] },
    { to: ['sam'], title: 'Q', choices: ['Yes', 'yes'] },
  ]
  for (const input of bad) assert.equal(kindOf(() => s.ask(owner, id, input)), 'invalid', JSON.stringify(input))
  assert.equal(kindOf(() => s.ask(outsider, id, { to: ['sam'], title: 'Q' })), 'not_found')

  const r = s.ask(owner, id, {
    to: ['@sam'], title: 'Merge the drafts?', body: 'Chapters 2 and 3 overlap.', choices: ['Merge', 'Keep separate'],
  })
  assert.equal(r.status, 'open')
  assert.equal(r.from, 'owner')
  assert.equal(r.to.length, 1)
  assert.equal(r.to[0].handle, 'sam')
  assert.equal(r.clientId, 'test')
  assert.equal(r.to[0].answerChoice, -1)
  assert.equal(r.expiresAt.getTime(), r.createdAt.getTime() + REQUEST_TTL_MS)

  // Only the person asked can answer, with one of the choices, once.
  assert.equal(kindOf(() => s.answerRequest(owner, id, r.id, 0, '')), 'forbidden')
  assert.equal(kindOf(() => s.answerRequest(sam, id, r.id, 2, '')), 'invalid')
  assert.equal(kindOf(() => s.answerRequest(sam, id, r.id, -1, 'hmm')), 'invalid')
  const ans = s.answerRequest(sam, id, r.id, 1, '  They cover different weeks.  ')
  const rc = ans.recipient(sam.accountId)!
  assert.equal(ans.status, 'answered')
  assert.equal(ans.choiceText(rc.answerChoice), 'Keep separate')
  assert.equal(rc.answerNote, 'They cover different weeks.')
  assert.equal(kindOf(() => s.answerRequest(sam, id, r.id, 0, '')), 'conflict')
  assert.equal(kindOf(() => s.withdrawRequest(owner, id, r.id)), 'conflict')

  // Without choices, the answer is a note. An agent can ask its own person.
  const open = s.ask(sam, id, { to: ['sam'], title: 'Which week is the deadline?' })
  assert.equal(kindOf(() => s.answerRequest(sam, id, open.id, -1, '')), 'invalid')
  assert.equal(kindOf(() => s.answerRequest(sam, id, open.id, 0, 'x')), 'invalid')

  // Only the asking member's agents withdraw; each member has at most five open.
  assert.equal(kindOf(() => s.withdrawRequest(owner, id, open.id)), 'forbidden')
  s.withdrawRequest({ accountId: sam.accountId, clientId: 'another app' }, id, open.id)
  for (let i = 0; i < MAX_OPEN_REQUESTS; i++) s.ask(owner, id, { to: ['sam'], title: 'Q' + '?'.repeat(i) })
  assert.equal(kindOf(() => s.ask(owner, id, { to: ['sam'], title: 'One too many' })), 'limit')
  assert.equal(s.openRequestCounts(sam).get(id), MAX_OPEN_REQUESTS)

  // After 14 days they expire, can't be answered, and stop counting.
  t.advance(REQUEST_TTL_MS + minute)
  const list = s.listRequests(sam, id)
  const statuses = new Map<RequestStatus, number>()
  for (const req of list) statuses.set(req.status, (statuses.get(req.status) ?? 0) + 1)
  assert.equal(statuses.get('expired'), MAX_OPEN_REQUESTS)
  assert.equal(statuses.get('answered'), 1)
  assert.equal(statuses.get('withdrawn'), 1)
  assert.equal(kindOf(() => s.answerRequest(sam, id, list[0].id, -1, 'late')), 'conflict')
  s.ask(owner, id, { to: ['sam'], title: 'Fresh' })
})

test('request messages match Go', () => {
  const { t, s, owner, sam, id } = team()
  const msg = (fn: () => unknown) => {
    try {
      fn()
    } catch (err) {
      return (err as Error).message
    }
    return ''
  }
  assert.equal(msg(() => s.ask(owner, id, { to: ['nobody'], title: 'Q' })),
    'invalid request: "nobody" isn\'t a member of this ether; use handles from list_ethers')
  assert.equal(msg(() => s.ask(owner, id, { to: ['sam'], title: 'two\nlines' })),
    'invalid request: title must be one line without control characters')
  const r = s.ask(owner, id, { to: ['sam'], title: 'Q' })
  assert.equal(msg(() => s.withdrawRequest(sam, id, r.id)), "not allowed: only @owner's agents can withdraw this request")
  s.withdrawRequest(owner, id, r.id)
  assert.equal(msg(() => s.answerRequest(sam, id, r.id, -1, 'x')), 'version conflict: this request is withdrawn')
  const stored = s.ask(owner, id, { to: ['sam'], title: 'Q', choices: ['<a>', 'b&c'] })
  // Choices are stored as Go's json.Marshal writes them.
  const row = t.db.get<{ choices: string }>('SELECT choices FROM requests WHERE id = ?', stored.id)
  assert.equal(row?.choices, '["\\u003ca\\u003e","b\\u0026c"]')
  assert.deepEqual(stored.choices, ['<a>', 'b&c'])
})

test('requests in pull', () => {
  const { t, s, owner, sam, id } = team()
  const chatgpt: Actor = { accountId: owner.accountId, clientId: 'chatgpt' }
  const codex: Actor = { accountId: owner.accountId, clientId: 'codex' }
  s.pull(chatgpt, id)
  s.pull(codex, id)
  const r = s.ask(chatgpt, id, { to: ['sam'], title: 'Merge?', choices: ['Yes', 'No'] })
  s.ask(sam, id, { to: ['owner'], title: 'Review my notes?' })

  t.advance(second)
  let d = s.pull(codex, id)
  assert.equal(d.yourOpen.length, 1)
  assert.equal(d.yourOpen[0].id, r.id)
  assert.equal(d.forYourUser.length, 1)
  assert.equal(d.forYourUser[0].from, 'sam')
  assert.equal(d.answers.length, 0)

  t.advance(second)
  s.answerRequest({ accountId: sam.accountId, clientId: '' }, id, r.id, 0, '')
  t.advance(second)
  // The member's other app, not just the one that asked, gets the answer once.
  for (const app of [codex, chatgpt]) {
    d = s.pull(app, id)
    assert.equal(d.answers.length, 1, app.clientId)
    assert.equal(d.answers[0].choiceText(d.answers[0].to[0].answerChoice), 'Yes')
    assert.equal(d.yourOpen.length, 0)
    assert.equal(s.pull(app, id).answers.length, 0, `${app.clientId} sees the answer twice`)
  }
})

test('request emails', () => {
  const { t, s, owner, sam, id } = team()

  const r1 = s.ask(owner, id, { to: ['sam'], title: 'First' })
  let due = s.dueRequestEmails()
  assert.equal(due.length, 1)
  assert.equal(due[0].email, 'sam@example.com')
  assert.ok(due[0].send)
  assert.equal(due[0].asked.length, 1)
  s.markRequestEmail(due[0], true)

  // Within the hour, new requests wait; afterwards they go out together.
  t.advance(10 * minute)
  s.ask(owner, id, { to: ['sam'], title: 'Second' })
  s.ask(owner, id, { to: ['sam'], title: 'Third' })
  assert.equal(s.dueRequestEmails().length, 0, 'emailed again within the hour')
  t.advance(REQUEST_EMAIL_GAP_MS)
  due = s.dueRequestEmails()
  assert.equal(due.length, 1)
  assert.equal(due[0].asked.length, 2)
  s.markRequestEmail(due[0], true)

  // The asker's person hears about an answer from someone else, but not
  // about answering their own agent.
  s.answerRequest(sam, id, r1.id, -1, 'Done.')
  const mine = s.ask(owner, id, { to: ['owner'], title: 'Note to self' })
  s.markRequestEmail({ accountId: '', email: '', send: false, asked: [mine], answers: [] }, false)
  s.answerRequest(owner, id, mine.id, -1, 'ok')
  due = s.dueRequestEmails()
  assert.equal(due.length, 1)
  assert.equal(due[0].email, 'owner@example.com')
  assert.equal(due[0].answers.length, 1)
  assert.equal(due[0].answers[0].request.id, r1.id)
  assert.equal(due[0].answers[0].by.handle, 'sam')

  // With emails off, items are marked handled and nothing is sent, so
  // turning emails back on later doesn't bring old news.
  assert.ok(s.accountById(owner.accountId).requestEmails, 'request emails should default to on')
  s.setRequestEmails(owner.accountId, false)
  due = s.dueRequestEmails()
  assert.equal(due.length, 1)
  assert.equal(due[0].send, false)
  s.markRequestEmail(due[0], false)
  s.setRequestEmails(owner.accountId, true)
  assert.equal(s.dueRequestEmails().length, 0, 'old news after turning emails back on')
})

// An agent can ask its own person and another member at once. Each answers
// separately; the request is answered when both have.
test('request to several', () => {
  const { t, s, owner, sam, id } = team()

  let r = s.ask(owner, id, { to: ['owner', '@sam', 'sam'], title: 'Ship it Friday?', choices: ['Yes', 'No'] })
  assert.deepEqual(r.to.map((rc) => rc.handle), ['owner', 'sam'])
  assert.ok(r.waitingOn(owner.accountId) && r.waitingOn(sam.accountId), 'both should be asked')
  t.advance(second)
  r = s.answerRequest(sam, id, r.id, 0, '')
  assert.equal(r.status, 'open')
  assert.equal(r.answerCount(), 1)
  assert.ok(!r.waitingOn(sam.accountId))
  assert.ok(r.waitingOn(owner.accountId))
  // The asker's agents see the first answer while the request stays open.
  const d = s.pull(owner, id, new Date(0))
  assert.equal(d.answers.length, 1)
  assert.equal(d.yourOpen.length, 1)
  assert.equal(d.forYourUser.length, 1)
  assert.equal(s.openRequestCounts(sam).get(id) ?? 0, 0)
  r = s.answerRequest(owner, id, r.id, 1, "Let's wait.")
  assert.equal(r.status, 'answered')
  // Only sam's answer is news for the owner's email; answering your own
  // agent isn't.
  for (const m of s.dueRequestEmails()) {
    if (m.accountId === owner.accountId) {
      assert.equal(m.answers.length, 1)
      assert.equal(m.answers[0].by.handle, 'sam')
    }
  }
})

test('agent name', () => {
  const { s, owner, sam, id } = team()

  assert.equal(s.getEther(owner, id).agent('sam'), '@sam')
  for (const bad of ['@owner', 'owner', 'Seventeen chars!!', 'slash/name', '<b>']) {
    assert.notEqual(kindOf(() => s.setAgentName(sam, id, bad)), undefined, `name ${bad} was accepted`)
  }
  s.setAgentName(sam, id, '  Atlas   Two ')
  let e = s.getEther(owner, id)
  assert.equal(e.agent('sam'), 'Atlas Two')
  assert.equal(e.agent('owner'), '@owner')
  assert.equal(e.members.find((m) => m.handle === 'sam')?.agent(), 'Atlas Two')
  assert.equal(kindOf(() => s.setAgentName(owner, id, 'atlas two')), 'exists')
  s.setAgentName(sam, id, '')
  e = s.getEther(owner, id)
  assert.equal(e.agent('sam'), '@sam')
})

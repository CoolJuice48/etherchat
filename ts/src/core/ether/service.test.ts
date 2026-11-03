// Port of go/core/ether/service_test.go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConflictError, EtherError } from '../errors.ts'
import { normalizeEmail, type Mode } from './index.ts'
import { newTestService, trio } from './testing.ts'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

/** The thrown error's kind, its text for other errors, or undefined on success. */
function kindOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof EtherError ? err.kind : String(err)
  }
}

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  return undefined
}

const text = (b: Uint8Array) => new TextDecoder().decode(b)

test('create ether layout', () => {
  const { t, alice, bob, etherId: id } = trio()
  const e = t.svc.getEther(bob, id)
  assert.equal(e.ownerHandle, 'alice')
  assert.equal(e.members.length, 2)
  assert.ok(e.members[0].owner)
  const paths = t.svc.listFiles(alice, id, '', true).map((fi) => fi.path)
  assert.equal(paths.join(' '), 'members members/alice members/bob shared')
})

// Exercises the §6 matrix through the service, so target construction and
// the checks in each operation are covered too.
test('permissions end to end', () => {
  const { t, alice, bob, carol, etherId: id } = trio()
  const s = t.svc
  const shared: Mode = 'shared_edit'

  s.writeFile(alice, id, 'members/alice/notes.md', "alice's notes", 0)
  s.writeFile(alice, id, 'shared/plan.md', 'the plan', 0) // author_only
  s.writeFile(bob, id, 'shared/scratch.md', 'scratch', 0, shared) // shared_edit by bob
  s.writeFile(bob, id, 'shared/bob-only.md', 'bob only', 0) // author_only by bob
  s.writeFile(bob, id, 'shared/owner-may-delete.md', 'x', 0, shared) // shared_edit by bob

  const steps: [string, () => unknown, string | undefined][] = [
    ["bob reads alice's workspace", () => s.readFile(bob, id, 'members/alice/notes.md', 0), undefined],
    ["bob writes into alice's workspace", () => s.writeFile(bob, id, 'members/alice/new.md', 'x', 0), 'forbidden'],
    ["bob edits alice's workspace file", () => s.writeFile(bob, id, 'members/alice/notes.md', 'x', 1), 'forbidden'],
    ["alice edits bob's author_only shared file", () => s.writeFile(alice, id, 'shared/bob-only.md', 'x', 1), 'forbidden'],
    ["alice edits bob's shared_edit file", () => s.writeFile(alice, id, 'shared/scratch.md', 'edited by alice', 1), undefined],
    ["bob edits alice's author_only shared file", () => s.writeFile(bob, id, 'shared/plan.md', 'x', 1), 'forbidden'],
    ["alice (owner) deletes bob's author_only shared file", () => s.deleteFile(alice, id, 'shared/bob-only.md', 1), 'forbidden'],
    ["alice (owner) deletes bob's shared_edit file", () => s.deleteFile(alice, id, 'shared/owner-may-delete.md', 1), undefined],
    ["bob deletes alice's workspace file", () => s.deleteFile(bob, id, 'members/alice/notes.md', 1), 'forbidden'],
    ["bob changes the mode of alice's file", () => s.setMode(bob, id, 'shared/plan.md', 'shared_edit'), 'forbidden'],
    ["alice (owner) changes the mode of bob's shared_edit file", () => s.setMode(alice, id, 'shared/scratch.md', 'author_only'), undefined],
    ['alice can no longer edit it', () => s.writeFile(alice, id, 'shared/scratch.md', 'x', 2), 'forbidden'],
    ['bob tries to make a file shared_edit in his workspace', () => s.writeFile(bob, id, 'members/bob/x.md', 'x', 0, shared), 'invalid'],
    ['bob deletes the shared/ root', () => s.deleteFile(bob, id, 'shared', 0), 'forbidden'],
    ['alice deletes her workspace root', () => s.deleteFile(alice, id, 'members/alice', 0), 'forbidden'],
    ["bob creates a folder in alice's workspace", () => s.createFolder(bob, id, 'members/alice/sub'), 'forbidden'],
    ['carol (non-member) reads', () => s.readFile(carol, id, 'shared/plan.md', 0), 'not_found'],
    ['carol (non-member) lists', () => s.listFiles(carol, id, '', true), 'not_found'],
    ['carol (non-member) writes', () => s.writeFile(carol, id, 'shared/c.md', 'x', 0), 'not_found'],
    ['unknown ether', () => s.getEther(alice, 'nosuchether'), 'not_found'],
  ]
  for (const [name, fn, want] of steps) assert.equal(kindOf(fn), want, name)

  // The messages match Go's.
  assert.equal(String(caught(() => s.writeFile(bob, id, 'members/alice/new.md', 'x', 0))),
    "EtherError: not allowed: you can't create members/alice/new.md")
  assert.equal((caught(() => s.setMode(bob, id, 'shared/plan.md', 'shared_edit')) as Error).message,
    "not allowed: you can't change mode shared/plan.md")
})

test('version conflicts', () => {
  const { t, alice, bob, etherId: id } = trio()
  const s = t.svc

  const r = s.writeFile(alice, id, 'shared/doc.md', 'v1', 0, 'shared_edit')
  assert.equal(r.version, 1)
  assert.ok(r.created)

  // Creating again with expected 0 conflicts and reports the current head.
  let err = caught(() => s.writeFile(bob, id, 'shared/doc.md', 'other v1', 0))
  assert.ok(err instanceof ConflictError)
  assert.equal(err.current, 1)
  assert.equal(err.currentAuthor, 'alice')
  assert.equal(err.message, 'version conflict on shared/doc.md: current version is 1 by @alice')

  s.writeFile(bob, id, 'shared/doc.md', 'v2 by bob', 1)

  // Alice still thinks it's version 1.
  err = caught(() => s.writeFile(alice, id, 'shared/doc.md', 'stale', 1))
  assert.ok(err instanceof ConflictError)
  assert.equal(err.current, 2)
  assert.equal(err.currentAuthor, 'bob')
  // Editing a file that doesn't exist yet with expected > 0 conflicts with current 0.
  err = caught(() => s.writeFile(alice, id, 'shared/missing.md', 'x', 3))
  assert.ok(err instanceof ConflictError)
  assert.equal(err.current, 0)
  assert.equal(err.message, 'version conflict on shared/missing.md: file does not exist')
  // Stale delete.
  assert.equal(kindOf(() => s.deleteFile(alice, id, 'shared/doc.md', 1)), 'conflict')

  const got = s.readFile(alice, id, 'shared/doc.md', 0)
  assert.equal(text(got.content), 'v2 by bob')
  assert.equal(got.version, 2)
  assert.equal(got.author, 'alice')
  assert.equal(got.updatedBy, 'bob')
  const old = s.readFile(bob, id, 'shared/doc.md', 1)
  assert.equal(text(old.content), 'v1')
})

// Go races two goroutines on the same expected version. The core here is
// synchronous, so the two writers take turns: exactly one must win and the
// other must get a conflict.
test('competing writers', () => {
  const { t, alice, bob, etherId: id } = trio()
  t.svc.writeFile(alice, id, 'shared/race.md', 'v1', 0, 'shared_edit')
  for (let round = 1; round <= 20; round++) {
    const results = [alice, bob].map((who) => kindOf(() => t.svc.writeFile(who, id, 'shared/race.md', 'round', round)))
    assert.equal(results.filter((k) => k === undefined).length, 1, `round ${round}`)
    assert.equal(results.filter((k) => k === 'conflict').length, 1, `round ${round}`)
  }
  const hist = t.svc.fileHistory(alice, id, 'shared/race.md')
  assert.equal(hist[0].version, 21)
})

test('delete and recreate', () => {
  const { t, alice, etherId: id } = trio()
  const s = t.svc
  s.writeFile(alice, id, 'members/alice/tmp.md', 'x', 0)
  s.deleteFile(alice, id, 'members/alice/tmp.md', 1)
  assert.equal(kindOf(() => s.readFile(alice, id, 'members/alice/tmp.md', 0)), 'not_found')
  const r = s.writeFile(alice, id, 'members/alice/tmp.md', 'again', 0)
  assert.equal(r.version, 1)
  assert.ok(r.created)

  s.createFolder(alice, id, 'members/alice/dir/sub')
  assert.equal(kindOf(() => s.deleteFile(alice, id, 'members/alice/dir', 0)), 'invalid')
  s.deleteFile(alice, id, 'members/alice/dir/sub', 0)
  s.deleteFile(alice, id, 'members/alice/dir', 0)
})

test('paths are case-insensitive', () => {
  const { t, alice, etherId: id } = trio()
  t.svc.writeFile(alice, id, 'shared/Notes.md', 'x', 0)
  assert.equal(kindOf(() => t.svc.writeFile(alice, id, 'shared/notes.md', 'y', 0)), 'conflict')
  // A differently cased workspace segment lands under the stored spelling.
  const r = t.svc.writeFile(alice, id, 'members/ALICE/todo.md', 'x', 0)
  assert.equal(r.path, 'members/alice/todo.md')
})

test('file types', () => {
  const { t, alice, etherId: id } = trio()
  const s = t.svc
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/x.pdf', 'x', 0)), 'invalid')
  assert.equal((caught(() => s.writeFile(alice, id, 'shared/x.pdf', 'x', 0)) as Error).message,
    'invalid request: file type not allowed: ".pdf"; allowed: .md .txt')
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/x.md', 'bad\x00byte', 0)), 'invalid')
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/x.md', new Uint8Array([0xff, 0xfe]), 0)), 'invalid')
  assert.equal((caught(() => s.writeFile(alice, id, 'shared/x.md', new Uint8Array([0xff, 0xfe]), 0)) as Error).message,
    'invalid request: file content does not match its type: not valid UTF-8')
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/big.md', 'a'.repeat((256 << 10) + 1), 0)), 'limit')
  assert.equal((caught(() => s.writeFile(alice, id, 'shared/big.md', 'a'.repeat((256 << 10) + 1), 0)) as Error).message,
    'limit reached: file too large for its type: 262145 bytes, limit 262144')
  s.writeFile(alice, id, 'shared/ok.txt', 'plain text', 0)
})

test('history pruning', () => {
  const { t, alice, etherId: id } = trio({ limits: (l) => { l.maxVersionsPerFile = 3 } })
  for (let v = 0; v < 5; v++) t.svc.writeFile(alice, id, 'members/alice/log.md', `version ${v + 1}`, v)
  const hist = t.svc.fileHistory(alice, id, 'members/alice/log.md')
  assert.equal(hist.length, 3)
  assert.equal(hist[0].version, 5)
  assert.equal(hist[2].version, 3)
  const err = caught(() => t.svc.readFile(alice, id, 'members/alice/log.md', 1)) as EtherError
  assert.equal(err.kind, 'not_found')
  assert.equal(err.message, 'not found: members/alice/log.md has no version 1 (it may have been pruned)')
  const row = t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM blobs WHERE unreferenced_since IS NOT NULL`)
  assert.equal(row?.n, 2)
})

test('limits', () => {
  const { t, alice, etherId: id } = trio({
    limits: (l) => {
      l.maxFilesPerEther = 6 // 4 system folders + 2
      l.maxEtherBytes = 20
      l.maxEthersPerAccount = 2
    },
  })
  const s = t.svc
  s.writeFile(alice, id, 'shared/a.md', '0123456789', 0)
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/b.md', '0123456789x', 0)), 'limit')
  s.writeFile(alice, id, 'shared/b.md', '1', 0)
  assert.equal(kindOf(() => s.writeFile(alice, id, 'shared/c.md', '1', 0)), 'limit')
  s.createEther(alice, 'second')
  assert.equal(kindOf(() => s.createEther(alice, 'third')), 'limit')
})

test('invites', () => {
  const t = newTestService()
  const s = t.svc
  const owner = t.account('owner@example.com')
  const m1 = t.account('m1@example.com')
  const m2 = t.account('m2@example.com')
  const m3 = t.account('m3@example.com')
  const m4 = t.account('m4@example.com')
  const e = s.createEther(owner, 'Team')

  assert.equal(kindOf(() => s.createInvite(owner, e.id, 'stranger@example.com')), 'not_allowed')

  const c1 = s.createInvite(owner, e.id, 'm1@example.com').code
  // The code is bound to m1's email: m2 can't use it.
  assert.equal(kindOf(() => s.joinWithCode(m2, c1)), 'not_found')
  // Lowercase, without dashes, still works.
  s.joinWithCode(m1, c1.replaceAll('-', '').toLowerCase())
  assert.equal(kindOf(() => s.joinWithCode(m1, c1)), 'not_found')
  assert.equal(kindOf(() => s.createInvite(owner, e.id, 'm1@example.com')), 'exists')

  // Members (2) + pending invites count toward the limit of 4.
  s.createInvite(m1, e.id, 'm2@example.com')
  const c3 = s.createInvite(owner, e.id, 'm3@example.com').code
  assert.equal(kindOf(() => s.createInvite(owner, e.id, 'm4@example.com')), 'limit')
  // Re-inviting the same address replaces the pending invite instead of adding one.
  const c3b = s.createInvite(owner, e.id, 'm3@example.com').code
  assert.equal(kindOf(() => s.joinWithCode(m3, c3)), 'not_found')

  const pending = s.pendingInvitesFor(m3)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].etherName, 'Team')
  assert.equal(pending[0].invitedByHandle, 'owner')
  // Looking at an invite doesn't use it, and only its own address can look.
  for (let i = 0; i < 2; i++) {
    const inv = s.inviteByCode(m3, c3b)
    assert.equal(inv.etherName, 'Team')
    assert.ok(inv.invitedByEmail.startsWith('owner@'))
  }
  assert.equal(kindOf(() => s.inviteByCode(m4, c3b)), 'not_found')
  assert.equal(kindOf(() => s.declineInvite(m4, c3b)), 'not_found')

  // Expired codes don't work, and stop counting toward the limit.
  t.advance(8 * day)
  assert.equal((caught(() => s.joinWithCode(m3, c3b)) as Error).message,
    'not found: invite code is invalid, expired, already used, or for a different email')
  const c4 = s.createInvite(owner, e.id, 'm4@example.com').code
  s.joinWithCode(m4, c4)

  // Only the owner revokes.
  const { invite } = s.createInvite(owner, e.id, 'm2@example.com')
  assert.equal(kindOf(() => s.revokeInvite(m1, e.id, invite.id)), 'forbidden')
  s.revokeInvite(owner, e.id, invite.id)
})

test('membership', () => {
  const { t, alice, bob, etherId: id } = trio()
  const s = t.svc
  s.writeFile(bob, id, 'members/bob/notes.md', 'bob was here', 0)

  assert.equal(kindOf(() => s.leaveEther(alice, id)), 'forbidden')
  assert.equal(kindOf(() => s.removeMember(bob, id, 'alice')), 'forbidden')
  s.removeMember(alice, id, 'bob')
  assert.equal(kindOf(() => s.readFile(bob, id, 'shared', 0)), 'not_found')
  // The removed member's workspace stays readable as history.
  assert.equal(text(s.readFile(alice, id, 'members/bob/notes.md', 0).content), 'bob was here')
  // Bob can be invited back and finds his workspace intact.
  t.join(alice, bob, id, 'bob@example.com')
  s.readFile(bob, id, 'members/bob/notes.md', 0)

  assert.equal(kindOf(() => s.renameEther(bob, id, 'Mine now')), 'forbidden')
  s.deleteEther(alice, id)
  assert.equal(kindOf(() => s.getEther(alice, id)), 'not_found')
  assert.deepEqual(s.listEthers(bob), [])
})

test('allowlist and accounts', () => {
  const t = newTestService()
  const s = t.svc
  assert.equal(kindOf(() => s.ensureAccount('nobody@example.com', true)), 'not_allowed')
  const a = t.account('Alex@Example.com')
  const acct = s.accountById(a.accountId)
  assert.equal(acct.email, 'alex@example.com')
  assert.equal(acct.handle, 'alex')
  assert.ok(acct.verified)
  // Same local part at another domain gets a numbered handle.
  const b = t.account('alex@other.example')
  assert.equal(s.accountById(b.accountId).handle, 'alex2')

  // Handles change only before joining an ether.
  assert.equal(kindOf(() => s.setHandle(b.accountId, 'alex')), 'exists')
  s.setHandle(b.accountId, 'jt')
  s.createEther(b, 'x')
  assert.equal(kindOf(() => s.setHandle(b.accountId, 'jt2')), 'forbidden')

  // Disallowing disables the account; re-allowing re-enables it.
  s.disallow('alex@example.com')
  assert.equal(kindOf(() => s.createEther(a, 'y')), 'disabled')
  assert.equal(kindOf(() => s.ensureAccount('alex@example.com', true)), 'not_allowed')
  s.allow('alex@example.com', 'back')
  s.createEther(a, 'y')

  assert.equal(kindOf(() => normalizeEmail('Alex <alex@example.com>')), 'invalid')
})

test('board', () => {
  const { t, alice, bob, etherId: id } = trio()
  const s = t.svc
  const start = t.now()

  const p1 = s.postMessage(alice, id, { intent: 'update', title: 'Monday', body: 'Did the schema.' })
  assert.ok(p1.publishedAt, 'immediate post not published')
  assert.equal(kindOf(() => s.postMessage(bob, id, { intent: 'chitchat', body: 'x' })), 'invalid')
  assert.equal(kindOf(() => s.postMessage(bob, id, { intent: 'fyi', body: '  ' })), 'invalid')

  t.advance(minute)
  const sendAt = new Date(t.now().getTime() + 4 * hour)
  const sched = s.postMessage(bob, id, { intent: 'handoff', body: '4pm update', sendAt })
  assert.equal(sched.publishedAt, undefined, 'scheduled post published early')
  // Bob's scheduled post isn't on the board yet.
  assert.equal(s.readBoard(alice, id, undefined, 0).length, 1)
  assert.equal(s.listScheduled(bob, id).length, 1)

  t.advance(5 * hour)
  assert.equal(s.publishDue(), 1)
  // A reader who caught up just before publish still sees it: the post is
  // stamped with the publish time, not the scheduled time.
  const posts = s.readBoard(alice, id, new Date(start.getTime() + 2 * hour), 0)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].id, sched.id)
  assert.equal(posts[0].author, 'bob')

  const reply = s.postMessage(alice, id, { intent: 'review', body: 'Looks good', replyTo: sched.id })
  assert.equal(reply.replyTo, sched.id)
  assert.equal(kindOf(() => s.cancelPost(bob, id, reply.id)), 'forbidden')
  s.cancelPost(alice, id, reply.id)

  // A scheduled post whose author left the ether is cancelled, not published.
  const later = new Date(t.now().getTime() + hour)
  s.postMessage(bob, id, { intent: 'fyi', body: 'bye', sendAt: later })
  s.leaveEther(bob, id)
  t.advance(2 * hour)
  assert.equal(s.publishDue(), 0)

  const tooFar = new Date(t.now().getTime() + 31 * day)
  assert.equal((caught(() => s.postMessage(alice, id, { intent: 'fyi', body: 'x', sendAt: tooFar })) as Error).message,
    'invalid request: posts can be scheduled at most 720h0m0s ahead')
})

// TypeScript-only: the audit rows activity reads match Go's byte for byte.
test('audit rows and activity', () => {
  const { t, alice, bob, etherId: id } = trio()
  const s = t.svc
  s.writeFile(alice, id, 'shared/a.md', 'hello', 0)
  s.setMode(alice, id, 'shared/a.md', 'shared_edit')
  const p = s.postMessage(bob, id, { intent: 'fyi', body: 'hi', title: 'T' })
  s.setAgentName(bob, id, 'Scout')
  const rows = t.db.all<{ action: string; target: string; detail: string; client_id: string }>(
    `SELECT action, target, detail, client_id FROM audit_log WHERE ether_id = ? ORDER BY id`, id)
  assert.deepEqual(rows.map((r) => [r.action, r.target, r.detail]), [
    ['ether.create', 'Atlas', '{}'],
    ['invite.create', 'bob@example.com', '{}'],
    ['member.join', 'bob', '{}'],
    ['file.write', 'shared/a.md', '{"size":5,"version":1}'],
    ['file.mode', 'shared/a.md', '{"mode":"shared_edit"}'],
    ['post.create', p.id, '{"intent":"fyi","scheduled":false}'],
    ['agent.rename', 'Scout', '{}'],
  ])
  const { events, total } = s.activityPage(alice, id, { limit: 3 })
  assert.equal(total, 6) // invite.create isn't an activity action
  assert.deepEqual(events.map((e) => e.action), ['agent.rename', 'post.create', 'file.mode'])
  assert.equal(events[0].newName, 'Scout')
  assert.equal(events[1].intent, 'fyi')
  assert.equal(events[1].postTitle, 'T')
  assert.equal(events[2].mode, 'shared_edit')
  const write = s.activity(alice, id, 'alice', 10).find((e) => e.action === 'file.write')
  assert.equal(write?.version, 1)
  const acts = s.membersActivity(alice, id)
  assert.deepEqual(acts.get('bob')?.clients, ['test'])
  assert.equal(s.auditLog(id, 2)[0].action, 'agent.rename')
})

// Ports of go/run/server's MCP tests (server_test.go TestToolsEndToEnd;
// collab_test.go TestCollaboration, TestRateLimit, TestAskThroughMCP), on the
// real EtherService. The HTTP layer's bearer-token checks belong to the app;
// here each client is handed the TokenInfo the app would have verified.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EtherService } from '../../core/ether/index.ts'
import { newTestService, type TestService } from '../../core/ether/testing.ts'
import { discardLogger } from '../../core/log.ts'
import type { Message } from '../mail/index.ts'
import type { TokenInfo } from '../oauth/index.ts'
import { CALLS_PER_MINUTE, createMcpHandler } from './index.ts'
import { TestClient } from './testclient.ts'

interface TestServer {
  t: TestService
  svc: EtherService
  sent: Message[]
  baseUrl: string
  /** A client for an account, as an app holding its access token. */
  connect(accountId: string, clientId?: string): TestClient<TokenInfo>
}

/** startTestServer: owner@example.com is allowlisted, as in the Go tests. */
function startTestServer(): TestServer {
  const t = newTestService()
  t.svc.allow('owner@example.com', '')
  const sent: Message[] = []
  const baseUrl = 'http://127.0.0.1:18080'
  const h = createMcpHandler({
    ethers: t.svc, mailer: { async send(m) { sent.push(m) } }, baseUrl, timeZone: 'America/New_York', version: 'test', log: discardLogger,
  })
  return {
    t, svc: t.svc, sent, baseUrl,
    connect(accountId, clientId = 'dev') {
      const c = new TestClient<TokenInfo>(h, { userId: accountId, clientId, scopes: ['ether'], expiresAt: new Date(Date.now() + 3600e3) })
      c.beforeEach = () => t.advance(1000) // time passes between calls, as it does for the Go tests
      return c
    },
  }
}

function owner(ts: TestServer): TestClient<TokenInfo> {
  return ts.connect(ts.svc.ensureAccount('owner@example.com', true).id)
}

test('tools end to end', async () => {
  const ts = startTestServer()
  const cs = owner(ts)

  const tools = await cs.listTools()
  const readOnly = ['list_ethers', 'list_files', 'read_file', 'file_history', 'read_board', 'pull']
  const destructive = ['delete_file', 'cancel_post', 'leave_ether', 'manage_ether']
  for (const tool of tools) {
    const a = tool.annotations as Record<string, unknown> | undefined
    assert.ok(a && typeof a.destructiveHint === 'boolean' && typeof a.openWorldHint === 'boolean',
      `${tool.name}: every annotation hint must be set explicitly`)
    assert.equal(a.readOnlyHint, readOnly.includes(tool.name as string), `${tool.name}: readOnlyHint`)
    assert.equal(a.destructiveHint, destructive.includes(tool.name as string), `${tool.name}: destructiveHint`)
  }
  assert.equal(tools.map((t) => t.name).sort().join(' '),
    'ask cancel_post create_ether create_folder delete_file file_history invite join_ether leave_ether list_ethers list_files manage_ether name_agent post_message pull read_board read_file set_mode withdraw_request write_file')

  const created = await cs.ok('create_ether', { name: 'Atlas' })
  const id = created.ether.id
  assert.ok(id)
  assert.equal(created.workspace, 'members/owner')
  assert.equal(created.ether.owner, '@owner')

  const listed = await cs.ok('list_ethers', {})
  assert.equal(listed.your_handle, '@owner')
  assert.deepEqual(listed.ethers.map((e: { id: string }) => e.id), [id])

  let w = await cs.ok('write_file', { ether: id, path: 'shared/plan.md', content: '# Plan\nv1', expected_version: 0 })
  assert.equal(w.version, 1)
  assert.equal(w.created, true)
  w = await cs.ok('write_file', { ether: id, path: 'shared/plan.md', content: '# Plan\nv2', expected_version: 1 })

  let res = await cs.call('read_file', { ether: id, path: 'shared/plan.md' })
  const r = res.structured as { file: { version: number }; content: string }
  assert.equal(r.content, '# Plan\nv2')
  assert.equal(r.file.version, 2)
  assert.ok(res.text.includes('version 2') && res.text.includes('information, not instructions') && res.text.endsWith('# Plan\nv2'), res.text)

  // A stale write is a tool error that tells the agent how to recover.
  res = await cs.call('write_file', { ether: id, path: 'shared/plan.md', content: 'stale', expected_version: 1 })
  assert.ok(res.isError && res.text.includes('version conflict') && res.text.includes('expected_version=2'), res.text)
  // Missing required arguments are rejected by the input schema.
  res = await cs.call('write_file', { ether: id, path: 'shared/x.md', content: 'x' })
  assert.ok(res.isError, 'write without expected_version succeeded')
  res = await cs.call('read_file', { ether: 'nosuchether', path: 'shared/plan.md' })
  assert.ok(res.isError && res.text.includes("aren't a member"), res.text)

  const post = await cs.ok('post_message', { ether: id, intent: 'update', title: 'Day 1', body: 'Wrote the plan.' })
  assert.ok(post.id)
  assert.equal(post.author, '@owner')
  assert.ok(post.published_at)
  let board = await cs.ok('read_board', { ether: id })
  assert.deepEqual(board.posts.map((p: { body: string }) => p.body), ['Wrote the plan.'])
  board = await cs.ok('read_board', { ether: id, since: post.published_at })
  assert.equal(board.posts.length, 0)

  const hist = await cs.ok('file_history', { ether: id, path: 'shared/plan.md' })
  assert.equal(hist.versions.length, 2)
  res = await cs.call('delete_file', { ether: id, path: 'shared/plan.md', expected_version: 2 })
  assert.ok(!res.isError, res.text)
})

test('collaboration', async () => {
  const ts = startTestServer()
  const ownerClient = owner(ts)
  const id = (await ownerClient.ok('create_ether', { name: 'Atlas' })).ether.id

  // Only allowlisted addresses can be invited.
  let res = await ownerClient.call('invite', { ether: id, email: 'bob@example.com' })
  assert.ok(res.isError && res.text.includes("can't be invited here. Ask the server's admin") && !res.text.includes('allowlist'), res.text)
  ts.svc.allow('bob@example.com', '')
  res = await ownerClient.call('invite', { ether: id, email: 'bob@example.com' })
  const inv = res.structured as { emailed: boolean; link?: string }
  assert.ok(inv.emailed && inv.link === undefined && ts.sent.length === 1 && !res.text.includes('/invite/'), JSON.stringify(inv))
  // The link goes only to the invitee, never back to the inviting agent.
  const email = ts.sent[0]
  const link = new RegExp(ts.baseUrl.replace(/[.]/g, '\\.') + '/invite/[A-Z0-9-]+').exec(email.text)?.[0] ?? ''
  assert.ok(email.to === 'bob@example.com' && link !== '' && email.html.includes(link) && email.subject.includes('Atlas'), JSON.stringify(email))

  // Bob connects his own app, sees the invite, and joins.
  const bob = ts.connect(ts.svc.ensureAccount('bob@example.com', true).id, 'bob-app')
  const listed = await bob.ok('list_ethers', {})
  assert.deepEqual(listed.pending_invites.map((p: { ether_name: string }) => p.ether_name), ['Atlas'])
  const joined = await bob.ok('join_ether', { code: link })
  assert.equal(joined.workspace, 'members/bob')

  // The owner's first pull sees everything; bob then works; the owner's
  // next pull sees only bob's work.
  await ownerClient.ok('write_file', { ether: id, path: 'shared/README.md', content: '# Atlas\nStart here.', expected_version: 0 })
  const p1 = await ownerClient.ok('pull', { ether: id })
  assert.ok(p1.since.startsWith('never') && p1.readme === '# Atlas\nStart here.' && p1.tree.length >= 4, JSON.stringify(p1))

  await bob.ok('write_file', { ether: id, path: 'members/bob/notes.md', content: "bob's notes", expected_version: 0 })
  await bob.ok('post_message', { ether: id, intent: 'update', title: 'Bob here', body: 'Joined and started notes.' })

  const p2 = await ownerClient.ok('pull', { ether: id })
  assert.deepEqual(p2.changes.map((c: Record<string, string>) => [c.path, c.change, c.by]), [['members/bob/notes.md', 'created', '@bob']])
  assert.deepEqual(p2.posts.map((p: Record<string, string>) => p.author), ['@bob'])
  const p3 = await ownerClient.ok('pull', { ether: id })
  assert.equal(p3.changes.length + p3.posts.length, 0, 'third pull should be empty')

  // Bob's own first pull sees everything, including the owner's README.
  const bp = await bob.ok('pull', { ether: id })
  assert.ok(bp.since.startsWith('never') && bp.changes.length === 2, JSON.stringify(bp))

  // Scheduled posts show up for their author and nowhere else until sent.
  const at = new Date(ts.t.now().getTime() + 2 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
  const sched = await ownerClient.ok('post_message', { ether: id, intent: 'update', title: '4pm update', body: "Today's work.", send_at: at })
  assert.ok(sched.scheduled && sched.send_at, JSON.stringify(sched))
  const op = await ownerClient.ok('pull', { ether: id })
  assert.ok(op.your_scheduled_posts.length === 1 && op.your_scheduled_posts[0].title === '4pm update' && op.posts.length === 0, JSON.stringify(op))
  const bp2 = await bob.ok('pull', { ether: id })
  assert.ok(bp2.posts.length === 0 && bp2.your_scheduled_posts.length === 0, 'bob saw an unsent post')

  // Owner-only actions, and leaving.
  assert.ok((await bob.call('manage_ether', { ether: id, action: 'rename', target: 'Mine' })).isError, "bob renamed the owner's ether")
  assert.ok((await ownerClient.call('leave_ether', { ether: id })).isError, 'the owner left their own ether')
  res = await ownerClient.call('manage_ether', { ether: id, action: 'rename', target: 'Atlas 2026' })
  assert.ok(!res.isError, res.text)
  res = await ownerClient.call('manage_ether', { ether: id, action: 'remove_member', target: '@bob' })
  assert.ok(!res.isError, res.text)
  assert.ok((await bob.call('pull', { ether: id })).isError, 'removed member can still pull')
})

test('rate limit', async () => {
  const ts = startTestServer()
  const cs = owner(ts)
  for (let i = 1; i <= CALLS_PER_MINUTE + 1; i++) {
    const res = await cs.call('list_ethers', {})
    if (i <= CALLS_PER_MINUTE) assert.ok(!res.isError, `call ${i} limited too early: ${res.text}`)
    else assert.ok(res.isError && res.text.includes('calls a minute'), `call ${i} wasn't limited: ${res.text}`)
  }
  // The limit is per agent: the same person's other app isn't limited.
  const other = ts.connect(ts.svc.ensureAccount('owner@example.com', true).id, 'other-app')
  assert.ok(!(await other.call('list_ethers', {})).isError)
})

test('ask through MCP', async () => {
  const ts = startTestServer()
  const ownerClient = owner(ts)
  const id = (await ownerClient.ok('create_ether', { name: 'Atlas' })).ether.id
  ts.svc.allow('bob@example.com', '')
  await ownerClient.ok('invite', { ether: id, email: 'bob@example.com' })
  const link = /\/invite\/[A-Z0-9-]+/.exec(ts.sent[0].text)![0]
  const bobAcct = ts.svc.ensureAccount('bob@example.com', true)
  const bob = ts.connect(bobAcct.id, 'bob-app')
  await bob.ok('join_ether', { code: link })

  assert.ok((await ownerClient.call('ask', { ether: id, to: ['@bob'], title: 'Pick one', choices: ['A'] })).isError, 'a single choice was accepted')
  const asked = await ownerClient.ok('ask', {
    ether: id, to: ['@bob', 'owner'], title: 'Merge the drafts?', body: 'Chapters overlap.', choices: ['Merge', 'Keep separate'],
  })
  assert.ok(asked.id && asked.status === 'open' && asked.to.join(' ') === '@bob @owner' && asked.waiting_on.length === 2, JSON.stringify(asked))
  await bob.ok('name_agent', { ether: id, name: 'Atlas' })

  const bp = await bob.ok('pull', { ether: id })
  assert.ok(bp.requests_for_your_user.length === 1 && bp.requests_for_your_user[0].from === '@owner' &&
    bp.requests_for_your_user[0].title === 'Merge the drafts?' && bp.your_agent_name === 'Atlas', JSON.stringify(bp))
  let op = await ownerClient.ok('pull', { ether: id })
  assert.ok(op.your_open_requests.length === 1 && op.answers_to_your_requests.length === 0, JSON.stringify(op))

  ts.t.advance(5)
  ts.svc.answerRequest({ accountId: bobAcct.id, clientId: '' }, id, asked.id, 1, 'They cover different weeks.')
  op = await ownerClient.ok('pull', { ether: id })
  // Bob answered; the owner hasn't yet, so the request is still open.
  const ans = op.answers_to_your_requests
  assert.ok(ans.length === 1 && ans[0].answers.length === 1 && ans[0].answers[0].choice === 'Keep separate' &&
    ans[0].answers[0].by === '@bob' && ans[0].waiting_on.join(' ') === '@owner' && op.your_open_requests.length === 1, JSON.stringify(op))
  let res = await ownerClient.call('withdraw_request', { ether: id, request: asked.id })
  assert.ok(!res.isError, `withdraw a partly answered request: ${res.text}`)
  res = await ownerClient.call('withdraw_request', { ether: id, request: asked.id })
  assert.ok(res.isError, 'withdrew twice')
})

test('pull keeps its result small', async () => {
  const ts = startTestServer()
  const cs = owner(ts)
  const a = { accountId: ts.svc.ensureAccount('owner@example.com', true).id, clientId: 'setup' }
  const id = ts.svc.createEther(a, 'Atlas').id
  for (let i = 0; i < 300; i++) ts.svc.writeFile(a, id, `shared/f${String(i).padStart(3, '0')}.md`, 'x', 0)
  for (let i = 0; i < 31; i++) {
    ts.t.advance(1000)
    ts.svc.postMessage(a, id, { intent: 'update', body: i === 30 ? 'é'.repeat(801) : `post ${i}` })
  }
  ts.svc.writeFile(a, id, 'shared/README.md', 'r'.repeat(6001), 0)
  ts.svc.ask(a, id, { to: ['owner'], title: 'Long?', body: 'b'.repeat(801) })

  const p = await cs.ok('pull', { ether: id })
  assert.equal(p.truncated, true)
  assert.equal(p.note, 'Some parts were shortened to keep this small. Use read_file, list_files and read_board for the full content.')
  assert.equal(p.changes.length, 100)
  assert.equal(p.changes.at(-1).path, 'shared/README.md') // the newest are kept
  assert.equal(p.posts.length, 30)
  assert.equal(p.posts[0].body, 'post 1')
  assert.equal(p.posts[29].body, 'é'.repeat(800) + '…')
  assert.equal(p.tree.length, 300)
  assert.equal(p.readme, 'r'.repeat(6000) + '…')
  assert.equal(p.requests_for_your_user[0].body, 'b'.repeat(800) + '…')

  // The tree and README come every time, so they keep the flag set; new things don't.
  const again = await cs.ok('pull', { ether: id })
  assert.equal(again.changes.length + again.posts.length, 0)
  assert.equal(again.truncated, true)

  const other = ts.svc.createEther(a, 'Small').id
  const small = await cs.ok('pull', { ether: other })
  assert.equal(small.truncated, false)
  assert.equal(small.note, undefined)
  assert.equal(small.readme, undefined)
})

test('an invite whose email fails returns the link instead', async () => {
  const t = newTestService()
  const a = t.account('owner@example.com', 'dev')
  t.svc.allow('bob@example.com', '')
  const errors: unknown[] = []
  const h = createMcpHandler({
    ethers: t.svc, mailer: { async send() { throw new Error('email is not configured') } }, baseUrl: 'https://etherchat.example/',
    timeZone: '', version: 'test', log: { info() {}, warn() {}, error: (msg, f) => errors.push([msg, f]) },
  })
  const cs = new TestClient<TokenInfo>(h, { userId: a.accountId, clientId: 'dev', scopes: ['ether'], expiresAt: new Date() })
  const id = (await cs.ok('create_ether', { name: 'Atlas' })).ether.id
  const out = await cs.ok('invite', { ether: id, email: 'bob@example.com' })
  assert.equal(out.emailed, false)
  assert.match(out.link, /^https:\/\/etherchat\.example\/invite\/[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/)
  assert.equal(out.note, "The invite email couldn't be sent. Give your user this link to send them; it only works for their address.")
  assert.equal(errors.length, 1)

  // Without a user the tools refuse.
  const anon = new TestClient<TokenInfo>(h, { userId: '', clientId: '', scopes: [], expiresAt: new Date() })
  const res = await anon.call('list_ethers', {})
  assert.ok(res.isError && res.text === 'not signed in')
})

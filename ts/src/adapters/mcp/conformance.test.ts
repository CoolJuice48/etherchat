// Replays requests recorded against the Go server (etherd's handler, with the
// Go MCP SDK) and compares what came back. testdata/ holds the recordings:
//
//   go-tools-list.json  the tools/list result's tools, byte for byte
//   go-protocol.json    155 protocol cases: statuses, headers, bodies
//   go-scenario.json    every tool, in one session, with ids and times normalized
//
// Bodies are compared as parsed JSON. Two cases aren't recorded: HEAD (the
// HTTP server drops the body) and a request ID beyond 2^63 (Go saturates it to
// int64; JavaScript numbers can't). Batch responses are compared without
// regard to order, which the Go server doesn't fix either.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { newTestService } from '../../core/ether/testing.ts'
import { discardLogger } from '../../core/log.ts'
import type { Message } from '../mail/index.ts'
import type { TokenInfo } from '../oauth/index.ts'
import { createMcpHandler } from './index.ts'
import { ACCEPT } from './testclient.ts'

const testdata = new URL('./testdata/', import.meta.url)
const load = (name: string) => JSON.parse(readFileSync(new URL(name, testdata), 'utf8'))

/** A server like the Go recordings': account owner@example.com on client "dev", bob allowlisted. */
function setup() {
  const t = newTestService()
  const owner = t.account('owner@example.com', 'dev')
  t.svc.allow('bob@example.com', '')
  const sent: Message[] = []
  const h = createMcpHandler({
    ethers: t.svc, mailer: { async send(m) { sent.push(m) } }, baseUrl: 'http://127.0.0.1:18765',
    timeZone: 'America/New_York', version: 'test', log: discardLogger,
  })
  const token: TokenInfo = { userId: owner.accountId, clientId: 'dev', scopes: ['ether'], expiresAt: new Date(Date.now() + 3600e3) }
  return { t, h, token, sent }
}

test('tools/list is the Go server\'s, byte for byte', async () => {
  const { h, token } = setup()
  const res = await h(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, 'Mcp-Protocol-Version': '2025-06-18' },
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  }), token)
  const body = await res.json() as { result: { tools: unknown[] } }
  assert.equal(JSON.stringify(body.result.tools), JSON.stringify(load('go-tools-list.json')))
})

test('protocol cases match the Go server', async () => {
  const { h, token } = setup()
  const tools = JSON.stringify(load('go-tools-list.json'))
  const instructions = JSON.stringify((await import('./mcpserver.ts')).INSTRUCTIONS)
  const cases = load('go-protocol.json') as {
    name: string
    request: { method: string; headers: Record<string, string>; body?: string }
    response: { status: number; headers: Record<string, string>; body: string }
  }[]
  assert.equal(cases.length, 155)
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }
  const sortBatch = (v: unknown) => Array.isArray(v) ? [...v].sort((a, b) => String(a.id).localeCompare(String(b.id))) : v
  for (const c of cases) {
    const res = await h(new Request('http://localhost/mcp', { method: c.request.method, headers: c.request.headers, body: c.request.body }), token)
    assert.equal(res.status, c.response.status, `${c.name}: status`)
    for (const k of ['content-type', 'allow', 'cache-control', 'mcp-session-id', 'connection']) {
      assert.equal(res.headers.get(k) ?? undefined, c.response.headers[k], `${c.name}: ${k}`)
    }
    const want = c.response.body.split('"$TOOLS"').join(tools).split('"$INSTRUCTIONS"').join(instructions)
    assert.deepEqual(sortBatch(parse(await res.text())), sortBatch(parse(want)), `${c.name}: body`)
  }
})

test('a session using every tool matches the Go server', async () => {
  const { t, h, token } = setup()
  const second = 1000
  let n = 0
  const out: unknown[] = []
  const send = (body: string, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    t.advance(second)
    return h(new Request('http://localhost/mcp', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers }, body,
    }), token)
  }
  const call = async (label: string, name: string, args: unknown) => {
    const res = await send(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      { 'Mcp-Protocol-Version': '2025-06-18' })
    const j = await res.json() as { result?: { structuredContent?: Record<string, any> } }
    out.push([label, res.status, j])
    return j.result?.structuredContent as Record<string, any>
  }

  const created = await call('create', 'create_ether', { name: 'Atlas <&> "q"' })
  const id = created.ether.id
  await call('create-bad', 'create_ether', { name: '' })
  await call('list_ethers', 'list_ethers', {})
  await call('write1', 'write_file', { ether: id, path: 'shared/plan.md', content: '# Plan\nv1 <b>&amp;</b> \u2028 é', expected_version: 0 })
  await call('write2', 'write_file', { ether: id, path: 'shared/plan.md', content: '# Plan\nv2', expected_version: 1 })
  await call('write-stale', 'write_file', { ether: id, path: 'shared/plan.md', content: 'stale', expected_version: 1 })
  await call('write-new-stale', 'write_file', { ether: id, path: 'shared/new.md', content: 'x', expected_version: 3 })
  await call('write-bad-ext', 'write_file', { ether: id, path: 'shared/x.exe', content: 'x', expected_version: 0 })
  await call('write-bad-mode', 'write_file', { ether: id, path: 'shared/m.md', content: 'x', expected_version: 0, mode: 'bogus' })
  await call('write-mode', 'write_file', { ether: id, path: 'shared/m.md', content: 'x', expected_version: 0, mode: 'shared_edit' })
  await call('write-ws', 'write_file', { ether: id, path: 'members/owner/notes.md', content: 'mine', expected_version: 0 })
  await call('read', 'read_file', { ether: id, path: 'shared/plan.md' })
  await call('read-v1', 'read_file', { ether: id, path: 'shared/plan.md', version: 1 })
  await call('read-folder', 'read_file', { ether: id, path: 'shared' })
  await call('read-missing', 'read_file', { ether: id, path: 'shared/none.md' })
  await call('list-top', 'list_files', { ether: id })
  await call('list-rec', 'list_files', { ether: id, path: 'shared', recursive: true })
  await call('history', 'file_history', { ether: id, path: 'shared/plan.md' })
  await call('folder', 'create_folder', { ether: id, path: 'shared/docs/sub' })
  await call('set-mode', 'set_mode', { ether: id, path: 'shared/plan.md', mode: 'shared_edit' })
  await call('set-mode-bad', 'set_mode', { ether: id, path: 'shared/plan.md', mode: 'x' })
  await call('set-mode-ws', 'set_mode', { ether: id, path: 'members/owner/notes.md', mode: 'shared_edit' })
  await call('delete-stale', 'delete_file', { ether: id, path: 'shared/m.md', expected_version: 5 })
  await call('delete', 'delete_file', { ether: id, path: 'shared/m.md', expected_version: 1 })
  await call('delete-folder-nonempty', 'delete_file', { ether: id, path: 'shared/docs', expected_version: 0 })
  await call('history-deleted', 'file_history', { ether: id, path: 'shared/m.md' })
  const post = await call('post', 'post_message', { ether: id, intent: 'update', title: 'Day 1', body: 'Wrote <the> plan.' })
  await call('post-bad-intent', 'post_message', { ether: id, intent: 'gossip', body: 'x' })
  await call('post-empty', 'post_message', { ether: id, intent: 'fyi', body: '  ' })
  await call('post-reply', 'post_message', { ether: id, intent: 'fyi', body: 'reply', reply_to: post.id })
  await call('post-bad-sendat', 'post_message', { ether: id, intent: 'fyi', body: 'x', send_at: 'tomorrow' })
  const at = new Date(t.now().getTime() + 2 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
  const sched = await call('post-sched', 'post_message', { ether: id, intent: 'update', title: '4pm', body: 'later', send_at: at })
  await call('post-sched-far', 'post_message', { ether: id, intent: 'update', body: 'later', send_at: '2099-01-01T00:00:00Z' })
  await call('board', 'read_board', { ether: id })
  await call('board-since', 'read_board', { ether: id, since: post.published_at })
  await call('board-limit', 'read_board', { ether: id, limit: 1 })
  await call('board-bad-since', 'read_board', { ether: id, since: '2026-13-01T00:00:00Z' })
  await call('pull1', 'pull', { ether: id })
  await call('pull2', 'pull', { ether: id })
  await call('pull-epoch', 'pull', { ether: id, since: '1970-01-01T00:00:00Z' })
  await call('pull-bad', 'pull', { ether: id, since: 'x' })
  await call('cancel', 'cancel_post', { ether: id, post_id: sched.id })
  await call('cancel-again', 'cancel_post', { ether: id, post_id: sched.id })
  await call('invite-notallowed', 'invite', { ether: id, email: 'zed@example.com' })
  await call('invite-bad', 'invite', { ether: id, email: 'not an email' })
  await call('invite', 'invite', { ether: id, email: 'bob@example.com' })
  await call('join-bad', 'join_ether', { code: 'http://x/invite/AAAA-BBBB-CCCC-DDDD' })
  await call('ask-one', 'ask', { ether: id, to: ['owner'], title: 'Pick', choices: ['A'] })
  const asked = await call('ask', 'ask', { ether: id, to: ['@owner'], title: 'Merge?', body: 'Chapters <overlap>.', choices: ['Merge', 'Keep'] })
  await call('ask-nobody', 'ask', { ether: id, to: ['@nobody'], title: 'x' })
  await call('ask-null', 'ask', { ether: id, to: null, title: 'x' })
  await call('name', 'name_agent', { ether: id, name: '  Atlas   Bot ' })
  await call('name-bad', 'name_agent', { ether: id, name: '@x' })
  await call('pull3', 'pull', { ether: id })
  await call('name-clear', 'name_agent', { ether: id, name: ' ' })
  await call('withdraw', 'withdraw_request', { ether: id, request: asked.id })
  await call('withdraw-again', 'withdraw_request', { ether: id, request: asked.id })
  await call('manage-bad', 'manage_ether', { ether: id, action: 'explode' })
  await call('manage-rename', 'manage_ether', { ether: id, action: 'rename', target: '  Atlas 2026 ' })
  await call('manage-revoke', 'manage_ether', { ether: id, action: 'revoke_invite', target: 'bob@example.com' })
  await call('manage-revoke-none', 'manage_ether', { ether: id, action: 'revoke_invite', target: 'bob@example.com' })
  await call('manage-remove-self', 'manage_ether', { ether: id, action: 'remove_member', target: '@owner' })
  await call('leave-owner', 'leave_ether', { ether: id })
  await call('manage-delete', 'manage_ether', { ether: id, action: 'delete' })
  await call('list-after-delete', 'list_ethers', {})

  const listen = (id: number, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params })
  const newHeaders = { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen' }
  const newMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
  for (const [label, params] of [['listen-none', { notifications: {} }], ['listen-missing', {}]] as const) {
    const res = await send(listen(77, params))
    out.push([label, res.status, `${res.headers.get('content-type')} | ${res.headers.get('cache-control')} | ${await res.text()}`])
  }
  {
    const ctl = new AbortController()
    const res = await send(listen(78, { _meta: newMeta, notifications: { toolsListChanged: true, promptsListChanged: true } }), newHeaders, ctl.signal)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    out.push(['listen-hold', res.status, `${res.headers.get('content-type')} | ${new TextDecoder().decode(value)}`])
    ctl.abort()
  }
  {
    const res = await send(listen(79, { _meta: newMeta }), newHeaders)
    out.push(['listen-new-missing', res.status, `${res.headers.get('content-type')} | ${await res.text()}`])
  }

  const ids = new Map<string, string>()
  const got = JSON.stringify(out, null, 1)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TIME')
    .replace(/\b[a-z2-7]{16}\b/g, (m) => {
      if (!ids.has(m)) ids.set(m, 'ID' + ids.size)
      return ids.get(m)!
    })
    .replace(/[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/g, 'CODE')
  const want = readFileSync(new URL('go-scenario.json', testdata), 'utf8').trimEnd()
  const gotSteps = JSON.parse(got) as unknown[][]
  const wantSteps = JSON.parse(want) as unknown[][]
  assert.equal(gotSteps.length, wantSteps.length)
  for (let i = 0; i < wantSteps.length; i++) assert.deepEqual(gotSteps[i], wantSteps[i], String(wantSteps[i][0]))
})

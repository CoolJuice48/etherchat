// The protocol layer on its own, with two fake tools: what a client sees
// from the Go SDK's stateless, JSON-response Streamable HTTP handler.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as z from 'zod'
import { discardLogger } from '../../core/log.ts'
import { createStatelessServer, defineTool, JsonRpcError, MAX_REQUEST_BODY_BYTES } from './protocol.ts'
import { ACCEPT, post, TestClient } from './testclient.ts'

// A JSON-RPC reply as these tests read it.
type Rpc = { result?: any; error?: any }
const reply = async (res: Response): Promise<Rpc> => (await res.json()) as Rpc

interface Ctx {
  user: string
}

const annotations = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true }

const echo = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Echoes its input.',
  annotations,
  input: z.strictObject({
    text: z.string().describe('what to say'),
    times: z.int().optional().describe('how often'),
    tags: z.array(z.string()).nullable().optional(),
  }),
  output: z.strictObject({ said: z.string(), user: z.string(), zz: z.string() }),
  goStruct: 'echoIn',
  async handler(input, ctx: Ctx) {
    if (input.text === 'fail') throw new Error('it failed')
    if (input.text === 'protocol') throw new JsonRpcError(-32603, 'boom')
    return { output: { zz: 'last', said: input.text.repeat(input.times ?? 1), user: ctx.user } }
  },
})

const header = defineTool({
  name: 'header',
  title: 'Header',
  description: 'Returns its own content.',
  annotations,
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  async handler() {
    return { output: { ok: true }, content: [{ type: 'text', text: 'custom' }] }
  },
})

const h = createStatelessServer<Ctx>({
  impl: { name: 'fake', title: 'Fake', version: '1.2.3' },
  instructions: 'Use <tools> & enjoy.',
  tools: [header, echo],
  log: discardLogger,
})
const ctx: Ctx = { user: 'alice' }

const NEW = '2026-07-28'
const meta = { 'io.modelcontextprotocol/protocolVersion': NEW, 'io.modelcontextprotocol/clientCapabilities': {} }
const serverInfo = { name: 'fake', title: 'Fake', version: '1.2.3' }

function rpc(method: string, params?: unknown, id: unknown = 1): string {
  const m: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) m.params = params
  return JSON.stringify(m)
}

function newHeaders(method: string, name?: string): Record<string, string> {
  const hd: Record<string, string> = { 'Mcp-Protocol-Version': NEW, 'Mcp-Method': method }
  if (name) hd['Mcp-Name'] = name
  return hd
}

test('HTTP methods and headers', async () => {
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const res = await h(new Request('http://localhost/mcp', { method, headers: { Accept: ACCEPT } }), ctx)
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'POST')
    assert.equal(await res.text(), 'Method Not Allowed\n')
  }
  // An unsupported version header is refused before the method is looked at.
  let res = await h(new Request('http://localhost/mcp', { headers: { 'Mcp-Protocol-Version': '2020-01-01' } }), ctx)
  assert.equal(res.status, 400)
  assert.equal(await res.text(), 'Bad Request: Unsupported protocol version (supported versions: 2026-07-28,2025-11-25,2025-06-18,2025-03-26,2024-11-05)\n')

  res = await post(h, ctx, rpc('ping'), { 'Content-Type': 'text/plain' })
  assert.equal(res.status, 415)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await res.text(), "Content-Type must be 'application/json'\n")
  res = await post(h, ctx, rpc('ping'), { 'Content-Type': 'Application/JSON; charset=utf-8' })
  assert.equal(res.status, 200)

  res = await post(h, ctx, rpc('ping'), { Accept: 'application/json' })
  assert.equal(res.status, 400)
  assert.equal(await res.text(), "Accept must contain both 'application/json' and 'text/event-stream'\n")
  res = await post(h, ctx, rpc('ping'), { Accept: '*/*' })
  assert.equal(res.status, 200)

  res = await post(h, ctx, ' '.repeat(MAX_REQUEST_BODY_BYTES + 1))
  assert.equal(res.status, 413)
  assert.equal(await res.text(), `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes\n`)

  res = await post(h, ctx, '')
  assert.equal(res.status, 400)
  assert.equal(await res.text(), 'POST requires a non-empty body\n')
  res = await post(h, ctx, '{"jsonrpc":"1.0","id":1,"method":"ping"}')
  assert.equal(await res.text(), 'malformed payload: invalid message version tag "1.0"; expected "2.0"\n')
  res = await post(h, ctx, rpc('ping'), { 'Last-Event-ID': 'x_1' })
  assert.equal(res.status, 400)
})

test('initialize negotiates the version; ping; notifications', async () => {
  const init = async (version: string) => {
    const res = await post(h, ctx, rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'c', version: '1' } }))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json')
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(res.headers.get('mcp-session-id'), null) // stateless: no sessions
    return (await reply(res)).result
  }
  assert.deepEqual(await init('2025-06-18'), {
    capabilities: { logging: {}, tools: { listChanged: true } },
    instructions: 'Use <tools> & enjoy.',
    protocolVersion: '2025-06-18',
    serverInfo,
  })
  assert.equal((await init('2024-11-05')).protocolVersion, '2024-11-05')
  assert.equal((await init('2026-07-28')).protocolVersion, '2025-11-25') // initialize is legacy
  assert.equal((await init('1999-01-01')).protocolVersion, '2025-11-25')

  let res = await post(h, ctx, rpc('ping', undefined, 'abc'))
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 'abc', result: {} })

  res = await post(h, ctx, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  assert.equal(res.status, 202)
  assert.equal(await res.text(), '')
  res = await post(h, ctx, JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} }))
  assert.equal(res.status, 202)

  res = await post(h, ctx, rpc('foo/bar'))
  assert.equal(res.status, 400)
  assert.equal(await res.text(), 'JSON RPC not handled: "foo/bar" unsupported\n')
  res = await post(h, ctx, JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }))
  assert.equal(await res.text(), 'invalid request: missing id for "tools/list"\n')
  res = await post(h, ctx, rpc('tools/call'))
  assert.equal(await res.text(), 'invalid request: missing required "params"\n')

  // Every -32601 reads "method not found".
  res = await post(h, ctx, rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: 'b' } }))
  assert.deepEqual((await reply(res)).error, { code: -32601, message: 'method not found: "completion/complete"' })
  res = await post(h, ctx, rpc('server/discover'))
  assert.deepEqual((await reply(res)).error, { code: -32601, message: 'method not found: "server/discover"' })
})

test('tools/list', async () => {
  const c = new TestClient(h, ctx)
  const { body } = await c.rpc('tools/list')
  const r = body.result as Record<string, unknown>
  assert.equal(r.ttlMs, 0)
  assert.equal(r.cacheScope, 'public')
  const tools = r.tools as Record<string, unknown>[]
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'header']) // sorted
  assert.deepEqual(Object.keys(tools[0]), ['annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title'])
  assert.deepEqual(tools[0].inputSchema, {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'what to say' },
      times: { type: 'integer', description: 'how often' },
      tags: { type: ['null', 'array'], items: { type: 'string' } },
    },
    required: ['text'],
    additionalProperties: false,
  })
  assert.deepEqual(tools[0].annotations, annotations)
  const cursor = await c.rpc('tools/list', { cursor: 'abc' })
  assert.deepEqual(cursor.body.error, { code: -32602, message: 'invalid params' })
})

test('tools/call results and errors', async () => {
  const c = new TestClient(h, ctx)
  let r = await c.call('echo', { text: '<a>', times: 2 })
  assert.equal(r.isError, false)
  assert.deepEqual(r.structured, { said: '<a><a>', user: 'alice', zz: 'last' })
  // The text is Go's json.Marshal of the output: sorted keys, HTML-safe escapes.
  assert.equal(r.text, '{"said":"\\u003ca\\u003e\\u003ca\\u003e","user":"alice","zz":"last"}')
  assert.deepEqual(Object.keys(r.raw), ['content', 'structuredContent'])

  r = await c.call('header', {})
  assert.equal(r.text, 'custom')
  assert.deepEqual(r.structured, { ok: true })

  r = await c.call('echo', { text: 'fail' })
  assert.deepEqual(r.raw, { content: [{ type: 'text', text: 'it failed' }], isError: true })

  r = await c.call('echo', {})
  assert.equal(r.text, 'validating "arguments": validating root: required: missing properties: ["text"]')
  r = await c.call('echo', { text: 'x', extra: 1 })
  assert.equal(r.text, 'validating "arguments": validating root: unexpected additional properties ["extra"]')
  r = await c.call('echo', { text: 'x', times: 1e30 })
  assert.equal(r.text, 'json: cannot unmarshal "1e+30" into Go struct field mcpserver.echoIn.times of type int64')
  const { body } = await c.rpc('tools/call', { name: 'echo', arguments: [] })
  assert.equal((body.result as { isError: boolean }).isError, true)

  let res = await c.rpc('tools/call', { name: 'nope' })
  assert.deepEqual(res.body.error, { code: -32602, message: 'unknown tool "nope"' })
  res = await c.rpc('tools/call', { name: 'echo', arguments: { text: 'protocol' } })
  assert.deepEqual(res.body.error, { code: -32603, message: 'boom' })
  res = await c.rpc('tools/call', null)
  assert.deepEqual(res.body.error, { code: -32600, message: `handling 'tools/call': invalid request: missing required "params"` })
})

test('batches', async () => {
  let res = await post(h, ctx, JSON.stringify([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } },
  ]))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'unknown tool "nope"' } },
  ])
  res = await post(h, ctx, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))
  assert.deepEqual(await res.json(), [{ jsonrpc: '2.0', id: 1, result: {} }]) // a batch stays an array
  res = await post(h, ctx, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), { 'Mcp-Protocol-Version': '2025-06-18' })
  assert.equal(res.status, 400)
  assert.equal(await res.text(), 'JSON-RPC batching is not supported in 2025-06-18 and later (request version: 2025-06-18)\n')
  res = await post(h, ctx, '[]')
  assert.equal(await res.text(), 'malformed payload: empty batch\n')
})

test('server/discover and the 2026-07-28 protocol', async () => {
  let res = await post(h, ctx, rpc('server/discover', { _meta: meta }), newHeaders('server/discover'))
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.equal(text, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      ttlMs: 0,
      cacheScope: 'public',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { logging: {}, tools: { listChanged: true } },
      instructions: 'Use <tools> & enjoy.',
    },
  }))

  res = await post(h, ctx, rpc('tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta }), newHeaders('tools/call', 'echo'))
  assert.deepEqual(await res.json(), {
    jsonrpc: '2.0',
    id: 1,
    result: {
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      content: [{ type: 'text', text: '{"said":"hi","user":"alice","zz":"last"}' }],
      structuredContent: { said: 'hi', user: 'alice', zz: 'last' },
      resultType: 'complete',
    },
  })

  // Protocol errors carry HTTP statuses on the new protocol.
  const cases: [string, string, unknown, Record<string, string>, number, unknown][] = [
    ['no _meta', 'tools/list', {}, newHeaders('tools/list'), 400,
      { code: -32602, message: 'missing or invalid _meta field "io.modelcontextprotocol/protocolVersion"' }],
    ['no header', 'tools/list', { _meta: meta }, {}, 400,
      { code: -32020, message: 'Mcp-Protocol-Version header is required for requests carrying "io.modelcontextprotocol/protocolVersion"' }],
    ['mismatch', 'tools/list', { _meta: meta }, { ...newHeaders('tools/list'), 'Mcp-Protocol-Version': '2025-06-18' }, 400,
      { code: -32020, message: 'Mcp-Protocol-Version header "2025-06-18" does not match request io.modelcontextprotocol/protocolVersion "2026-07-28"' }],
    ['no Mcp-Method', 'tools/list', { _meta: meta }, { 'Mcp-Protocol-Version': NEW }, 400,
      { code: -32020, message: 'missing required Mcp-Method header' }],
    ['no Mcp-Name', 'tools/call', { name: 'echo', _meta: meta }, newHeaders('tools/call'), 400,
      { code: -32020, message: 'missing required Mcp-Name header for method "tools/call"' }],
    ['no capabilities', 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': NEW } }, newHeaders('tools/list'), 400,
      { code: -32602, message: 'missing or invalid _meta field "io.modelcontextprotocol/clientCapabilities"' }],
    ['ping is gone', 'ping', { _meta: meta }, newHeaders('ping'), 404, { code: -32601, message: 'method not found: "ping"' }],
    ['unknown method', 'foo/bar', { _meta: meta }, newHeaders('foo/bar'), 404,
      { code: -32601, message: 'JSON RPC not handled: "foo/bar" unsupported' }],
    ['unknown tool', 'tools/call', { name: 'nope', _meta: meta }, newHeaders('tools/call', 'nope'), 400,
      { code: -32602, message: 'unknown tool "nope"' }],
  ]
  for (const [label, method, params, hd, status, error] of cases) {
    res = await post(h, ctx, rpc(method, params), hd)
    assert.equal(res.status, status, label)
    assert.deepEqual((await reply(res)).error, error, label)
  }

  const future = { ...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' }
  res = await post(h, ctx, rpc('tools/list', { _meta: future }), { 'Mcp-Protocol-Version': '2027-01-01', 'Mcp-Method': 'tools/list' })
  assert.equal(res.status, 400)
  assert.deepEqual((await reply(res)).error, {
    code: -32022,
    message: 'unsupported protocol version',
    data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: '2027-01-01' },
  })
})

test('subscriptions/listen streams, and holds while subscribed', async () => {
  let res = await post(h, ctx, rpc('subscriptions/listen', { notifications: {} }, 7))
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.equal(await res.text(),
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":7},"notifications":{}}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"_meta":{"io.modelcontextprotocol/subscriptionId":7}}}\n\n')

  const ctl = new AbortController()
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    signal: ctl.signal,
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
    body: rpc('subscriptions/listen', { notifications: { toolsListChanged: true, promptsListChanged: true } }, 8),
  })
  res = await h(req, ctx)
  const reader = res.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.equal(first, 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":8},"notifications":{"toolsListChanged":true}}}\n\n')
  const next = reader.read()
  ctl.abort()
  assert.equal((await next).done, true) // the stream ends when the client goes away
})

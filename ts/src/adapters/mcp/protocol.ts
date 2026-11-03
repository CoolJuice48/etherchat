// A stateless MCP server over Streamable HTTP, with Web-standard Request and
// Response only, so it runs unchanged on Node and Cloudflare Workers.
//
// It reproduces what a client sees from the official Go SDK
// (github.com/modelcontextprotocol/go-sdk v1.8.0) serving an mcp.Server
// through NewStreamableHTTPHandler with Stateless: true and JSONResponse: true:
//
//   - mcp/streamable.go: StreamableHTTPHandler.ServeHTTP, serveStateless,
//     ephemeralConnectOpts, servePOST, streamableAccepts, extractErrorStatus
//     (statuses, headers, batching, 202 for notifications, SEP-2575 checks);
//   - mcp/streamable_headers.go: validateMcpHeaders (Mcp-Method, Mcp-Name);
//   - mcp/server.go: ServerSession.handle (initialization gate, new-protocol
//     method gating), initialize, discover, listTools, callTool, the method
//     table serverMethodInfos;
//   - mcp/shared.go: checkRequest, unmarshalParams, validateRequestMeta,
//     negotiatedVersion, supportedProtocolVersions;
//   - mcp/server.go (toolForErr) and mcp/tool.go (applySchema): argument
//     validation and how tool results and tool errors are built;
//   - internal/jsonrpc2: message decoding, ID rules, the error codes, and the
//     rewrite of every -32601 error to `method not found: "<method>"`.
//
// Each request gets a throwaway session, as in the Go SDK's stateless mode,
// so nothing is kept between requests.

import type * as z from 'zod'
import type { Logger } from '../../core/log.ts'
import { goEscape, goQuote, goSchema, sortKeys, validate, type JsonSchema } from './schema.ts'

// Protocol versions, newest first (shared.go).
export const LATEST_PROTOCOL_VERSION = '2026-07-28'
const V20260728 = '2026-07-28'
const V20251125 = '2025-11-25'
const V20250618 = '2025-06-18'
const V20250326 = '2025-03-26'
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [V20260728, V20251125, V20250618, V20250326, '2024-11-05']

/** StreamableHTTPOptions.MaxRequestBodyBytes's default. */
export const MAX_REQUEST_BODY_BYTES = 4 << 20

// JSON-RPC and MCP error codes (jsonrpc/jsonrpc.go, mcp/shared.go).
export const CODE_INVALID_REQUEST = -32600
export const CODE_METHOD_NOT_FOUND = -32601
export const CODE_INVALID_PARAMS = -32602
export const CODE_INTERNAL_ERROR = -32603
export const CODE_HEADER_MISMATCH = -32020
export const CODE_MISSING_REQUIRED_CLIENT_CAPABILITIES = -32021
export const CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022

// SEP-2575 per-request _meta keys.
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'

/** A JSON-RPC error a handler returns as the response (Go's *jsonrpc.Error). code 0 is a plain Go error. */
export class JsonRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}

export interface Implementation {
  name: string
  title?: string
  version: string
}

/** Every hint is always sent, as the Go server sets each one explicitly. */
export interface ToolAnnotations {
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
  readOnlyHint: boolean
}

/** A tool as tools/list shows it, keys in the Go SDK's order. */
export interface Tool {
  annotations: ToolAnnotations
  description: string
  inputSchema: JsonSchema
  name: string
  outputSchema: JsonSchema
  title: string
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface CallToolResult {
  content: TextContent[]
  structuredContent?: unknown
  isError?: boolean
}

/** A registered tool: its listing and its call handler. */
export interface ServerTool<C> {
  tool: Tool
  /** args is params.arguments as sent (undefined when absent). Throws JsonRpcError for protocol errors. */
  call(args: unknown, ctx: C): Promise<CallToolResult>
}

/** What a typed tool handler returns: the structured output and, optionally, its own content. */
export interface ToolOutput<O> {
  output: O
  content?: TextContent[]
}

export interface ToolSpec<In extends z.ZodObject, Out extends z.ZodType, C> {
  name: string
  title: string
  description: string
  annotations: ToolAnnotations
  /** The arguments. Fields that aren't optional are required, as Go fields without omitempty. */
  input: In
  /** The structured output, which also sets the tool's outputSchema. */
  output: Out
  /** The Go input struct's name, for the json errors Go reports when an integer doesn't fit. */
  goStruct?: string
  /** Go integer fields declared int rather than int64. */
  goInts?: readonly string[]
  /** Throws for a tool error (an isError result with the error's message), or JsonRpcError for a protocol error. */
  handler(input: z.infer<In>, ctx: C): Promise<ToolOutput<z.infer<Out>>>
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const int64Limit = 2 ** 63

/**
 * A tool with typed input and output, like the Go SDK's generic mcp.AddTool:
 * arguments are validated against the input schema (an invalid call is a tool
 * error naming the problem), the output becomes structuredContent and, unless
 * the handler supplies content, a text block of the same JSON.
 */
export function defineTool<In extends z.ZodObject, Out extends z.ZodType, C>(spec: ToolSpec<In, Out, C>): ServerTool<C> {
  const inputSchema = goSchema(spec.input, 'input')
  const outputSchema = goSchema(spec.output, 'output')
  const tool: Tool = {
    annotations: spec.annotations,
    description: spec.description,
    inputSchema,
    name: spec.name,
    outputSchema,
    title: spec.title,
  }
  return {
    tool,
    async call(args, ctx) {
      // applySchema: arguments are unmarshaled into a map (null and absent are {}), then validated.
      let input: unknown = args ?? {}
      if (!isObject(input)) {
        return errorResult(`validating "arguments": unmarshaling arguments: json: cannot unmarshal ${goQuote(JSON.stringify(input))} into Go value of type map[string]interface {}`)
      }
      const invalid = validate(input, inputSchema)
      if (invalid !== undefined) return errorResult(`validating "arguments": ${invalid}`)
      // Unmarshaling into the Go struct: integers must fit the field.
      for (const [k, s] of Object.entries(inputSchema.properties ?? {})) {
        const n = input[k]
        if (s.type === 'integer' && typeof n === 'number' && (n >= int64Limit || n < -int64Limit)) {
          const goType = spec.goInts?.includes(k) ? 'int' : 'int64'
          return errorResult(`json: cannot unmarshal ${goQuote(JSON.stringify(n))} into Go struct field mcpserver.${spec.goStruct ?? 'input'}.${k} of type ${goType}`)
        }
      }
      let res: ToolOutput<z.infer<Out>>
      try {
        res = await spec.handler(input as z.infer<In>, ctx)
      } catch (err) {
        if (err instanceof JsonRpcError) throw err
        return errorResult(err instanceof Error ? err.message : String(err))
      }
      // The output goes through JSON and a map, as in the SDK: keys sorted, HTML-safe escaping.
      const out = sortKeys(res.output)
      const bad = validate(out, outputSchema)
      if (bad !== undefined) throw new JsonRpcError(0, `validating tool output: ${bad}`)
      return {
        content: res.content ?? [{ type: 'text', text: goEscape(JSON.stringify(out)) }],
        structuredContent: out,
      }
    },
  }
}

export interface ServerConfig<C> {
  impl: Implementation
  instructions: string
  tools: ServerTool<C>[]
  log: Logger
}

// ---------------------------------------------------------------------------
// JSON-RPC messages (internal/jsonrpc2/messages.go)

type Id = string | number

interface RequestMsg {
  kind: 'request'
  /** undefined for a notification. */
  id: Id | undefined
  method: string
  params: unknown
  /** The "params" key was present (Go's non-empty json.RawMessage, null included). */
  hasParams: boolean
}

interface ResponseMsg {
  kind: 'response'
  id: Id
}

type Message = RequestMsg | ResponseMsg

interface Outgoing {
  jsonrpc: '2.0'
  id?: Id
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Go's %T of a decoded JSON value. */
function goTypeName(v: unknown): string {
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return 'float64'
  if (typeof v === 'string') return 'string'
  if (Array.isArray(v)) return '[]interface {}'
  return 'map[string]interface {}'
}

function makeId(v: unknown): Id | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number') return Math.trunc(v) + 0 // Int64ID(int64(f)); +0 turns -0 into 0
  if (typeof v === 'string') return v
  throw `parse error: invalid ID type ${goTypeName(v)}`
}

function decodeMessage(v: unknown): Message {
  if (!isObject(v)) {
    throw `unmarshaling jsonrpc message: json: cannot unmarshal ${goQuote(JSON.stringify(v))} into Go value of type jsonrpc2.wireDecode`
  }
  const tag = v.jsonrpc ?? ''
  if (typeof tag !== 'string') {
    throw `unmarshaling jsonrpc message: json: cannot unmarshal ${goQuote(JSON.stringify(tag))} into Go struct field wireDecode.jsonrpc of type string`
  }
  if (tag !== '2.0') throw `invalid message version tag ${goQuote(tag)}; expected "2.0"`
  const id = makeId(v.id)
  if (Object.hasOwn(v, 'method')) {
    const method = v.method ?? ''
    if (typeof method !== 'string') {
      throw `unmarshaling jsonrpc message: json: cannot unmarshal ${goQuote(JSON.stringify(method))} into Go value of type string`
    }
    return { kind: 'request', id, method, params: v.params, hasParams: Object.hasOwn(v, 'params') }
  }
  if (id === undefined) throw 'invalid request'
  return { kind: 'response', id }
}

/** readBatch: an array is a batch, anything else one message. Throws the error text. */
function readBatch(text: string): { msgs: Message[]; isBatch: boolean } {
  const v = parseFirstValue(text)
  if (Array.isArray(v)) {
    if (v.length === 0) throw 'empty batch'
    return { msgs: v.map(decodeMessage), isBatch: true }
  }
  return { msgs: [decodeMessage(v)], isBatch: false }
}

/**
 * Parses the first JSON value in text. Like the SDK's json.Decoder, it
 * ignores anything after a complete top-level object or array.
 */
function parseFirstValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    const end = firstValueEnd(text)
    if (end > 0 && end < text.length) {
      try {
        return JSON.parse(text.slice(0, end))
      } catch {
        // report the original error
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw `unmarshaling jsonrpc message: ${msg.startsWith('Unexpected end of JSON input') ? 'unexpected EOF' : msg}`
  }
}

/** The index just past the top-level object or array text starts with, or -1. */
function firstValueEnd(text: string): number {
  let i = 0
  while (i < text.length && ' \t\r\n'.includes(text[i])) i++
  if (text[i] !== '{' && text[i] !== '[') return -1
  let depth = 0
  let inString = false
  for (; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// The method table (serverMethodInfos) and params decoding

type FieldKind = 'string' | 'object' | 'bool' | 'any'

interface MethodInfo {
  notification?: true
  /** missingParamsOK: params may be absent or null. */
  optional?: true
  goType: string
  fields: Record<string, [FieldKind, string]>
}

const meta: [FieldKind, string] = ['object', 'mcp.Meta']
const cursor: [FieldKind, string] = ['string', 'string']

const methodInfos: Record<string, MethodInfo> = {
  'completion/complete': {
    goType: 'CompleteParams',
    fields: { _meta: meta, ref: ['object', 'mcp.CompleteReference'], argument: ['object', 'mcp.CompleteParamsArgument'], context: ['object', 'mcp.CompleteContext'] },
  },
  'server/discover': { optional: true, goType: 'DiscoverParams', fields: { _meta: meta } },
  initialize: {
    goType: 'initializeParamsV2',
    fields: { _meta: meta, capabilities: ['object', 'mcp.clientCapabilitiesV2'], clientInfo: ['object', 'mcp.Implementation'], protocolVersion: ['string', 'string'] },
  },
  ping: { optional: true, goType: 'PingParams', fields: { _meta: meta } },
  'prompts/list': { optional: true, goType: 'ListPromptsParams', fields: { _meta: meta, cursor } },
  'prompts/get': { goType: 'GetPromptParams', fields: { _meta: meta, name: ['string', 'string'], arguments: ['object', 'map[string]string'] } },
  'tools/list': { optional: true, goType: 'ListToolsParams', fields: { _meta: meta, cursor } },
  'tools/call': {
    goType: 'CallToolParamsRaw',
    fields: { _meta: meta, name: ['string', 'string'], inputResponses: ['object', 'mcp.InputResponseMap'], requestState: ['string', 'string'] },
  },
  'resources/list': { optional: true, goType: 'ListResourcesParams', fields: { _meta: meta, cursor } },
  'resources/templates/list': { optional: true, goType: 'ListResourceTemplatesParams', fields: { _meta: meta, cursor } },
  'resources/read': { goType: 'ReadResourceParams', fields: { _meta: meta, uri: ['string', 'string'] } },
  'logging/setLevel': { goType: 'SetLoggingLevelParams', fields: { _meta: meta, level: ['string', 'mcp.LoggingLevel'] } },
  'resources/subscribe': { goType: 'SubscribeParams', fields: { _meta: meta, uri: ['string', 'string'] } },
  'subscriptions/listen': { goType: 'SubscriptionsListenParams', fields: { _meta: meta, notifications: ['object', 'mcp.NotificationSubscriptions'] } },
  'resources/unsubscribe': { goType: 'UnsubscribeParams', fields: { _meta: meta, uri: ['string', 'string'] } },
  'notifications/cancelled': { notification: true, optional: true, goType: 'CancelledParams', fields: {} },
  'notifications/initialized': { notification: true, optional: true, goType: 'InitializedParams', fields: {} },
  'notifications/roots/list_changed': { notification: true, optional: true, goType: 'RootsListChangedParams', fields: {} },
  'notifications/progress': { notification: true, goType: 'ProgressNotificationParams', fields: {} },
}

/** checkRequest: returns the error text, and whether it's "not handled" (an unknown method). */
function checkRequest(m: RequestMsg): { err: string; notHandled: boolean } | undefined {
  const info = methodInfos[m.method]
  if (!info) return { err: `JSON RPC not handled: ${goQuote(m.method)} unsupported`, notHandled: true }
  const isCall = m.id !== undefined
  if (info.notification && isCall) return { err: `invalid request: unexpected id for ${goQuote(m.method)}`, notHandled: false }
  if (!info.notification && !isCall) return { err: `invalid request: missing id for ${goQuote(m.method)}`, notHandled: false }
  if (!info.optional && !m.hasParams) return { err: 'invalid request: missing required "params"', notHandled: false }
  return undefined
}

function kindOk(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case 'string': return typeof v === 'string'
    case 'bool': return typeof v === 'boolean'
    case 'object': return isObject(v)
    case 'any': return true
  }
}

/** The json error for params that don't fit the Go params struct, or undefined. */
function paramsTypeError(info: MethodInfo, params: unknown): string | undefined {
  if (params === null || params === undefined) return undefined
  if (!isObject(params)) {
    return `json: cannot unmarshal ${goQuote(JSON.stringify(params))} into Go value of type mcp.${info.goType}`
  }
  for (const [k, [kind, goType]] of Object.entries(info.fields)) {
    const v = params[k]
    if (v === undefined || v === null || kindOk(kind, v)) continue
    return `json: cannot unmarshal ${goQuote(restFrom(params, k))} into Go struct field mcp.${info.goType}.${k} of type ${goType}`
  }
  return undefined
}

/** The params JSON from key's value to the end, which is what the SDK's decoder quotes in a type error. */
function restFrom(params: Record<string, unknown>, key: string): string {
  let prefix = '{'
  for (const [k, v] of Object.entries(params)) {
    if (k === key) {
      prefix += JSON.stringify(k) + ':'
      break
    }
    prefix += JSON.stringify(k) + ':' + JSON.stringify(v) + ','
  }
  return JSON.stringify(params).slice(prefix.length)
}

/** unmarshalParams: the params object ({} when absent or null and allowed), or a thrown JsonRpcError. */
function unmarshalParams(m: RequestMsg): Record<string, unknown> {
  const info = methodInfos[m.method]
  const raw = m.hasParams ? goQuote(JSON.stringify(m.params)) : '""'
  const typeErr = paramsTypeError(info, m.params)
  if (m.method === 'initialize') {
    // initializeMethodInfo: plain errors, so the code is 0.
    if (typeErr !== undefined) {
      throw new JsonRpcError(0, `handling 'initialize': unmarshaling ${raw} into a *mcp.initializeParamsV2: ${typeErr}`)
    }
    if (!isObject(m.params)) throw new JsonRpcError(0, `handling 'initialize': missing required "params"`)
    return m.params
  }
  if (typeErr !== undefined) {
    throw new JsonRpcError(CODE_INVALID_PARAMS, `handling '${m.method}': invalid params: unmarshaling ${raw} into a *mcp.${info.goType}: ${typeErr}`)
  }
  if (!isObject(m.params)) {
    if (!info.optional) throw new JsonRpcError(CODE_INVALID_REQUEST, `handling '${m.method}': invalid request: missing required "params"`)
    return {}
  }
  return m.params
}

/** extractRequestMeta: params._meta when params and _meta are objects. */
function requestMeta(params: unknown): Record<string, unknown> | undefined {
  if (!isObject(params)) return undefined
  const m = params._meta
  if (m === undefined || m === null) return undefined
  return isObject(m) ? m : undefined
}

function metaObject(m: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = m[key]
  return isObject(v) ? v : undefined
}

function validImplementation(v: Record<string, unknown>): boolean {
  for (const k of ['name', 'title', 'description', 'version', 'websiteUrl']) {
    if (v[k] !== undefined && v[k] !== null && typeof v[k] !== 'string') return false
  }
  return true
}

interface ValidatedMeta {
  usesNewProtocol: boolean
  protocolVersion: string
}

/** validateRequestMeta: whether a call follows the >= 2026-07-28 protocol. Throws JsonRpcError. */
function validateRequestMeta(m: RequestMsg): ValidatedMeta {
  const old = { usesNewProtocol: false, protocolVersion: '' }
  if (m.id === undefined) return old
  const md = requestMeta(m.params)
  if (!md) return old
  const v = md[META_PROTOCOL_VERSION]
  if (typeof v !== 'string' || v < V20260728) return old
  if (Object.hasOwn(md, META_CLIENT_INFO)) {
    const ci = metaObject(md, META_CLIENT_INFO)
    if (!ci || !validImplementation(ci)) {
      throw new JsonRpcError(CODE_INVALID_PARAMS, `invalid _meta field ${goQuote(META_CLIENT_INFO)}`)
    }
  }
  if (!metaObject(md, META_CLIENT_CAPABILITIES)) {
    throw new JsonRpcError(CODE_INVALID_PARAMS, `missing or invalid _meta field ${goQuote(META_CLIENT_CAPABILITIES)}`)
  }
  return { usesNewProtocol: true, protocolVersion: v }
}

/** negotiatedVersion: the client's version if supported and older than 2026-07-28, else the newest that is. */
function negotiatedVersion(clientVersion: string): string {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion) && clientVersion < V20260728) return clientVersion
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) if (v < V20260728) return v
  return V20251125
}

// ---------------------------------------------------------------------------
// HTTP helpers

const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }

/** http.Error. */
function httpError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message + '\n', { status, headers: { ...textHeaders, ...extra } })
}

/** writeJSONRPCError: a JSON-RPC error written before any handler ran. */
function jsonRpcErrorResponse(status: number, id: Id | undefined, code: number, message: string): Response {
  const body: Outgoing = { jsonrpc: '2.0' }
  if (id !== undefined) body.id = id
  body.error = { code, message }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const tokenRe = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** mime.ParseMediaType's media type, or "" when the header doesn't parse. */
export function baseMediaType(value: string | null): string {
  if (!value) return ''
  const semi = value.indexOf(';')
  const base = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase()
  const slash = base.indexOf('/')
  if (slash < 0 ? !tokenRe.test(base) : !tokenRe.test(base.slice(0, slash)) || !tokenRe.test(base.slice(slash + 1))) return ''
  let rest = semi < 0 ? '' : value.slice(semi)
  const seen = new Set<string>()
  const param = /^\s*;\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+|"(?:[^"\\]|\\.)*")/
  while (rest.trim() !== '') {
    const m = param.exec(rest)
    if (!m) {
      if (rest.trim() === ';') break // a trailing semicolon is ignored
      return ''
    }
    const key = m[1].toLowerCase()
    if (seen.has(key)) return ''
    seen.add(key)
    rest = rest.slice(m[0].length)
  }
  return base
}

/** streamableAccepts. */
export function streamableAccepts(value: string | null): { json: boolean; stream: boolean } {
  let json = false
  let stream = false
  for (const raw of (value ?? '').split(',')) {
    const base = raw.trim().split(';')[0].trim().toLowerCase()
    if (base === 'application/json' || base === 'application/*') json = true
    else if (base === 'text/event-stream' || base === 'text/*') stream = true
    else if (base === '*/*') json = stream = true
  }
  return { json, stream }
}

/** Reads the body, or returns undefined when it's longer than limit bytes. */
async function readBody(req: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(req.headers.get('content-length') ?? NaN)
  if (declared > limit) return undefined
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** extractErrorStatus: on the >= 2026-07-28 protocol some error codes carry their own HTTP status. */
function errorStatus(headerVersion: string, msg: Outgoing): number {
  if (headerVersion < V20260728 || !msg.error) return 0
  switch (msg.error.code) {
    case CODE_METHOD_NOT_FOUND:
      return 404
    case CODE_INVALID_PARAMS:
    case CODE_UNSUPPORTED_PROTOCOL_VERSION:
    case CODE_MISSING_REQUIRED_CLIENT_CAPABILITIES:
      return 400
  }
  return 0
}

function sseEvent(msg: Outgoing): string {
  return `event: message\ndata: ${JSON.stringify(msg)}\n\n`
}

// ---------------------------------------------------------------------------
// The server

const capabilities = { logging: {}, tools: { listChanged: true } }

/** One request's throwaway session (ServerSessionState). */
interface Session {
  /** The protocol version InitializeParams carries; undefined until initialized. */
  initVersion?: string
}

/** What handling one call produced: messages to send, and whether it holds the stream open. */
interface Handled {
  out: Outgoing[]
  hold?: boolean
}

/** Creates the endpoint. ctx (the caller's identity) is passed through to tool handlers. */
export function createStatelessServer<C>(cfg: ServerConfig<C>): (req: Request, ctx: C) => Promise<Response> {
  const tools = [...cfg.tools].sort((a, b) => (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
  const byName = new Map(tools.map((t) => [t.tool.name, t]))
  const listing = tools.map((t) => t.tool)

  /** ServerSession.handle plus jsonrpc2's processResult for one call. */
  async function handleCall(m: RequestMsg, s: Session, ctx: C): Promise<Handled> {
    const id = m.id!
    try {
      const vm = validateRequestMeta(m)
      if (vm.usesNewProtocol && !SUPPORTED_PROTOCOL_VERSIONS.includes(vm.protocolVersion)) {
        throw new JsonRpcError(CODE_UNSUPPORTED_PROTOCOL_VERSION, 'unsupported protocol version',
          { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: vm.protocolVersion })
      }
      switch (m.method) {
        case 'initialize':
        case 'ping':
        case 'logging/setLevel':
        case 'resources/subscribe':
        case 'resources/unsubscribe':
          if (vm.usesNewProtocol) throw new JsonRpcError(CODE_METHOD_NOT_FOUND, `${goQuote(m.method)} is not supported in the new protocol`)
          break
        case 'server/discover':
          if (!vm.usesNewProtocol) {
            throw new JsonRpcError(CODE_METHOD_NOT_FOUND, `${goQuote(m.method)} is only supported in protocol version >= ${V20260728}`)
          }
          break
        default:
          if (s.initVersion === undefined && !vm.usesNewProtocol) {
            throw new JsonRpcError(0, `method ${goQuote(m.method)} is invalid during session initialization`)
          }
          if (s.initVersion === undefined) s.initVersion = vm.protocolVersion
      }
      const params = unmarshalParams(m)
      const h = await dispatch(m, params, s, ctx, vm)
      if (vm.usesNewProtocol) {
        for (const o of h.out) if (o.id === id && o.result !== undefined) o.result = complete(o.result, m.method)
      }
      return h
    } catch (err) {
      return { out: [{ jsonrpc: '2.0', id, error: wireError(err, m.method) }] }
    }
    function complete(result: unknown, method: string): unknown {
      // setCompleteResultType and annotateServerInfo, in Go's field order.
      const r = result as Record<string, unknown>
      if (Object.keys(r).length === 0) return r // emptyResult (ping) gets neither
      const md = { [META_SERVER_INFO]: cfg.impl, ...(r._meta as Record<string, unknown> | undefined) }
      if (method === 'tools/call') {
        const { _meta: _, resultType: __, ...rest } = r
        return { _meta: md, ...rest, resultType: 'complete' }
      }
      const { _meta: _, resultType: __, ...rest } = r
      return { resultType: 'complete', _meta: sortKeys(md), ...rest }
    }
  }

  /** The method handlers. */
  async function dispatch(m: RequestMsg, p: Record<string, unknown>, s: Session, ctx: C, vm: ValidatedMeta): Promise<Handled> {
    const id = m.id!
    const reply = (result: unknown): Handled => ({ out: [{ jsonrpc: '2.0', id, result }] })
    const list = (key: string, items: unknown[]): Handled => {
      if (typeof p.cursor === 'string' && p.cursor !== '') {
        // Cursors are gob-encoded page tokens; this server never issues one (every list fits a page).
        throw new JsonRpcError(CODE_INVALID_PARAMS, 'invalid params')
      }
      return reply({ ttlMs: 0, cacheScope: 'public', [key]: items })
    }
    switch (m.method) {
      case 'initialize': {
        if (s.initVersion !== undefined) throw new JsonRpcError(0, `duplicate ${goQuote('initialize')} received`)
        const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : ''
        s.initVersion = requested
        return reply({
          capabilities,
          instructions: cfg.instructions,
          protocolVersion: negotiatedVersion(requested),
          serverInfo: cfg.impl,
        })
      }
      case 'ping':
      case 'logging/setLevel':
        return reply({})
      case 'server/discover':
        return reply({
          ttlMs: 0,
          cacheScope: 'public',
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities,
          instructions: cfg.instructions,
        })
      case 'tools/list':
        return list('tools', listing)
      case 'prompts/list':
        return list('prompts', [])
      case 'resources/list':
        return list('resources', [])
      case 'resources/templates/list':
        return list('resourceTemplates', [])
      case 'resources/read':
        throw new JsonRpcError(CODE_INVALID_PARAMS, 'Resource not found', { uri: typeof p.uri === 'string' ? p.uri : '' })
      case 'prompts/get':
        throw new JsonRpcError(CODE_INVALID_PARAMS, `unknown prompt ${goQuote(typeof p.name === 'string' ? p.name : '')}`)
      case 'completion/complete': {
        if (!isObject(p.ref)) throw new JsonRpcError(CODE_INVALID_PARAMS, "invalid params: missing required 'ref' field")
        const arg = isObject(p.argument) ? p.argument : {}
        if (typeof arg.name !== 'string' || arg.name === '') {
          throw new JsonRpcError(CODE_INVALID_PARAMS, "invalid params: missing required 'argument.name' field")
        }
        throw new JsonRpcError(CODE_METHOD_NOT_FOUND, 'method not found')
      }
      case 'resources/subscribe':
      case 'resources/unsubscribe':
        throw new JsonRpcError(CODE_METHOD_NOT_FOUND, 'method not found')
      case 'subscriptions/listen': {
        if (!isObject(p.notifications)) {
          throw new JsonRpcError(CODE_INVALID_PARAMS, "invalid params: missing required 'notifications' field")
        }
        // Only the tools capability (with listChanged) exists, so only that subscription is agreed.
        const agreed: Record<string, unknown> = {}
        if (p.notifications.toolsListChanged === true) agreed.toolsListChanged = true
        const ack: Outgoing = {
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { [META_SUBSCRIPTION_ID]: id }, notifications: agreed },
        }
        if (agreed.toolsListChanged) return { out: [ack], hold: true } // the tool list never changes
        return { out: [ack, { jsonrpc: '2.0', id, result: { _meta: { [META_SUBSCRIPTION_ID]: id } } }] }
      }
      case 'tools/call': {
        const name = typeof p.name === 'string' ? p.name : ''
        const t = byName.get(name)
        if (!t) throw new JsonRpcError(CODE_INVALID_PARAMS, `unknown tool ${goQuote(name)}`)
        const res = await t.call(p.arguments, ctx)
        const result: Record<string, unknown> = { content: res.content ?? [] }
        if (res.structuredContent !== undefined) result.structuredContent = res.structuredContent
        if (res.isError) result.isError = true
        // handleMultiRoundTripResult: clients on >= 2026-07-28 see resultType.
        if (!vm.usesNewProtocol && (s.initVersion ?? LATEST_PROTOCOL_VERSION) >= V20260728) result.resultType = 'complete'
        return reply(result)
      }
    }
    throw new JsonRpcError(CODE_METHOD_NOT_FOUND, 'method not found')
  }

  /** toWireError, after processResult turns every -32601 into `method not found: "<method>"`. */
  function wireError(err: unknown, method: string): { code: number; message: string; data?: unknown } {
    if (err instanceof JsonRpcError) {
      if (err.code === CODE_METHOD_NOT_FOUND) return { code: CODE_METHOD_NOT_FOUND, message: `method not found: ${goQuote(method)}` }
      const e: { code: number; message: string; data?: unknown } = { code: err.code, message: err.message }
      if (err.data !== undefined) e.data = err.data
      return e
    }
    cfg.log.error('mcp handler failed', { method, err })
    return { code: 0, message: err instanceof Error ? err.message : String(err) }
  }

  return async function serve(req: Request, ctx: C): Promise<Response> {
    // ServeHTTP: the version header is checked before anything else.
    const headerVersion = req.headers.get('mcp-protocol-version') ?? ''
    if (headerVersion !== '' && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion) && headerVersion < V20260728) {
      return httpError(400, `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(',')})`)
    }
    // serveStateless: POST only; GET and DELETE are 405 without sessions.
    if (req.method !== 'POST') return httpError(405, 'Method Not Allowed', { Allow: 'POST' })
    if (baseMediaType(req.headers.get('content-type')) !== 'application/json') {
      return httpError(415, "Content-Type must be 'application/json'")
    }
    const accepts = streamableAccepts(req.headers.get('accept'))
    if (!accepts.json || !accepts.stream) {
      return httpError(400, "Accept must contain both 'application/json' and 'text/event-stream'")
    }
    const bytes = await readBody(req, MAX_REQUEST_BODY_BYTES)
    if (!bytes) return httpError(413, `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`)

    // servePOST.
    if (req.headers.has('last-event-id')) return httpError(400, "can't send Last-Event-ID for POST request")
    if (bytes.length === 0) return httpError(400, 'POST requires a non-empty body')
    let msgs: Message[]
    let isBatch: boolean
    try {
      ;({ msgs, isBatch } = readBatch(new TextDecoder().decode(bytes)))
    } catch (err) {
      return httpError(400, `malformed payload: ${String(err)}`)
    }
    const protocolVersion = headerVersion || V20250326
    if (isBatch && protocolVersion >= V20250618) {
      return httpError(400, `JSON-RPC batching is not supported in ${V20250618} and later (request version: ${protocolVersion})`)
    }

    // ephemeralConnectOpts: old-protocol requests get a session that looks initialized.
    const requests = msgs.filter((m): m is RequestMsg => m.kind === 'request')
    const usesNewProtocol = protocolVersion >= V20260728 && requests.length > 0
    const session: Session = {}
    if (!requests.some((m) => m.method === 'initialize') && !usesNewProtocol) session.initVersion = protocolVersion

    const calls: RequestMsg[] = []
    const seen = new Set<string>()
    let listen = false
    for (const m of requests) {
      const bad = checkRequest(m)
      if (bad) {
        if (protocolVersion >= V20260728 && bad.notHandled && m.id !== undefined) {
          return jsonRpcErrorResponse(404, m.id, CODE_METHOD_NOT_FOUND, bad.err)
        }
        return httpError(400, bad.err)
      }
      // SEP-2575: a request carrying _meta's protocol version must send the
      // same version in the header.
      const md = requestMeta(m.params)
      const metaVersion = md && typeof md[META_PROTOCOL_VERSION] === 'string' ? md[META_PROTOCOL_VERSION] as string : ''
      if ((m.id !== undefined && protocolVersion >= V20260728) || metaVersion !== '') {
        if (headerVersion === '') {
          return jsonRpcErrorResponse(400, m.id, CODE_HEADER_MISMATCH,
            `Mcp-Protocol-Version header is required for requests carrying ${goQuote(META_PROTOCOL_VERSION)}`)
        }
        if (metaVersion === '') {
          return jsonRpcErrorResponse(400, m.id, CODE_INVALID_PARAMS, `missing or invalid _meta field ${goQuote(META_PROTOCOL_VERSION)}`)
        }
        if (headerVersion !== metaVersion) {
          return jsonRpcErrorResponse(400, m.id, CODE_HEADER_MISMATCH,
            `Mcp-Protocol-Version header ${goQuote(headerVersion)} does not match request ${META_PROTOCOL_VERSION} ${goQuote(metaVersion)}`)
        }
      }
      if (m.id !== undefined) {
        const key = typeof m.id + ':' + String(m.id)
        if (!seen.has(key)) calls.push(m) // a repeated ID gets one response, as in Go
        seen.add(key)
        if (m.method === 'subscriptions/listen') listen = true
      }
    }
    if (!isBatch && msgs.length === 1 && msgs[0].kind === 'request') {
      const bad = validateMcpHeaders(req.headers, msgs[0])
      if (bad) return jsonRpcErrorResponse(400, msgs[0].id, CODE_HEADER_MISMATCH, bad)
    }
    // Notifications alone (or responses) are accepted with no body.
    if (calls.length === 0) return new Response(null, { status: 202 })

    const base = { 'Cache-Control': 'no-cache, no-transform' }
    if (listen) return serveListen(calls, session, ctx, req, headerVersion, isBatch)

    const responses: Outgoing[] = []
    for (const m of calls) {
      const h = await handleCall(m, session, ctx)
      for (const o of h.out) if (o.id !== undefined) responses.push(o)
    }
    if (!isBatch) {
      const status = errorStatus(headerVersion, responses[0]) || 200
      return new Response(JSON.stringify(responses[0]), { status, headers: { ...base, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify(responses), { status: 200, headers: { ...base, 'Content-Type': 'application/json' } })
  }

  /**
   * A POST carrying subscriptions/listen is answered as an event stream. When
   * a subscription was agreed, the stream stays open until the client goes
   * away, as the Go handler blocks until its request is cancelled.
   */
  async function serveListen(calls: RequestMsg[], s: Session, ctx: C, req: Request, headerVersion: string, isBatch: boolean): Promise<Response> {
    const events: Outgoing[] = []
    let hold = false
    for (const m of calls) {
      const h = await handleCall(m, s, ctx)
      events.push(...h.out)
      if (h.hold) {
        hold = true
        break // the handler blocks; later calls in a batch never run
      }
    }
    const headers = { 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' }
    // deliverLocked's SEP-2575 override: an error that's the first thing written replaces the stream.
    const status = !isBatch && events.length > 0 ? errorStatus(headerVersion, events[0]) : 0
    if (status) return new Response(JSON.stringify(events[0]), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
    const enc = new TextEncoder()
    let end = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(sseEvent(e)))
        if (!hold) {
          controller.close()
          return
        }
        end = () => {
          req.signal.removeEventListener('abort', end)
          try {
            controller.close()
          } catch {
            // already closed or cancelled
          }
        }
        if (req.signal.aborted) end()
        else req.signal.addEventListener('abort', end, { once: true })
      },
      cancel() {
        req.signal.removeEventListener('abort', end)
      },
    })
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'text/event-stream' } })
  }
}

/** validateMcpHeaders: on >= 2026-07-28, Mcp-Method (and Mcp-Name for named methods) must match the body. */
function validateMcpHeaders(h: Headers, m: RequestMsg): string | undefined {
  const version = h.get('mcp-protocol-version') ?? ''
  if (version === '' || version < V20260728) return undefined
  const method = h.get('mcp-method') ?? ''
  if (method === '') return 'missing required Mcp-Method header'
  if (method !== m.method) return `header mismatch: Mcp-Method header value '${method}' does not match body value '${m.method}'`
  if (m.method === 'tools/call' || m.method === 'resources/read' || m.method === 'prompts/get') {
    const name = h.get('mcp-name') ?? ''
    if (name === '') return `missing required Mcp-Name header for method ${goQuote(m.method)}`
    const inBody = extractName(m)
    if (inBody === undefined) return `failed to extract name from parameters for method ${goQuote(m.method)}`
    if (name !== inBody) return `header mismatch: Mcp-Name header value '${name}' does not match body value '${inBody}'`
  }
  return undefined
}

/** extractName: the tool or prompt name, or the resource URI, when the params decode. */
function extractName(m: RequestMsg): string | undefined {
  const p = m.params
  if (p === null || p === undefined) return ''
  if (!isObject(p)) return undefined
  const md = p._meta
  if (md !== undefined && md !== null && !isObject(md)) return undefined
  const key = m.method === 'resources/read' ? 'uri' : 'name'
  const v = p[key]
  if (v !== undefined && v !== null && typeof v !== 'string') return undefined
  if (m.method === 'prompts/get' && p.arguments !== undefined && p.arguments !== null) {
    if (!isObject(p.arguments) || Object.values(p.arguments).some((a) => a !== null && typeof a !== 'string')) return undefined
  }
  return (v as string | null | undefined) ?? ''
}

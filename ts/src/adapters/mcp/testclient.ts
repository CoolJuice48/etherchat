// A minimal MCP client for tests: it calls a handler directly with Web
// Request objects, as the app would after authenticating. Never import it
// from production code.

export type Handler<C> = (req: Request, ctx: C) => Promise<Response>

export const ACCEPT = 'application/json, text/event-stream'

/** POSTs a raw body to the handler. */
export function post<C>(h: Handler<C>, ctx: C, body: string, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers },
    body,
  })
  return h(req, ctx)
}

export interface CallResult {
  isError: boolean
  /** The text content, joined. */
  text: string
  structured: unknown
  raw: Record<string, unknown>
}

/** A connected test client, as the Go tests' mcp.ClientSession. */
export class TestClient<C> {
  private id = 0
  readonly h: Handler<C>
  ctx: C
  version: string
  /** Runs before every request (tests use it to move a fake clock). */
  beforeEach: () => void = () => {}

  constructor(h: Handler<C>, ctx: C, version = '2025-06-18') {
    this.h = h
    this.ctx = ctx
    this.version = version
  }

  /** Sends one JSON-RPC call and returns the parsed response. */
  async rpc(method: string, params?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    this.beforeEach()
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id: ++this.id, method }
    if (params !== undefined) msg.params = params
    const res = await post(this.h, this.ctx, JSON.stringify(msg), { 'Mcp-Protocol-Version': this.version })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  async listTools(): Promise<Record<string, unknown>[]> {
    const { body } = await this.rpc('tools/list', {})
    if (body.error) throw new Error(`tools/list: ${JSON.stringify(body.error)}`)
    return (body.result as { tools: Record<string, unknown>[] }).tools
  }

  /** Calls a tool; a protocol error throws, a tool error is returned with isError. */
  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const { body } = await this.rpc('tools/call', { name, arguments: args })
    if (body.error) throw new Error(`${name}: protocol error ${JSON.stringify(body.error)}`)
    const r = body.result as Record<string, unknown>
    const content = (r.content as { type: string; text: string }[]) ?? []
    return {
      isError: r.isError === true,
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      structured: r.structuredContent,
      raw: r,
    }
  }

  /** Calls a tool that must succeed and returns its structured output. */
  async ok<T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.call(name, args)
    if (r.isError) throw new Error(`${name}: ${r.text}`)
    return r.structured as T
  }
}

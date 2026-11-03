// The MCP endpoint (a port of go/adapters/mcpserver plus the Go SDK's
// stateless Streamable HTTP handler): every ether tool, served over
// Web-standard Request/Response.
//
// Authentication happens before the handler: the app checks the bearer token
// (scope SCOPE) and answers 401 with WWW-Authenticate itself, then passes the
// verified TokenInfo here. userId and clientId become the ether Actor.

import type { EtherService } from '../../core/ether/index.ts'
import type { Logger } from '../../core/log.ts'
import { RateLimiter } from '../../core/ratelimit.ts'
import type { Mailer } from '../mail/index.ts'
import type { TokenInfo } from '../oauth/index.ts'
import { registerCollab } from './collab.ts'
import { INSTRUCTIONS, type Tools } from './mcpserver.ts'
import { createStatelessServer, type ServerTool } from './protocol.ts'
import { registerRequests } from './requests.ts'
import { registerTools } from './tools.ts'

export { CALLS_PER_MINUTE, INSTRUCTIONS, SCOPE } from './mcpserver.ts'
export { MAX_REQUEST_BODY_BYTES, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts'

export interface McpOptions {
  ethers: EtherService
  /** Sends invite emails. */
  mailer: Mailer
  /** The public origin invite emails point people to. */
  baseUrl: string
  /** The IANA zone invite emails show dates in ('' is UTC). Tool results always use UTC. */
  timeZone: string
  /** The server version, shown in serverInfo. */
  version: string
  log: Logger
}

/** Every tool. */
export function tools(t: Tools): ServerTool<TokenInfo>[] {
  return [...registerTools(t), ...registerCollab(t), ...registerRequests(t)]
}

/**
 * The MCP endpoint's handler, for POST (and every other method) on /mcp.
 * One handler keeps one rate limiter, so create it once per process (or
 * Durable Object).
 */
export function createMcpHandler(o: McpOptions): (req: Request, token: TokenInfo) => Promise<Response> {
  const t: Tools = {
    svc: o.ethers, mail: o.mailer, baseUrl: o.baseUrl, timeZone: o.timeZone, log: o.log, limiter: new RateLimiter(),
  }
  return createStatelessServer<TokenInfo>({
    impl: { name: 'etherchat', title: 'Etherchat', version: o.version },
    instructions: INSTRUCTIONS,
    tools: tools(t),
    log: o.log,
  })
}

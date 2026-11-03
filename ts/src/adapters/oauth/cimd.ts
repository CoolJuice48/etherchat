// Client ID Metadata Documents: the client_id is an https URL whose JSON
// document describes the client. The URL comes from whoever starts an
// authorization, so fetching is locked down (see cimd-node.ts and
// cimd-worker.ts) and the document is validated here.

import { cleanName, checkRedirectUri, type Client } from './clients.ts'
import { decodeStruct, goQuote } from './compat.ts'
import { parseAddr, parseUrl, unmap } from './gourl.ts'

/** Fetchers refuse documents larger than this. */
export const CIMD_MAX_BYTES = 64 << 10

/** Fetchers give up after this long. */
export const CIMD_TIMEOUT_MS = 5000

/** isCimd reports whether clientId is a Client ID Metadata Document URL. */
export function isCimd(clientId: string): boolean {
  return clientId.startsWith('https://')
}

/**
 * checkCimdUrl applies the Client ID Metadata Document URL rules: https, a
 * host, a path, and no fragment, credentials, or dot segments. It throws an
 * Error whose message is the reason.
 */
export function checkCimdUrl(raw: string): void {
  const u = parseUrl(raw)
  if (u.scheme !== 'https' || u.host === '') throw new Error('client_id must be an https URL')
  if (u.user) throw new Error('client_id must not contain credentials')
  if (u.fragment !== '' || raw.includes('#')) throw new Error('client_id must not have a fragment')
  if (u.path === '' || u.path === '/') throw new Error('client_id must have a path')
  for (const seg of u.path.split('/')) {
    if (seg === '.' || seg === '..') throw new Error('client_id must not contain dot segments')
  }
}

/**
 * clientFromDocument validates a fetched metadata document. v1 supports
 * public clients only (token_endpoint_auth_method "none"); signed client
 * assertions (private_key_jwt) come later. It throws an Error whose message
 * is the reason.
 */
export function clientFromDocument(clientId: string, doc: unknown): Client {
  let d
  try {
    d = decodeStruct(doc, {
      client_id: 'string',
      client_name: 'string',
      redirect_uris: 'strings',
      token_endpoint_auth_method: 'string',
    })
  } catch (err) {
    throw new Error(`metadata document is not JSON: ${(err as Error).message}`)
  }
  if ((d.client_id ?? '') !== clientId) throw new Error("metadata document's client_id doesn't match its URL")
  const uris = d.redirect_uris ?? []
  if (uris.length === 0 || uris.length > 10) throw new Error('metadata document needs 1 to 10 redirect_uris')
  for (const u of uris) {
    try {
      checkRedirectUri(u)
    } catch (err) {
      throw new Error(`${(err as Error).message}: ${u}`)
    }
  }
  const m = d.token_endpoint_auth_method ?? ''
  if (m !== '' && m !== 'none') throw new Error(`token_endpoint_auth_method ${goQuote(m)} isn't supported yet; use none`)
  let name = cleanName(d.client_name ?? '')
  if (name === '') name = parseUrl(clientId).host
  return { id: clientId, kind: 'cimd', name, redirectUris: uris, authMethod: 'none' }
}

// Go's netip.Prefix.Contains for the few ranges below.
function inPrefix(b: Uint8Array, prefix: number[], bits: number): boolean {
  if (b.length !== prefix.length) return false
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3
    const mask = 0x80 >> (i & 7)
    if ((b[byte] & mask) !== (prefix[byte] & mask)) return false
  }
  return true
}

const v6 = (...groups: number[]): number[] => {
  const out: number[] = []
  for (let i = 0; i < 8; i++) out.push((groups[i] ?? 0) >> 8, (groups[i] ?? 0) & 0xff)
  return out
}

const blockedPrefixes: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[192, 0, 0, 0], 24],
  [[198, 18, 0, 0], 15], // benchmarking
  [v6(0x64, 0xff9b), 96], // NAT64 can map to private IPv4
  [v6(0x2001, 0xdb8), 32],
]

/**
 * publicAddr reports whether ip (a textual address) is a routable public
 * address, with the same ranges as the Go server's check.
 */
export function publicAddr(ip: string): boolean {
  const a = parseAddr(ip)
  if (!a) return false
  const b = unmap(a).bytes
  if (b.length === 4) {
    if (b[0] === 127) return false // loopback
    if (b[0] === 10 || (b[0] === 172 && (b[1] & 0xf0) === 16) || (b[0] === 192 && b[1] === 168)) return false // private
    if (b[0] === 169 && b[1] === 254) return false // link-local unicast
    if ((b[0] & 0xf0) === 0xe0) return false // multicast, including link-local multicast
    if (b.every((x) => x === 0)) return false // unspecified
  } else {
    if (b.every((x, i) => x === (i === 15 ? 1 : 0))) return false // loopback
    if ((b[0] & 0xfe) === 0xfc) return false // private (unique local)
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false // link-local unicast
    if (b[0] === 0xff) return false // multicast, including interface- and link-local
    if (b.every((x) => x === 0)) return false // unspecified
  }
  for (const [p, bits] of blockedPrefixes) {
    if (inPrefix(b, p, bits)) return false
  }
  return true
}

// Client ID Metadata Document fetching on Node, locked down as the Go server's
// is: https only, no redirects, 5 seconds, 64 KB, and it refuses to connect to
// any address that isn't public. The address check happens at connect time,
// in the socket's DNS lookup, so a hostname can't be pointed at the home
// network between a check and the connection.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { Agent, request } from 'node:https'
import { isIP } from 'node:net'
import { CIMD_MAX_BYTES, CIMD_TIMEOUT_MS, publicAddr } from './cimd.ts'
import type { MetadataFetcher } from './index.ts'

export interface NodeFetcherOptions {
  /** Which resolved addresses may be contacted; publicAddr by default. Tests widen it. */
  addressAllowed?: (ip: string) => boolean
  /** Extra trusted CA certificates, for tests. */
  ca?: string
}

type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void

export class NodeMetadataFetcher implements MetadataFetcher {
  private readonly allowed: (ip: string) => boolean
  private readonly ca: string | undefined
  // A dedicated agent: no environment proxy, and no kept-alive sockets, so
  // every fetch resolves and checks its address afresh.
  private readonly agent = new Agent({ keepAlive: false })

  constructor(o: NodeFetcherOptions = {}) {
    this.allowed = o.addressAllowed ?? publicAddr
    this.ca = o.ca
  }

  // Resolves host, refuses it if any address isn't allowed, and hands the
  // socket the first address only.
  private readonly lookup = (hostname: string, options: { family?: number | string; all?: boolean; hints?: number }, callback: LookupCallback): void => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family ?? 0)
    dnsLookup(hostname, { all: true, family, hints: options.hints }, (err, addresses) => {
      if (err) {
        callback(err, '')
        return
      }
      for (const a of addresses) {
        if (!this.allowed(a.address)) {
          callback(new Error(`refusing to fetch from non-public address ${a.address}`), '')
          return
        }
      }
      if (addresses.length === 0) {
        callback(new Error(`no addresses for ${hostname}`), '')
        return
      }
      const first = addresses[0]
      if (options.all) callback(null, [first])
      else callback(null, first.address, first.family)
    })
  }

  async fetchJson(url: string): Promise<unknown> {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('client_id must be an https URL')
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname
    // Sockets skip the lookup for IP literals, so check those here.
    if (isIP(host) && !this.allowed(host)) throw new Error(`refusing to fetch from non-public address ${host}`)

    const body = await new Promise<string>((resolve, reject) => {
      let done = false
      const finish = (err: Error | null, text = ''): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) {
          req.destroy()
          reject(err)
        } else {
          resolve(text)
        }
      }
      const req = request({
        protocol: 'https:',
        hostname: host,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: 'application/json' },
        agent: this.agent,
        lookup: this.lookup as never,
        ca: this.ca,
      })
      const timer = setTimeout(() => finish(new Error(`fetching ${url}: timed out after ${CIMD_TIMEOUT_MS} ms`)), CIMD_TIMEOUT_MS)
      req.on('error', (err) => finish(err))
      req.on('response', (res) => {
        // Redirects aren't followed: any status but 200 is a failure.
        if (res.statusCode !== 200) {
          res.resume()
          finish(new Error(`metadata document returned HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (chunk: Buffer) => {
          n += chunk.length
          if (n > CIMD_MAX_BYTES) {
            res.destroy()
            finish(new Error(`metadata document is larger than ${CIMD_MAX_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish(null, new TextDecoder().decode(Buffer.concat(chunks))))
        res.on('error', (err) => finish(err))
      })
      req.end()
    })
    try {
      return JSON.parse(body)
    } catch (err) {
      throw new Error(`metadata document is not JSON: ${(err as Error).message}`)
    }
  }
}

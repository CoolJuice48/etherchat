// Client ID Metadata Document fetching on Cloudflare Workers. Workers can't
// reach private networks, so there's no address check here; the rest of the
// lockdown matches the Node fetcher: https only, no redirects, 5 seconds,
// 64 KB.

import { CIMD_MAX_BYTES, CIMD_TIMEOUT_MS } from './cimd.ts'
import type { MetadataFetcher } from './index.ts'

export class WorkerMetadataFetcher implements MetadataFetcher {
  private readonly fetchFn: typeof fetch

  /** fetchFn is the global fetch; tests pass their own. */
  constructor(fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetchFn = fetchFn
  }

  async fetchJson(url: string): Promise<unknown> {
    if (new URL(url).protocol !== 'https:') throw new Error('client_id must be an https URL')
    const resp = await this.fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // 'manual' rather than 'error': Workers have historically accepted only
      // 'follow' and 'manual'. A redirect then arrives as a 3xx, which the
      // status check below refuses, so no redirect is ever followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    })
    if (resp.status !== 200) {
      await resp.body?.cancel().catch(() => {})
      throw new Error(`metadata document returned HTTP ${resp.status}`)
    }
    const text = await readCapped(resp, CIMD_MAX_BYTES)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(`metadata document is not JSON: ${(err as Error).message}`)
    }
  }
}

/** Reads a response body as text, failing once it passes max bytes. */
export async function readCapped(resp: Response, max: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let n = 0
  if (resp.body) {
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.length
      if (n > max) {
        await reader.cancel().catch(() => {})
        throw new Error(`metadata document is larger than ${max} bytes`)
      }
      chunks.push(value)
    }
  }
  const all = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}

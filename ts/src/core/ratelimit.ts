// An in-memory sliding-window rate limiter keyed by string. Memory is enough
// for one server process (Node) or one Durable Object (Cloudflare).

export class RateLimiter {
  private hits = new Map<string, number[]>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Records a hit for key and reports whether it's within max hits per windowMs. */
  allow(key: string, max: number, windowMs: number): boolean {
    const now = this.now()
    const cutoff = now - windowMs
    if (this.hits.size > 10_000) {
      for (const [k, h] of this.hits) {
        if (h.length === 0 || h[h.length - 1] < cutoff) this.hits.delete(k)
      }
    }
    const h = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    if (h.length >= max) {
      this.hits.set(key, h)
      return false
    }
    h.push(now)
    this.hits.set(key, h)
    return true
  }
}

/**
 * The visitor's address: Cloudflare's CF-Connecting-IP when present (tunnel
 * or Workers), otherwise what the runtime reports for the connection.
 */
export function clientIp(headers: Headers, remoteAddr = ''): string {
  return headers.get('cf-connecting-ip') ?? remoteAddr
}

// Cross-origin protection, as Go's net/http CrossOriginProtection does it:
// browsers can't submit a form here from another site. GET, HEAD and
// OPTIONS are always allowed; other requests are rejected when
// Sec-Fetch-Site says they're cross-origin, or, from browsers that don't
// send it, when the Origin header's host isn't the Host header.

import type { MiddlewareHandler } from 'hono'
import { httpError } from './web.ts'

const fromSecFetchSite = 'cross-origin request detected from Sec-Fetch-Site header'
const fromOldBrowser = 'cross-origin request detected, and/or browser is out of date: ' +
  'Sec-Fetch-Site is missing, and Origin does not match Host'

// The host of an Origin header, as Go's url.Parse(origin).Host reads it, or
// undefined when it doesn't parse.
function originHost(origin: string): string | undefined {
  if (/[\x00-\x20\x7f]/.test(origin)) return undefined
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(origin)
  const rest = m ? m[2] : origin
  if (!rest.startsWith('//')) return ''
  const authority = rest.slice(2).split(/[/?#]/)[0]
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  if (/%(?![0-9a-fA-F]{2})/.test(host)) return undefined
  return host
}

/** Why a request is rejected, or undefined if it's allowed (Go's CrossOriginProtection.Check). */
export function crossOriginCheck(method: string, headers: Headers, host: string): string | undefined {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined
  switch (headers.get('sec-fetch-site') ?? '') {
    case '':
      break
    case 'same-origin':
    case 'none':
      return undefined
    default:
      return fromSecFetchSite
  }
  const origin = headers.get('origin') ?? ''
  if (origin === '') return undefined
  if (originHost(origin) === host) return undefined
  return fromOldBrowser
}

export const crossOriginProtection: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host') ?? new URL(c.req.url).host
  const why = crossOriginCheck(c.req.method, c.req.raw.headers, host)
  if (why) return httpError(why, 403)
  await next()
}

// OAuth clients: registered by RFC 7591 dynamic registration ("dcr") or
// described by a fetched Client ID Metadata Document ("cimd"), and the rules
// for their redirect URIs and display names.

import { trimSpace } from './compat.ts'
import { isLoopbackIp, parseUrl, type GoUrl } from './gourl.ts'

/** A registered (DCR) or fetched (CIMD) OAuth client. */
export interface Client {
  id: string
  kind: 'dcr' | 'cimd'
  name: string
  redirectUris: string[]
  /** none, client_secret_basic, or client_secret_post */
  authMethod: string
}

/** cleanName makes a client-supplied name safe and short for display. */
export function cleanName(name: string): string {
  let out = ''
  for (const ch of trimSpace(name)) {
    const c = ch.codePointAt(0)!
    // unicode.IsControl, zero-width space, right-to-left override
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200b || c === 0x202e) continue
    out += ch
  }
  const runes = [...out]
  return runes.length > 80 ? runes.slice(0, 80).join('') : out
}

const blockedSchemes = ['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'filesystem', 'http', 'https', 'ws', 'wss', 'ftp']

function tryParse(raw: string): GoUrl | undefined {
  try {
    return parseUrl(raw)
  } catch {
    return undefined
  }
}

/**
 * checkRedirectUri accepts https URLs, http on loopback (native apps,
 * RFC 8252 §7.3), and private-use schemes like cursor:// (RFC 8252 §7.1).
 * It throws an Error whose message is the reason.
 */
export function checkRedirectUri(raw: string): void {
  const u = tryParse(raw)
  if (!u || u.fragment !== '' || raw.includes('#')) {
    throw new Error('redirect URIs must be absolute URLs without a fragment')
  }
  switch (u.scheme) {
    case 'https':
      if (u.host === '') throw new Error('https redirect URIs need a host')
      return
    case 'http':
      if (!isLoopback(u.hostname())) throw new Error('http redirect URIs are only allowed on localhost')
      return
    default: {
      const s = u.scheme.toLowerCase()
      if (s === '' || blockedSchemes.includes(s)) throw new Error('redirect URI scheme not allowed')
      if (!/^[a-z0-9+.-]+$/.test(s)) throw new Error('redirect URI scheme not allowed')
    }
  }
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || isLoopbackIp(host)
}

/**
 * redirectAllowed reports whether requested matches a registered redirect
 * URI exactly, or differs only in port on a loopback http URI (RFC 8252 §7.3).
 */
export function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  const req = tryParse(requested)
  if (!req || req.scheme !== 'http' || !isLoopback(req.hostname())) return false
  for (const r of registered) {
    const reg = tryParse(r)
    if (reg && reg.scheme === 'http' && reg.hostname() === req.hostname() &&
      reg.path === req.path && reg.rawQuery === req.rawQuery) {
      return true
    }
  }
  return false
}

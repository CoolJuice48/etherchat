// Emails, handles, agent names, ether names, IDs and invite codes: the
// validation and formats behind accounts.go, ethers.go, agentname.go,
// invites.go and ether.go's newID.

import { createHmac, randomBytes } from 'node:crypto'
import { invalid } from '../errors.ts'
import { base32, fields, goLower, goQuote, goUpper, hasControl, runeCount, trimSpace, utf8Length } from './gofmt.ts'

// --- Emails ---

// RFC 5322 atext as Go's net/mail reads it: printable ASCII except the
// specials, plus any non-ASCII character (RFC 6532).
const atext = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\u{80}-\\u{D7FF}\\u{E000}-\\u{10FFFF}]"
const dotAtom = `${atext}+(?:\\.${atext}+)*`
// dtext: printable ASCII except [, ] and \, plus non-ASCII.
const dtext = '[!-Z^-~\\u{80}-\\u{D7FF}\\u{E000}-\\u{10FFFF}]'
const addrSpec = new RegExp(`^${dotAtom}@(?:${dotAtom}|\\[(${dtext}*)\\])$`, 'u')

/**
 * Returns the bare, lowercased address or throws invalid. It accepts what
 * Go's mail.ParseAddress parses back to the same text: a dot-atom local part
 * and a dot-atom or IP-literal domain, at most 254 bytes.
 */
export function normalizeEmail(raw: string): string {
  raw = trimSpace(raw)
  const m = addrSpec.exec(raw)
  if (!m || utf8Length(raw) > 254 || (m[1] !== undefined && !validDomainLiteral(m[1]))) {
    throw invalid(`${goQuote(raw)} is not a plain email address`)
  }
  return goLower(raw)
}

/** Go's check on a domain literal's text: an IPv4 address, or "IPv6:" and any IP. */
function validDomainLiteral(text: string): boolean {
  if (text.startsWith('IPv6:')) return parseIp(text.slice(5)) !== undefined
  const ip = parseIp(text)
  if (!ip) return false
  // To4: an IPv4 address, or IPv4-mapped IPv6.
  return ip.slice(0, 10).every((b) => b === 0) && ip[10] === 0xff && ip[11] === 0xff
}

/** Go's net.ParseIP (via netip.ParseAddr, zones refused) as 16 bytes, or undefined. */
export function parseIp(s: string): Uint8Array | undefined {
  for (const c of s) {
    if (c === '.') {
      const v4 = parseIpv4Fields(s)
      if (!v4) return undefined
      const out = new Uint8Array(16)
      out[10] = out[11] = 0xff
      out.set(v4, 12)
      return out
    }
    if (c === ':') return parseIpv6(s)
    if (c === '%') return undefined
  }
  return undefined
}

function parseIpv4Fields(s: string): number[] | undefined {
  const fields: number[] = []
  let val = 0
  let digits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c >= '0' && c <= '9') {
      if (digits === 1 && val === 0) return undefined // leading zero
      val = val * 10 + (c.charCodeAt(0) - 48)
      digits++
      if (val > 255) return undefined
    } else if (c === '.') {
      if (i === 0 || i === s.length - 1 || s[i - 1] === '.') return undefined
      if (fields.length === 3) return undefined
      fields.push(val)
      val = 0
      digits = 0
    } else {
      return undefined
    }
  }
  if (fields.length < 3) return undefined
  fields.push(val)
  return fields
}

function parseIpv6(s: string): Uint8Array | undefined {
  if (s.includes('%')) return undefined // a zone, which ParseIP refuses
  const ip = new Uint8Array(16)
  let ellipsis = -1
  if (s.startsWith('::')) {
    ellipsis = 0
    s = s.slice(2)
    if (s === '') return ip
  }
  let i = 0
  while (i < 16) {
    let off = 0
    let acc = 0
    for (; off < s.length; off++) {
      const d = parseInt(s[off], 16)
      if (Number.isNaN(d) || !/[0-9a-fA-F]/.test(s[off])) break
      acc = acc * 16 + d
      if (off > 3 || acc > 0xffff) return undefined
    }
    if (off === 0) return undefined
    if (off < s.length && s[off] === '.') {
      if (ellipsis < 0 && i !== 12) return undefined
      if (i + 4 > 16) return undefined
      const v4 = parseIpv4Fields(s)
      if (!v4) return undefined
      ip.set(v4, i)
      s = ''
      i += 4
      break
    }
    ip[i] = acc >> 8
    ip[i + 1] = acc & 0xff
    i += 2
    s = s.slice(off)
    if (s === '') break
    if (s[0] !== ':' || s.length === 1) return undefined
    s = s.slice(1)
    if (s[0] === ':') {
      if (ellipsis >= 0) return undefined
      ellipsis = i
      s = s.slice(1)
      if (s === '') break
    }
  }
  if (s !== '') return undefined
  if (i < 16) {
    if (ellipsis < 0) return undefined
    const n = 16 - i
    for (let j = i - 1; j >= ellipsis; j--) ip[j + n] = ip[j]
    ip.fill(0, ellipsis, ellipsis + n)
  } else if (ellipsis >= 0) {
    return undefined
  }
  return ip
}

// --- Handles ---

const maxHandleLen = 32

/**
 * Whether h can be a handle: lowercase letters, digits, '.', '_' and '-',
 * starting and ending with a letter or digit, at most 32 characters.
 */
export function validHandle(h: string): boolean {
  return h.length <= maxHandleLen && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(h)
}

/** Turns an email's local part into a valid handle. */
export function deriveHandle(email: string): string {
  const local = goLower(email.slice(0, email.lastIndexOf('@')))
  let b = ''
  for (const ch of local) {
    // Go works on bytes: each byte of a non-ASCII character becomes a '-'.
    b += /[a-z0-9._-]/.test(ch) ? ch : '-'.repeat(utf8Length(ch))
  }
  let h = b.replace(/^[._-]+|[._-]+$/g, '')
  if (h.length > maxHandleLen - 4) {
    // leave room for a numeric suffix
    h = h.slice(0, maxHandleLen - 4).replace(/[._-]+$/, '')
  }
  return h === '' ? 'user' : h
}

// --- Ether and agent names ---

const maxEtherName = 80

export function checkEtherName(name: string): string {
  name = trimSpace(name)
  if (name === '' || runeCount(name) > maxEtherName) throw invalid(`ether name must be 1-${maxEtherName} characters`)
  if (hasControl(name)) throw invalid("ether name can't contain control characters")
  return name
}

/** The longest name an agent can give itself. */
export const MAX_AGENT_NAME = 16

/** Tidies and checks an agent name; "" means back to "@handle". */
export function checkAgentName(name: string): string {
  name = fields(name).join(' ')
  if (name !== '') {
    if (runeCount(name) > MAX_AGENT_NAME) throw invalid(`an agent name can be at most ${MAX_AGENT_NAME} characters`)
    if (name.startsWith('@')) throw invalid("an agent name can't start with @; handles do")
    if (!/^[\p{L}\p{Nd} \-_.']*$/u.test(name)) throw invalid("an agent name can use letters, digits, spaces and - _ . '")
  }
  return name
}

// --- IDs and codes ---

/** A random 80-bit ID as 16 lowercase base32 characters. */
export function newId(): string {
  return base32(randomBytes(10)).toLowerCase()
}

/** 80 random bits as XXXX-XXXX-XXXX-XXXX in base32. */
export function newInviteCode(): string {
  const s = base32(randomBytes(10))
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`
}

const codeDigits: Record<string, string> = { '-': '', ' ': '', '0': 'O', '1': 'I', '8': 'B' }

/**
 * Uppercases, drops separators, and maps digits people confuse with base32
 * letters (0→O, 1→I, 8→B).
 */
export function normalizeCode(code: string): string {
  return goUpper(trimSpace(code)).replace(/[- 018]/g, (c) => codeDigits[c])
}

/** HMAC-SHA256 of "kind:code" keyed by the pepper, in hex, as Go's codeHMAC. */
export function codeHmac(pepper: Uint8Array, kind: string, code: string): string {
  return createHmac('sha256', pepper).update(`${kind}:${code}`).digest('hex')
}

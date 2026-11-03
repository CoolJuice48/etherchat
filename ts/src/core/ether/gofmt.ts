// Small ports of Go standard-library behavior the domain's messages and
// stored values depend on: %q quoting, Duration.String, json.Marshal,
// strings.TrimSpace/Fields/ToLower, unicode.IsControl and byte-order sorting.
// Matching them keeps error texts and database rows identical to Go's.

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u
const hex = '0123456789abcdef'

/** Go's fmt %q (strconv.Quote) of a string. */
export function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const r = ch.codePointAt(0)!
    switch (ch) {
      case '"': out += '\\"'; continue
      case '\\': out += '\\\\'; continue
    }
    if (printable.test(ch) && !(r >= 0xd800 && r <= 0xdfff)) {
      out += ch
      continue
    }
    switch (ch) {
      case '\x07': out += '\\a'; continue
      case '\b': out += '\\b'; continue
      case '\f': out += '\\f'; continue
      case '\n': out += '\\n'; continue
      case '\r': out += '\\r'; continue
      case '\t': out += '\\t'; continue
      case '\v': out += '\\v'; continue
    }
    if (r < 0x20 || r === 0x7f) {
      out += '\\x' + hex[r >> 4] + hex[r & 0xf]
    } else if (r >= 0xd800 && r <= 0xdfff) {
      out += '\\ufffd' // a lone surrogate: Go would see invalid UTF-8
    } else if (r < 0x10000) {
      out += '\\u' + r.toString(16).padStart(4, '0')
    } else {
      out += '\\U' + r.toString(16).padStart(8, '0')
    }
  }
  return out + '"'
}

/** Go's strings.ToLower: simple, one-to-one case mapping per code point. */
export function goLower(s: string): string {
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase()
  let out = ''
  for (const ch of s) {
    if (ch === '\u0130') {
      out += 'i'
      continue
    }
    const l = ch.toLowerCase()
    out += [...l].length === 1 ? l : ch
  }
  return out
}

/** Go's strings.ToUpper: simple, one-to-one case mapping per code point. */
export function goUpper(s: string): string {
  if (/^[\x00-\x7f]*$/.test(s)) return s.toUpperCase()
  let out = ''
  for (const ch of s) {
    const u = ch.toUpperCase()
    out += [...u].length === 1 ? u : ch
  }
  return out
}

/** Go's strings.TrimSpace (Unicode White_Space, which excludes U+FEFF unlike String.trim). */
export function trimSpace(s: string): string {
  return s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
}

/** Go's strings.Fields. */
export function fields(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((f) => f !== '')
}

/** Whether s contains a character unicode.IsControl reports (C0, DEL, C1). */
export function hasControl(s: string): boolean {
  return /\p{Cc}/u.test(s)
}

/** Length of s in UTF-8 bytes (Go's len of a string). */
export function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const r = ch.codePointAt(0)!
    n += r < 0x80 ? 1 : r < 0x800 ? 2 : r < 0x10000 ? 3 : 4
  }
  return n
}

/** Number of code points (Go's utf8.RuneCountInString). */
export function runeCount(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Whether s encodes to valid UTF-8: no lone surrogates (Go's utf8.ValidString). */
export function validUtf8(s: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
}

/** Compares strings in UTF-8 byte order, as Go's < and sort.Strings do. */
export function compareStrings(a: string, b: string): number {
  const x = a[Symbol.iterator]()
  const y = b[Symbol.iterator]()
  for (;;) {
    const p = x.next()
    const q = y.next()
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1
    const d = p.value.codePointAt(0)! - q.value.codePointAt(0)!
    if (d !== 0) return d
  }
}

/** Go's time.Duration.String for a whole number of milliseconds. */
export function goDuration(ms: number): string {
  if (ms === 0) return '0s'
  const neg = ms < 0
  let u = Math.abs(ms)
  let out: string
  if (u < 1000) {
    out = `${u}ms`
  } else {
    const h = Math.floor(u / 3_600_000)
    u -= h * 3_600_000
    const m = Math.floor(u / 60_000)
    u -= m * 60_000
    const s = Math.floor(u / 1000)
    const frac = u - s * 1000
    let secs = `${s}`
    if (frac > 0) secs += '.' + String(frac).padStart(3, '0').replace(/0+$/, '')
    out = h > 0 ? `${h}h${m}m${secs}s` : m > 0 ? `${m}m${secs}s` : `${secs}s`
  }
  return neg ? '-' + out : out
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort(compareStrings)) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * Go's json.Marshal: object keys sorted (as for a Go map), and <, >, &,
 * U+2028 and U+2029 escaped.
 */
export function goJson(v: unknown): string {
  return JSON.stringify(sortKeys(v)).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 (Go's base32.StdEncoding) without padding. */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xfff // at most 4 pending bits plus this byte
    bits += 8
    while (bits >= 5) {
      out += base32Alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += base32Alphabet[(value << (5 - bits)) & 31]
  return out
}

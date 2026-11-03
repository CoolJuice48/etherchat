// Small pieces of Go's standard library the OAuth server's wire behavior
// depends on: encoding/json output and struct decoding, strconv.Quote,
// strings.Fields/TrimSpace, request body limits, form and Basic auth parsing.

import { timingSafeEqual } from 'node:crypto'
import { parseQuery, queryUnescape, type Values } from './gourl.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Length in UTF-8 bytes, which is what Go's len(string) counts. */
export function byteLen(s: string): number {
  return enc.encode(s).length
}

/** Go's subtle.ConstantTimeCompare on two strings' bytes. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// unicode.IsSpace.
const space = '\t\n\v\f\r \u0085                 　'

/** Go's strings.TrimSpace. */
export function trimSpace(s: string): string {
  let i = 0
  let j = s.length
  while (i < j && space.includes(s[i])) i++
  while (j > i && space.includes(s[j - 1])) j--
  return s.slice(i, j)
}

/** Go's strings.Fields. */
export function fields(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of s) {
    if (space.includes(ch)) {
      if (cur !== '') out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/** Go's strings.TrimRight(s, "/"). */
export function trimRightSlash(s: string): string {
  let j = s.length
  while (j > 0 && s[j - 1] === '/') j--
  return s.slice(0, j)
}

const hex = '0123456789abcdef'

function isLoneSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdfff
}

// encoding/json's string encoding with HTML escaping (json.Marshal and
// json.Encoder both escape <, > and &).
function jsonString(s: string): string {
  let out = '"'
  for (const ch of s) {
    let c = ch.codePointAt(0)!
    if (isLoneSurrogate(c)) c = 0xfffd
    switch (c) {
      case 0x5c:
        out += '\\\\'
        continue
      case 0x22:
        out += '\\"'
        continue
      case 0x08:
        out += '\\b'
        continue
      case 0x0c:
        out += '\\f'
        continue
      case 0x0a:
        out += '\\n'
        continue
      case 0x0d:
        out += '\\r'
        continue
      case 0x09:
        out += '\\t'
        continue
      case 0x2028:
      case 0x2029:
        out += '\\u' + c.toString(16)
        continue
    }
    if (c < 0x20 || c === 0x3c || c === 0x3e || c === 0x26) {
      out += '\\u00' + hex[c >> 4] + hex[c & 15]
    } else {
      out += String.fromCodePoint(c)
    }
  }
  return out + '"'
}

/**
 * Go's json.Marshal for plain values. Object keys keep their order, so build
 * objects in Go's order: struct field order for structs, sorted for maps.
 * Undefined fields are left out (omitempty).
 */
export function goJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  switch (typeof v) {
    case 'string':
      return jsonString(v)
    case 'number':
      return Number.isFinite(v) ? String(v) : 'null'
    case 'boolean':
      return v ? 'true' : 'false'
  }
  if (Array.isArray(v)) return '[' + v.map(goJson).join(',') + ']'
  const parts: string[] = []
  for (const [k, x] of Object.entries(v as object)) {
    if (x !== undefined) parts.push(jsonString(k) + ':' + goJson(x))
  }
  return '{' + parts.join(',') + '}'
}

// strconv.IsPrint, near enough: letters, marks, numbers, punctuation,
// symbols, and the ASCII space.
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u

/** Go's strconv.Quote (what %q prints for a string). */
export function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) {
    let c = ch.codePointAt(0)!
    if (isLoneSurrogate(c)) c = 0xfffd
    const r = String.fromCodePoint(c)
    if (c === 0x22 || c === 0x5c) {
      out += '\\' + r
    } else if (c === 0x20 || (c > 0x20 && c < 0x7f) || (c >= 0x80 && printable.test(r))) {
      out += r
    } else if (c === 0x07) out += '\\a'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c === 0x0b) out += '\\v'
    else if (c < 0x20 || c === 0x7f) out += '\\x' + hex[c >> 4] + hex[c & 15]
    else if (c < 0x10000) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += '\\U' + c.toString(16).padStart(8, '0')
  }
  return out + '"'
}

export type FieldKind = 'string' | 'strings'

/**
 * Decodes a parsed JSON value into a flat struct the way Go's encoding/json
 * does: keys match field names exactly or case-insensitively, unknown keys
 * are ignored, null leaves a string alone and clears a slice, null slice
 * elements become "", and any other type mismatch is an error (thrown).
 */
export function decodeStruct<S extends Record<string, FieldKind>>(
  v: unknown,
  spec: S,
): { [K in keyof S]?: S[K] extends 'strings' ? string[] : string } {
  const out: Record<string, string | string[] | undefined> = {}
  if (v === null) return out as never
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('json: cannot unmarshal into struct')
  const names = Object.keys(spec)
  for (const [key, val] of Object.entries(v as object)) {
    const name = names.includes(key) ? key : names.find((n) => fold(n) === fold(key))
    if (!name) continue
    if (spec[name] === 'string') {
      if (val === null) continue
      if (typeof val !== 'string') throw new TypeError(`json: cannot unmarshal into field ${name} of type string`)
      out[name] = val
    } else {
      if (val === null) {
        out[name] = undefined
        continue
      }
      if (!Array.isArray(val)) throw new TypeError(`json: cannot unmarshal into field ${name} of type []string`)
      out[name] = val.map((x) => {
        if (x === null) return ''
        if (typeof x !== 'string') throw new TypeError(`json: cannot unmarshal into field ${name} of type []string`)
        return x
      })
    }
  }
  return out as never
}

// Unicode simple case folding, for the ASCII field names used here.
function fold(s: string): string {
  return s.replace(/ſ/g, 's').toLowerCase()
}

/**
 * The first JSON value in text, as Go's json.Decoder reads it: leading
 * whitespace skipped, anything after the value ignored. Only an object or
 * null can decode into a struct, so anything else is an error (thrown).
 */
export function firstJsonValue(text: string): unknown {
  let i = 0
  while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  if (text.startsWith('null', i)) return null
  if (text[i] !== '{') throw new SyntaxError('json: not an object')
  let depth = 0
  let inString = false
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (inString) {
      if (c === '\\') j++
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
    } else if (c === '{' || c === '[') {
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(i, j + 1))
    }
  }
  throw new SyntaxError('unexpected EOF')
}

/** The size Go's http.MaxBytesReader allows the OAuth endpoints. */
export const maxBodyBytes = 16 << 10

/**
 * Reads at most limit+1 bytes of a body. over reports a body longer than
 * limit; bytes then holds the first limit bytes (what Go's MaxBytesReader
 * hands out before failing).
 */
export async function readLimited(req: Request, limit: number): Promise<{ bytes: Uint8Array; over: boolean }> {
  if (!req.body) return { bytes: new Uint8Array(0), over: false }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  let over = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    n += value.length
    if (n > limit) {
      over = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  const all = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return { bytes: over ? all.slice(0, limit) : all, over }
}

export function utf8(bytes: Uint8Array): string {
  return dec.decode(bytes)
}

const tspecials = '()<>@,;:\\"/[]?='

function isToken(s: string): boolean {
  if (s === '') return false
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c <= 0x20 || c >= 0x7f || tspecials.includes(ch)) return false
  }
  return true
}

/**
 * Go's mime.ParseMediaType, reduced to what form parsing needs: the
 * lowercased media type, and whether the header (parameters included) is
 * well formed.
 */
export function mediaType(v: string): { type: string; ok: boolean } {
  const semi = v.indexOf(';')
  const type = trimSpace(semi < 0 ? v : v.slice(0, semi)).toLowerCase()
  const slash = type.indexOf('/')
  const typeOk = slash < 0 ? isToken(type) : isToken(type.slice(0, slash)) && isToken(type.slice(slash + 1))
  if (!typeOk) return { type: '', ok: false }
  let rest = semi < 0 ? '' : v.slice(semi)
  const seen = new Map<string, string>()
  for (;;) {
    rest = rest.replace(/^\s+/, '')
    if (rest === '') break
    const m = /^;\s*([^\s()<>@,;:\\"/[\]?=]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s()<>@,;:\\"/[\]?=]+)/.exec(rest)
    if (!m) {
      if (trimSpace(rest) === ';') break
      return { type, ok: false }
    }
    // Repeating a parameter is allowed only with the same value.
    const key = m[1].toLowerCase()
    const value = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2]
    if (seen.has(key) && seen.get(key) !== value) return { type: '', ok: false }
    seen.set(key, value)
    rest = rest.slice(m[0].length)
  }
  return { type, ok: true }
}

/**
 * Go's Request.ParseForm for a POST: the body's form values when the content
 * type is application/x-www-form-urlencoded, and whether parsing (of the
 * body, the content type or the URL's query) failed.
 */
export async function parsePostForm(req: Request): Promise<{ form: Values; ok: boolean }> {
  let ok = true
  const rawQuery = new URL(req.url).search.slice(1)
  let form: Values = new Map()
  let ct = req.headers.get('content-type') ?? ''
  if (ct === '') ct = 'application/octet-stream'
  const mt = mediaType(ct)
  if (!mt.ok) ok = false
  if (mt.type === 'application/x-www-form-urlencoded') {
    const { bytes, over } = await readLimited(req, maxBodyBytes)
    if (over) {
      ok = false
    } else {
      const parsed = parseQuery(utf8(bytes))
      form = parsed.values
      if (parsed.err) ok = false
    }
  }
  if (parseQuery(rawQuery).err) ok = false
  return { form, ok }
}

/** The first value of key in v, or "" (Go's Values.Get). */
export function get(v: Values, key: string): string {
  return v.get(key)?.[0] ?? ''
}

/** Go's Request.BasicAuth. */
export function basicAuth(headers: Headers): { username: string; password: string } | undefined {
  const auth = headers.get('authorization') ?? ''
  if (auth.length < 6 || auth.slice(0, 6).toLowerCase() !== 'basic ') return undefined
  const b64 = auth.slice(6).replace(/[\r\n]/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) return undefined
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const cs = utf8(bytes)
  const colon = cs.indexOf(':')
  if (colon < 0) return undefined
  return { username: cs.slice(0, colon), password: cs.slice(colon + 1) }
}

export { queryUnescape }

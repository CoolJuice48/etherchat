// URL helpers that escape exactly as Go's net/url does, so links and
// redirects match the Go server's byte for byte.

const upperHex = '0123456789ABCDEF'
const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

type Mode = 'path' | 'pathSegment' | 'queryComponent'

// net/url's shouldEscape for the two modes the site uses.
function shouldEscape(b: number, mode: Mode): boolean {
  if ((b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39)) return false
  const c = String.fromCharCode(b)
  if ('-_.~'.includes(c)) return false
  if ('$&+,/:;=?@'.includes(c)) {
    if (mode === 'path') return c === '?'
    return mode === 'queryComponent' ? true : c === '/' || c === ';' || c === ',' || c === '?'
  }
  return true
}

function escape(s: string, mode: Mode): string {
  let out = ''
  for (const b of utf8.encode(s)) {
    if (b === 0x20 && mode === 'queryComponent') out += '+'
    else if (shouldEscape(b, mode)) out += '%' + upperHex[b >> 4] + upperHex[b & 15]
    else out += String.fromCharCode(b)
  }
  return out
}

/** Go's url.PathEscape. */
export function pathEscape(s: string): string {
  return escape(s, 'pathSegment')
}

/** A whole path as Go's url.URL.EscapedPath writes it. */
export function escapeUrlPath(s: string): string {
  return escape(s, 'path')
}

/** Go's url.QueryEscape. */
export function queryEscape(s: string): string {
  return escape(s, 'queryComponent')
}

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  return -1
}

/** Go's url.QueryUnescape; undefined for a malformed escape. */
export function queryUnescape(s: string): string | undefined {
  const bytes: number[] = []
  const src = utf8.encode(s)
  for (let i = 0; i < src.length; i++) {
    const b = src[i]
    if (b === 0x25) {
      if (i + 2 >= src.length) return undefined
      const hi = unhex(src[i + 1]), lo = unhex(src[i + 2])
      if (hi < 0 || lo < 0) return undefined
      bytes.push(hi * 16 + lo)
      i += 2
    } else if (b === 0x2b) bytes.push(0x20)
    else bytes.push(b)
  }
  return utf8Decoder.decode(new Uint8Array(bytes))
}

/** Go's url.Values: keys in the order first seen, each with its values. */
export type Values = Map<string, string[]>

/** Go's url.ParseQuery, skipping pairs it would reject. */
export function parseQuery(query: string): Values {
  const out: Values = new Map()
  for (const pair of query.split('&')) {
    if (pair === '' || pair.includes(';')) continue
    const eq = pair.indexOf('=')
    const k = queryUnescape(eq < 0 ? pair : pair.slice(0, eq))
    const v = queryUnescape(eq < 0 ? '' : pair.slice(eq + 1))
    if (k === undefined || v === undefined) continue
    const list = out.get(k)
    if (list) list.push(v)
    else out.set(k, [v])
  }
  return out
}

/** Values.Get: the first value, or "". */
export function first(v: Values, key: string): string {
  return v.get(key)?.[0] ?? ''
}

/** Go's url.Values.Encode: sorted by key, query-escaped. */
export function encodeValues(v: Values): string {
  const parts: string[] = []
  for (const k of [...v.keys()].sort(byBytes)) {
    for (const value of v.get(k) ?? []) parts.push(queryEscape(k) + '=' + queryEscape(value))
  }
  return parts.join('&')
}

/** Orders strings by their UTF-8 bytes, like Go's sort.Strings. */
export function byBytes(a: string, b: string): number {
  if (a === b) return 0
  const x = utf8.encode(a), y = utf8.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i]
  }
  return x.length - y.length
}

/** Go's path.Clean. */
export function cleanPath(p: string): string {
  if (p === '') return '.'
  const rooted = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!rooted) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (rooted) return '/' + joined
  return joined === '' ? '.' : joined
}

// Each path segment is escaped separately so "/" stays a separator.
export function escapePath(p: string): string {
  return p.split('/').map(pathEscape).join('/')
}

export function etherUrl(id: string): string {
  return '/e/' + pathEscape(id)
}

export function fileUrl(id: string, path: string): string {
  return etherUrl(id) + '/f/' + escapePath(path)
}

export function rawUrl(id: string, path: string, version: number): string {
  return fileUrl(id, path) + '?raw=1&v=' + version
}

export function downloadUrl(id: string, path: string, version: number): string {
  return etherUrl(id) + '/d/' + escapePath(path) + '?v=' + version
}

export function historyUrl(id: string, path: string): string {
  return etherUrl(id) + '/h/' + escapePath(path)
}

export function commsUrl(id: string): string {
  return etherUrl(id) + '/comms'
}

export function sharedUrl(id: string): string {
  return etherUrl(id) + '/shared'
}

export function agentUrl(id: string, handle: string): string {
  return etherUrl(id) + '/m/' + pathEscape(handle)
}

/** The id of a folder's row in a file tree, so links can point at it. */
export function folderId(path: string): string {
  return 'd-' + pathEscape(path)
}

const tspecials = '()<>@,;:\\"/[]?='

function isToken(s: string): boolean {
  return s !== '' && [...s].every((c) => c > ' ' && c < '\x7f' && !tspecials.includes(c))
}

/** Go's mime.FormatMediaType with one parameter, as Content-Disposition uses it. */
export function formatMediaType(type: string, param: string, value: string): string {
  let out = type.toLowerCase() + '; ' + param.toLowerCase()
  if ([...value].some((c) => (c < ' ' || c > '~') && c !== '\t')) {
    // RFC 2231: UTF-8 with percent escapes for anything outside the attribute characters.
    out += "*=utf-8''"
    for (const b of utf8.encode(value)) {
      const c = String.fromCharCode(b)
      if (b <= 0x20 || b >= 0x7f || c === '*' || c === "'" || c === '%' || tspecials.includes(c)) {
        out += '%' + upperHex[b >> 4] + upperHex[b & 15]
      } else out += c
    }
    return out
  }
  if (isToken(value)) return out + '=' + value
  return out + '="' + value.replace(/["\\]/g, (c) => '\\' + c) + '"'
}

// Go's net/url and net/netip parsing, ported for the parts the OAuth server
// depends on. Redirect URIs are compared as registered and rebuilt with the
// code and state, so the WHATWG URL parser (which normalizes hosts, ports and
// escapes) would answer differently from the Go server; this one doesn't.
// Escaping works on UTF-8 bytes, as Go's does.

const enc = new TextEncoder()
const dec = new TextDecoder()

type Mode = 'path' | 'pathSegment' | 'host' | 'zone' | 'userPassword' | 'queryComponent' | 'fragment'

/** A failure to parse a URL, IP address or query (the text is informative only). */
export class UrlError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'UrlError'
  }
}

function isAlnum(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)
}

function ishex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
}

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  return c - 0x41 + 10
}

// shouldEscape is Go's, character for character.
function shouldEscape(c: number, mode: Mode): boolean {
  if (isAlnum(c)) return false
  const ch = String.fromCharCode(c)
  if (mode === 'host' || mode === 'zone') {
    if ('!$&\'()*+,;=:[]<>"'.includes(ch) && c < 0x80) return false
  }
  if (c < 0x80 && '-_.~'.includes(ch)) return false
  if (c < 0x80 && '$&+,/:;=?@'.includes(ch)) {
    switch (mode) {
      case 'path':
        return ch === '?'
      case 'pathSegment':
        return ch === '/' || ch === ';' || ch === ',' || ch === '?'
      case 'userPassword':
        return ch === '@' || ch === '/' || ch === '?' || ch === ':'
      case 'queryComponent':
        return true
      case 'fragment':
        return false
    }
  }
  if (mode === 'fragment' && c < 0x80 && '!()*'.includes(ch)) return false
  return true
}

function unescape(s: string, mode: Mode): string {
  const b = enc.encode(s)
  let n = 0
  let hasPlus = false
  for (let i = 0; i < b.length;) {
    const c = b[i]
    if (c === 0x25) {
      n++
      if (i + 2 >= b.length || !ishex(b[i + 1]) || !ishex(b[i + 2])) throw new UrlError('invalid URL escape')
      const is25 = b[i + 1] === 0x32 && b[i + 2] === 0x35
      if (mode === 'host' && unhex(b[i + 1]) < 8 && !is25) throw new UrlError('invalid URL escape')
      if (mode === 'zone') {
        const v = (unhex(b[i + 1]) << 4) | unhex(b[i + 2])
        if (!is25 && v !== 0x20 && shouldEscape(v, 'host')) throw new UrlError('invalid URL escape')
      }
      i += 3
    } else if (c === 0x2b) {
      hasPlus = mode === 'queryComponent'
      i++
    } else {
      if ((mode === 'host' || mode === 'zone') && c < 0x80 && shouldEscape(c, mode)) {
        throw new UrlError('invalid character in host name')
      }
      i++
    }
  }
  if (n === 0 && !hasPlus) return s
  const out: number[] = []
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x25) {
      out.push((unhex(b[i + 1]) << 4) | unhex(b[i + 2]))
      i += 2
    } else if (b[i] === 0x2b) {
      out.push(mode === 'queryComponent' ? 0x20 : 0x2b)
    } else {
      out.push(b[i])
    }
  }
  return dec.decode(new Uint8Array(out))
}

const upperhex = '0123456789ABCDEF'

function escape(s: string, mode: Mode): string {
  let out = ''
  for (const c of enc.encode(s)) {
    if (c === 0x20 && mode === 'queryComponent') out += '+'
    else if (shouldEscape(c, mode)) out += '%' + upperhex[c >> 4] + upperhex[c & 15]
    else out += String.fromCharCode(c)
  }
  return out
}

/** Go's url.QueryEscape. */
export function queryEscape(s: string): string {
  return escape(s, 'queryComponent')
}

/** Go's url.QueryUnescape; throws UrlError on a malformed escape. */
export function queryUnescape(s: string): string {
  return unescape(s, 'queryComponent')
}

export interface Userinfo {
  username: string
  password: string
  passwordSet: boolean
}

/** Go's url.URL. Fields hold what Go's would; methods are Go's. */
export class GoUrl {
  scheme = ''
  opaque = ''
  user: Userinfo | undefined = undefined
  host = ''
  path = ''
  rawPath = ''
  rawQuery = ''
  fragment = ''
  rawFragment = ''
  forceQuery = false
  omitHost = false

  hostname(): string {
    return splitHostPort(this.host).host
  }

  port(): string {
    return splitHostPort(this.host).port
  }

  /** Parses rawQuery, dropping malformed pairs. */
  query(): Values {
    return parseQuery(this.rawQuery).values
  }

  escapedPath(): string {
    if (this.rawPath !== '' && validEncoded(this.rawPath, 'path')) {
      try {
        if (unescape(this.rawPath, 'path') === this.path) return this.rawPath
      } catch {
        // fall through
      }
    }
    if (this.path === '*') return '*'
    return escape(this.path, 'path')
  }

  escapedFragment(): string {
    if (this.rawFragment !== '' && validEncoded(this.rawFragment, 'fragment')) {
      try {
        if (unescape(this.rawFragment, 'fragment') === this.fragment) return this.rawFragment
      } catch {
        // fall through
      }
    }
    return escape(this.fragment, 'fragment')
  }

  toString(): string {
    let buf = ''
    if (this.scheme !== '') buf += this.scheme + ':'
    if (this.opaque !== '') {
      buf += this.opaque
    } else {
      if (this.scheme !== '' || this.host !== '' || this.user) {
        if (this.omitHost && this.host === '' && !this.user) {
          // omit empty host
        } else {
          if (this.host !== '' || this.path !== '' || this.user) buf += '//'
          if (this.user) {
            let ui = escape(this.user.username, 'userPassword')
            if (this.user.passwordSet) ui += ':' + escape(this.user.password, 'userPassword')
            buf += ui + '@'
          }
          if (this.host !== '') buf += escape(this.host, 'host')
        }
      }
      let path = this.escapedPath()
      if (this.omitHost && this.host === '' && !this.user && path.startsWith('//')) {
        buf += '%2F'
        path = path.slice(1)
      }
      if (path !== '' && path[0] !== '/' && this.host !== '') buf += '/'
      if (buf.length === 0) {
        const slash = path.indexOf('/')
        const segment = slash < 0 ? path : path.slice(0, slash)
        if (segment.includes(':')) buf += './'
      }
      buf += path
    }
    if (this.forceQuery || this.rawQuery !== '') buf += '?' + this.rawQuery
    if (this.fragment !== '') buf += '#' + this.escapedFragment()
    return buf
  }
}

function splitHostPort(hostPort: string): { host: string; port: string } {
  let host = hostPort
  let port = ''
  const colon = host.lastIndexOf(':')
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    port = host.slice(colon + 1)
    host = host.slice(0, colon)
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return { host, port }
}

function validOptionalPort(port: string): boolean {
  if (port === '') return true
  if (port[0] !== ':') return false
  for (const ch of port.slice(1)) {
    if (ch < '0' || ch > '9') return false
  }
  return true
}

function validEncoded(s: string, mode: Mode): boolean {
  for (const c of enc.encode(s)) {
    const ch = String.fromCharCode(c)
    if (c < 0x80 && "!$&'()*+,;=:@[]%".includes(ch)) continue
    if (shouldEscape(c, mode)) return false
  }
  return true
}

function getScheme(raw: string): { scheme: string; rest: string } {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) continue
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) return { scheme: '', rest: raw }
      continue
    }
    if (c === 0x3a) {
      if (i === 0) throw new UrlError('missing protocol scheme')
      return { scheme: raw.slice(0, i), rest: raw.slice(i + 1) }
    }
    return { scheme: '', rest: raw }
  }
  return { scheme: '', rest: raw }
}

/** Go's url.Parse; throws UrlError where Go returns an error. */
export function parseUrl(raw: string): GoUrl {
  const hash = raw.indexOf('#')
  const u = parse(hash < 0 ? raw : raw.slice(0, hash))
  const frag = hash < 0 ? '' : raw.slice(hash + 1)
  if (frag === '') return u
  u.fragment = unescape(frag, 'fragment')
  u.rawFragment = escape(u.fragment, 'fragment') === frag ? '' : frag
  return u
}

function parse(raw: string): GoUrl {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) throw new UrlError('net/url: invalid control character in URL')
  }
  const url = new GoUrl()
  if (raw === '*') {
    url.path = '*'
    return url
  }
  const s = getScheme(raw)
  url.scheme = s.scheme.toLowerCase()
  let rest = s.rest
  if (rest.endsWith('?') && rest.split('?').length === 2) {
    url.forceQuery = true
    rest = rest.slice(0, -1)
  } else {
    const q = rest.indexOf('?')
    if (q >= 0) {
      url.rawQuery = rest.slice(q + 1)
      rest = rest.slice(0, q)
    }
  }
  if (!rest.startsWith('/')) {
    if (url.scheme !== '') {
      url.opaque = rest
      return url
    }
    const slash = rest.indexOf('/')
    const segment = slash < 0 ? rest : rest.slice(0, slash)
    if (segment.includes(':')) throw new UrlError('first path segment in URL cannot contain colon')
  }
  if ((url.scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    let authority = rest.slice(2)
    rest = ''
    const i = authority.indexOf('/')
    if (i >= 0) {
      rest = authority.slice(i)
      authority = authority.slice(0, i)
    }
    parseAuthority(url, authority)
  } else if (url.scheme !== '' && rest.startsWith('/')) {
    url.omitHost = true
  }
  url.path = unescape(rest, 'path')
  url.rawPath = escape(url.path, 'path') === rest ? '' : rest
  return url
}

function parseAuthority(url: GoUrl, authority: string): void {
  const i = authority.lastIndexOf('@')
  url.host = parseHost(url.scheme, i < 0 ? authority : authority.slice(i + 1))
  if (i < 0) return
  const userinfo = authority.slice(0, i)
  if (!validUserinfo(userinfo)) throw new UrlError('net/url: invalid userinfo')
  const colon = userinfo.indexOf(':')
  if (colon < 0) {
    url.user = { username: unescape(userinfo, 'userPassword'), password: '', passwordSet: false }
  } else {
    url.user = {
      username: unescape(userinfo.slice(0, colon), 'userPassword'),
      password: unescape(userinfo.slice(colon + 1), 'userPassword'),
      passwordSet: true,
    }
  }
}

function parseHost(scheme: string, host: string): string {
  const open = host.lastIndexOf('[')
  if (open > 0) throw new UrlError('invalid IP-literal')
  if (open === 0) {
    const close = host.lastIndexOf(']')
    if (close < 0) throw new UrlError("missing ']' in host")
    const colonPort = host.slice(close + 1)
    if (!validOptionalPort(colonPort)) throw new UrlError('invalid port after host')
    const unescapedColonPort = unescape(colonPort, 'host')
    const name = host.slice(1, close)
    let unescapedName: string
    const zone = name.indexOf('%25')
    if (zone >= 0) {
      unescapedName = unescape(name.slice(0, zone), 'host') + unescape(name.slice(zone), 'zone')
    } else {
      unescapedName = unescape(name, 'host')
    }
    const addr = parseAddr(unescapedName)
    if (!addr) throw new UrlError('invalid host')
    if (addr.bytes.length === 4) throw new UrlError('invalid IP-literal')
    return '[' + unescapedName + ']' + unescapedColonPort
  }
  let i = host.indexOf(':')
  if (i !== -1) {
    const last = host.lastIndexOf(':')
    // Go is strict about extra colons for http and https only (urlstrictcolons).
    if (last !== i && scheme !== 'http' && scheme !== 'https') i = last
    if (!validOptionalPort(host.slice(i))) throw new UrlError('invalid port after host')
  }
  return unescape(host, 'host')
}

function validUserinfo(s: string): boolean {
  for (const ch of s) {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) continue
    if ("-._:~!$&'()*+,;=%@".includes(ch)) continue
    return false
  }
  return true
}

/** Go's url.Values: keys in insertion order, each with its values. */
export type Values = Map<string, string[]>

/** Go's url.ParseQuery: every valid pair, plus the first error if any. */
export function parseQuery(query: string): { values: Values; err?: UrlError } {
  const values: Values = new Map()
  let err: UrlError | undefined
  if (query.split('&').length > 10000) {
    return { values, err: new UrlError('number of URL query parameters exceeded limit') }
  }
  let rest = query
  while (rest !== '') {
    const amp = rest.indexOf('&')
    let key = amp < 0 ? rest : rest.slice(0, amp)
    rest = amp < 0 ? '' : rest.slice(amp + 1)
    if (key.includes(';')) {
      err = new UrlError('invalid semicolon separator in query')
      continue
    }
    if (key === '') continue
    const eq = key.indexOf('=')
    let value = eq < 0 ? '' : key.slice(eq + 1)
    key = eq < 0 ? key : key.slice(0, eq)
    try {
      key = queryUnescape(key)
      value = queryUnescape(value)
    } catch (e) {
      err ??= e as UrlError
      continue
    }
    const vs = values.get(key)
    if (vs) vs.push(value)
    else values.set(key, [value])
  }
  return { values, err }
}

// Go sorts strings by bytes; code point order is the same thing.
function compareBytes(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** Go's Values.Encode: sorted by key, Go's escaping. */
export function encodeValues(v: Values): string {
  const parts: string[] = []
  for (const k of [...v.keys()].sort(compareBytes)) {
    const ke = queryEscape(k)
    for (const x of v.get(k)!) parts.push(ke + '=' + queryEscape(x))
  }
  return parts.join('&')
}

/** A parsed IP address: 4 bytes for IPv4, 16 for IPv6. */
export interface Addr {
  bytes: Uint8Array
  zone: string
}

/** Go's netip.ParseAddr, or undefined where Go returns an error. */
export function parseAddr(s: string): Addr | undefined {
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case '.':
        return parseIPv4(s)
      case ':':
        return parseIPv6(s)
      case '%':
        return undefined
    }
  }
  return undefined
}

function parseIPv4Fields(s: string, out: Uint8Array, at: number): boolean {
  let val = 0
  let pos = 0
  let digits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x30 && c <= 0x39) {
      if (digits === 1 && val === 0) return false
      val = val * 10 + (c - 0x30)
      digits++
      if (val > 255) return false
    } else if (c === 0x2e) {
      if (i === 0 || i === s.length - 1 || s[i - 1] === '.') return false
      if (pos === 3) return false
      out[at + pos] = val
      pos++
      val = 0
      digits = 0
    } else {
      return false
    }
  }
  if (pos < 3) return false
  out[at + 3] = val
  return true
}

function parseIPv4(s: string): Addr | undefined {
  const bytes = new Uint8Array(4)
  return parseIPv4Fields(s, bytes, 0) ? { bytes, zone: '' } : undefined
}

function parseIPv6(input: string): Addr | undefined {
  let s = input
  let zone = ''
  const pct = s.indexOf('%')
  if (pct !== -1) {
    zone = s.slice(pct + 1)
    s = s.slice(0, pct)
    if (zone === '') return undefined
  }
  const ip = new Uint8Array(16)
  let ellipsis = -1
  if (s.length >= 2 && s[0] === ':' && s[1] === ':') {
    ellipsis = 0
    s = s.slice(2)
    if (s.length === 0) return { bytes: ip, zone }
  }
  let i = 0
  while (i < 16) {
    let off = 0
    let acc = 0
    for (; off < s.length; off++) {
      const c = s.charCodeAt(off)
      if (c >= 0x30 && c <= 0x39) acc = acc * 16 + (c - 0x30)
      else if (c >= 0x61 && c <= 0x66) acc = acc * 16 + (c - 0x61 + 10)
      else if (c >= 0x41 && c <= 0x46) acc = acc * 16 + (c - 0x41 + 10)
      else break
      if (off > 3) return undefined
      if (acc > 0xffff) return undefined
    }
    if (off === 0) return undefined
    if (off < s.length && s[off] === '.') {
      if (ellipsis < 0 && i !== 12) return undefined
      if (i + 4 > 16) return undefined
      if (!parseIPv4Fields(s, ip, i)) return undefined
      s = ''
      i += 4
      break
    }
    ip[i] = acc >> 8
    ip[i + 1] = acc & 0xff
    i += 2
    s = s.slice(off)
    if (s.length === 0) break
    if (s[0] !== ':') return undefined
    if (s.length === 1) return undefined
    s = s.slice(1)
    if (s[0] === ':') {
      if (ellipsis >= 0) return undefined
      ellipsis = i
      s = s.slice(1)
      if (s.length === 0) break
    }
  }
  if (s.length !== 0) return undefined
  if (i < 16) {
    if (ellipsis < 0) return undefined
    const n = 16 - i
    for (let j = i - 1; j >= ellipsis; j--) ip[j + n] = ip[j]
    ip.fill(0, ellipsis, ellipsis + n)
  } else if (ellipsis >= 0) {
    return undefined
  }
  return { bytes: ip, zone }
}

/** The IPv4 address inside an IPv4-mapped IPv6 one (Go's Unmap), else a itself. */
export function unmap(a: Addr): Addr {
  const b = a.bytes
  if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return { bytes: b.slice(12), zone: '' }
  }
  return a
}

/** Go's net.ParseIP(host).IsLoopback() (no zones; mapped IPv4 counts). */
export function isLoopbackIp(host: string): boolean {
  const a = parseAddr(host)
  if (!a || a.zone !== '') return false
  const u = unmap(a)
  if (u.bytes.length === 4) return u.bytes[0] === 127
  return u.bytes.every((x, i) => x === (i === 15 ? 1 : 0))
}

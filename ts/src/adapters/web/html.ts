// HTML templating that escapes like Go's html/template: every interpolated
// value is escaped for where it lands (text, an attribute, or a URL
// attribute), unless it's SafeHtml, which is trusted markup.
//
//   html`<a href="${url}">${name}</a>`
//
// Arrays are joined; undefined, null and false render as nothing. Inside
// <script>, values are HTML-escaped rather than JS-escaped: put only raw()
// trusted code there, as the code page does.

/** Markup that is already safe to put in a page as-is. */
export class SafeHtml {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

/** Marks a trusted string (never one from a user or an agent) as markup. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s)
}

// Go's htmlReplacementTable, for text, RCDATA and quoted attribute values.
const htmlReplacements: Record<string, string> = {
  '\0': '\uFFFD',
  '"': '&#34;',
  '&': '&amp;',
  "'": '&#39;',
  '+': '&#43;',
  '<': '&lt;',
  '>': '&gt;',
}

/** Escapes s exactly as html/template does in text and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[\0"&'+<>]/g, (c) => htmlReplacements[c])
}

const utf8 = new TextEncoder()

function isHex(c: string): boolean {
  return /^[0-9a-fA-F]$/.test(c)
}

// html/template's processURLOnto: percent-encodes a URL byte by byte with
// lowercase hex. norm keeps reserved characters and existing %xx escapes
// (urlNormalizer); otherwise everything but unreserved characters is
// escaped (urlEscaper).
function processUrl(s: string, norm: boolean): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const code = s.charCodeAt(i)
    if (code >= 0x80) {
      // A non-ASCII character: escape its UTF-8 bytes (a surrogate pair is one character).
      const end = code >= 0xd800 && code <= 0xdbff && i + 1 < s.length ? i + 2 : i + 1
      for (const b of utf8.encode(s.slice(i, end))) out += '%' + b.toString(16).padStart(2, '0')
      i = end - 1
      continue
    }
    if ('!#$&*+,/:;=?@[]'.includes(c)) {
      if (norm) {
        out += c
        continue
      }
    } else if ('-._~'.includes(c) || /[a-zA-Z0-9]/.test(c)) {
      out += c
      continue
    } else if (c === '%' && norm && i + 2 < s.length && isHex(s[i + 1]) && isHex(s[i + 2])) {
      out += c
      continue
    }
    out += '%' + code.toString(16).padStart(2, '0')
  }
  return out
}

/** html/template's urlNormalizer. */
export function normalizeUrl(s: string): string {
  return processUrl(s, true)
}

/** html/template's urlEscaper. */
export function escapeUrl(s: string): string {
  return processUrl(s, false)
}

/** html/template's urlFilter: only http, https and mailto URLs, or relative ones. */
export function filterUrl(s: string): string {
  const colon = s.indexOf(':')
  if (colon >= 0) {
    const protocol = s.slice(0, colon)
    if (!protocol.includes('/') && !/^(https?|mailto)$/i.test(protocol)) return '#ZgotmplZ'
  }
  return s
}

// Attributes whose values are URLs (html/template's attrTypeMap, plus any
// name containing src, uri or url).
const urlAttrs = new Set([
  'action', 'archive', 'background', 'cite', 'classid', 'codebase', 'data', 'formaction', 'href', 'icon',
  'longdesc', 'manifest', 'poster', 'profile', 'src', 'usemap', 'xmlns',
])

function isUrlAttr(name: string): boolean {
  name = name.toLowerCase()
  if (name.startsWith('data-')) name = name.slice(5)
  if (name.includes(':')) return name.startsWith('xmlns:')
  return urlAttrs.has(name) || name.includes('src') || name.includes('uri') || name.includes('url')
}

// Where an interpolation lands, from the template text before it.
type Context =
  | { kind: 'text' }
  | { kind: 'tag' }
  | { kind: 'attr'; quote: string; url: boolean; urlPart: 'none' | 'path' | 'query' }

// The tokenizer's state between the static parts of one template.
interface Scan {
  state: 'text' | 'tag' | 'attrName' | 'afterName' | 'beforeValue' | 'value' | 'comment'
  attr: string
  quote: string
  url: boolean
  urlPart: 'none' | 'path' | 'query'
}

function advance(s: Scan, text: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    switch (s.state) {
      case 'text':
        if (c === '<') {
          if (text.startsWith('<!--', i)) {
            s.state = 'comment'
            i += 3
          } else if (/[a-zA-Z/!?]/.test(text[i + 1] ?? '')) {
            s.state = 'tag'
            while (i + 1 < text.length && !/[\s>]/.test(text[i + 1])) i++
          }
        }
        break
      case 'comment':
        if (text.startsWith('-->', i)) {
          s.state = 'text'
          i += 2
        }
        break
      case 'tag':
        if (c === '>') s.state = 'text'
        else if (!/[\s/]/.test(c)) {
          s.state = 'attrName'
          s.attr = c
        }
        break
      case 'attrName':
        if (c === '=') s.state = 'beforeValue'
        else if (c === '>') s.state = 'text'
        else if (/\s/.test(c)) s.state = 'afterName'
        else s.attr += c
        break
      case 'afterName':
        if (c === '=') s.state = 'beforeValue'
        else if (c === '>') s.state = 'text'
        else if (!/\s/.test(c)) {
          s.state = 'attrName'
          s.attr = c
        }
        break
      case 'beforeValue':
        if (/\s/.test(c)) break
        s.state = 'value'
        s.url = isUrlAttr(s.attr)
        s.urlPart = 'none'
        if (c === '"' || c === "'") s.quote = c
        else {
          s.quote = ''
          i-- // the first character of an unquoted value
        }
        break
      case 'value':
        if (s.quote ? c === s.quote : /[\s>]/.test(c)) {
          s.state = c === '>' ? 'text' : 'tag'
        } else if (s.url) {
          if (c === '?' || c === '#') s.urlPart = 'query'
          else if (s.urlPart === 'none' && !/\s/.test(c)) s.urlPart = 'path'
        }
        break
    }
  }
}

function contextOf(s: Scan): Context {
  switch (s.state) {
    case 'value':
      return { kind: 'attr', quote: s.quote, url: s.url, urlPart: s.urlPart }
    case 'beforeValue':
      // An unquoted value starts here.
      return { kind: 'attr', quote: '', url: isUrlAttr(s.attr), urlPart: 'none' }
    case 'text':
    case 'comment':
      return { kind: 'text' }
    default:
      return { kind: 'tag' }
  }
}

function escapeIn(ctx: Context, v: unknown): string {
  if (v === undefined || v === null || v === false) return ''
  if (Array.isArray(v)) return v.map((x) => escapeIn(ctx, x)).join('')
  if (v instanceof SafeHtml) return v.value
  const s = String(v)
  if (ctx.kind !== 'attr' || !ctx.url) return escapeHtml(s)
  switch (ctx.urlPart) {
    case 'none':
      return escapeHtml(normalizeUrl(filterUrl(s)))
    case 'path':
      return escapeHtml(normalizeUrl(s))
    case 'query':
      return escapeHtml(escapeUrl(s))
  }
}

// The contexts of each template's interpolations, worked out once per call site.
const contexts = new WeakMap<TemplateStringsArray, Context[]>()

function contextsOf(strings: TemplateStringsArray): Context[] {
  let out = contexts.get(strings)
  if (!out) {
    out = []
    const scan: Scan = { state: 'text', attr: '', quote: '', url: false, urlPart: 'none' }
    for (let i = 0; i < strings.length - 1; i++) {
      advance(scan, strings[i])
      out.push(contextOf(scan))
    }
    contexts.set(strings, out)
  }
  return out
}

/** The tag: escapes each value for its context and returns SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  const ctx = contextsOf(strings)
  let out = strings[0]
  for (let i = 0; i < values.length; i++) {
    out += escapeIn(ctx[i], values[i]) + strings[i + 1]
  }
  return new SafeHtml(out)
}

/** Joins fragments, like a template's range. */
export function join(parts: Iterable<SafeHtml | string>, sep = ''): SafeHtml {
  const out: string[] = []
  for (const p of parts) out.push(p instanceof SafeHtml ? p.value : escapeHtml(p))
  return new SafeHtml(out.join(sep))
}

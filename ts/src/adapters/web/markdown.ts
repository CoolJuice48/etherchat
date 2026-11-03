// Markdown for agent-written text: files, posts, and request bodies.
//
// It renders like the Go server's goldmark setup (GFM, with its own link
// renderers): raw HTML is parsed but never output (goldmark writes
// "<!-- raw HTML omitted -->" in its place), dangerous URL schemes get an
// empty href, and external links get rel="noopener noreferrer nofollow" with
// the full URL shown beside them. The page's Content-Security-Policy blocks
// images from other origins, which stops the markdown-image exfiltration trick.
//
// markdown-it does the parsing. Where goldmark differs, rules here follow
// goldmark: its linkify, single-tilde strikethrough rendered as <del>, task
// list checkboxes, and URLs escaped with its URLEscape.

import markdownIt from 'markdown-it'
import type { MarkdownIt, StateCore, StateInline, Token } from 'markdown-it'
import { SafeHtml } from './html.ts'

// ---- goldmark's escaping ----

/** goldmark's util.EscapeHTML. */
function escapeHtml(s: string): string {
  return s.replace(/[\0"&<>]/g, (c) => ({ '\0': '\uFFFD', '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
}

const asciiPunct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
const isPunct = (c: string | undefined) => c !== undefined && c.length === 1 && asciiPunct.includes(c)
const isAlphaNumeric = (c: string | undefined) => c !== undefined && /^[a-zA-Z0-9]$/.test(c)

// Characters goldmark's URLEscape leaves alone.
const urlSafe = new Set("!#$&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~")
const utf8 = new TextEncoder()

function unescapePunctuations(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function validRune(v: number): string {
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '\uFFFD'
  return String.fromCodePoint(v)
}

function resolveNumericReferences(s: string): string {
  return s.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]{1,7}));/g, (m, hex: string | undefined, dec: string | undefined) => {
    const v = hex !== undefined ? parseInt(hex.slice(-8), 16) : parseInt(dec as string, 10)
    return validRune(hex !== undefined && hex.length > 8 ? 0x110000 : v)
  })
}

let decodeEntity: (s: string) => string = (s) => s

function resolveEntityNames(s: string): string {
  return s.replace(/&([a-zA-Z0-9]+);/g, (m) => decodeEntity(m))
}

/** goldmark's util.URLEscape. */
function urlEscape(v: string, resolveReference: boolean): string {
  if (resolveReference) v = resolveEntityNames(resolveNumericReferences(unescapePunctuations(v)))
  let out = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (urlSafe.has(c)) out += c
    else if (c === '%' && i + 2 < v.length && /[0-9a-fA-F]/.test(v[i + 1]) && /[0-9a-fA-F]/.test(v[i + 2])) {
      out += v.slice(i, i + 3)
      i += 2
    } else if (c === ' ') out += '%20'
    else {
      // url.QueryEscape of one character: its UTF-8 bytes, uppercase hex.
      const code = v.codePointAt(i) as number
      const ch = String.fromCodePoint(code)
      for (const b of utf8.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
      i += ch.length - 1
    }
  }
  return out
}

/** goldmark's html.IsDangerousURL. */
function isDangerousUrl(url: string): boolean {
  const l = url.toLowerCase()
  if (l.startsWith('data:image/') && url.length >= 11) {
    return !/^(png|gif|jpeg|webp);/.test(l.slice(11))
  }
  return l.startsWith('javascript:') || l.startsWith('vbscript:') || l.startsWith('file:') || l.startsWith('data:')
}

function isExternal(url: string): boolean {
  const l = url.toLowerCase()
  return l.startsWith('http://') || l.startsWith('https://') || l.startsWith('//') || l.startsWith('mailto:')
}

const externalRel = ' rel="noopener noreferrer nofollow"'

// A link title that was given but empty: markdown-it drops empty titles,
// goldmark keeps them as title="".
const emptyTitle = '\uE000'

// ---- goldmark's linkify ----

const urlRegexp = /^(?:http|https|ftp):\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-z]+(?::\d+)?(?:[/#?][-a-zA-Z0-9@:%_+.~#$!?&/=();,'">^{}[\]`]*)?/
const wwwRegexp = /^www\.[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-z]+(?:[/#?][-a-zA-Z0-9@:%_+.~#!?&/=();,'">^{}[\]`]*)?/
const emailLocal = new Set("!#$%&'*+-./0123456789=?ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz{|}~")
const emailDomain = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*/

/** goldmark's util.FindEmailIndex. */
function findEmailIndex(b: string): number {
  let i = 0
  while (i < b.length && emailLocal.has(b[i])) i++
  if (i === 0 || i >= b.length || b[i] !== '@') return -1
  i++
  if (i >= b.length) return -1
  const m = emailDomain.exec(b.slice(i))
  return m ? i + m[0].length : -1
}

const count = (s: string, c: string) => s.split(c).length - 1

// Whether goldmark would be inside a link label here: after a "[" whose "]"
// hasn't come yet in this paragraph. It doesn't linkify there.
function inLinkLabel(state: StateInline): boolean {
  let depth = 0
  const scan = (s: string) => {
    for (const c of s) {
      if (c === '[') depth++
      else if (c === ']') depth = Math.max(0, depth - 1)
    }
  }
  let inLink = 0
  for (const t of state.tokens) {
    if (t.type === 'link_open') inLink++
    else if (t.type === 'link_close') inLink--
    else if (t.type === 'text' && inLink === 0) scan(t.content)
  }
  scan(state.pending)
  return depth > 0
}

// Whether the tokenizer is where goldmark tries its inline parsers on any
// character: the start of a line, or right after an inline node.
function atNodeBoundary(state: StateInline): boolean {
  if (state.pending !== '') return false
  const last = state.tokens[state.tokens.length - 1]
  return !last || last.type !== 'text_special'
}

// goldmark's strikethrough parser takes runs of one or two tildes not
// preceded by a tilde.
function strikeDelimiterAt(state: StateInline, pos: number): boolean {
  if (state.src[pos] !== '~' || (pos > 0 && state.src[pos - 1] === '~')) return false
  let end = pos
  while (state.src[end] === '~') end++
  return end - pos <= 2
}

function linkify(state: StateInline, silent: boolean): boolean {
  // Silent runs skip over a link label, where goldmark doesn't linkify.
  if (silent || state.linkLevel > 0 || state.env.inImageLabel) return false
  const src = state.src
  let pos = state.pos
  const c = src[pos]
  let consumed = ''
  if (c === ' ' || c === '(' || (c === '~' && !strikeDelimiterAt(state, pos))) {
    consumed = c
    pos++
  } else if (!atNodeBoundary(state) || isPunct(c) || c === '\n') {
    return false
  }
  const nl = src.indexOf('\n', pos)
  const line = src.slice(pos, nl < 0 || nl >= state.posMax ? state.posMax : nl + 1)

  let m: { end: number; start: number } | undefined
  let protocol = ''
  let email = false
  if (line.startsWith('http:') || line.startsWith('https:') || line.startsWith('ftp:')) {
    const r = urlRegexp.exec(line)
    if (r) m = { start: 0, end: r[0].length }
  }
  if (!m && line.startsWith('www.')) {
    const r = wwwRegexp.exec(line)
    if (r) {
      m = { start: 0, end: r[0].length }
      protocol = 'http'
    }
  }
  if (!m) {
    if (line.length > 0 && isPunct(line[0])) return false
    email = true
    const stop = findEmailIndex(line)
    if (stop < 0) return false
    const at = line.indexOf('@')
    if (!line.slice(at, stop - 1).includes('.')) return false
    m = { start: 0, end: stop }
    if (line[m.end - 1] === '.') m.end--
    if (m.end < line.length && (line[m.end] === '-' || line[m.end] === '_')) return false
  }

  let i = m.end - 1
  while (i > 0 && '?!.,:*_~'.includes(line[i])) i--
  i++
  if (line[i - 1] === ')') {
    i -= Math.max(0, count(line.slice(0, i), ')') - count(line.slice(0, i), '('))
  } else if (line[i - 1] === ';') {
    let j = i - 2
    while (j >= m.start && isAlphaNumeric(line[j])) j--
    if (j !== i - 2 && line[j] === '&') i = j
  }
  if (inLinkLabel(state)) return false

  const text = line.slice(0, i)
  state.pending += consumed
  const open = state.push('link_open', 'a', 1)
  open.attrs = [['href', email ? 'mailto:' + text : protocol ? protocol + '://' + text : text]]
  open.markup = 'linkify'
  open.info = 'auto'
  const t = state.push('text', '', 0)
  t.content = text
  const close = state.push('link_close', 'a', -1)
  close.markup = 'linkify'
  close.info = 'auto'
  state.pos = pos + i
  return true
}

// The text rule, stopping at spaces and "(" too, so linkify sees them.
function text(state: StateInline, silent: boolean): boolean {
  let pos = state.pos
  while (pos < state.posMax && !/[\n!#$%&*+\-:<=>@[\\\]^_`{}~ (]/.test(state.src[pos])) pos++
  if (pos === state.pos) return false
  if (!silent) state.pending += state.src.slice(state.pos, pos)
  state.pos = pos
  return true
}

// goldmark keeps some of a line's trailing whitespace: its linkify parser
// splits text at each space, and only the last piece is trimmed. So a soft
// break drops one trailing space or tab, and a hard break ("  " before the
// newline) drops three.
function newline(state: StateInline, silent: boolean): boolean {
  let pos = state.pos
  if (state.src.charCodeAt(pos) !== 0x0a) return false
  if (!silent) {
    const ws = (/[ \t\v\f]*$/.exec(state.pending) as RegExpExecArray)[0]
    const hard = ws.endsWith('  ')
    const kept = ws.slice(0, Math.max(0, ws.length - (hard ? 3 : 1)))
    state.pending = state.pending.slice(0, state.pending.length - ws.length) + kept
    state.push(hard ? 'hardbreak' : 'softbreak', 'br', 0)
  }
  pos++
  while (pos < state.posMax && (state.src[pos] === ' ' || state.src[pos] === '\t')) pos++
  state.pos = pos
  return true
}

// ---- goldmark's strikethrough: one or two tildes, rendered as <del> ----

function strikethrough(state: StateInline, silent: boolean): boolean {
  if (silent || !strikeDelimiterAt(state, state.pos)) return false
  const scanned = state.scanDelims(state.pos, true)
  for (let i = 0; i < scanned.length; i++) {
    const token = state.push('text', '', 0)
    token.content = '~'
    state.delimiters.push({
      marker: 0x7e, length: scanned.length, token: state.tokens.length - 1,
      end: -1, open: scanned.can_open, close: scanned.can_close,
    })
  }
  state.pos += scanned.length
  return true
}

function strikethroughPairs(state: StateInline, delimiters: StateInline['delimiters']): void {
  for (let i = delimiters.length - 1; i >= 0; i--) {
    const start = delimiters[i]
    if (start.marker !== 0x7e || start.end === -1) continue
    const end = delimiters[start.end]
    // Two matched tildes in a row make one <del>, as goldmark consumes both.
    const double = i > 0 && delimiters[i - 1].end === start.end + 1 && delimiters[i - 1].marker === 0x7e &&
      delimiters[i - 1].token === start.token - 1 && delimiters[start.end + 1].token === end.token + 1
    const open = state.tokens[start.token]
    open.type = 'del_open'
    open.tag = 'del'
    open.nesting = 1
    open.content = ''
    const close = state.tokens[end.token]
    close.type = 'del_close'
    close.tag = 'del'
    close.nesting = -1
    close.content = ''
    if (double) {
      state.tokens[delimiters[i - 1].token].content = ''
      state.tokens[delimiters[start.end + 1].token].content = ''
      i--
    }
  }
}

function strikethroughPostProcess(state: StateInline): boolean {
  strikethroughPairs(state, state.delimiters)
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters) strikethroughPairs(state, meta.delimiters)
  }
  return false
}

// ---- task list checkboxes ----

const taskRegexp = /^\[([\t\n\f\r xX])\][\t\n\f\r ]*/

// goldmark parses "[ ]" or "[x]" at the very start of a list item's first
// block as a checkbox. This takes it off the text before inline parsing.
function taskLists(state: StateCore): boolean {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'inline' || tokens[i - 2].type !== 'list_item_open') continue
    if (tokens[i - 1].type !== 'paragraph_open' && tokens[i - 1].type !== 'heading_open') continue
    const m = taskRegexp.exec(t.content)
    if (!m) continue
    t.content = t.content.slice(m[0].length)
    t.meta = { ...(t.meta ?? {}), task: m[1] === 'x' || m[1] === 'X' ? 'checked' : 'unchecked' }
  }
  return false
}

function taskCheckboxes(state: StateCore): boolean {
  for (const t of state.tokens) {
    const task = t.meta?.task
    if (t.type !== 'inline' || !task) continue
    const box = new state.Token('task_checkbox', 'input', 0)
    box.meta = { checked: task === 'checked' }
    t.children = [box, ...(t.children ?? [])]
  }
  return false
}

// ---- raw HTML: parsed, then omitted ----

// HTML block kinds 1-5 end at a closing marker; goldmark writes a second
// "omitted" comment when that marker is on a later line.
const closingKinds: [RegExp, RegExp][] = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
]

function htmlBlock(tokens: Token[], idx: number): string {
  const lines = tokens[idx].content.replace(/\n$/, '').split('\n')
  const first = lines[0].replace(/^ {0,3}/, '')
  for (const [open, close] of closingKinds) {
    if (!open.test(first)) continue
    if (lines.length > 1 && !close.test(first) && close.test(lines[lines.length - 1])) {
      return '<!-- raw HTML omitted -->\n<!-- raw HTML omitted -->\n'
    }
    break
  }
  return '<!-- raw HTML omitted -->\n'
}

// ---- the renderer ----

function matchingOpen(tokens: Token[], idx: number): Token | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    if (tokens[i].type === 'link_open') return tokens[i]
  }
  return undefined
}

// An image's alt text, as goldmark's renderTexts writes it.
function altText(tokens: Token[] | null): string {
  let out = ''
  let auto = 0
  for (const t of tokens ?? []) {
    if (t.type === 'link_open' && t.info === 'auto') auto++
    else if (t.type === 'link_close' && t.info === 'auto') auto--
    else if (auto > 0) continue
    else if (t.type === 'text' || t.type === 'text_special' || t.type === 'code_inline') out += escapeHtml(t.content)
    else if (t.type === 'softbreak') out += '\n'
    else if (t.type === 'hardbreak') out += '<br>\n'
    else if (t.type === 'image') out += altText(t.children)
  }
  return out
}

function newMarkdown(): MarkdownIt {
  const md = new markdownIt('default', { html: true, linkify: false, typographer: false })
  decodeEntity = (s) => md.utils.unescapeAll(s)

  // Keep destinations and titles as written, the way goldmark's AST holds
  // them; the renderer escapes them as goldmark does.
  md.validateLink = () => true
  md.normalizeLink = (s) => s
  md.normalizeLinkText = (s) => s
  const parseDestination = md.helpers.parseLinkDestination
  md.helpers.parseLinkDestination = (str, start, max) => {
    const res = parseDestination(str, start, max)
    if (res.ok) res.str = str.charCodeAt(start) === 0x3c ? str.slice(start + 1, res.pos - 1) : str.slice(start, res.pos)
    return res
  }
  const parseTitle = md.helpers.parseLinkTitle
  md.helpers.parseLinkTitle = (str, start, max, prev) => {
    const res = parseTitle(str, start, max, prev)
    if (res.ok && !prev) res.str = str.slice(start + 1, res.pos - 1) || emptyTitle
    return res
  }

  md.disable(['strikethrough', 'linkify'])
  md.inline.ruler.at('text', text)
  md.inline.ruler.at('newline', newline)
  md.inline.ruler.before('text', 'gm_linkify', linkify)
  md.inline.ruler.before('emphasis', 'gm_strikethrough', strikethrough)
  md.inline.ruler2.before('emphasis', 'gm_strikethrough', strikethroughPostProcess)
  // goldmark doesn't linkify inside an image's label.
  const imageIndex = md.inline.ruler.__find__('image')
  const image = md.inline.ruler.__rules__[imageIndex].fn
  md.inline.ruler.at('image', (state, silent) => {
    const was = state.env.inImageLabel
    state.env.inImageLabel = true
    try {
      return image(state, silent)
    } finally {
      state.env.inImageLabel = was
    }
  })
  md.core.ruler.before('inline', 'gm_tasks', taskLists)
  md.core.ruler.after('inline', 'gm_checkboxes', taskCheckboxes)

  const rules = md.renderer.rules
  rules.blockquote_open = () => '<blockquote>\n'
  rules.html_block = (tokens, idx) => htmlBlock(tokens, idx)
  rules.html_inline = () => '<!-- raw HTML omitted -->'
  rules.task_checkbox = (tokens, idx) =>
    tokens[idx].meta?.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> '
  rules.text = (tokens, idx) => escapeHtml(tokens[idx].content)
  rules.link_open = (tokens, idx) => {
    const t = tokens[idx]
    const dest = String(t.attrGet('href') ?? '')
    if (t.info === 'auto') {
      const url = urlEscape(dest, false)
      return `<a href="${isDangerousUrl(url) ? '' : escapeHtml(url)}"${externalRel}>`
    }
    let out = `<a href="${isDangerousUrl(dest) ? '' : escapeHtml(urlEscape(dest, true))}"`
    if (isExternal(dest)) out += externalRel
    const title = t.attrGet('title')
    if (title !== null) out += ` title="${title === emptyTitle ? '' : escapeHtml(String(title))}"`
    return out + '>'
  }
  rules.link_close = (tokens, idx) => {
    if (tokens[idx].info === 'auto') return '</a>'
    const dest = String(matchingOpen(tokens, idx)?.attrGet('href') ?? '')
    return isExternal(dest) ? `</a> <span class="url">(${escapeHtml(dest)})</span>` : '</a>'
  }
  rules.image = (tokens, idx) => {
    const t = tokens[idx]
    const dest = urlEscape(String(t.attrGet('src') ?? ''), true)
    let out = `<img src="${isDangerousUrl(dest) ? '' : escapeHtml(dest)}" alt="${altText(t.children)}"`
    const title = t.attrGet('title')
    if (title !== null) {
      out += ` title="${title === emptyTitle ? '' : escapeHtml(md.utils.unescapeAll(String(title)))}"`
    }
    return out + '>'
  }
  // A tight list item's text is followed by a newline before a block, as
  // goldmark writes it (markdown-it's own rules only do this for tags).
  for (const name of ['fence', 'code_block', 'html_block', 'blockquote_open']) {
    const rule = rules[name] ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
    rules[name] = (tokens, idx, options, env, self) =>
      (idx > 0 && tokens[idx - 1].hidden ? '\n' : '') + rule(tokens, idx, options, env, self)
  }
  return md
}

let md: MarkdownIt | undefined

/** Renders agent-written markdown to safe HTML. */
export function renderMarkdown(src: string): SafeHtml {
  md ??= newMarkdown()
  return new SafeHtml(md.render(src, {}))
}

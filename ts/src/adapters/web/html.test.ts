import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, html, join, raw, SafeHtml } from './html.ts'

// Each value rendered as html/template would in text, a plain attribute, a
// URL attribute (at the start, in the path, in the query, in the fragment).
const page = (v: string) =>
  html`<p title="${v}">${v}</p><a href="${v}">x</a><a href="/x/${v}">x</a><a href="/x?q=${v}">x</a><a href="#${v}">x</a>`.value

// Expected outputs are Go's html/template's.
const cases: [string, string][] = [
  ["a'b\"c<d>&e+f",
    '<p title="a&#39;b&#34;c&lt;d&gt;&amp;e&#43;f">a&#39;b&#34;c&lt;d&gt;&amp;e&#43;f</p><a href="a%27b%22c%3cd%3e&amp;e&#43;f">x</a><a href="/x/a%27b%22c%3cd%3e&amp;e&#43;f">x</a><a href="/x?q=a%27b%22c%3cd%3e%26e%2bf">x</a><a href="#a%27b%22c%3cd%3e%26e%2bf">x</a>'],
  ['/e/abc?x=1&y=2#frag',
    '<p title="/e/abc?x=1&amp;y=2#frag">/e/abc?x=1&amp;y=2#frag</p><a href="/e/abc?x=1&amp;y=2#frag">x</a><a href="/x//e/abc?x=1&amp;y=2#frag">x</a><a href="/x?q=%2fe%2fabc%3fx%3d1%26y%3d2%23frag">x</a><a href="#%2fe%2fabc%3fx%3d1%26y%3d2%23frag">x</a>'],
  ['javascript:alert(1)',
    '<p title="javascript:alert(1)">javascript:alert(1)</p><a href="#ZgotmplZ">x</a><a href="/x/javascript:alert%281%29">x</a><a href="/x?q=javascript%3aalert%281%29">x</a><a href="#javascript%3aalert%281%29">x</a>'],
  ['/path with spaces/é',
    '<p title="/path with spaces/é">/path with spaces/é</p><a href="/path%20with%20spaces/%c3%a9">x</a><a href="/x//path%20with%20spaces/%c3%a9">x</a><a href="/x?q=%2fpath%20with%20spaces%2f%c3%a9">x</a><a href="#%2fpath%20with%20spaces%2f%c3%a9">x</a>'],
  ['%41%zz%',
    '<p title="%41%zz%">%41%zz%</p><a href="%41%25zz%25">x</a><a href="/x/%41%25zz%25">x</a><a href="/x?q=%2541%25zz%25">x</a><a href="#%2541%25zz%25">x</a>'],
  ['mailto:a@b.c',
    '<p title="mailto:a@b.c">mailto:a@b.c</p><a href="mailto:a@b.c">x</a><a href="/x/mailto:a@b.c">x</a><a href="/x?q=mailto%3aa%40b.c">x</a><a href="#mailto%3aa%40b.c">x</a>'],
  ['{}|\\^`',
    '<p title="{}|\\^`">{}|\\^`</p><a href="%7b%7d%7c%5c%5e%60">x</a><a href="/x/%7b%7d%7c%5c%5e%60">x</a><a href="/x?q=%7b%7d%7c%5c%5e%60">x</a><a href="#%7b%7d%7c%5c%5e%60">x</a>'],
  ['\0',
    '<p title="�">�</p><a href="%00">x</a><a href="/x/%00">x</a><a href="/x?q=%00">x</a><a href="#%00">x</a>'],
]

test('escapes values as html/template does, by context', () => {
  for (const [v, want] of cases) assert.equal(page(v), want, JSON.stringify(v))
})

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & 'Jerry' + 1</a>`), '&lt;a href=&#34;x&#34;&gt;Tom &amp; &#39;Jerry&#39; &#43; 1&lt;/a&gt;')
})

test('SafeHtml, nesting, arrays and empty values', () => {
  const items = ['<a>', 'b']
  assert.equal(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`.value, '<ul><li>&lt;a&gt;</li><li>b</li></ul>')
  assert.equal(html`${undefined}${null}${false}${0}${''}${true}`.value, '0true')
  assert.equal(html`<p>${raw('<b>ok</b>')}</p>`.value, '<p><b>ok</b></p>')
  assert.equal(html`<a href="/x"${true && html` aria-current="page"`}>`.value, '<a href="/x" aria-current="page">')
  assert.ok(html`x` instanceof SafeHtml)
  assert.equal(join(['<', raw('<br>')], ', ').value, '&lt;, <br>')
})

test('attribute contexts follow the template text, not values', () => {
  // A value can't open a URL query: the second value is still in the path.
  assert.equal(html`<a href="${'/x?'}${'a b'}">`.value, '<a href="/x?a%20b">')
  // Single quotes, unquoted values, and URL-ish attribute names.
  assert.equal(html`<img src='${'a b'}' data-url=${'c d'}>`.value, "<img src='a%20b' data-url=c%20d>")
  // After the tag closes, it's text again.
  assert.equal(html`<a href="${'#'}">${'a b'}</a>`.value, '<a href="#">a b</a>')
})

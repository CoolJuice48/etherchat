// TypeScript-only: the formats and validation that must agree with Go
// byte for byte. Expected values were produced by the Go code (go 1.27).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base32, goDuration, goJson, goQuote, trimSpace } from './gofmt.ts'
import { codeHmac, newId, normalizeCode, normalizeEmail } from './names.ts'

test('normalize email agrees with Go', () => {
  const ok: Record<string, string> = {
    'alex@example.com': 'alex@example.com',
    ' Alex@Example.COM ': 'alex@example.com',
    'a.b@c.d': 'a.b@c.d',
    'a@b': 'a@b',
    'a@b-c.d': 'a@b-c.d',
    'a+tag@x.io': 'a+tag@x.io',
    "a!#$%&'*/=?^_`{|}~-@x.io": "a!#$%&'*/=?^_`{|}~-@x.io",
    'a@[1.2.3.4]': 'a@[1.2.3.4]',
    'a@[::ffff:1.2.3.4]': 'a@[::ffff:1.2.3.4]',
    'a@[IPv6:::1]': 'a@[ipv6:::1]',
    'a@[IPv6:1.2.3.4]': 'a@[ipv6:1.2.3.4]',
    'a@[IPv6:2001:db8::1]': 'a@[ipv6:2001:db8::1]',
    'a@[IPv6:::ffff:1.2.3.4]': 'a@[ipv6:::ffff:1.2.3.4]',
    'j\u00f6hn@ex\u00e4mple.com': 'j\u00f6hn@ex\u00e4mple.com',
    '\u00c4LEX@EXAMPLE.COM': '\u00e4lex@example.com',
    'a@b.c\u00a0': 'a@b.c',
  }
  for (const [input, want] of Object.entries(ok)) assert.equal(normalizeEmail(input), want, input)

  const bad = [
    'Alex <alex@example.com>', 'alex@example.com (x)', '"alex"@example.com', '.a@b.c', 'a.@b.c', 'a..b@c.d',
    'a@b..c', 'a@[01.2.3.4]', 'a@[300.1.1.1]', 'a@[1.2.3]', 'a@[2001:db8::1]', 'a@[IPv6:1::2::3]', 'a b@c.d',
    'a@b c', 'a\t@b.c', '@b.c', 'a@', 'a@b.c@d', 'a'.repeat(250) + '@b.cd',
  ]
  for (const input of bad) assert.throws(() => normalizeEmail(input), { name: 'EtherError' }, input)
  assert.throws(() => normalizeEmail('"alex"@example.com'), {
    message: 'invalid request: "\\"alex\\"@example.com" is not a plain email address',
  })
  assert.throws(() => normalizeEmail('a\t@b.c'), { message: 'invalid request: "a\\t@b.c" is not a plain email address' })
})

test('quoting agrees with Go', () => {
  const cases: Record<string, string> = {
    plain: '"plain"',
    'a"b': '"a\\"b"',
    'back\\slash': '"back\\\\slash"',
    'tab\there': '"tab\\there"',
    'nl\nx': '"nl\\nx"',
    'nul\x00': '"nul\\x00"',
    '\x01\x7f': '"\\x01\\x7f"',
    '\u00fcn\u00ef': '"\u00fcn\u00ef"',
    '\u00a0nbsp': '"\\u00a0nbsp"',
    '\u00ad': '"\\u00ad"',
    '\u2028': '"\\u2028"',
    'emoji\u{1f600}': '"emoji\u{1f600}"',
    '\u{e0001}': '"\\U000e0001"',
    'bell\x07\b\f\v\r': '"bell\\a\\b\\f\\v\\r"',
  }
  for (const [input, want] of Object.entries(cases)) assert.equal(goQuote(input), want, JSON.stringify(input))
})

test('durations agree with Go', () => {
  const cases: [number, string][] = [
    [0, '0s'], [1, '1ms'], [999, '999ms'], [1000, '1s'], [1500, '1.5s'], [90_000, '1m30s'],
    [3_600_000, '1h0m0s'], [2_592_000_000, '720h0m0s'], [93_784_005, '26h3m4.005s'], [-60_000, '-1m0s'],
  ]
  for (const [ms, want] of cases) assert.equal(goDuration(ms), want)
})

test('json agrees with Go', () => {
  assert.equal(goJson({ version: 3, size: 10 }), '{"size":10,"version":3}')
  assert.equal(goJson({ intent: 'fyi', scheduled: false }), '{"intent":"fyi","scheduled":false}')
  assert.equal(goJson(['<a>', 'b&c', '\u2028', '\u00e9']), '["\\u003ca\\u003e","b\\u0026c","\\u2028","\u00e9"]')
  assert.equal(goJson([]), '[]')
})

test('codes and ids agree with Go', () => {
  const pepper = new TextEncoder().encode('p'.repeat(32))
  assert.equal(codeHmac(pepper, 'invite', normalizeCode('abcd-efgh-ijkl-mnop')),
    'acc898ef3bf477cd5376ece794e87ed280974d8f2f2a7b0394f8f09ba4a8c8ec')
  // RFC 4648 test vectors.
  const enc = (s: string) => base32(new TextEncoder().encode(s))
  assert.equal(enc(''), '')
  assert.equal(enc('f'), 'MY')
  assert.equal(enc('foob'), 'MZXW6YQ')
  assert.equal(enc('foobar'), 'MZXW6YTBOI')
  assert.match(newId(), /^[a-z2-7]{16}$/)
  assert.notEqual(newId(), newId())
})

test('trim space is Go\'s', () => {
  assert.equal(trimSpace('\u0085 x \u3000'), 'x')
  assert.equal(trimSpace('\ufeffx'), '\ufeffx') // U+FEFF isn't space to Go
})

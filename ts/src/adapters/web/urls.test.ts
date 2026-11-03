import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanPath, encodeValues, escapeUrlPath, formatMediaType, parseQuery, pathEscape, queryEscape } from './urls.ts'

// Expected values are Go's net/url, path and mime.
test('escaping matches net/url', () => {
  assert.equal(pathEscape('Week 1 notes.txt'), 'Week%201%20notes.txt')
  assert.equal(pathEscape("!$&'()*+,;=:@[]"), "%21$&%27%28%29%2A+%2C%3B=:@%5B%5D")
  assert.equal(pathEscape('a/b?c'), 'a%2Fb%3Fc')
  assert.equal(queryEscape('a b+c/é'), 'a+b%2Bc%2F%C3%A9')
  assert.equal(escapeUrlPath("/e/a,b;c/d e?f!(g)"), '/e/a,b;c/d%20e%3Ff%21%28g%29')
  assert.equal(queryEscape('~-._'), '~-._')
})

test('query parsing and encoding', () => {
  assert.deepEqual([...parseQuery('a=1&b=2&a=3')], [['a', ['1', '3']], ['b', ['2']]])
  assert.deepEqual([...parseQuery('a=%zz&b=2')], [['b', ['2']]])
  assert.deepEqual([...parseQuery('a;b=1&c=2')], [['c', ['2']]])
  assert.deepEqual([...parseQuery('x=a+b%20c&k')], [['x', ['a b c']], ['k', ['']]])
  const v = new Map(Object.entries({ page: ['2'], from: ['2026-10-01T12:00'], 'a b': ['c&d', 'e+f'] }))
  assert.equal(encodeValues(v), 'a+b=c%26d&a+b=e%2Bf&from=2026-10-01T12%3A00&page=2')
})

test('cleanPath', () => {
  assert.equal(cleanPath('/a/b/../c'), '/a/c')
  assert.equal(cleanPath('/a//b/./'), '/a/b')
  assert.equal(cleanPath('/../a'), '/a')
  assert.equal(cleanPath(''), '.')
})

test('formatMediaType', () => {
  assert.equal(formatMediaType('attachment', 'filename', 'plain.txt'), 'attachment; filename=plain.txt')
  assert.equal(formatMediaType('attachment', 'filename', 'Week 1 notes.txt'), 'attachment; filename="Week 1 notes.txt"')
  assert.equal(formatMediaType('attachment', 'filename', 'a"b\\c'), 'attachment; filename="a\\"b\\\\c"')
  assert.equal(formatMediaType('attachment', 'filename', 'é ü.md'), "attachment; filename*=utf-8''%C3%A9%20%C3%BC.md")
})

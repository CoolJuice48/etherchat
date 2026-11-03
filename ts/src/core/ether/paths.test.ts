// Port of go/core/ether/paths_test.go (paths, handles and invite codes).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePath, validHandle, ZONE_SHARED, ZONE_WORKSPACE } from './index.ts'
import { deriveHandle, newInviteCode, normalizeCode } from './names.ts'

test('parse path', () => {
  const ok: [string, string][] = [
    ['shared/plan.md', 'shared/plan.md'],
    ['shared/notes/', 'shared/notes'],
    ['members/alex/Week 3 notes.md', 'members/alex/Week 3 notes.md'],
    ['members/alex/a/b/c/d/e/f.md', 'members/alex/a/b/c/d/e/f.md'],
    ['shared', 'shared'],
  ]
  for (const [input, want] of ok) assert.equal(parsePath(input).toString(), want)

  const bad = [
    '',
    '/shared/plan.md',
    'notes/plan.md',
    'shared/../members/x.md',
    'shared//plan.md',
    'shared/.hidden.md',
    'shared/ space.md',
    'shared/trailing /x.md',
    'shared/semi;colon.md',
    'shared/ünicode.md',
    'members/alex/a/b/c/d/e/f/g.md',
    'shared/' + 'a'.repeat(260) + '.md',
  ]
  for (const input of bad) assert.throws(() => parsePath(input), { name: 'EtherError' }, `parsePath(${JSON.stringify(input)}) succeeded`)

  // The messages match Go's.
  assert.throws(() => parsePath('shared/semi;colon.md'), {
    message: `invalid request: path "shared/semi;colon.md": only letters, digits, '.', '_', '-' and spaces are allowed`,
  })
  assert.throws(() => parsePath('/x'), {
    message: `invalid request: path "/x" must not start with '/'; paths start with members/ or shared/`,
  })
})

test('path parts', () => {
  const p = parsePath('members/alex/notes/plan.md')
  assert.equal(p.zone(), ZONE_WORKSPACE)
  assert.equal(p.workspaceHandle(), 'alex')
  assert.equal(p.isRoot(), false)
  for (const root of ['members', 'members/alex', 'shared']) assert.ok(parsePath(root).isRoot(), `${root} should be a root`)
  const s = parsePath('shared/plan.md')
  assert.equal(s.zone(), ZONE_SHARED)
  assert.equal(s.workspaceHandle(), '')
  assert.equal(s.parent()?.toString(), 'shared')
  assert.equal(parsePath('shared').parent(), undefined)
  assert.deepEqual(p.ancestors().map(String), ['members', 'members/alex', 'members/alex/notes'])
})

test('handles', () => {
  const derive: Record<string, string> = {
    'alex.morgan@example.com': 'alex.morgan',
    'Alex+ether@example.com': 'alex-ether',
    '_x_@example.com': 'x',
    '...@example.com': 'user',
    ['a'.repeat(40) + '@example.com']: 'a'.repeat(28),
    // Go works on bytes: a two-byte character becomes two dashes.
    'jörg@example.com': 'j--rg',
  }
  for (const [email, want] of Object.entries(derive)) {
    assert.equal(deriveHandle(email), want, email)
    assert.ok(validHandle(deriveHandle(email)), `deriveHandle(${email}) produced an invalid handle`)
  }
  for (const h of ['', '-alex', 'alex-', 'Alex', 'ja ck', 'a'.repeat(33)]) assert.equal(validHandle(h), false, h)
  assert.ok(validHandle('a'))
  assert.ok(validHandle('a'.repeat(32)))
})

test('normalize code', () => {
  assert.equal(normalizeCode(' abcd-efgh-ijkl-mn0p '), 'ABCDEFGHIJKLMNOP')
  const code = newInviteCode()
  assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/)
})

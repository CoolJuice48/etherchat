// Port of go/core/ether/permissions_test.go: every cell of the permission matrix.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowed, parseMode, type Op, type Target } from './index.ts'

test('allowed matrix', () => {
  const ownWS: Target = { zone: 'workspace', ownWorkspace: true }
  const otherWS: Target = { zone: 'workspace' }
  const otherWSAsOwner: Target = { zone: 'workspace', isOwner: true }
  const sharedAO = (isAuthor: boolean, isOwner: boolean): Target => ({ zone: 'shared', isAuthor, isOwner, mode: 'author_only' })
  const sharedSE = (isAuthor: boolean, isOwner: boolean): Target => ({ zone: 'shared', isAuthor, isOwner, mode: 'shared_edit' })
  const newShared: Target = { zone: 'shared' }

  const cases: [string, Op, Target, boolean][] = [
    // Read: every member, everywhere.
    ['read own workspace', 'read', ownWS, true],
    ['read other workspace', 'read', otherWS, true],
    ['read shared author_only, not author', 'read', sharedAO(false, false), true],
    ['read shared shared_edit, not author', 'read', sharedSE(false, false), true],

    // Create.
    ['create in own workspace', 'create', ownWS, true],
    ['create in other workspace', 'create', otherWS, false],
    ['create in other workspace as owner', 'create', otherWSAsOwner, false],
    ['create in shared', 'create', newShared, true],

    // Edit.
    ['edit own workspace', 'edit', ownWS, true],
    ['edit other workspace', 'edit', otherWS, false],
    ['edit other workspace as owner', 'edit', otherWSAsOwner, false],
    ['edit shared author_only as author', 'edit', sharedAO(true, false), true],
    ['edit shared author_only as member', 'edit', sharedAO(false, false), false],
    ['edit shared author_only as owner', 'edit', sharedAO(false, true), false],
    ['edit shared shared_edit as author', 'edit', sharedSE(true, false), true],
    ['edit shared shared_edit as member', 'edit', sharedSE(false, false), true],
    ['edit shared shared_edit as owner', 'edit', sharedSE(false, true), true],

    // Delete.
    ['delete own workspace', 'delete', ownWS, true],
    ['delete other workspace', 'delete', otherWS, false],
    ['delete other workspace as owner', 'delete', otherWSAsOwner, false],
    ['delete shared author_only as author', 'delete', sharedAO(true, false), true],
    ['delete shared author_only as member', 'delete', sharedAO(false, false), false],
    ['delete shared author_only as owner', 'delete', sharedAO(false, true), false],
    ['delete shared shared_edit as author', 'delete', sharedSE(true, false), true],
    ['delete shared shared_edit as member', 'delete', sharedSE(false, false), false],
    ['delete shared shared_edit as owner', 'delete', sharedSE(false, true), true],

    // Change mode.
    ['change mode in own workspace', 'change mode', ownWS, false],
    ['change mode in other workspace', 'change mode', otherWS, false],
    ['change mode shared author_only as author', 'change mode', sharedAO(true, false), true],
    ['change mode shared author_only as member', 'change mode', sharedAO(false, false), false],
    ['change mode shared author_only as owner', 'change mode', sharedAO(false, true), false],
    ['change mode shared shared_edit as author', 'change mode', sharedSE(true, false), true],
    ['change mode shared shared_edit as member', 'change mode', sharedSE(false, false), false],
    ['change mode shared shared_edit as owner', 'change mode', sharedSE(false, true), true],
  ]
  for (const [name, op, t, want] of cases) assert.equal(allowed(op, t), want, name)
})

test('parse mode', () => {
  assert.equal(parseMode('shared_edit'), 'shared_edit')
  assert.throws(() => parseMode('rw'), { message: 'invalid request: mode must be "author_only" or "shared_edit"' })
})

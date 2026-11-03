// Port of go/core/ether/maintenance_test.go. Go's blob store is files on
// disk with a day's grace for orphans; here blobs commit with their rows, so
// an orphan (content with no blobs row) goes on the next collection.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trio } from './testing.ts'

const day = 24 * 60 * 60 * 1000

test('purge and garbage', () => {
  const { t, alice, etherId: id } = trio({ limits: (l) => { l.maxVersionsPerFile = 1 } })
  const s = t.svc

  s.writeFile(alice, id, 'shared/a.md', 'one', 0)
  s.writeFile(alice, id, 'shared/a.md', 'two', 1) // "one" is pruned and unreferenced

  // Nothing is deleted before the grace period.
  assert.equal(s.collectGarbage(), 0)
  t.advance(8 * day)
  assert.equal(s.collectGarbage(), 1)
  assert.equal(new TextDecoder().decode(s.readFile(alice, id, 'shared/a.md', 0).content), 'two')
  assert.equal(t.blobs.list().length, 1)

  // Stored content with no blobs row is deleted right away.
  const orphan = t.blobs.put(new TextEncoder().encode('x'))
  assert.equal(s.collectGarbage(), 1)
  assert.equal(t.blobs.get(orphan), undefined)
  assert.equal(t.blobs.list().length, 1)

  // A deleted ether is purged after 30 days, and its blobs become collectable.
  s.deleteEther(alice, id)
  assert.equal(s.purgeDeletedEthers(), 0, 'purged too early')
  t.advance(31 * day)
  assert.equal(s.purgeDeletedEthers(), 1)
  const count = (sql: string) => t.db.get<{ n: number }>(sql, id)?.n
  assert.equal(count('SELECT COUNT(*) AS n FROM nodes WHERE ether_id = ?'), 0)
  assert.equal(count('SELECT COUNT(*) AS n FROM ethers WHERE id = ?'), 0)
  assert.equal(count("SELECT COUNT(*) AS n FROM audit_log WHERE ether_id = ? AND action = 'ether.purge'"), 1)
  t.advance(8 * day)
  assert.equal(s.collectGarbage(), 1, "blobs of the purged ether weren't collected")
  assert.equal(t.blobs.list().length, 0)
})

// TypeScript-only: Go has no test for SweepInvites.
test('sweep invites', () => {
  const { t, alice, etherId: id } = trio()
  const s = t.svc
  t.account('dan@example.com')
  s.createInvite(alice, id, 'dan@example.com')
  assert.equal(s.sweepInvites(), 0) // bob's invite was used just now; dan's is pending
  t.advance(15 * day) // dan's expired a week ago, bob's was used two weeks ago
  assert.equal(s.sweepInvites(), 2)
})

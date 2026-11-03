import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../core/db.ts'
import { blobDataMigration, SqliteBlobStore } from '../core/blobs.ts'
import { defaultLimits, type Limits } from '../core/limits.ts'
import { EtherService } from '../core/ether/index.ts'
import { openNodeDatabase, type NodeDatabase } from '../adapters/sqlite/node.ts'
import { listBackups, restoreBackup, runBackup, serverRunning } from './backup.ts'

interface Site {
  dbPath: string
  db: NodeDatabase
  svc: EtherService
}

function openSite(dataDir: string, limits: Limits = defaultLimits()): Site {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const dbPath = join(dataDir, 'etherchat.db')
  const db = openNodeDatabase(dbPath)
  migrate(db, [blobDataMigration])
  return { dbPath, db, svc: new EtherService(db, new SqliteBlobStore(db), limits, new TextEncoder().encode('p'.repeat(32))) }
}

function tempRoot(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'etherchat-backup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const text = (b: Uint8Array) => new TextDecoder().decode(b)

// The restore drill: back up, lose the data folder entirely, restore, and
// check everything is back.
test('restore drill', (t) => {
  const root = tempRoot(t)
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backups')
  const s = openSite(dataDir)

  s.svc.allow('alice@example.com', '')
  const acct = s.svc.ensureAccount('alice@example.com', true)
  const a = { accountId: acct.id, clientId: 'test' }
  const e = s.svc.createEther(a, 'Atlas')
  const want: Record<string, string> = { 'shared/plan.md': 'plan v2', 'members/alice/notes.md': 'notes' }
  s.svc.writeFile(a, e.id, 'shared/plan.md', 'plan v1', 0)
  s.svc.writeFile(a, e.id, 'shared/plan.md', 'plan v2', 1)
  s.svc.writeFile(a, e.id, 'members/alice/notes.md', 'notes', 0)
  s.svc.postMessage(a, e.id, { intent: 'update', body: 'hello' })

  const t0 = new Date(Date.UTC(2026, 9, 9, 3, 0, 0))
  const res = runBackup(s.db, backupDir, 14, t0)
  assert.equal(res.snapshot.path, join(backupDir, 'etherchat-20261009-030000.db'))
  assert.equal(res.snapshot.at.getTime(), t0.getTime())
  assert.equal(res.pruned, 0)
  assert.throws(() => runBackup(s.db, backupDir, 14, t0), /already exists/)

  // Changes after the backup are lost by a restore; that's expected.
  s.svc.writeFile(a, e.id, 'shared/after.md', 'written after the backup', 0)

  // The disk dies.
  s.db.close()
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })

  const snaps = listBackups(backupDir)
  assert.equal(snaps.length, 1)
  assert.equal(restoreBackup(snaps[0].path, join(dataDir, 'etherchat.db'), new Date(t0.getTime() + 3600_000)), '',
    'nothing should have been moved aside')

  const r = openSite(dataDir)
  for (const [path, content] of Object.entries(want)) {
    assert.equal(text(r.svc.readFile(a, e.id, path).content), content, path)
  }
  assert.equal(text(r.svc.readFile(a, e.id, 'shared/plan.md', 1).content), 'plan v1', 'history after restore')
  assert.throws(() => r.svc.readFile(a, e.id, 'shared/after.md'), 'a file written after the backup came back')
  assert.equal(r.svc.readBoard(a, e.id).length, 1)

  // Restoring over an existing database keeps the old one beside it.
  r.db.close()
  const moved = restoreBackup(snaps[0].path, join(dataDir, 'etherchat.db'), new Date(t0.getTime() + 2 * 3600_000))
  assert.equal(moved, join(dataDir, 'etherchat.db.before-restore-20261009-050000'))
  assert.ok(existsSync(moved), 'previous database not kept')
})

test('prune and integrity', (t) => {
  const root = tempRoot(t)
  const backupDir = join(root, 'backups')
  const s = openSite(join(root, 'data'))
  t.after(() => s.db.close())
  s.svc.allow('a@example.com', '')
  const a = { accountId: s.svc.ensureAccount('a@example.com', true).id, clientId: 'test' }
  const e = s.svc.createEther(a, 'E')

  const t0 = Date.UTC(2026, 9, 1, 3, 0, 0)
  for (let i = 1; i <= 3; i++) {
    s.svc.writeFile(a, e.id, 'shared/b.md', 'x'.repeat(i), i - 1)
    const res = runBackup(s.db, backupDir, 2, new Date(t0 + i * 24 * 3600_000))
    assert.equal(res.pruned, i === 3 ? 1 : 0)
  }
  const snaps = listBackups(backupDir)
  assert.equal(snaps.length, 2)
  assert.ok(snaps[0].at > snaps[1].at, 'newest first')

  // Files that aren't snapshots are ignored.
  writeFileSync(join(backupDir, 'etherchat-20261399-000000.db'), '')
  writeFileSync(join(backupDir, 'notes.txt'), '')
  assert.equal(listBackups(backupDir).length, 2)
  assert.deepEqual(listBackups(join(root, 'nowhere')), [])

  // A corrupted snapshot is refused, and nothing is touched.
  const bad = join(backupDir, 'etherchat-20261020-030000.db')
  writeFileSync(bad, 'not a database')
  assert.throws(() => restoreBackup(bad, join(root, 'x.db'), new Date(t0)), /integrity check of etherchat-20261020-030000.db failed/)
  assert.ok(!existsSync(join(root, 'x.db')))

  // So is one missing a blob a file version needs.
  const holey = join(root, 'holey.db')
  s.db.run('VACUUM INTO ?', holey)
  const h = openNodeDatabase(holey)
  h.run('DELETE FROM blob_data WHERE sha256 IN (SELECT sha256 FROM blob_data LIMIT 1)')
  h.close()
  assert.throws(() => restoreBackup(holey, join(root, 'y.db'), new Date(t0)), /blobs that holey.db needs are missing/)
})

test('serverRunning', async () => {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  assert.equal(await serverRunning(`127.0.0.1:${port}`), true)
  await new Promise((resolve) => srv.close(resolve))
  assert.equal(await serverRunning(`127.0.0.1:${port}`), false)
})

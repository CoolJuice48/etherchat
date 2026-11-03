import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { migrations } from './migrations.ts'
import { migrate } from './db.ts'
import { openNodeDatabase } from '../adapters/sqlite/node.ts'

const goDir = join(import.meta.dirname, '../../../go/adapters/store/migrations')

test('migrations match the Go server', () => {
  const files = readdirSync(goDir).filter((f) => f.endsWith('.sql')).sort()
  assert.deepEqual(migrations.map((m) => m.name), files)
  for (const m of migrations) {
    assert.equal(m.sql, readFileSync(join(goDir, m.name), 'utf8'), `${m.name} differs; copy it from go/`)
  }
})

test('migrate applies once', () => {
  const db = openNodeDatabase(':memory:')
  migrate(db)
  migrate(db)
  const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')
  assert.equal(n?.n, migrations.length)
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE name = 'request_recipients'"))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { DurableDatabase, type DurableSqlValue, type DurableStorageLike, type SqlCursorLike } from './durable.ts'
import { migrate } from '../../core/db.ts'
import { migrations } from '../../core/migrations.ts'
import { blobDataMigration, SqliteBlobStore, sha256Hex } from '../../core/blobs.ts'

/**
 * A stand-in for a Durable Object's ctx.storage, on node:sqlite, that
 * behaves as the real one does where it matters here (checked against
 * workerd): BEGIN/COMMIT/SAVEPOINT refused, BigInt bindings refused, BLOBs
 * returned as ArrayBuffer, rowsWritten counting index entries too,
 * several statements per exec, nested transactionSync allowed.
 */
class FakeStorage implements DurableStorageLike {
  readonly db = new DatabaseSync(':memory:')
  transactions = 0
  private savepoints = 0

  readonly sql = {
    exec: (query: string, ...bindings: DurableSqlValue[]): SqlCursorLike => {
      const stripped = query.replace(/--[^\n]*/g, '').trim()
      if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(stripped)) {
        throw new Error('To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs')
      }
      if (/^PRAGMA\s+(journal_mode|integrity_check|busy_timeout)/i.test(stripped)) throw new Error('not authorized: SQLITE_AUTH')
      const args = bindings.map((b) => {
        if (typeof b === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number')
        if (b instanceof Uint8Array) throw new TypeError('the adapter should pass ArrayBuffer')
        return b instanceof ArrayBuffer ? new Uint8Array(b) : b
      })
      let rows: Record<string, DurableSqlValue>[] = []
      if (bindings.length === 0 && /;\s*\S/.test(stripped.replace(/;\s*$/, ''))) {
        this.db.exec(query)
      } else {
        const stmt = this.db.prepare(query)
        if (stmt.columns().length > 0) {
          rows = stmt.all(...args).map((r) => {
            const o: Record<string, DurableSqlValue> = {}
            for (const [k, v] of Object.entries(r)) {
              o[k] = v instanceof Uint8Array ? v.slice().buffer : (v as DurableSqlValue)
            }
            return o
          })
        } else {
          stmt.run(...args)
        }
      }
      let i = 0
      return {
        next: () => (i < rows.length ? { done: false, value: rows[i++] } : { done: true, value: undefined }),
        toArray: () => rows.slice(i),
        // Index entries count as written rows, so this overstates changes.
        rowsWritten: 99,
      } as SqlCursorLike
    },
  }

  transactionSync<T>(fn: () => T): T {
    this.transactions++
    const name = `sp${this.savepoints++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const out = fn()
      this.db.exec(`RELEASE ${name}`)
      return out
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      throw err
    }
  }
}

function open(): { db: DurableDatabase; storage: FakeStorage } {
  const storage = new FakeStorage()
  const db = new DurableDatabase(storage)
  migrate(db, [blobDataMigration])
  return { db, storage }
}

test('migrations apply once, each in a transaction', () => {
  const { db, storage } = open()
  assert.equal(storage.transactions, migrations.length + 1)
  migrate(db, [blobDataMigration])
  assert.equal(storage.transactions, migrations.length + 1)
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')?.n, migrations.length + 1)
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE name = 'blob_data'"))
})

test('run reports changed rows, not rows written', () => {
  const { db } = open()
  const now = Date.now()
  const r = db.run('INSERT INTO allowed_emails (email, added_at) VALUES (?, ?), (?, ?)', 'a@x.y', now, 'b@x.y', now)
  assert.deepEqual(r, { changes: 2 })
  assert.deepEqual(db.run("UPDATE allowed_emails SET note = 'n'"), { changes: 2 })
  assert.deepEqual(db.run('DELETE FROM allowed_emails WHERE email = ?', 'nobody'), { changes: 0 })
})

test('get and all', () => {
  const { db } = open()
  db.run('INSERT INTO allowed_emails (email, added_at, note) VALUES (?, ?, ?)', 'a@x.y', 5, 'hi')
  assert.deepEqual(db.get('SELECT email, added_at, note FROM allowed_emails'), { email: 'a@x.y', added_at: 5, note: 'hi' })
  assert.equal(db.get('SELECT email FROM allowed_emails WHERE email = ?', 'none'), undefined)
  assert.deepEqual(db.all('SELECT email FROM allowed_emails WHERE added_at = ?', 5n), [{ email: 'a@x.y' }])
  assert.throws(() => db.get('SELECT ? AS v', 2n ** 60n), RangeError)
})

test('blobs round-trip as Uint8Array', () => {
  const { db } = open()
  const blobs = new SqliteBlobStore(db)
  const buf = new Uint8Array([9, 9, 1, 2, 3, 9])
  const content = buf.subarray(2, 5)
  const sha = blobs.put(content)
  assert.equal(sha, sha256Hex(content))
  const got = blobs.get(sha)
  assert.ok(got instanceof Uint8Array)
  assert.deepEqual([...got!], [1, 2, 3])
  assert.deepEqual(blobs.list(), [sha])
  const raw = db.get<{ data: unknown }>('SELECT data FROM blob_data')
  assert.ok(raw?.data instanceof Uint8Array)
})

test('transactions commit, roll back, and nested calls join', () => {
  const { db, storage } = open()
  const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM allowed_emails')!.n
  const add = (email: string) => db.run('INSERT INTO allowed_emails (email, added_at) VALUES (?, 0)', email)
  const before = storage.transactions

  assert.equal(db.transaction(() => { add('a@x.y'); return 'done' }), 'done')
  assert.equal(count(), 1)

  assert.throws(() => db.transaction(() => { add('b@x.y'); throw new Error('boom') }), /boom/)
  assert.equal(count(), 1)

  db.transaction(() => {
    add('c@x.y')
    db.transaction(() => add('d@x.y'))
    // An inner failure that the outer catches doesn't undo the inner writes:
    // nested calls join the outer transaction, they aren't savepoints.
    try {
      db.transaction(() => { add('e@x.y'); throw new Error('inner') })
    } catch { /* keep going */ }
  })
  assert.equal(count(), 4)

  assert.throws(() => db.transaction(() => {
    add('f@x.y')
    db.transaction(() => add('g@x.y'))
    throw new Error('outer')
  }))
  assert.equal(count(), 4)
  assert.equal(storage.transactions - before, 4, 'one transactionSync per outermost call')

  // The depth resets after a failure, so the next call starts a new transaction.
  db.transaction(() => add('h@x.y'))
  assert.equal(storage.transactions - before, 5)
})

test('statements Durable Objects refuse are never sent', () => {
  const { db } = open()
  // exec passes SQL through; the core never sends these, and the runtime
  // refuses them with a clear message if anything does.
  assert.throws(() => db.exec('BEGIN'), /transactionSync/)
})

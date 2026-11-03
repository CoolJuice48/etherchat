// SqlDatabase over a Durable Object's built-in SQLite (ctx.storage.sql), for
// Cloudflare. One Durable Object holds the whole instance: schema, rows and
// blob bytes.
//
// Differences from Node's node:sqlite that this adapter absorbs:
//   - BEGIN, COMMIT, ROLLBACK and SAVEPOINT are refused; transactions go
//     through ctx.storage.transactionSync, which commits when its callback
//     returns and rolls back when it throws.
//   - Some PRAGMAs are refused (journal_mode, busy_timeout, integrity_check).
//     None are needed: the runtime manages durability, there's one writer,
//     and foreign keys are enforced by default.
//   - A cursor's rowsWritten counts index entries as well as rows (an insert
//     of 2 rows into a table with one index reports 4), so the changed-row
//     count comes from SQLite's changes() instead.
//   - BLOBs come back as ArrayBuffer; they're returned as Uint8Array, as
//     node:sqlite does. BigInt bindings are refused; safe integers are
//     converted to numbers.

import type { Row, SqlDatabase, SqlValue } from '../../core/db.ts'

/** The value types Durable Object SQL accepts and returns. */
export type DurableSqlValue = ArrayBuffer | string | number | null

/** The parts of a Durable Object SQL cursor used here. */
export interface SqlCursorLike {
  next(): IteratorResult<Record<string, DurableSqlValue>, unknown>
  toArray(): Record<string, DurableSqlValue>[]
}

/** The parts of ctx.storage this adapter uses (DurableObjectStorage). */
export interface DurableStorageLike {
  readonly sql: { exec(query: string, ...bindings: DurableSqlValue[]): SqlCursorLike }
  transactionSync<T>(fn: () => T): T
}

export class DurableDatabase implements SqlDatabase {
  private readonly storage: DurableStorageLike
  private depth = 0

  constructor(storage: DurableStorageLike) {
    this.storage = storage
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    this.storage.sql.exec(sql, ...params.map(bind)).toArray()
    const row = this.storage.sql.exec('SELECT changes() AS n').next()
    return { changes: row.done ? 0 : Number((row.value as { n: number }).n) }
  }

  all<T extends object = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.storage.sql.exec(sql, ...params.map(bind)).toArray().map(normalize) as T[]
  }

  get<T extends object = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    const first = this.storage.sql.exec(sql, ...params.map(bind)).next()
    return first.done ? undefined : (normalize(first.value as Record<string, DurableSqlValue>) as T)
  }

  exec(sql: string): void {
    // Several statements are allowed; every one runs before exec returns.
    this.storage.sql.exec(sql).toArray()
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      // Join the outer transaction, as the Node adapter does.
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    this.depth = 1
    try {
      return this.storage.transactionSync(fn)
    } finally {
      this.depth = 0
    }
  }
}

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)

function bind(v: SqlValue): DurableSqlValue {
  if (v instanceof Uint8Array) {
    // A view of part of a buffer would bind the whole buffer; copy it out.
    const whole = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer
    return whole ? (v.buffer as ArrayBuffer) : v.slice().buffer
  }
  if (typeof v === 'bigint') {
    if (v > maxSafe || v < -maxSafe) throw new RangeError(`SQL parameter ${v} is outside the safe integer range`)
    return Number(v)
  }
  if (typeof v === 'boolean') return v ? 1 : 0 // not a SqlValue, but SQLite's own convention
  return v
}

function normalize(row: Record<string, DurableSqlValue>): Row {
  const out: Row = {}
  for (const k of Object.keys(row)) {
    const v = row[k]
    out[k] = v instanceof ArrayBuffer ? new Uint8Array(v) : v
  }
  return out
}

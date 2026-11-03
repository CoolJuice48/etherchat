// SqlDatabase on Node's built-in node:sqlite, for self-hosting. One file,
// WAL mode, foreign keys on, writes serialized by the single connection.

import { DatabaseSync } from 'node:sqlite'
import type { Row, SqlDatabase, SqlValue } from '../../core/db.ts'

export function openNodeDatabase(path: string): NodeDatabase {
  return new NodeDatabase(new DatabaseSync(path))
}

export class NodeDatabase implements SqlDatabase {
  readonly raw: DatabaseSync
  private depth = 0

  constructor(raw: DatabaseSync) {
    this.raw = raw
    raw.exec('PRAGMA journal_mode = WAL')
    raw.exec('PRAGMA foreign_keys = ON')
    raw.exec('PRAGMA busy_timeout = 5000')
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...(params as never[]))
    return { changes: Number(r.changes) }
  }

  all<T extends object = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])).map(normalize) as T[]
  }

  get<T extends object = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.raw.prepare(sql).get(...(params as never[]))
    return row ? (normalize(row) as T) : undefined
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (err) {
      this.raw.exec('ROLLBACK')
      throw err
    } finally {
      this.depth = 0
    }
  }

  close(): void {
    this.raw.close()
  }
}

// node:sqlite returns rows with a null prototype; copy into plain objects.
function normalize(row: object): Row {
  return { ...(row as Row) }
}

// The storage contract the core is written against. It's synchronous on
// purpose: Node's built-in node:sqlite and Cloudflare Durable Objects'
// storage.sql are both synchronous SQLite, so one core runs on either.

import { migrations } from './migrations.ts'

export type SqlValue = string | number | bigint | null | Uint8Array

export type Row = Record<string, SqlValue>

/** One SQLite connection. */
export interface SqlDatabase {
  /** Runs one statement and reports how many rows it changed. */
  run(sql: string, ...params: SqlValue[]): { changes: number }
  /** Every row a query returns. */
  all<T extends object = Row>(sql: string, ...params: SqlValue[]): T[]
  /** The first row a query returns, or undefined. */
  get<T extends object = Row>(sql: string, ...params: SqlValue[]): T | undefined
  /** Runs SQL without parameters, possibly several statements (migrations). */
  exec(sql: string): void
  /**
   * Runs fn atomically: commits when it returns, rolls back when it throws.
   * A call inside another joins the outer transaction.
   */
  transaction<T>(fn: () => T): T
}

/**
 * Brings the schema up to date. Versions below 1000 are the shared schema
 * (the same as the Go server's); 1000 and up are TypeScript-only additions.
 */
export function migrate(db: SqlDatabase, extra: { version: number; name: string; sql: string }[] = []): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  for (const m of [...migrations, ...extra].sort((a, b) => a.version - b.version)) {
    const done = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?', m.version)
    if (done && Number(done.n) > 0) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', m.version, Date.now())
    })
  }
}

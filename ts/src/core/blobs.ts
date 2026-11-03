// Content-addressed storage for file versions. The blobs table (shared
// schema) holds each blob's size, type and reference state; a BlobStore
// holds the bytes. The default keeps them in the same SQLite database, so a
// write and its blob commit together and one file (or one Durable Object)
// is the whole instance.

import { createHash } from 'node:crypto'
import type { SqlDatabase } from './db.ts'

export interface BlobStore {
  /** Stores content if it's new and returns its SHA-256 in lowercase hex. */
  put(content: Uint8Array): string
  get(sha256: string): Uint8Array | undefined
  delete(sha256: string): void
  /** Every stored hash, for garbage collection. */
  list(): string[]
}

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** TypeScript-only schema for SqliteBlobStore (see migrate's extra migrations). */
export const blobDataMigration = {
  version: 1000,
  name: '1000_blob_data.sql',
  sql: `CREATE TABLE IF NOT EXISTS blob_data (
  sha256 TEXT PRIMARY KEY,
  data   BLOB NOT NULL
);`,
}

export class SqliteBlobStore implements BlobStore {
  private readonly db: SqlDatabase

  constructor(db: SqlDatabase) {
    this.db = db
  }

  put(content: Uint8Array): string {
    const sha = sha256Hex(content)
    this.db.run('INSERT INTO blob_data (sha256, data) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING', sha, content)
    return sha
  }

  get(sha256: string): Uint8Array | undefined {
    const row = this.db.get<{ data: Uint8Array | ArrayBuffer }>('SELECT data FROM blob_data WHERE sha256 = ?', sha256)
    if (!row) return undefined
    return row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)
  }

  delete(sha256: string): void {
    this.db.run('DELETE FROM blob_data WHERE sha256 = ?', sha256)
  }

  list(): string[] {
    return this.db.all<{ sha256: string }>('SELECT sha256 FROM blob_data').map((r) => r.sha256)
  }
}

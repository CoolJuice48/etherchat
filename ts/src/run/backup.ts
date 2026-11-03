// Backups for Node, a port of go/run/backup: consistent SQLite snapshots
// made with VACUUM INTO. Blobs live in the same database (blob_data), so one
// snapshot file is a complete backup; there's no blob folder to copy.
//
// Layout under the backup directory:
//
//	etherchat-20261009-031500.db   snapshots, the newest `keep` kept

import { closeSync, copyFileSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, chmodSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SqlDatabase } from '../core/db.ts'
import { splitHostPort } from './config.ts'

const prefix = 'etherchat-'
const suffix = '.db'

/** One backup file. */
export interface Snapshot {
  path: string
  at: Date
}

/** A finished backup. */
export interface BackupResult {
  snapshot: Snapshot
  pruned: number // old snapshots removed
}

/** Snapshots db into dir and keeps only the newest keep snapshots. */
export function runBackup(db: SqlDatabase, dir: string, keep: number, now: Date): BackupResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const final = join(dir, prefix + stamp(now) + suffix)
  if (existsSync(final)) throw new Error(`${final} already exists`)
  const tmp = final + '.tmp'
  rmSync(tmp, { force: true })
  try {
    db.run('VACUUM INTO ?', tmp)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new Error(`snapshot: ${(err as Error).message}`, { cause: err })
  }
  try {
    check(tmp)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  chmodSync(tmp, 0o600)
  renameSync(tmp, final)
  const at = new Date(Math.floor(now.getTime() / 1000) * 1000)
  return { snapshot: { path: final, at }, pruned: prune(dir, keep) }
}

/**
 * Verifies a snapshot: SQLite's integrity check, and every blob a file
 * version references is present. It throws if either fails.
 */
export function check(path: string): void {
  const name = basename(path)
  let result = ''
  let missing: { sha: string }[] = []
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    result = row?.integrity_check ?? ''
    if (result === 'ok') {
      missing = db.prepare(`SELECT DISTINCT v.blob_sha256 AS sha FROM versions v
        WHERE v.blob_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blob_data d WHERE d.sha256 = v.blob_sha256)`).all() as { sha: string }[]
    }
  } catch (err) {
    throw new Error(`integrity check of ${name} failed: ${(err as Error).message}`, { cause: err })
  } finally {
    db?.close()
  }
  if (result !== 'ok') throw new Error(`integrity check of ${name} failed: ${result}`)
  if (missing.length > 0) throw new Error(`${missing.length} blobs that ${name} needs are missing from it (first: ${missing[0].sha})`)
}

/** Snapshots in dir, newest first; none if dir doesn't exist. */
export function listBackups(dir: string): Snapshot[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Snapshot[] = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const at = parseStamp(name.slice(prefix.length, name.length - suffix.length))
    if (at) out.push({ path: join(dir, name), at })
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime())
}

// Keeps the newest keep snapshots.
function prune(dir: string, keep: number): number {
  let removed = 0
  for (const s of listBackups(dir).slice(keep)) {
    rmSync(s.path)
    removed++
  }
  return removed
}

/**
 * Replaces the database at dbPath with snapshot. The server must be stopped
 * (see serverRunning). The current database, with its -wal and -shm files,
 * is kept beside it with a .before-restore-<time> suffix, which is returned
 * ('' if there was none).
 */
export function restoreBackup(snapshot: string, dbPath: string, now: Date): string {
  check(snapshot)
  let moved = dbPath + '.before-restore-' + stamp(now)
  if (existsSync(dbPath)) {
    renameSync(dbPath, moved)
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(dbPath + ext)) renameSync(dbPath + ext, moved + ext)
    }
  } else {
    moved = ''
  }
  // A copy, not a link: the restored database will change, the backup mustn't.
  copyFileSync(snapshot, dbPath, constants.COPYFILE_EXCL)
  chmodSync(dbPath, 0o600)
  const fd = openSync(dbPath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return moved
}

/** Whether something accepts connections at listen (host:port), within a second. */
export function serverRunning(listen: string): Promise<boolean> {
  const hp = splitHostPort(listen)
  if (!hp) return Promise.resolve(false)
  return new Promise((resolve) => {
    const sock = connect({ host: hp.host === 'localhost' ? '127.0.0.1' : hp.host, port: Number(hp.port) })
    const done = (up: boolean) => {
      sock.destroy()
      resolve(up)
    }
    sock.setTimeout(1000, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// Snapshot names carry the UTC time, like 20261009-031500.
function stamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
}

function parseStamp(s: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return undefined
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, se))
  return stamp(at) === s ? at : undefined // rejects out-of-range fields, as Go's time.Parse does
}

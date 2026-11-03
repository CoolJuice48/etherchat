// A test fixture for anything built on EtherService: an in-memory database
// with the full schema, a SqliteBlobStore, the default limits, and a clock
// the test controls. Node only (it opens node:sqlite); never import it from
// production code.
//
//   newTestService(opts?: {
//     limits?: (l: Limits) => void   // adjust the default limits
//     start?: Date                   // the fake clock's start; default 2026-10-08T12:00:00Z
//   }): TestService
//
//   interface TestService {
//     db: NodeDatabase               // migrated, including blobDataMigration
//     blobs: SqliteBlobStore
//     limits: Limits
//     pepper: Uint8Array             // 32 bytes of 'p', as the Go tests use
//     svc: EtherService              // already on the fake clock
//     clock: () => Date              // the fake clock; pass it to other services' setClock
//     now(): Date                    // the fake clock's current time
//     advance(ms: number): void      // moves the clock forward
//     set(t: Date): void             // sets the clock
//     account(email: string, clientId?: string): Actor   // allowlists, then ensureAccount(email, true); clientId 'test'
//     join(inviter: Actor, member: Actor, etherId: string, email: string): void  // invite and redeem
//   }
//
//   trio(opts?) → { t: TestService, alice: Actor, bob: Actor, carol: Actor, etherId: string }
//     An ether "Atlas" owned by alice@example.com with bob@example.com as a
//     member and carol@example.com allowlisted but outside.

import { openNodeDatabase, type NodeDatabase } from '../../adapters/sqlite/node.ts'
import { blobDataMigration, SqliteBlobStore } from '../blobs.ts'
import { migrate } from '../db.ts'
import { defaultLimits, type Limits } from '../limits.ts'
import type { Actor } from './model.ts'
import { EtherService } from './service.ts'

export interface TestServiceOptions {
  limits?: (l: Limits) => void
  start?: Date
}

export interface TestService {
  db: NodeDatabase
  blobs: SqliteBlobStore
  limits: Limits
  pepper: Uint8Array
  svc: EtherService
  clock: () => Date
  now(): Date
  advance(ms: number): void
  set(t: Date): void
  account(email: string, clientId?: string): Actor
  join(inviter: Actor, member: Actor, etherId: string, email: string): void
}

export function newTestService(opts: TestServiceOptions = {}): TestService {
  const db = openNodeDatabase(':memory:')
  migrate(db, [blobDataMigration])
  const blobs = new SqliteBlobStore(db)
  const limits = defaultLimits()
  opts.limits?.(limits)
  const pepper = new TextEncoder().encode('p'.repeat(32))
  const svc = new EtherService(db, blobs, limits, pepper)
  let current = new Date(opts.start ?? Date.UTC(2026, 9, 8, 12, 0, 0))
  const clock = () => new Date(current)
  svc.setClock(clock)
  return {
    db,
    blobs,
    limits,
    pepper,
    svc,
    clock,
    now: clock,
    advance(ms) {
      current = new Date(current.getTime() + ms)
    },
    set(t) {
      current = new Date(t)
    },
    account(email, clientId = 'test') {
      svc.allow(email, '')
      const a = svc.ensureAccount(email, true)
      return { accountId: a.id, clientId }
    },
    join(inviter, member, etherId, email) {
      const { code } = svc.createInvite(inviter, etherId, email)
      svc.joinWithCode(member, code)
    },
  }
}

export function trio(opts: TestServiceOptions = {}): { t: TestService; alice: Actor; bob: Actor; carol: Actor; etherId: string } {
  const t = newTestService(opts)
  const alice = t.account('alice@example.com')
  const bob = t.account('bob@example.com')
  const carol = t.account('carol@example.com')
  const e = t.svc.createEther(alice, 'Atlas')
  t.join(alice, bob, e.id, 'bob@example.com')
  return { t, alice, bob, carol, etherId: e.id }
}

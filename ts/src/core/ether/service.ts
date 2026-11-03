// EtherService: Etherchat's domain logic, a port of go/core/ether's Service.
// Accounts and the allowlist, ethers and membership, invites, files and
// versions, the board, requests, activity, and every permission check. The
// MCP and web layers call this and nothing else decides who may do what.
//
// Methods are synchronous and throw EtherError (or ConflictError); each Go
// db.Tx/ReadTx is one db.transaction.

import type { BlobStore } from '../blobs.ts'
import type { SqlDatabase, SqlValue } from '../db.ts'
import { ConflictError, EtherError, invalid, isKind } from '../errors.ts'
import { extensions, FileError, validate, type Type } from '../files.ts'
import type { Limits } from '../limits.ts'
import { compareStrings, fields, goDuration, goJson, goQuote, hasControl, runeCount, trimSpace, utf8Length, validUtf8 } from './gofmt.ts'
import {
  Ether,
  Member,
  parseIntent,
  type Account,
  type Actor,
  type ActivityFilter,
  type AllowedEmail,
  type AuditEntry,
  type Change,
  type Digest,
  type EtherStats,
  type Event,
  type File,
  type FileInfo,
  type Invite,
  type MemberActivity,
  type Post,
  type PostInput,
  type RequestAnswer,
  type RequestEmail,
  type VersionInfo,
  type WriteResult,
} from './model.ts'
import {
  checkAgentName,
  checkEtherName,
  codeHmac,
  deriveHandle,
  newId,
  newInviteCode,
  normalizeCode,
  normalizeEmail,
  validHandle,
} from './names.ts'
import { Path, parsePath, rootMembers, rootShared, workspacePath, ZONE_SHARED, ZONE_WORKSPACE } from './paths.ts'
import {
  allowed,
  MODE_AUTHOR_ONLY,
  OP_CHANGE_MODE,
  OP_CREATE,
  OP_DELETE,
  OP_EDIT,
  parseMode,
  type Mode,
  type Op,
  type Target,
} from './permissions.ts'
import {
  checkAsk,
  MAX_OPEN_REQUESTS,
  maxAnswerNote,
  Recipient,
  Request,
  REQUEST_ANSWERED,
  REQUEST_EMAIL_GAP_MS,
  REQUEST_EXPIRED,
  REQUEST_OPEN,
  REQUEST_TTL_MS,
  REQUEST_WITHDRAWN,
  type AskInput,
} from './requests.ts'

const hour = 60 * 60 * 1000
const day = 24 * hour

// Retention periods.
const sweepAfter = 7 * day // expired invites, then their rows go
const blobGrace = 7 * day // unreferenced blobs wait this long before deletion
const purgeEthersAfter = 30 * day // deleted ethers are purged after this

/** Go's zero time.Time in Unix milliseconds: "no since" sorts before everything. */
const zeroTimeMs = -62135596800000

const noActor: Actor = { accountId: '', clientId: '' }

/** The audit actions members can see. Invite events are left out because their targets are email addresses. */
const activityActions = `('ether.create', 'ether.rename', 'member.join', 'member.leave', 'member.remove',
	'file.write', 'file.delete', 'folder.create', 'folder.delete', 'file.mode', 'post.create', 'post.delete',
	'request.create', 'request.answer', 'agent.rename')`

/**
 * Hides post events for posts that are still scheduled or were cancelled
 * before publishing, so the feed doesn't announce them early.
 */
const visiblePost = `NOT (l.action = 'post.create' AND (p.published_at IS NULL OR p.cancelled_at IS NOT NULL))`

const postColumns = `p.id, p.ether_id, a.handle, p.client_id, p.intent, p.title, p.body,
	COALESCE(p.reply_to, '') AS reply_to, p.created_at, p.send_at, p.published_at`

/** Go's ErrInvalid wrapping ErrFolder: kind 'folder', and the message Go prints. */
class FolderError extends EtherError {
  constructor(detail: string) {
    super('folder', detail)
    this.message = `invalid request: ${detail}`
  }
}

const notFound = (detail = '') => new EtherError('not_found', detail)

function forbidden(op: Op, p: Path): EtherError {
  return new EtherError('forbidden', `you can't ${op} ${p}`)
}

function fileTypeError(err: unknown): unknown {
  if (!(err instanceof FileError)) return err
  switch (err.kind) {
    case 'too_large':
      return new EtherError('limit', err.message)
    case 'unsupported_type':
      return invalid(`${err.message}; allowed: ${extensions().join(' ')}`)
    default:
      return invalid(err.message)
  }
}

const date = (ms: number) => new Date(ms)
const optDate = (ms: SqlValue | undefined) => (ms === null || ms === undefined ? undefined : new Date(Number(ms)))

/** A file or folder row. */
interface Node {
  id: string
  kind: 'file' | 'folder'
  path: string
  authorId: string
  authorHandle: string
  mode: Mode
  system: boolean
  head: number
}

/** The actor's standing in one ether. */
interface Membership {
  etherId: string
  ownerId: string
  /** The actor's handle. */
  handle: string
}

interface AccountRow {
  id: string
  email: string
  handle: string
  email_verified_at: number | null
  created_at: number
  disabled_at: number | null
  request_emails?: number
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    email: r.email,
    handle: r.handle,
    verified: r.email_verified_at !== null,
    createdAt: date(r.created_at),
    disabled: r.disabled_at !== null,
    requestEmails: !!r.request_emails,
  }
}

interface InviteRow {
  id: string
  ether_id: string
  name: string
  email: string
  handle: string
  inviter_email: string
  created_at: number
  expires_at: number
}

const inviteColumns = `i.id, i.ether_id, e.name, i.email, a.handle, a.email AS inviter_email, i.created_at, i.expires_at`

function toInvite(r: InviteRow): Invite {
  return {
    id: r.id,
    etherId: r.ether_id,
    etherName: r.name,
    email: r.email,
    invitedByHandle: r.handle,
    invitedByEmail: r.inviter_email,
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
  }
}

interface PostRow {
  id: string
  ether_id: string
  handle: string
  client_id: string
  intent: string
  title: string
  body: string
  reply_to: string
  created_at: number
  send_at: number | null
  published_at: number | null
}

function toPost(r: PostRow): Post {
  return {
    id: r.id,
    etherId: r.ether_id,
    author: r.handle,
    clientId: r.client_id,
    intent: r.intent as Post['intent'],
    title: r.title,
    body: r.body,
    replyTo: r.reply_to,
    createdAt: date(r.created_at),
    sendAt: optDate(r.send_at),
    publishedAt: optDate(r.published_at),
  }
}

export class EtherService {
  private readonly db: SqlDatabase
  private readonly blobs: BlobStore
  private readonly limits: Limits
  private readonly pepper: Uint8Array
  private now: () => Date = () => new Date()

  /** pepper keys the HMACs of invite codes. */
  constructor(db: SqlDatabase, blobs: BlobStore, limits: Limits, pepper: Uint8Array) {
    this.db = db
    this.blobs = blobs
    this.limits = limits
    this.pepper = pepper
  }

  /** Replaces the clock, for tests. */
  setClock(now: () => Date): void {
    this.now = now
  }

  private nowMs(): number {
    return this.now().getTime()
  }

  /** How many people one ether can have, counting pending invites. */
  maxMembers(): number {
    return this.limits.maxMembers
  }

  /** Records an action. detail must not contain file contents or secrets. */
  private audit(a: Actor, etherId: string, action: string, target: string, detail?: Record<string, unknown>): void {
    const d = detail && Object.keys(detail).length > 0 ? goJson(detail) : '{}'
    this.db.run(
      `INSERT INTO audit_log (at, account_id, client_id, ether_id, action, target, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.nowMs(), a.accountId || null, a.clientId ?? '', etherId || null, action, target, d,
    )
  }

  // --- Queries shared by several operations ---

  /** Checks the account exists and is enabled, and returns its handle. */
  private requireActiveAccount(accountId: string): string {
    const row = this.db.get<{ handle: string; disabled_at: number | null }>(
      `SELECT handle, disabled_at FROM accounts WHERE id = ?`, accountId)
    if (!row) throw notFound()
    if (row.disabled_at !== null) throw new EtherError('disabled')
    return row.handle
  }

  /**
   * Throws not_found unless the account is an active member of a live
   * ether, so non-members can't tell whether the ether exists.
   */
  private requireMember(etherId: string, accountId: string): Membership {
    const handle = this.requireActiveAccount(accountId)
    const row = this.db.get<{ owner_id: string }>(
      `SELECT e.owner_id FROM ethers e
		 JOIN memberships m ON m.ether_id = e.id
		 WHERE e.id = ? AND e.deleted_at IS NULL AND m.account_id = ? AND m.left_at IS NULL`,
      etherId, accountId)
    if (!row) throw notFound()
    return { etherId, ownerId: row.owner_id, handle }
  }

  private accountWhere(where: 'id = ?' | 'email = ?', arg: string): Account {
    const row = this.db.get<AccountRow>(
      `SELECT id, email, handle, email_verified_at, created_at, disabled_at, request_emails FROM accounts WHERE ${where}`, arg)
    if (!row) throw notFound()
    return toAccount(row)
  }

  private isAllowedNormalized(email: string): boolean {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM allowed_emails WHERE email = ?`, email)
    return Number(row?.n) > 0
  }

  private loadEther(etherId: string): Ether {
    const e = this.db.get<{ id: string; name: string; owner_id: string; handle: string; created_at: number }>(
      `SELECT e.id, e.name, e.owner_id, a.handle, e.created_at
		 FROM ethers e JOIN accounts a ON a.id = e.owner_id WHERE e.id = ?`, etherId)
    if (!e) throw notFound()
    const rows = this.db.all<{ id: string; handle: string; joined_at: number; agent_name: string }>(
      `SELECT a.id, a.handle, m.joined_at, m.agent_name FROM memberships m JOIN accounts a ON a.id = m.account_id
		 WHERE m.ether_id = ? AND m.left_at IS NULL ORDER BY m.joined_at, a.handle`, etherId)
    return new Ether({
      id: e.id,
      name: e.name,
      ownerId: e.owner_id,
      ownerHandle: e.handle,
      createdAt: date(e.created_at),
      members: rows.map((r) => new Member({
        accountId: r.id,
        handle: r.handle,
        joinedAt: date(r.joined_at),
        owner: r.id === e.owner_id,
        agentName: r.agent_name,
      })),
    })
  }

  private activeMemberCount(etherId: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memberships WHERE ether_id = ? AND left_at IS NULL`, etherId)
    return Number(row?.n ?? 0)
  }

  private endMembership(etherId: string, accountId: string, now: number): void {
    this.db.run(`UPDATE memberships SET left_at = ? WHERE ether_id = ? AND account_id = ?`, now, etherId, accountId)
  }

  // --- Allowlist and accounts (accounts.go) ---

  /** Adds an email to the allowlist. Adding an existing entry updates its note. */
  allow(email: string, note = ''): void {
    email = normalizeEmail(email)
    this.db.transaction(() => {
      if (this.isAllowedNormalized(email)) {
        this.db.run(`UPDATE allowed_emails SET note = ? WHERE email = ?`, note, email)
        return
      }
      this.db.run(`INSERT INTO allowed_emails (email, added_at, note) VALUES (?, ?, ?)`, email, this.nowMs(), note)
      // Re-adding an address re-enables the account disallow disabled.
      this.db.run(`UPDATE accounts SET disabled_at = NULL WHERE email = ?`, email)
      this.audit(noActor, '', 'allowlist.add', email)
    })
  }

  /** Removes an email from the allowlist and disables its account. */
  disallow(email: string): void {
    email = normalizeEmail(email)
    this.db.transaction(() => {
      if (this.db.run(`DELETE FROM allowed_emails WHERE email = ?`, email).changes === 0) throw notFound()
      this.db.run(`UPDATE accounts SET disabled_at = ? WHERE email = ? AND disabled_at IS NULL`, this.nowMs(), email)
      this.audit(noActor, '', 'allowlist.remove', email)
    })
  }

  /**
   * Marks an allowlisted address as a server admin, or unmarks it. Admins
   * get the requests people send to allow new addresses.
   */
  setAdmin(email: string, admin: boolean): void {
    email = normalizeEmail(email)
    this.db.transaction(() => {
      if (this.db.run(`UPDATE allowed_emails SET admin = ? WHERE email = ?`, admin ? 1 : 0, email).changes === 0) {
        throw notFound(`${email} isn't allowed yet; allow it first`)
      }
      this.audit(noActor, '', admin ? 'admin.add' : 'admin.remove', email)
    })
  }

  /** The server admins' addresses. */
  adminEmails(): string[] {
    return this.db.all<{ email: string }>(`SELECT email FROM allowed_emails WHERE admin = 1 ORDER BY email`)
      .map((r) => r.email)
  }

  /** Notes in the audit log that a member asked the admins to allow addresses. */
  recordAllowRequest(a: Actor, emails: string[]): void {
    this.db.transaction(() => this.audit(a, '', 'allowlist.request', emails.join(' ')))
  }

  /** The allowlist, sorted by email. */
  listAllowed(): AllowedEmail[] {
    return this.db.all<{ email: string; added_at: number; note: string; admin: number }>(
      `SELECT email, added_at, note, admin FROM allowed_emails ORDER BY email`,
    ).map((r) => ({ email: r.email, addedAt: date(r.added_at), note: r.note, admin: !!r.admin }))
  }

  /** Whether email is on the allowlist. Throws invalid for a malformed address. */
  isAllowed(email: string): boolean {
    return this.isAllowedNormalized(normalizeEmail(email))
  }

  /**
   * Returns the account for an allowlisted email, creating it on first use.
   * verified marks the email as proven (a successful sign-in code).
   */
  ensureAccount(email: string, verified: boolean): Account {
    email = normalizeEmail(email)
    return this.db.transaction(() => {
      if (!this.isAllowedNormalized(email)) throw new EtherError('not_allowed')
      const row = this.db.get<AccountRow>(
        `SELECT id, email, handle, email_verified_at, created_at, disabled_at, request_emails FROM accounts WHERE email = ?`, email)
      if (row) {
        const existing = toAccount(row)
        if (existing.disabled) throw new EtherError('disabled')
        if (verified && !existing.verified) {
          this.db.run(`UPDATE accounts SET email_verified_at = ? WHERE id = ?`, this.nowMs(), existing.id)
          existing.verified = true
        }
        return existing
      }
      const handle = this.uniqueHandle(deriveHandle(email))
      const now = this.nowMs()
      const id = newId()
      this.db.run(
        `INSERT INTO accounts (id, email, handle, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, email, handle, verified ? now : null, now)
      this.audit({ accountId: id, clientId: '' }, '', 'account.create', handle)
      // As in Go, a new account's requestEmails reads false here (the column defaults to on).
      return { id, email, handle, verified, createdAt: date(now), disabled: false, requestEmails: false }
    })
  }

  /** base, or base2, base3, ... if base is taken. */
  private uniqueHandle(base: string): string {
    for (let n = 1; ; n++) {
      const h = n > 1 ? `${base}${n}` : base
      const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts WHERE handle = ?`, h)
      if (Number(row?.n) === 0) return h
    }
  }

  accountById(id: string): Account {
    return this.accountWhere('id = ?', id)
  }

  accountByEmail(email: string): Account {
    return this.accountWhere('email = ?', normalizeEmail(email))
  }

  /** Every account, sorted by handle. requestEmails is false here, as in Go. */
  listAccounts(): Account[] {
    return this.db.all<AccountRow>(
      `SELECT id, email, handle, email_verified_at, created_at, disabled_at FROM accounts ORDER BY handle`,
    ).map(toAccount)
  }

  /** Disables an account without touching the allowlist. */
  disableAccount(email: string): void {
    email = normalizeEmail(email)
    this.db.transaction(() => {
      const res = this.db.run(
        `UPDATE accounts SET disabled_at = ? WHERE email = ? AND disabled_at IS NULL`, this.nowMs(), email)
      if (res.changes === 0) throw notFound()
      this.audit(noActor, '', 'account.disable', email)
    })
  }

  /**
   * Changes an account's handle. Handles name workspace folders, so they can
   * only change before the account has joined any ether.
   */
  setHandle(accountId: string, handle: string): void {
    if (!validHandle(handle)) {
      throw invalid("handle must be 1-32 characters of a-z, 0-9, '.', '_' or '-', starting and ending with a letter or digit")
    }
    this.db.transaction(() => {
      this.requireActiveAccount(accountId)
      const joined = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE account_id = ?`, accountId)
      if (Number(joined?.n) > 0) throw new EtherError('forbidden', 'handle can only change before joining an ether')
      const taken = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM accounts WHERE handle = ? AND id != ?`, handle, accountId)
      if (Number(taken?.n) > 0) throw new EtherError('exists', `handle @${handle} is taken`)
      this.db.run(`UPDATE accounts SET handle = ? WHERE id = ?`, handle, accountId)
      this.audit({ accountId, clientId: '' }, '', 'account.handle', handle)
    })
  }

  // --- Ethers and membership (ethers.go) ---

  /** Creates an ether owned by the actor, with members/, members/<handle>/ and shared/ in place. */
  createEther(a: Actor, name: string): Ether {
    name = checkEtherName(name)
    const id = this.db.transaction(() => {
      const handle = this.requireActiveAccount(a.accountId)
      const owned = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ethers WHERE owner_id = ? AND deleted_at IS NULL`, a.accountId)
      if (Number(owned?.n) >= this.limits.maxEthersPerAccount) {
        throw new EtherError('limit', `an account can own at most ${this.limits.maxEthersPerAccount} ethers`)
      }
      const now = this.nowMs()
      const id = newId()
      this.db.run(`INSERT INTO ethers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`, id, name, a.accountId, now)
      this.db.run(`INSERT INTO memberships (ether_id, account_id, joined_at) VALUES (?, ?, ?)`, id, a.accountId, now)
      this.ensureSystemFolders(id, a.accountId, handle)
      this.audit(a, id, 'ether.create', name)
      return id
    })
    return this.getEther(a, id)
  }

  /** Creates members/, members/<handle>/ and shared/ if missing. */
  private ensureSystemFolders(etherId: string, accountId: string, handle: string): void {
    for (const p of [rootMembers, workspacePath(handle), rootShared]) {
      this.mkdirAll(etherId, parsePath(p), accountId)
    }
  }

  /** An ether the actor belongs to. */
  getEther(a: Actor, etherId: string): Ether {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      return this.loadEther(etherId)
    })
  }

  /** The ethers the actor belongs to, newest first. */
  listEthers(a: Actor): Ether[] {
    return this.queryEthers(
      `SELECT e.id FROM ethers e JOIN memberships m ON m.ether_id = e.id
		 WHERE m.account_id = ? AND m.left_at IS NULL AND e.deleted_at IS NULL
		 ORDER BY e.created_at DESC`, a.accountId)
  }

  /** Stats for every ether the actor is in, by ether id. */
  directoryStats(a: Actor): Map<string, EtherStats> {
    const out = new Map<string, EtherStats>()
    const entry = (id: string) => {
      let st = out.get(id)
      if (!st) out.set(id, (st = { bytes: 0, messages: 0 }))
      return st
    }
    this.db.transaction(() => {
      this.requireActiveAccount(a.accountId)
      const mine = `SELECT ether_id FROM memberships WHERE account_id = ? AND left_at IS NULL`
      for (const r of this.db.all<{ id: string; n: number }>(
        `SELECT n.ether_id AS id, SUM(v.size) AS n FROM nodes n
			JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			WHERE n.kind = 'file' AND n.deleted_at IS NULL AND n.ether_id IN (${mine})
			GROUP BY n.ether_id`, a.accountId)) {
        entry(r.id).bytes = Number(r.n ?? 0)
      }
      for (const r of this.db.all<{ id: string; n: number }>(
        `SELECT ether_id AS id, COUNT(*) AS n FROM board_posts
			WHERE published_at IS NOT NULL AND cancelled_at IS NULL AND deleted_at IS NULL AND ether_id IN (${mine})
			GROUP BY ether_id`, a.accountId)) {
        entry(r.id).messages = Number(r.n)
      }
    })
    return out
  }

  /** Every live ether, for the admin CLI. */
  listAllEthers(): Ether[] {
    return this.queryEthers(`SELECT id FROM ethers WHERE deleted_at IS NULL ORDER BY created_at DESC`)
  }

  private queryEthers(query: string, ...args: SqlValue[]): Ether[] {
    return this.db.transaction(() =>
      this.db.all<{ id: string }>(query, ...args).map((r) => this.loadEther(r.id)))
  }

  /** Changes an ether's name. Owner only. */
  renameEther(a: Actor, etherId: string, name: string): void {
    name = checkEtherName(name)
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (m.ownerId !== a.accountId) throw new EtherError('forbidden', 'only the owner can rename an ether')
      this.db.run(`UPDATE ethers SET name = ? WHERE id = ?`, name, etherId)
      this.audit(a, etherId, 'ether.rename', name)
    })
  }

  /** Hides an ether immediately; a job purges it later. Owner only. */
  deleteEther(a: Actor, etherId: string): void {
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (m.ownerId !== a.accountId) throw new EtherError('forbidden', 'only the owner can delete an ether')
      this.db.run(`UPDATE ethers SET deleted_at = ? WHERE id = ?`, this.nowMs(), etherId)
      this.audit(a, etherId, 'ether.delete', '')
    })
  }

  /**
   * Removes the actor from an ether. The owner can't leave. The member's
   * workspace stays readable as history.
   */
  leaveEther(a: Actor, etherId: string): void {
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (m.ownerId === a.accountId) throw new EtherError('forbidden', "the owner can't leave; delete the ether instead")
      this.endMembership(etherId, a.accountId, this.nowMs())
      this.audit(a, etherId, 'member.leave', m.handle)
    })
  }

  /** Removes another member. Owner only. */
  removeMember(a: Actor, etherId: string, handle: string): void {
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (m.ownerId !== a.accountId) throw new EtherError('forbidden', 'only the owner can remove members')
      const row = this.db.get<{ id: string }>(
        `SELECT a.id FROM accounts a JOIN memberships m ON m.account_id = a.id
			 WHERE m.ether_id = ? AND a.handle = ? AND m.left_at IS NULL`, etherId, handle)
      if (!row) throw notFound()
      if (row.id === a.accountId) throw new EtherError('forbidden', "the owner can't remove themselves")
      this.endMembership(etherId, row.id, this.nowMs())
      this.audit(a, etherId, 'member.remove', handle)
    })
  }

  /**
   * Names the actor's agent in one ether. Agents start out as "@handle"; a
   * name is optional, and "" goes back to that. A name can't look like a
   * handle or match another member's handle or agent name, so nobody's agent
   * can pass for someone else's.
   */
  setAgentName(a: Actor, etherId: string, name: string): void {
    name = checkAgentName(name)
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      if (name !== '') {
        const taken = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM memberships m JOIN accounts acc ON acc.id = m.account_id
				 WHERE m.ether_id = ? AND m.left_at IS NULL AND m.account_id != ?
				 AND (lower(acc.handle) = lower(?) OR lower(m.agent_name) = lower(?))`,
          etherId, a.accountId, name, name)
        if (Number(taken?.n) > 0) {
          throw new EtherError('exists', `another member or their agent is already called ${goQuote(name)}`)
        }
      }
      this.db.run(`UPDATE memberships SET agent_name = ? WHERE ether_id = ? AND account_id = ?`, name, etherId, a.accountId)
      this.audit(a, etherId, 'agent.rename', name)
    })
  }

  // --- Invites (invites.go) ---

  /**
   * Invites an allowlisted email to an ether and returns the code. Any member
   * can invite. A new invite for the same email replaces the old one.
   * Members plus pending invites can't exceed the member limit.
   */
  createInvite(a: Actor, etherId: string, email: string): { code: string; invite: Invite } {
    email = normalizeEmail(email)
    const code = newInviteCode()
    const invite = this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (!this.isAllowedNormalized(email)) {
        throw new EtherError('not_allowed', `${email} can't be invited here. Ask the server's admin`)
      }
      const already = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memberships m JOIN accounts a ON a.id = m.account_id
			 WHERE m.ether_id = ? AND a.email = ? AND m.left_at IS NULL`, etherId, email)
      if (Number(already?.n) > 0) throw new EtherError('exists', `${email} is already a member`)
      const now = this.nowMs()
      this.db.run(
        `UPDATE invites SET revoked_at = ?
			 WHERE ether_id = ? AND email = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
        now, etherId, email)
      const members = this.activeMemberCount(etherId)
      const pending = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM invites WHERE ether_id = ? AND consumed_at IS NULL
			 AND revoked_at IS NULL AND expires_at > ?`, etherId, now)
      if (members + Number(pending?.n) >= this.limits.maxMembers) {
        throw new EtherError('limit', `an ether can have at most ${this.limits.maxMembers} members, counting pending invites`)
      }
      const e = this.loadEther(etherId)
      const inviter = this.accountWhere('id = ?', a.accountId)
      const inv: Invite = {
        id: newId(),
        etherId,
        etherName: e.name,
        email,
        invitedByHandle: m.handle,
        invitedByEmail: inviter.email,
        createdAt: date(now),
        expiresAt: date(now + this.limits.inviteTtlMs),
      }
      this.db.run(
        `INSERT INTO invites (id, ether_id, created_by, email, code_hmac, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        inv.id, etherId, a.accountId, email, this.codeHmac(code), now, inv.expiresAt.getTime())
      this.audit(a, etherId, 'invite.create', email)
      return inv
    })
    return { code, invite }
  }

  private codeHmac(code: string): string {
    return codeHmac(this.pepper, 'invite', normalizeCode(code))
  }

  /** Redeems an invite. The invite's email must match the actor's. */
  joinWithCode(a: Actor, code: string): Ether {
    const etherId = this.db.transaction(() => {
      const acct = this.accountWhere('id = ?', a.accountId)
      if (acct.disabled) throw new EtherError('disabled')
      const now = this.nowMs()
      const inv = this.inviteForCode(code, acct.email)
      const etherId = inv.etherId
      let member = true
      try {
        this.requireMember(etherId, a.accountId)
      } catch (err) {
        if (!isKind(err, 'not_found')) throw err
        member = false
      }
      if (member) throw new EtherError('exists', "you're already a member of this ether")
      if (this.activeMemberCount(etherId) >= this.limits.maxMembers) {
        throw new EtherError('limit', `this ether already has ${this.limits.maxMembers} members`)
      }
      this.db.run(
        `INSERT INTO memberships (ether_id, account_id, joined_at) VALUES (?, ?, ?)
			 ON CONFLICT(ether_id, account_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL`,
        etherId, a.accountId, now)
      this.ensureSystemFolders(etherId, a.accountId, acct.handle)
      this.db.run(`UPDATE invites SET consumed_at = ?, consumed_by = ? WHERE id = ?`, now, a.accountId, inv.id)
      this.audit(a, etherId, 'member.join', acct.handle)
      return etherId
    })
    return this.getEther(a, etherId)
  }

  /**
   * The pending invite for code if it was sent to email. Every other case
   * (unknown, expired, used, withdrawn, another address) is the same error,
   * so a code reveals nothing about invites it doesn't belong to.
   */
  private inviteForCode(code: string, email: string): Invite {
    const row = this.db.get<InviteRow>(
      `SELECT ${inviteColumns}
		 FROM invites i JOIN ethers e ON e.id = i.ether_id JOIN accounts a ON a.id = i.created_by
		 WHERE i.code_hmac = ? AND i.consumed_at IS NULL AND i.revoked_at IS NULL
		 AND i.expires_at > ? AND e.deleted_at IS NULL`,
      this.codeHmac(code), this.nowMs())
    if (!row || row.email !== email) {
      throw notFound('invite code is invalid, expired, already used, or for a different email')
    }
    return toInvite(row)
  }

  /** The pending invite for code, if it was sent to the actor's email. Looking doesn't use it up. */
  inviteByCode(a: Actor, code: string): Invite {
    return this.db.transaction(() => {
      const acct = this.accountWhere('id = ?', a.accountId)
      if (acct.disabled) throw new EtherError('disabled')
      return this.inviteForCode(code, acct.email)
    })
  }

  /** Turns down an invite sent to the actor's email. */
  declineInvite(a: Actor, code: string): void {
    this.db.transaction(() => {
      const acct = this.accountWhere('id = ?', a.accountId)
      const inv = this.inviteForCode(code, acct.email)
      this.db.run(`UPDATE invites SET revoked_at = ? WHERE id = ?`, this.nowMs(), inv.id)
      this.audit(a, inv.etherId, 'invite.decline', inv.email)
    })
  }

  /** Cancels a pending invite. Owner only. */
  revokeInvite(a: Actor, etherId: string, inviteId: string): void {
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      if (m.ownerId !== a.accountId) throw new EtherError('forbidden', 'only the owner can revoke invites')
      const res = this.db.run(
        `UPDATE invites SET revoked_at = ? WHERE id = ? AND ether_id = ?
			 AND consumed_at IS NULL AND revoked_at IS NULL`, this.nowMs(), inviteId, etherId)
      if (res.changes === 0) throw notFound()
      this.audit(a, etherId, 'invite.revoke', inviteId)
    })
  }

  /** Cancels the pending invite for an email. Owner only. */
  revokeInviteByEmail(a: Actor, etherId: string, email: string): void {
    email = normalizeEmail(email)
    const row = this.db.get<{ id: string }>(
      `SELECT id FROM invites WHERE ether_id = ? AND email = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      etherId, email, this.nowMs())
    if (!row) throw notFound()
    this.revokeInvite(a, etherId, row.id)
  }

  /** An ether's pending invites. Any member can see them. */
  listInvites(a: Actor, etherId: string): Invite[] {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      return this.pendingInvites('i.ether_id = ?', etherId)
    })
  }

  /** Invites waiting for the actor's own email. */
  pendingInvitesFor(a: Actor): Invite[] {
    return this.db.transaction(() => {
      const acct = this.accountWhere('id = ?', a.accountId)
      return this.pendingInvites('i.email = ?', acct.email)
    })
  }

  private pendingInvites(where: 'i.ether_id = ?' | 'i.email = ?', arg: string): Invite[] {
    return this.db.all<InviteRow>(
      `SELECT ${inviteColumns}
		 FROM invites i JOIN ethers e ON e.id = i.ether_id JOIN accounts a ON a.id = i.created_by
		 WHERE ${where} AND i.consumed_at IS NULL AND i.revoked_at IS NULL
		 AND i.expires_at > ? AND e.deleted_at IS NULL ORDER BY i.created_at`, arg, this.nowMs(),
    ).map(toInvite)
  }

  // --- Files and folders (nodes.go) ---

  private getNode(etherId: string, path: string): Node | undefined {
    const r = this.db.get<{
      id: string; kind: 'file' | 'folder'; path: string; author_id: string; handle: string
      mode: Mode; system: number; head_version: number
    }>(
      `SELECT n.id, n.kind, n.path, n.author_id, a.handle, n.mode, n.system, n.head_version
		 FROM nodes n JOIN accounts a ON a.id = n.author_id
		 WHERE n.ether_id = ? AND n.path = ? AND n.deleted_at IS NULL`, etherId, path)
    if (!r) return undefined
    return {
      id: r.id, kind: r.kind, path: r.path, authorId: r.author_id, authorHandle: r.handle,
      mode: r.mode, system: !!r.system, head: Number(r.head_version),
    }
  }

  /** The permission target for path p (and node n, if it exists). */
  private target(p: Path, m: Membership, actorId: string, n: Node | undefined): Target {
    const t: Target = { zone: p.zone(), isOwner: m.ownerId === actorId }
    if (t.zone === ZONE_WORKSPACE) t.ownWorkspace = p.workspaceHandle().toLowerCase() === m.handle.toLowerCase()
    if (n) {
      t.isAuthor = n.authorId === actorId
      t.mode = n.mode
    }
    return t
  }

  /**
   * Creates p and any missing ancestors as folders and returns p's node.
   * Children take their parent's stored spelling, so "members/Alex/x" lands
   * under an existing "members/alex". Callers check permissions first.
   */
  private mkdirAll(etherId: string, p: Path, authorId: string): Node {
    let parent: Node | undefined
    for (let i = 1; i <= p.depth(); i++) {
      const sub = new Path(p.segs.slice(0, i))
      const n = this.getNode(etherId, sub.toString())
      if (n) {
        if (n.kind !== 'folder') throw invalid(`${n.path} is a file, not a folder`)
        parent = n
        continue
      }
      let path = sub.name()
      let parentId: string | null = null
      if (parent) {
        path = parent.path + '/' + sub.name()
        parentId = parent.id
      }
      const id = newId()
      const now = this.nowMs()
      this.db.run(
        `INSERT INTO nodes (id, ether_id, parent_id, kind, name, path, author_id, system, created_at, updated_at)
			 VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, ?, ?)`,
        id, etherId, parentId, sub.name(), path, authorId, sub.isRoot() ? 1 : 0, now, now)
      parent = {
        id, kind: 'folder', path, authorId, authorHandle: '', mode: MODE_AUTHOR_ONLY, system: sub.isRoot(), head: 0,
      }
    }
    return parent!
  }

  private checkEntryLimit(etherId: string, adding: number): void {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM nodes WHERE ether_id = ? AND deleted_at IS NULL`, etherId)
    if (Number(row?.n) + adding > this.limits.maxFilesPerEther) {
      throw new EtherError('limit', `an ether can hold at most ${this.limits.maxFilesPerEther} files and folders`)
    }
  }

  private checkStorageLimit(etherId: string, adding: number): void {
    const row = this.db.get<{ n: number }>(
      `SELECT COALESCE(SUM(v.size), 0) AS n FROM versions v JOIN nodes n ON n.id = v.node_id WHERE n.ether_id = ?`, etherId)
    if (Number(row?.n) + adding > this.limits.maxEtherBytes) {
      throw new EtherError('limit', `the ether's storage limit (${this.limits.maxEtherBytes} bytes, including history) is full`)
    }
  }

  private headAuthor(nodeId: string, version: number): string {
    const row = this.db.get<{ handle: string }>(
      `SELECT a.handle FROM versions v JOIN accounts a ON a.id = v.author_id WHERE v.node_id = ? AND v.version = ?`,
      nodeId, version)
    if (!row) throw new Error('sql: no rows in result set')
    return row.handle
  }

  /**
   * Creates or replaces a text file. expected is the version the caller last
   * read: 0 to create a new file, otherwise the current head. A stale
   * expected throws a ConflictError. mode applies only in shared/.
   * content may be a string, which is written as UTF-8.
   */
  writeFile(a: Actor, etherId: string, rawPath: string, content: Uint8Array | string, expected: number, mode?: Mode): WriteResult {
    const p = parsePath(rawPath)
    if (p.isRoot()) throw invalid(`${p} is a system folder`)
    if (mode !== undefined && p.zone() !== ZONE_SHARED) throw invalid('mode applies only to files in shared/')
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    let ft: Type
    try {
      ft = validate(p.name(), bytes)
    } catch (err) {
      throw fileTypeError(err)
    }
    const size = bytes.length

    return this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      const n = this.getNode(etherId, p.toString())
      if (n && n.kind === 'folder') throw invalid(`${n.path} is a folder`)

      let current = 0
      let currentAuthor = ''
      if (n) {
        current = n.head
        currentAuthor = this.headAuthor(n.id, n.head)
      }
      if (expected !== current) throw new ConflictError(p.toString(), current, currentAuthor)

      const t = this.target(p, m, a.accountId, n)
      if (!n) {
        if (!allowed(OP_CREATE, t)) throw forbidden(OP_CREATE, p)
      } else {
        if (!allowed(OP_EDIT, t)) throw forbidden(OP_EDIT, p)
        if (mode !== undefined && mode !== n.mode && !allowed(OP_CHANGE_MODE, t)) throw forbidden(OP_CHANGE_MODE, p)
      }

      if (!n) this.checkEntryLimit(etherId, 1)
      this.checkStorageLimit(etherId, size)

      const now = this.nowMs()
      const created = !n
      let nodeId: string
      let storedPath: string
      let version: number
      if (!n) {
        const parent = this.mkdirAll(etherId, p.parent()!, a.accountId)
        nodeId = newId()
        storedPath = parent.path + '/' + p.name()
        version = 1
        this.db.run(
          `INSERT INTO nodes (id, ether_id, parent_id, kind, name, path, author_id, mode, head_version, created_at, updated_at)
				 VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 1, ?, ?)`,
          nodeId, etherId, parent.id, p.name(), storedPath, a.accountId, mode ?? MODE_AUTHOR_ONLY, now, now)
      } else {
        nodeId = n.id
        storedPath = n.path
        version = n.head + 1
        this.db.run(
          `UPDATE nodes SET head_version = ?, mode = ?, updated_at = ? WHERE id = ?`,
          version, mode ?? n.mode, now, nodeId)
      }

      // The content and its row commit with the version that references them.
      const sum = this.blobs.put(bytes)
      this.db.run(
        `INSERT INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(sha256) DO UPDATE SET unreferenced_since = NULL`,
        sum, size, ft.mime, now)
      this.db.run(
        `INSERT INTO versions (node_id, version, blob_sha256, mime_type, size, author_id, client_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        nodeId, version, sum, ft.mime, size, a.accountId, a.clientId ?? '', now)
      this.pruneVersions(nodeId, version)
      this.audit(a, etherId, 'file.write', storedPath, { version, size })
      return { path: storedPath, version, size, sha256: sum, created }
    })
  }

  /**
   * Keeps the newest maxVersionsPerFile versions of a node and marks blobs
   * that nothing references anymore.
   */
  private pruneVersions(nodeId: string, head: number): void {
    const cutoff = head - this.limits.maxVersionsPerFile
    if (cutoff < 1) return
    const shas = this.db.all<{ sha: string }>(
      `SELECT DISTINCT blob_sha256 AS sha FROM versions WHERE node_id = ? AND version <= ? AND blob_sha256 IS NOT NULL`,
      nodeId, cutoff).map((r) => r.sha)
    this.db.run(`DELETE FROM versions WHERE node_id = ? AND version <= ?`, nodeId, cutoff)
    this.markUnreferenced(shas)
  }

  /**
   * Stamps blobs that no version points to, so garbage collection can
   * delete them after a grace period.
   */
  private markUnreferenced(shas: string[]): void {
    for (const sha of shas) {
      this.db.run(
        `UPDATE blobs SET unreferenced_since = ? WHERE sha256 = ? AND unreferenced_since IS NULL
			 AND NOT EXISTS (SELECT 1 FROM versions WHERE blob_sha256 = ?)`,
        this.nowMs(), sha, sha)
    }
  }

  /** A file's head version, or a specific version if version > 0. */
  readFile(a: Actor, etherId: string, rawPath: string, version = 0): File {
    const p = parsePath(rawPath)
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const n = this.getNode(etherId, p.toString())
      if (!n) throw notFound()
      if (n.kind === 'folder') throw new FolderError(`${n.path} is a folder; list it instead`)
      if (version <= 0) version = n.head
      const v = this.db.get<{
        blob_sha256: string | null; mime_type: string; size: number; handle: string
        client_id: string; created_at: number; is_tombstone: number
      }>(
        `SELECT v.blob_sha256, v.mime_type, v.size, a.handle, v.client_id, v.created_at, v.is_tombstone
			 FROM versions v JOIN accounts a ON a.id = v.author_id WHERE v.node_id = ? AND v.version = ?`,
        n.id, version)
      if (!v) throw notFound(`${n.path} has no version ${version} (it may have been pruned)`)
      if (v.is_tombstone || v.blob_sha256 === null) throw notFound()
      const content = this.blobs.get(v.blob_sha256)
      if (!content) throw new Error(`reading ${n.path}: blob ${v.blob_sha256} is missing`)
      return {
        path: n.path,
        kind: 'file',
        version,
        size: Number(v.size),
        mime: v.mime_type,
        mode: n.mode,
        author: n.authorHandle,
        updatedBy: v.handle,
        clientId: v.client_id,
        updatedAt: date(v.created_at),
        sha256: v.blob_sha256,
        content,
      }
    })
  }

  /**
   * Lists a folder's children, or everything under it when recursive. An
   * empty prefix lists the top level (members/ and shared/).
   */
  listFiles(a: Actor, etherId: string, prefix = '', recursive = false): FileInfo[] {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      let where = 'n.parent_id IS NULL'
      let args: SqlValue[] = []
      if (prefix === '' && recursive) {
        where = '1 = 1'
      } else if (prefix !== '') {
        const p = parsePath(prefix)
        const dir = this.getNode(etherId, p.toString())
        if (!dir) throw notFound()
        if (dir.kind !== 'folder') throw invalid(`${dir.path} is a file; read it instead`)
        if (recursive) {
          where = 'lower(substr(n.path, 1, ?)) = lower(?)'
          args = [dir.path.length + 1, dir.path + '/']
        } else {
          where = 'n.parent_id = ?'
          args = [dir.id]
        }
      }
      return this.db.all<{
        path: string; kind: 'file' | 'folder'; head_version: number; mode: Mode; handle: string; updated_at: number
        size: number; mime: string; updated_by: string; client_id: string
      }>(
        `SELECT n.path, n.kind, n.head_version, n.mode, a.handle, n.updated_at,
			        COALESCE(v.size, 0) AS size, COALESCE(v.mime_type, '') AS mime,
			        COALESCE(va.handle, '') AS updated_by, COALESCE(v.client_id, '') AS client_id
			 FROM nodes n
			 JOIN accounts a ON a.id = n.author_id
			 LEFT JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			 LEFT JOIN accounts va ON va.id = v.author_id
			 WHERE n.ether_id = ? AND n.deleted_at IS NULL AND ${where}
			 ORDER BY n.path`, etherId, ...args,
      ).map((r) => ({
        path: r.path,
        kind: r.kind,
        version: Number(r.head_version),
        size: Number(r.size),
        mime: r.mime,
        mode: r.mode,
        author: r.handle,
        updatedBy: r.updated_by,
        clientId: r.client_id,
        updatedAt: date(r.updated_at),
      }))
    })
  }

  /** A file's versions, newest first. */
  fileHistory(a: Actor, etherId: string, rawPath: string): VersionInfo[] {
    const p = parsePath(rawPath)
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const n = this.getNode(etherId, p.toString())
      if (!n) throw notFound()
      if (n.kind === 'folder') throw new FolderError(`${n.path} is a folder`)
      return this.db.all<{
        version: number; size: number; sha: string; handle: string; client_id: string; created_at: number; is_tombstone: number
      }>(
        `SELECT v.version, v.size, COALESCE(v.blob_sha256, '') AS sha, a.handle, v.client_id, v.created_at, v.is_tombstone
			 FROM versions v JOIN accounts a ON a.id = v.author_id
			 WHERE v.node_id = ? ORDER BY v.version DESC`, n.id,
      ).map((r) => ({
        version: Number(r.version),
        size: Number(r.size),
        sha256: r.sha,
        author: r.handle,
        clientId: r.client_id,
        createdAt: date(r.created_at),
        tombstone: !!r.is_tombstone,
      }))
    })
  }

  /**
   * Deletes a file (recording a tombstone version) or an empty folder. For
   * files, expected must equal the current head version.
   */
  deleteFile(a: Actor, etherId: string, rawPath: string, expected: number): void {
    const p = parsePath(rawPath)
    if (p.isRoot()) throw new EtherError('forbidden', `${p} is a system folder`)
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      const n = this.getNode(etherId, p.toString())
      if (!n) throw notFound()
      if (n.kind === 'file' && expected !== n.head) {
        throw new ConflictError(n.path, n.head, this.headAuthor(n.id, n.head))
      }
      if (!allowed(OP_DELETE, this.target(p, m, a.accountId, n))) throw forbidden(OP_DELETE, p)
      const now = this.nowMs()
      let head = n.head
      if (n.kind === 'folder') {
        const children = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ? AND deleted_at IS NULL`, n.id)
        if (Number(children?.n) > 0) throw invalid(`${n.path} isn't empty`)
      } else {
        head++
        this.db.run(
          `INSERT INTO versions (node_id, version, author_id, client_id, created_at, is_tombstone)
				 VALUES (?, ?, ?, ?, ?, 1)`, n.id, head, a.accountId, a.clientId ?? '', now)
      }
      this.db.run(`UPDATE nodes SET deleted_at = ?, updated_at = ?, head_version = ? WHERE id = ?`, now, now, head, n.id)
      this.audit(a, etherId, `${n.kind}.delete`, n.path)
    })
  }

  /**
   * Creates a folder and any missing parents and returns its stored path.
   * Creating a folder that already exists succeeds.
   */
  createFolder(a: Actor, etherId: string, rawPath: string): string {
    const p = parsePath(rawPath)
    return this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      const existing = this.getNode(etherId, p.toString())
      if (existing) {
        if (existing.kind !== 'folder') throw invalid(`${existing.path} is a file`)
        return existing.path
      }
      if (!allowed(OP_CREATE, this.target(p, m, a.accountId, undefined))) throw forbidden(OP_CREATE, p)
      this.checkEntryLimit(etherId, p.depth())
      const n = this.mkdirAll(etherId, p, a.accountId)
      this.audit(a, etherId, 'folder.create', n.path)
      return n.path
    })
  }

  /** Changes a shared file's write mode. */
  setMode(a: Actor, etherId: string, rawPath: string, mode: Mode): void {
    const p = parsePath(rawPath)
    if (p.zone() !== ZONE_SHARED || p.isRoot()) throw invalid('mode applies only to files in shared/')
    parseMode(mode)
    this.db.transaction(() => {
      const m = this.requireMember(etherId, a.accountId)
      const n = this.getNode(etherId, p.toString())
      if (!n) throw notFound()
      if (n.kind !== 'file') throw invalid('mode applies only to files')
      if (!allowed(OP_CHANGE_MODE, this.target(p, m, a.accountId, n))) throw forbidden(OP_CHANGE_MODE, p)
      this.db.run(`UPDATE nodes SET mode = ?, updated_at = ? WHERE id = ?`, mode, this.nowMs(), n.id)
      this.audit(a, etherId, 'file.mode', n.path, { mode })
    })
  }

  // --- The board (board.go) ---

  private checkPost(input: PostInput): void {
    parseIntent(input.intent)
    const body = input.body ?? ''
    const title = input.title ?? ''
    if (trimSpace(body) === '') throw invalid('post body is empty')
    if (utf8Length(body) > this.limits.maxPostBytes) {
      throw new EtherError('limit', `posts can be at most ${this.limits.maxPostBytes} bytes`)
    }
    if (!validUtf8(body) || body.includes('\0')) throw invalid('post body must be UTF-8 text')
    if (runeCount(title) > 200) throw invalid('title can be at most 200 characters')
    if (hasControl(title)) throw invalid("title can't contain control characters or line breaks")
  }

  /** Adds a post to an ether's board, now or at input.sendAt. */
  postMessage(a: Actor, etherId: string, input: PostInput): Post {
    this.checkPost(input)
    const now = this.now().getTime()
    let sendAt: number | null = null
    let publishedAt: number | null = null
    if (input.sendAt && input.sendAt.getTime() > now) {
      if (input.sendAt.getTime() - now > this.limits.maxScheduleAheadMs) {
        throw invalid(`posts can be scheduled at most ${goDuration(this.limits.maxScheduleAheadMs)} ahead`)
      }
      sendAt = input.sendAt.getTime()
    } else {
      publishedAt = now
    }
    const id = newId()
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      let replyTo: string | null = null
      if (input.replyTo) {
        const row = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM board_posts WHERE id = ? AND ether_id = ?
				 AND published_at IS NOT NULL AND deleted_at IS NULL`, input.replyTo, etherId)
        if (Number(row?.n) === 0) throw notFound(`post ${input.replyTo} to reply to`)
        replyTo = input.replyTo
      }
      this.db.run(
        `INSERT INTO board_posts (id, ether_id, author_id, client_id, intent, title, body, reply_to, created_at, send_at, published_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, etherId, a.accountId, a.clientId ?? '', input.intent, input.title ?? '', input.body, replyTo, now, sendAt, publishedAt)
      this.audit(a, etherId, 'post.create', id, { intent: input.intent, scheduled: sendAt !== null })
    })
    return this.getPost(id)
  }

  private getPost(id: string): Post {
    const row = this.db.get<PostRow>(
      `SELECT ${postColumns} FROM board_posts p JOIN accounts a ON a.id = p.author_id WHERE p.id = ?`, id)
    if (!row) throw notFound()
    return toPost(row)
  }

  /**
   * Published posts newer than since (undefined: all), oldest first. limit
   * defaults to 50 and is capped at 200.
   */
  readBoard(a: Actor, etherId: string, since?: Date, limit = 0): Post[] {
    if (limit <= 0) limit = 50
    limit = Math.min(limit, 200)
    return this.queryPosts(a, etherId,
      `p.published_at > ? AND p.deleted_at IS NULL ORDER BY p.published_at, p.id LIMIT ?`,
      since ? since.getTime() : zeroTimeMs, limit)
  }

  /** The actor's own posts that haven't published yet. */
  listScheduled(a: Actor, etherId: string): Post[] {
    return this.queryPosts(a, etherId,
      `p.author_id = ? AND p.published_at IS NULL AND p.cancelled_at IS NULL ORDER BY p.send_at`, a.accountId)
  }

  private queryPosts(a: Actor, etherId: string, where: string, ...args: SqlValue[]): Post[] {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      return this.db.all<PostRow>(
        `SELECT ${postColumns} FROM board_posts p JOIN accounts a ON a.id = p.author_id
			 WHERE p.ether_id = ? AND ${where}`, etherId, ...args,
      ).map(toPost)
    })
  }

  /** Cancels the actor's scheduled post or deletes their published one. */
  cancelPost(a: Actor, etherId: string, postId: string): void {
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const row = this.db.get<{ author_id: string; published_at: number | null }>(
        `SELECT author_id, published_at FROM board_posts
			 WHERE id = ? AND ether_id = ? AND cancelled_at IS NULL AND deleted_at IS NULL`, postId, etherId)
      if (!row) throw notFound()
      if (row.author_id !== a.accountId) throw new EtherError('forbidden', "only a post's author can cancel or delete it")
      const [col, action] = row.published_at !== null ? ['deleted_at', 'post.delete'] : ['cancelled_at', 'post.cancel']
      this.db.run(`UPDATE board_posts SET ${col} = ? WHERE id = ?`, this.nowMs(), postId)
      this.audit(a, etherId, action, postId)
    })
  }

  /**
   * Publishes scheduled posts whose time has come and returns how many.
   * Posts are stamped with the actual publish time so "since" catch-up
   * queries never skip them. Posts whose author has left the ether or been
   * disabled are cancelled.
   */
  publishDue(): number {
    return this.db.transaction(() => {
      const now = this.nowMs()
      const due = `published_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL AND send_at <= ?`
      const authorActive = `EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id
			JOIN ethers e ON e.id = m.ether_id
			WHERE m.ether_id = board_posts.ether_id AND m.account_id = board_posts.author_id
			AND m.left_at IS NULL AND a.disabled_at IS NULL AND e.deleted_at IS NULL)`
      const published = this.db.run(`UPDATE board_posts SET published_at = ? WHERE ${due} AND ${authorActive}`, now, now).changes
      this.db.run(`UPDATE board_posts SET cancelled_at = ? WHERE ${due} AND NOT ${authorActive}`, now, now)
      return published
    })
  }

  // --- Activity and the audit log (activity.go) ---

  /**
   * Recent events in an ether, newest first. If handle is set, only that
   * member's events. limit defaults to 30, max 200.
   */
  activity(a: Actor, etherId: string, handle = '', limit = 0): Event[] {
    return this.activityPage(a, etherId, { handle, limit }).events
  }

  /** One page of an ether's events matching f, newest first, and how many match in all. */
  activityPage(a: Actor, etherId: string, f: ActivityFilter = {}): { events: Event[]; total: number } {
    let limit = f.limit ?? 0
    if (limit <= 0) limit = 30
    limit = Math.min(limit, 200)
    const offset = Math.max(f.offset ?? 0, 0)
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      let where = ''
      const args: SqlValue[] = [etherId]
      if (f.handle) {
        where += ' AND acc.handle = ?'
        args.push(f.handle)
      }
      if (f.from) {
        where += ' AND l.at >= ?'
        args.push(f.from.getTime())
      }
      if (f.until) {
        where += ' AND l.at < ?'
        args.push(f.until.getTime())
      }
      const from = `
			 FROM audit_log l
			 JOIN accounts acc ON acc.id = l.account_id
			 LEFT JOIN board_posts p ON l.action LIKE 'post.%' AND p.id = l.target
			 LEFT JOIN requests rq ON l.action LIKE 'request.%' AND rq.id = l.target
			 LEFT JOIN accounts rf ON rf.id = rq.asked_by
			 WHERE l.ether_id = ? AND l.action IN ${activityActions} AND ${visiblePost}`
      const total = Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n${from}${where}`, ...args)?.n ?? 0)
      const rows = this.db.all<{
        at: number; handle: string; client_id: string; action: string; target: string; detail: string
        post_title: string; post_intent: string; request_title: string; request_from: string; request_to: string
      }>(
        `SELECT l.at, acc.handle, l.client_id, l.action, l.target, l.detail,
			        COALESCE(p.title, '') AS post_title, COALESCE(p.intent, '') AS post_intent,
			        COALESCE(rq.title, '') AS request_title, COALESCE(rf.handle, '') AS request_from,
			        COALESCE((SELECT GROUP_CONCAT(ta.handle, ' ') FROM request_recipients rr
			                  JOIN accounts ta ON ta.id = rr.account_id WHERE rr.request_id = rq.id), '') AS request_to` +
          from + where + ` ORDER BY l.at DESC, l.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset)
      const events = rows.map((r): Event => {
        const e: Event = {
          at: date(r.at),
          handle: r.handle,
          clientId: r.client_id,
          action: r.action,
          target: r.target,
          version: 0,
          mode: '',
          intent: r.post_intent,
          postTitle: r.post_title,
          requestTitle: r.request_title,
          requestFrom: r.request_from,
          requestTo: fields(r.request_to),
          newName: r.action === 'agent.rename' ? r.target : '',
        }
        const d = parseDetail(r.detail)
        if (d) {
          e.version = Math.trunc(d.version)
          e.mode = d.mode
          if (e.intent === '') e.intent = d.intent
        }
        return e
      })
      return { events, total }
    })
  }

  /**
   * MemberActivity for everyone who has done anything in the ether, keyed by handle.
   */
  membersActivity(a: Actor, etherId: string): Map<string, MemberActivity> {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const out = new Map<string, MemberActivity>()
      for (const r of this.db.all<{ handle: string; last: number; clients: string }>(
        `SELECT acc.handle, MAX(l.at) AS last, COALESCE(GROUP_CONCAT(DISTINCT l.client_id), '') AS clients
			 FROM audit_log l
			 JOIN accounts acc ON acc.id = l.account_id
			 LEFT JOIN board_posts p ON l.action LIKE 'post.%' AND p.id = l.target
			 WHERE l.ether_id = ? AND l.action IN ${activityActions} AND ${visiblePost}
			 GROUP BY acc.handle`, etherId)) {
        const clients = r.clients.split(',').filter((c) => c !== '').sort(compareStrings)
        out.set(r.handle, { lastActive: date(r.last), clients })
      }
      return out
    })
  }

  /**
   * The newest audit entries, optionally for one ether. It's for the server
   * owner; it checks no membership.
   */
  auditLog(etherId: string, limit: number): AuditEntry[] {
    const where = etherId !== '' ? ' WHERE l.ether_id = ?' : ''
    const args: SqlValue[] = etherId !== '' ? [etherId] : []
    return this.db.all<{
      at: number; handle: string; client_id: string; ether_id: string; action: string; target: string; detail: string
    }>(
      `SELECT l.at, COALESCE(a.handle, '') AS handle, l.client_id, COALESCE(l.ether_id, '') AS ether_id, l.action, l.target, l.detail
		 FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id${where}
		 ORDER BY l.id DESC LIMIT ?`, ...args, limit,
    ).map((r) => ({
      at: date(r.at),
      handle: r.handle,
      clientId: r.client_id,
      etherId: r.ether_id,
      action: r.action,
      target: r.target,
      detail: r.detail,
    }))
  }

  // --- Catch-up (pull.go) ---

  /**
   * Everything new in an ether since `since`, or, when since is undefined,
   * since this client's last pull. It then records this pull as the
   * client's new catch-up point. Each (account, client) pair has its own
   * point, so the same person's ChatGPT and Codex catch up separately.
   */
  pull(a: Actor, etherId: string, since?: Date): Digest {
    const now = this.now()
    const clientId = a.clientId ?? ''
    const d = this.db.transaction((): Digest => {
      const m = this.requireMember(etherId, a.accountId)
      const ether = this.loadEther(etherId)
      let from = since
      if (!from) {
        const row = this.db.get<{ pulled_at: number }>(
          `SELECT pulled_at FROM pull_cursors WHERE account_id = ? AND client_id = ? AND ether_id = ?`,
          a.accountId, clientId, etherId)
        if (row) from = date(row.pulled_at)
      }
      const sinceMs = from ? from.getTime() : zeroTimeMs
      const changes = this.db.all<{
        path: string; head_version: number; handle: string; updated_at: number; created_at: number; deleted_at: number | null
      }>(
        `SELECT n.path, n.head_version, COALESCE(acc.handle, '') AS handle, n.updated_at, n.created_at, n.deleted_at
			 FROM nodes n
			 LEFT JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			 LEFT JOIN accounts acc ON acc.id = v.author_id
			 WHERE n.ether_id = ? AND n.kind = 'file' AND n.updated_at > ?
			 ORDER BY n.updated_at`, etherId, sinceMs,
      ).map((r): Change => ({
        path: r.path,
        version: Number(r.head_version),
        by: r.handle,
        at: date(r.updated_at),
        created: r.created_at > sinceMs,
        deleted: r.deleted_at !== null,
      }))
      return {
        ether, yourHandle: m.handle, since: from, pulledAt: now, paths: [], changes, posts: [], scheduled: [],
        invites: [], readme: '', answers: [], yourOpen: [], forYourUser: [],
      }
    })

    d.paths = this.listFiles(a, etherId, '', true)
    d.posts = this.readBoard(a, etherId, d.since, 200)
    d.scheduled = this.listScheduled(a, etherId)
    d.invites = this.listInvites(a, etherId)
    const requests = this.listRequests(a, etherId)
    const sinceMs = d.since ? d.since.getTime() : zeroTimeMs
    for (let i = requests.length - 1; i >= 0; i--) { // oldest first
      const r = requests[i]
      if (r.fromId === a.accountId) {
        if (r.to.some((rc) => rc.answeredAt !== undefined && rc.answeredAt.getTime() > sinceMs)) d.answers.push(r)
        if (r.status === REQUEST_OPEN) d.yourOpen.push(r)
      }
      if (r.waitingOn(a.accountId)) d.forYourUser.push(r)
    }
    try {
      const f = this.readFile(a, etherId, 'shared/README.md', 0)
      d.readme = new TextDecoder('utf-8', { ignoreBOM: true }).decode(f.content)
    } catch (err) {
      if (!isKind(err, 'not_found')) throw err
    }

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO pull_cursors (account_id, client_id, ether_id, pulled_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(account_id, client_id, ether_id) DO UPDATE SET pulled_at = excluded.pulled_at`,
        a.accountId, clientId, etherId, now.getTime())
    })
    return d
  }

  // --- Requests (requests.go) ---

  /** Creates a request from the actor's agent to one or more members. */
  ask(a: Actor, etherId: string, input: AskInput): Request {
    const req = checkAsk(input)
    const id = newId()
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const to: string[] = []
      for (let h of req.to) {
        h = trimSpace(h)
        if (h.startsWith('@')) h = h.slice(1)
        const row = this.db.get<{ id: string }>(
          `SELECT a.id FROM accounts a JOIN memberships m ON m.account_id = a.id
				 WHERE m.ether_id = ? AND m.left_at IS NULL AND a.disabled_at IS NULL AND a.handle = ?`, etherId, h)
        if (!row) throw invalid(`${goQuote(h)} isn't a member of this ether; use handles from list_ethers`)
        if (!to.includes(row.id)) to.push(row.id)
      }
      const now = this.nowMs()
      const open = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM requests r WHERE r.ether_id = ? AND r.asked_by = ?
			 AND r.withdrawn_at IS NULL AND r.expires_at > ?
			 AND EXISTS (SELECT 1 FROM request_recipients rr WHERE rr.request_id = r.id AND rr.answered_at IS NULL)`,
        etherId, a.accountId, now)
      if (Number(open?.n) >= MAX_OPEN_REQUESTS) {
        throw new EtherError('limit',
          `your agents already have ${MAX_OPEN_REQUESTS} open requests in this ether; withdraw one or wait for answers`)
      }
      this.db.run(
        `INSERT INTO requests (id, ether_id, asked_by, client_id, title, body, choices, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, etherId, a.accountId, a.clientId ?? '', req.title, req.body, goJson(req.choices), now, now + REQUEST_TTL_MS)
      for (const accountId of to) {
        this.db.run(`INSERT INTO request_recipients (request_id, account_id) VALUES (?, ?)`, id, accountId)
      }
      this.audit(a, etherId, 'request.create', id)
    })
    return this.getRequest(a, etherId, id)
  }

  /**
   * Records the actor's answer to a request that asked them: one of the
   * choices (choice is its index), or, when there are none, a note (choice
   * -1). A note can go with a choice too. Each person answers once, and
   * answers are final.
   */
  answerRequest(a: Actor, etherId: string, requestId: string, choice: number, note = ''): Request {
    note = trimSpace(note)
    if (runeCount(note) > maxAnswerNote || note.includes('\0')) {
      throw invalid(`the note can be at most ${maxAnswerNote} characters`)
    }
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const r = this.loadRequest(etherId, requestId)
      const rc = r.recipient(a.accountId)
      if (!rc) throw new EtherError('forbidden', "this request didn't ask you")
      if (rc.answered()) throw new EtherError('conflict', 'you already answered this request')
      if (r.status !== REQUEST_OPEN) throw new EtherError('conflict', `this request is ${r.status}`)
      if (r.choices.length > 0 && (choice < 0 || choice >= r.choices.length)) throw invalid('pick one of the choices')
      if (r.choices.length === 0 && choice !== -1) throw invalid('this request has no choices to pick')
      if (r.choices.length === 0 && note === '') throw invalid('write an answer')
      this.db.run(
        `UPDATE request_recipients SET answered_at = ?, answer_choice = ?, answer_note = ?
			 WHERE request_id = ? AND account_id = ?`,
        this.nowMs(), choice >= 0 ? choice : null, note, requestId, a.accountId)
      this.audit(a, etherId, 'request.answer', requestId)
    })
    return this.getRequest(a, etherId, requestId)
  }

  /**
   * Closes an open request, even if some people have answered. Any of the
   * asking member's apps can, since the request belongs to the member.
   */
  withdrawRequest(a: Actor, etherId: string, requestId: string): void {
    this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      const r = this.loadRequest(etherId, requestId)
      if (r.fromId !== a.accountId) throw new EtherError('forbidden', `only @${r.from}'s agents can withdraw this request`)
      if (r.status !== REQUEST_OPEN) throw new EtherError('conflict', `this request is ${r.status}`)
      this.db.run(`UPDATE requests SET withdrawn_at = ? WHERE id = ?`, this.nowMs(), requestId)
      this.audit(a, etherId, 'request.withdraw', requestId)
    })
  }

  /** One request. Every member can see every request in their ether, like the board. */
  getRequest(a: Actor, etherId: string, requestId: string): Request {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      return this.loadRequest(etherId, requestId)
    })
  }

  /** An ether's requests, newest first (at most 1000). */
  listRequests(a: Actor, etherId: string): Request[] {
    return this.db.transaction(() => {
      this.requireMember(etherId, a.accountId)
      return this.queryRequests(`r.ether_id = ? ORDER BY r.created_at DESC LIMIT 1000`, etherId)
    })
  }

  /** Per ether id, how many open requests are waiting for the actor's answer. */
  openRequestCounts(a: Actor): Map<string, number> {
    const out = new Map<string, number>()
    for (const r of this.db.all<{ id: string; n: number }>(
      `SELECT r.ether_id AS id, COUNT(*) AS n FROM request_recipients rr
		 JOIN requests r ON r.id = rr.request_id
		 JOIN memberships m ON m.ether_id = r.ether_id AND m.account_id = rr.account_id AND m.left_at IS NULL
		 WHERE rr.account_id = ? AND rr.answered_at IS NULL AND r.withdrawn_at IS NULL AND r.expires_at > ?
		 GROUP BY r.ether_id`, a.accountId, this.nowMs())) {
      out.set(r.id, Number(r.n))
    }
    return out
  }

  /** Turns request emails on or off for an account. */
  setRequestEmails(accountId: string, on: boolean): void {
    this.db.transaction(() => {
      if (this.db.run(`UPDATE accounts SET request_emails = ? WHERE id = ?`, on ? 1 : 0, accountId).changes === 0) {
        throw notFound()
      }
    })
  }

  private loadRequest(etherId: string, requestId: string): Request {
    const list = this.queryRequests(`r.id = ? AND r.ether_id = ?`, requestId, etherId)
    if (list.length === 0) throw notFound()
    return list[0]
  }

  /**
   * Loads the requests matching where (a condition on r, with any ORDER BY
   * and LIMIT), then everyone each one asked.
   */
  private queryRequests(where: string, ...args: SqlValue[]): Request[] {
    const rows = this.db.all<{
      id: string; ether_id: string; name: string; asked_by: string; handle: string; client_id: string
      title: string; body: string; choices: string; created_at: number; expires_at: number; withdrawn_at: number | null
    }>(
      `SELECT r.id, r.ether_id, e.name, r.asked_by, fa.handle, r.client_id, r.title, r.body, r.choices,
		        r.created_at, r.expires_at, r.withdrawn_at
		 FROM requests r JOIN ethers e ON e.id = r.ether_id JOIN accounts fa ON fa.id = r.asked_by
		 WHERE ${where}`, ...args)
    if (rows.length === 0) return []
    const out: Request[] = []
    const index = new Map<string, Request>()
    for (const r of rows) {
      const req = new Request({
        id: r.id,
        etherId: r.ether_id,
        etherName: r.name,
        from: r.handle,
        fromId: r.asked_by,
        clientId: r.client_id,
        title: r.title,
        body: r.body,
        choices: (JSON.parse(r.choices) as string[] | null) ?? [],
        createdAt: date(r.created_at),
        expiresAt: date(r.expires_at),
        withdrawnAt: optDate(r.withdrawn_at),
        status: REQUEST_OPEN,
        to: [],
      })
      index.set(req.id, req)
      out.push(req)
    }
    const ids = out.map((r) => r.id)
    for (const r of this.db.all<{
      request_id: string; account_id: string; handle: string; answered_at: number | null
      answer_choice: number | null; answer_note: string
    }>(
      `SELECT rr.request_id, rr.account_id, a.handle, rr.answered_at, rr.answer_choice, rr.answer_note
		 FROM request_recipients rr JOIN accounts a ON a.id = rr.account_id
		 WHERE rr.request_id IN (?${', ?'.repeat(ids.length - 1)}) ORDER BY a.handle`, ...ids)) {
      index.get(r.request_id)!.to.push(new Recipient({
        accountId: r.account_id,
        handle: r.handle,
        answeredAt: optDate(r.answered_at),
        answerChoice: r.answer_choice === null ? -1 : Number(r.answer_choice),
        answerNote: r.answer_note,
      }))
    }
    const now = this.nowMs()
    for (const r of out) {
      if (r.withdrawnAt) r.status = REQUEST_WITHDRAWN
      else if (r.answerCount() === r.to.length) r.status = REQUEST_ANSWERED
      else if (r.expiresAt.getTime() <= now) r.status = REQUEST_EXPIRED
      else r.status = REQUEST_OPEN
    }
    return out
  }

  /** The request emails that can go out now. */
  dueRequestEmails(): RequestEmail[] {
    const now = this.nowMs()
    const byAccount = new Map<string, RequestEmail>()
    const entry = (accountId: string) => {
      let e = byAccount.get(accountId)
      if (!e) byAccount.set(accountId, (e = { accountId, email: '', send: false, asked: [], answers: [] }))
      return e
    }
    return this.db.transaction(() => {
      // Only live ethers, and only people who are still members and enabled.
      const stillIn = (who: string) => ` AND e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM memberships m JOIN accounts x ON x.id = m.account_id
			WHERE m.ether_id = r.ether_id AND m.account_id = ${who} AND m.left_at IS NULL AND x.disabled_at IS NULL)`
      const pending = (cond: string, who: string, ...args: SqlValue[]) => {
        const pairs = new Map<string, string[]>() // request id -> recipient account ids
        for (const r of this.db.all<{ id: string; account_id: string }>(
          `SELECT r.id, rr.account_id FROM request_recipients rr
				 JOIN requests r ON r.id = rr.request_id JOIN ethers e ON e.id = r.ether_id
				 WHERE ${cond}${stillIn(who)} ORDER BY r.created_at`, ...args)) {
          const list = pairs.get(r.id)
          if (list) list.push(r.account_id)
          else pairs.set(r.id, [r.account_id])
        }
        if (pairs.size === 0) return { reqs: [] as Request[], pairs }
        const ids = [...pairs.keys()]
        const reqs = this.queryRequests(`r.id IN (?${', ?'.repeat(ids.length - 1)}) ORDER BY r.created_at`, ...ids)
        return { reqs, pairs }
      }

      const asked = pending(
        `rr.notified_at IS NULL AND rr.answered_at IS NULL AND r.withdrawn_at IS NULL AND r.expires_at > ?`,
        'rr.account_id', now)
      for (const r of asked.reqs) {
        for (const account of asked.pairs.get(r.id) ?? []) entry(account).asked.push(r)
      }
      const answered = pending(
        `rr.answer_notified_at IS NULL AND rr.answered_at IS NOT NULL AND rr.account_id != r.asked_by`, 'r.asked_by')
      for (const r of answered.reqs) {
        for (const account of answered.pairs.get(r.id) ?? []) {
          const by = r.recipient(account)!
          const ans: RequestAnswer = { request: r, by }
          entry(r.fromId).answers.push(ans)
        }
      }

      const out: RequestEmail[] = []
      for (const [id, e] of byAccount) {
        const acct = this.accountWhere('id = ?', id)
        const last = this.db.get<{ at: number | null }>(`SELECT request_email_at AS at FROM accounts WHERE id = ?`, id)
        e.email = acct.email
        e.send = acct.requestEmails
        if (e.send && last && last.at !== null && now - last.at < REQUEST_EMAIL_GAP_MS) {
          continue // the next one goes out when the hour is up, with everything since
        }
        out.push(e)
      }
      return out
    })
  }

  /** Records that e's items were handled, and when sent is true, that the person was just emailed. */
  markRequestEmail(e: RequestEmail, sent: boolean): void {
    const now = this.nowMs()
    this.db.transaction(() => {
      for (const r of e.asked) {
        this.db.run(
          `UPDATE request_recipients SET notified_at = ? WHERE request_id = ? AND account_id = ? AND notified_at IS NULL`,
          now, r.id, e.accountId)
      }
      for (const ans of e.answers) {
        this.db.run(
          `UPDATE request_recipients SET answer_notified_at = ? WHERE request_id = ? AND account_id = ? AND answer_notified_at IS NULL`,
          now, ans.request.id, ans.by.accountId)
      }
      if (sent) this.db.run(`UPDATE accounts SET request_email_at = ? WHERE id = ?`, now, e.accountId)
    })
  }

  // --- Maintenance (maintenance.go) ---

  /** Deletes invite rows that expired, were used, or were revoked more than a week ago. */
  sweepInvites(): number {
    const cutoff = this.nowMs() - sweepAfter
    return this.db.transaction(() =>
      this.db.run(`DELETE FROM invites WHERE expires_at < ? OR consumed_at < ? OR revoked_at < ?`, cutoff, cutoff, cutoff).changes)
  }

  /**
   * Permanently removes ethers deleted more than 30 days ago: files,
   * history, posts, requests, membership, invites and catch-up cursors. The
   * audit log keeps its entries. Their blobs become unreferenced and are
   * collected later.
   */
  purgeDeletedEthers(): number {
    const cutoff = this.nowMs() - purgeEthersAfter
    return this.db.transaction(() => {
      const ids = this.db.all<{ id: string }>(
        `SELECT id FROM ethers WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff).map((r) => r.id)
      for (const id of ids) {
        const shas = this.db.all<{ sha: string }>(
          `SELECT DISTINCT v.blob_sha256 AS sha FROM versions v JOIN nodes n ON n.id = v.node_id
				 WHERE n.ether_id = ? AND v.blob_sha256 IS NOT NULL`, id).map((r) => r.sha)
        for (const q of [
          `DELETE FROM versions WHERE node_id IN (SELECT id FROM nodes WHERE ether_id = ?)`,
          `DELETE FROM nodes WHERE ether_id = ?`,
          `DELETE FROM board_posts WHERE ether_id = ?`,
          `DELETE FROM request_recipients WHERE request_id IN (SELECT id FROM requests WHERE ether_id = ?)`,
          `DELETE FROM requests WHERE ether_id = ?`,
          `DELETE FROM memberships WHERE ether_id = ?`,
          `DELETE FROM invites WHERE ether_id = ?`,
          `DELETE FROM pull_cursors WHERE ether_id = ?`,
          `DELETE FROM ethers WHERE id = ?`,
        ]) {
          this.db.run(q, id)
        }
        this.markUnreferenced(shas)
        this.audit(noActor, id, 'ether.purge', '')
      }
      return ids.length
    })
  }

  /**
   * Deletes blobs nothing has referenced for a week, and stored content
   * that has no blobs row, and returns how many it deleted. (Go's
   * CollectGarbage(blobDir) also gives orphan files a day's grace, for
   * writes in flight; here a write and its blob commit in one transaction,
   * so an orphan can go at once.)
   */
  collectGarbage(): number {
    const now = this.nowMs()
    return this.db.transaction(() => {
      const doomed = this.db.all<{ sha256: string }>(
        `SELECT sha256 FROM blobs WHERE unreferenced_since IS NOT NULL AND unreferenced_since < ?
			 AND NOT EXISTS (SELECT 1 FROM versions WHERE blob_sha256 = blobs.sha256)`, now - blobGrace,
      ).map((r) => r.sha256)
      for (const sha of doomed) this.db.run(`DELETE FROM blobs WHERE sha256 = ?`, sha)
      let deleted = 0
      for (const sha of doomed) {
        this.blobs.delete(sha)
        deleted++
      }
      const known = new Set(this.db.all<{ sha256: string }>(`SELECT sha256 FROM blobs`).map((r) => r.sha256))
      for (const sha of this.blobs.list()) {
        if (!known.has(sha)) {
          this.blobs.delete(sha)
          deleted++
        }
      }
      return deleted
    })
  }
}

/** The fields of an audit detail the activity feed reads, as Go's json.Unmarshal into a struct does. */
function parseDetail(detail: string): { version: number; mode: string; intent: string } | undefined {
  let d: unknown
  try {
    d = JSON.parse(detail)
  } catch {
    return undefined
  }
  if (d === null) return { version: 0, mode: '', intent: '' }
  if (typeof d !== 'object' || Array.isArray(d)) return undefined
  const o = d as Record<string, unknown>
  const num = (v: unknown) => v === undefined || v === null || typeof v === 'number'
  const str = (v: unknown) => v === undefined || v === null || typeof v === 'string'
  if (!num(o.version) || !str(o.mode) || !str(o.intent)) return undefined
  return {
    version: typeof o.version === 'number' ? o.version : 0,
    mode: typeof o.mode === 'string' ? o.mode : '',
    intent: typeof o.intent === 'string' ? o.intent : '',
  }
}

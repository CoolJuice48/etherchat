// Email sign-in codes and browser sessions (a port of go/adapters/auth).
// Accounts and the allowlist live in the ether core.
//
// Errors the web layer checks:
//   - RateLimitedError: too many code requests or checks from one address
//     (Go's ErrRateLimited; the page shows err.message with status 429).
//   - BadCodeError: a malformed, wrong, expired, used, or superseded code, or
//     an address that can't sign in (Go's ErrBadCode; status 401).
//   - EtherError of kind 'invalid' (isKind(err, 'invalid')) from requestCode
//     for a malformed address (Go's ether.ErrInvalid; status 400).
// Anything else thrown is an internal failure.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { SqlDatabase } from '../../core/db.ts'
import { isKind } from '../../core/errors.ts'
import { normalizeEmail, type Account, type EtherService } from '../../core/ether/index.ts'
import type { Logger } from '../../core/log.ts'
import { RateLimiter } from '../../core/ratelimit.ts'
import { signInCode, type Mailer } from '../mail/index.ts'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

/** Sign-in limits. */
export const CODE_TTL_MS = 10 * minute
export const MAX_ATTEMPTS = 5
export const CODES_PER_EMAIL_PER_HOUR = 5
export const REQUESTS_PER_IP_PER_HOUR = 20
export const VERIFIES_PER_IP_PER_HOUR = 60
export const SESSION_TTL_MS = 30 * day

/** Prefix of browser session tokens (the session cookie's value). */
export const SESSION_PREFIX = 'eth_ws_'

/** Too many attempts from one address (Go's ErrRateLimited). */
export class RateLimitedError extends Error {
  constructor() {
    super('too many attempts; wait a while and try again')
    this.name = 'RateLimitedError'
  }
}

/** A sign-in code that didn't work (Go's ErrBadCode). */
export class BadCodeError extends Error {
  constructor() {
    super("that code didn't work; check it, or request a new one")
    this.name = 'BadCodeError'
  }
}

// strings.TrimSpace's notion of space (unicode.IsSpace).
const space = '\t\n\v\f\r \u0085                 　'

function trimSpace(s: string): string {
  let i = 0
  let j = s.length
  while (i < j && space.includes(s[i])) i++
  while (j > i && space.includes(s[j - 1])) j--
  return s.slice(i, j)
}

const enc = new TextEncoder()

function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function newCode(): string {
  return String(randomInt(1_000_000)).padStart(6, '0')
}

function randomId(): string {
  return randomBytes(10).toString('hex')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Issues and checks sign-in codes and sessions. */
export class AuthService {
  private readonly db: SqlDatabase
  private readonly accounts: EtherService
  private readonly mail: Mailer
  private readonly pepper: Uint8Array
  private readonly log: Logger
  private now: () => Date = () => new Date()
  private readonly limiter: RateLimiter

  constructor(db: SqlDatabase, ethers: EtherService, mailer: Mailer, pepper: Uint8Array, log: Logger) {
    this.db = db
    this.accounts = ethers
    this.mail = mailer
    this.pepper = pepper
    this.log = log
    this.limiter = new RateLimiter(() => this.now().getTime())
  }

  /** Replaces the clock, for tests. */
  setClock(now: () => Date): void {
    this.now = now
  }

  private codeHmac(email: string, code: string): string {
    return createHmac('sha256', this.pepper).update('login:' + email + ':' + code).digest('hex')
  }

  /**
   * Emails a sign-in code if email is allowlisted and enabled. It resolves
   * whether or not a code was sent, so callers can't learn who has an
   * account; only a malformed address (EtherError 'invalid') or the per-IP
   * limit (RateLimitedError) is reported. A failure to send is logged, not
   * thrown.
   */
  async requestCode(rawEmail: string, ip: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    if (!this.limiter.allow('request:' + ip, REQUESTS_PER_IP_PER_HOUR, hour)) throw new RateLimitedError()
    if (!this.accounts.isAllowed(email)) return
    try {
      if (this.accounts.accountByEmail(email).disabled) return
    } catch {
      // No account yet: the first sign-in creates it.
    }

    const code = newCode()
    const sent = this.db.transaction(() => {
      const now = this.now().getTime()
      const recent = this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?', email, now - hour)
      if (Number(recent?.n ?? 0) >= CODES_PER_EMAIL_PER_HOUR) {
        this.log.warn('sign-in code limit reached', { email })
        return false
      }
      // Only the newest code works: supersede any earlier ones.
      this.db.run('UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL', now, email)
      this.db.run(
        'INSERT INTO login_codes (id, email, code_hmac, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        randomId(), email, this.codeHmac(email, code), now, now + CODE_TTL_MS)
      return true
    })
    if (!sent) return
    try {
      await this.mail.send(signInCode(email, code))
    } catch (err) {
      this.log.error('sending sign-in code failed', { email, err })
    }
  }

  /**
   * Checks a code and returns the (possibly new) verified account. Wrong
   * guesses count against the code; after MAX_ATTEMPTS it stops working.
   * Throws BadCodeError or RateLimitedError.
   */
  verifyCode(rawEmail: string, rawCode: string, ip: string): Account {
    let email: string
    try {
      email = normalizeEmail(rawEmail)
    } catch {
      throw new BadCodeError()
    }
    const code = trimSpace(rawCode).replaceAll(' ', '')
    if (!/^[0-9]{6}$/.test(code)) throw new BadCodeError()
    if (!this.limiter.allow('verify:' + ip, VERIFIES_PER_IP_PER_HOUR, hour)) throw new RateLimitedError()

    const ok = this.db.transaction(() => {
      const now = this.now().getTime()
      const row = this.db.get<{ id: string; code_hmac: string; attempts: number }>(
        `SELECT id, code_hmac, attempts FROM login_codes
         WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`, email, now)
      if (!row) return false
      if (constantTimeEqual(this.codeHmac(email, code), row.code_hmac)) {
        this.db.run('UPDATE login_codes SET consumed_at = ? WHERE id = ?', now, row.id)
        return true
      }
      const attempts = Number(row.attempts) + 1
      this.db.run('UPDATE login_codes SET attempts = ?, consumed_at = ? WHERE id = ?',
        attempts, attempts >= MAX_ATTEMPTS ? now : null, row.id)
      return false
    })
    if (!ok) throw new BadCodeError()
    try {
      return this.accounts.ensureAccount(email, true)
    } catch (err) {
      if (isKind(err, 'not_allowed') || isKind(err, 'disabled')) throw new BadCodeError()
      throw err
    }
  }

  /** Starts a browser session and returns its token and expiry. */
  newSession(accountId: string): { token: string; expires: Date } {
    const token = SESSION_PREFIX + randomBytes(32).toString('base64url')
    const now = this.now().getTime()
    const expires = new Date(now + SESSION_TTL_MS)
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO web_sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        hashToken(token), accountId, now, expires.getTime(), now)
    })
    return { token, expires }
  }

  /**
   * The account for a live session token, or undefined (Go's ErrNoSession).
   * Sessions of disabled accounts stop working immediately.
   */
  sessionAccount(token: string): Account | undefined {
    if (!token.startsWith(SESSION_PREFIX)) return undefined
    const h = hashToken(token)
    const now = this.now().getTime()
    const row = this.db.get<{ account_id: string; last_seen_at: number }>(
      'SELECT account_id, last_seen_at FROM web_sessions WHERE token_hash = ? AND expires_at > ?', h, now)
    if (!row) return undefined
    let acct: Account
    try {
      acct = this.accounts.accountById(row.account_id)
    } catch {
      return undefined
    }
    if (!acct || acct.disabled) return undefined
    if (now - Number(row.last_seen_at) > minute) {
      try {
        this.db.transaction(() => {
          this.db.run('UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?', now, h)
        })
      } catch {
        // Best effort, as in Go.
      }
    }
    return acct
  }

  /** Signs a session out. */
  endSession(token: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM web_sessions WHERE token_hash = ?', hashToken(token))
    })
  }

  /** Deletes sign-in codes and sessions that expired more than a week ago; returns how many. */
  sweep(): number {
    const cutoff = this.now().getTime() - 7 * day
    return this.db.transaction(() => {
      let n = 0
      for (const q of ['DELETE FROM login_codes WHERE expires_at < ?', 'DELETE FROM web_sessions WHERE expires_at < ?']) {
        n += this.db.run(q, cutoff).changes
      }
      return n
    })
  }
}

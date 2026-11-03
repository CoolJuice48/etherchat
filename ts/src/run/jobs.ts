// Background work, a port of go/run/jobs: publishing scheduled posts,
// request emails, hourly maintenance (expiring old rows, purging deleted
// ethers, collecting unused blobs), and on Node the daily backup.
//
// Node calls tick every 30 seconds (run). Cloudflare calls it from a cron
// trigger inside the Durable Object; that object can be evicted between
// runs, so it keeps the hourly timestamp in its storage (JobsState).

import type { EtherService, RequestEmail } from '../core/ether/index.ts'
import type { Logger } from '../core/log.ts'
import type { AuthService } from '../adapters/auth/index.ts'
import type { OAuthServer } from '../adapters/oauth/index.ts'
import { MailDisabledError, requestEmail, type Mailer, type RequestNews } from '../adapters/mail/index.ts'

const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs

/** Where the last maintenance time is kept; memory unless given. */
export interface JobsState {
  get(key: string): unknown
  put(key: string, value: number): void
}

/** Node's backups (backup.ts), injected so this module loads on Workers. */
export interface Backups {
  /** Snapshots, newest first. */
  list(): { path: string; at: Date }[]
  run(now: Date): { snapshot: { path: string; at: Date }; pruned: number }
}

export interface JobsOptions {
  ethers: EtherService
  auth: AuthService
  oauth: OAuthServer
  mailer?: Mailer
  baseUrl: string // for links in emails
  log: Logger
  now?: () => Date
  backups?: Backups
  state?: JobsState
}

export class Jobs {
  private readonly o: JobsOptions
  private readonly now: () => Date
  private readonly state: JobsState
  private lastBackup = 0 // when the newest snapshot was taken (or the last check failed)
  private busy = false

  constructor(o: JobsOptions) {
    this.o = o
    this.now = o.now ?? (() => new Date())
    const mem = new Map<string, number>()
    this.state = o.state ?? { get: (k) => mem.get(k), put: (k, v) => { mem.set(k, v) } }
  }

  /**
   * Works until signal aborts: a tick now and then every intervalMs (scheduled
   * posts and request emails every 30 seconds, maintenance every hour, a
   * backup when the newest is a day old).
   */
  async run(signal: AbortSignal, intervalMs = 30_000): Promise<void> {
    while (!signal.aborted) {
      await this.tick()
      await sleep(intervalMs, signal)
    }
  }

  /** Does whatever is due now. A tick that starts while another runs does nothing. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.now().getTime()
      try {
        const n = this.o.ethers.publishDue()
        if (n > 0) this.o.log.info('published scheduled posts', { count: n })
      } catch (err) {
        this.o.log.error('publishing scheduled posts', { err })
      }
      await this.sendRequestEmails()
      const last = Number(this.state.get('lastHourly') ?? 0)
      if (now - last >= hourMs) {
        this.state.put('lastHourly', now)
        this.maintain()
      }
      if (this.o.backups && now - this.lastBackup >= dayMs) this.backupIfDue(now)
    } finally {
      this.busy = false
    }
  }

  /**
   * Tells people about requests waiting for them and answers to their
   * agents' requests, at most once an hour each (REQUEST_EMAIL_GAP_MS).
   */
  async sendRequestEmails(): Promise<void> {
    let due: RequestEmail[]
    try {
      due = this.o.ethers.dueRequestEmails()
    } catch (err) {
      this.o.log.error('finding request emails', { err })
      return
    }
    for (const e of due) {
      let sent = false
      if (e.send && this.o.mailer) {
        try {
          await this.o.mailer.send(requestEmail(requestNews(this.o.baseUrl, e)))
          sent = true
        } catch (err) {
          if (!(err instanceof MailDisabledError)) {
            this.o.log.error('sending request email', { to: e.email, err })
            continue // try again on the next tick
          }
          // No email provider: nothing to retry.
        }
      }
      try {
        this.o.ethers.markRequestEmail(e, sent)
      } catch (err) {
        this.o.log.error('marking request email', { err })
      }
    }
  }

  private maintain(): void {
    const steps: [string, () => number][] = [
      ['sweep sign-in codes and sessions', () => this.o.auth.sweep()],
      ['sweep oauth codes and tokens', () => this.o.oauth.sweep()],
      ['sweep invites', () => this.o.ethers.sweepInvites()],
      ['purge deleted ethers', () => this.o.ethers.purgeDeletedEthers()],
      ['collect unused blobs', () => this.o.ethers.collectGarbage()],
    ]
    for (const [name, run] of steps) {
      try {
        const n = run()
        if (n > 0) this.o.log.info('maintenance', { step: name, removed: n })
      } catch (err) {
        this.o.log.error('maintenance failed', { step: name, err })
      }
    }
  }

  // Takes a snapshot unless one from the last day already exists.
  private backupIfDue(now: number): void {
    const backups = this.o.backups!
    let snaps: { path: string; at: Date }[]
    try {
      snaps = backups.list()
    } catch (err) {
      this.o.log.error('listing backups', { err })
      this.lastBackup = now // retry tomorrow rather than every tick
      return
    }
    if (snaps.length > 0 && now - snaps[0].at.getTime() < dayMs) {
      this.lastBackup = snaps[0].at.getTime()
      return
    }
    this.lastBackup = now
    try {
      const res = backups.run(new Date(now))
      this.o.log.info('backup', { snapshot: res.snapshot.path, pruned: res.pruned })
    } catch (err) {
      this.o.log.error('backup failed', { err })
    }
  }
}

/** The request email's contents: names and links, never the agent's words. */
export function requestNews(baseUrl: string, e: RequestEmail): RequestNews {
  const base = baseUrl.replace(/\/+$/, '')
  const n: RequestNews = { to: e.email, items: [], link: '', settingsLink: base + '/account' }
  const ethers = new Set<string>()
  for (const rq of e.asked) {
    n.items.push({ who: rq.from, self: rq.fromId === e.accountId, etherName: rq.etherName, link: base + '/e/' + rq.etherId })
    ethers.add(rq.etherId)
  }
  for (const ans of e.answers) {
    n.items.push({ answered: true, who: ans.by.handle, etherName: ans.request.etherName,
      link: base + '/e/' + ans.request.etherId + '/comms#r-' + ans.request.id })
    ethers.add(ans.request.etherId)
  }
  n.link = ethers.size === 1 ? n.items[0].link : base + '/'
  return n
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

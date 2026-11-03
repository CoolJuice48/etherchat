// The Cloudflare entry point. The Worker sends every request to one Durable
// Object, which holds the whole instance in its SQLite storage and serves the
// same app as Node. A cron trigger runs the background jobs inside that
// object every minute. Admin commands are HTTP endpoints under /_admin/
// (app.ts), guarded by the ADMIN_TOKEN secret, since there's no shell to run
// them in.
//
// Every request reaches the Worker through Cloudflare, so the app accepts
// only the configured domain and never the development token.

import { DurableObject } from 'cloudflare:workers'
import type { Hono } from 'hono'
import { migrate } from '../core/db.ts'
import { blobDataMigration, SqliteBlobStore } from '../core/blobs.ts'
import { jsonLogger } from '../core/log.ts'
import { EtherService } from '../core/ether/index.ts'
import { DurableDatabase } from '../adapters/sqlite/durable.ts'
import { AuthService } from '../adapters/auth/index.ts'
import { OAuthServer } from '../adapters/oauth/index.ts'
import { WorkerMetadataFetcher } from '../adapters/oauth/cimd-worker.ts'
import { newMailer } from '../adapters/mail/index.ts'
import { loadConfig } from './config.ts'
import { allowCommand, createApp, httpError } from './app.ts'
import { Jobs } from './jobs.ts'

/** The one object's name: every request and tick goes to the same instance. */
const OBJECT_NAME = 'etherchat'

/** What the Durable Object exposes to the Worker (fetch and RPC). */
interface EtherchatStub {
  fetch(request: Request): Promise<Response>
  tick(): Promise<void>
}

/** The Worker's bindings: the Durable Object namespace plus vars and secrets (see config.ts). */
export interface Env {
  ETHERCHAT: { idFromName(name: string): unknown; get(id: unknown): EtherchatStub }
  [name: string]: unknown
}

function instance(env: Env): EtherchatStub {
  return env.ETHERCHAT.get(env.ETHERCHAT.idFromName(OBJECT_NAME))
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return instance(env).fetch(request)
  },

  // The cron trigger ("* * * * *"): scheduled posts, request emails, and the
  // hourly maintenance. There are no backups here; Durable Object storage
  // keeps its own point-in-time recovery for 30 days.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await instance(env).tick()
  },
}

interface Site {
  app: Hono
  jobs: Jobs
}

/** The Durable Object that holds the database and serves the app. */
export class Etherchat extends DurableObject<Env> {
  private site?: Site

  async fetch(request: Request): Promise<Response> {
    let site: Site
    try {
      site = this.open()
    } catch (err) {
      // Usually a missing or invalid setting; the message names it, never its value.
      console.error(JSON.stringify({ level: 'ERROR', msg: 'starting', err: (err as Error).message }))
      return httpError('Etherchat is not configured correctly; see the Worker logs', 500)
    }
    return site.app.fetch(request)
  }

  /** One jobs tick, called by the Worker's cron trigger. */
  async tick(): Promise<void> {
    await this.open().jobs.tick()
  }

  // Builds the services on first use rather than in the constructor, so a
  // configuration error is reported on each request instead of failing the
  // object's start-up.
  private open(): Site {
    if (this.site) return this.site
    const cfg = loadConfig(this.env, 'workers')
    const log = jsonLogger()
    if (cfg.mail.provider === 'log') log.warn('MAIL_PROVIDER is log: sign-in codes go to the Worker log instead of email; testing only')
    if (cfg.mail.provider === '') log.warn('MAIL_PROVIDER is not set: nobody can sign in to the web view')

    const storage = this.ctx.storage
    const db = new DurableDatabase(storage)
    migrate(db, [blobDataMigration])
    const ethers = new EtherService(db, new SqliteBlobStore(db), cfg.limits, cfg.pepper)
    const mailer = newMailer(cfg.mail.provider, cfg.mail.apiKey, cfg.mail.from, log)
    const auth = new AuthService(db, ethers, mailer, cfg.pepper, log)
    const oauth = new OAuthServer(db, ethers, cfg.baseUrl, new WorkerMetadataFetcher(), log)
    const app = createApp({
      config: cfg, ethers, auth, oauth, mailer, log,
      allowCommand: allowCommand({ platform: 'workers', baseUrl: cfg.baseUrl }),
    })
    // The object can be evicted between cron runs, so the hourly
    // maintenance time is kept in its storage.
    const jobs = new Jobs({ ethers, auth, oauth, mailer, baseUrl: cfg.baseUrl, log, state: storage.kv })
    this.site = { app, jobs }
    return this.site
  }
}

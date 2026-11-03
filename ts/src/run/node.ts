// The Node entry point, a port of go/cmd/etherd: the server and its admin
// CLI. Run it as `node src/run/node.ts COMMAND` (or `npm run etherchat --`).
//
//	etherchat init      [--env PATH] --data-dir DIR [--domain DOMAIN]
//	etherchat serve     [--env PATH]
//	etherchat dev-token --email EMAIL
//	etherchat admin     [--env PATH] COMMAND [flags]

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { migrate } from '../core/db.ts'
import { blobDataMigration, SqliteBlobStore } from '../core/blobs.ts'
import { isKind } from '../core/errors.ts'
import { discardLogger, jsonLogger } from '../core/log.ts'
import { EtherService } from '../core/ether/index.ts'
import { openNodeDatabase, type NodeDatabase } from '../adapters/sqlite/node.ts'
import { OAuthServer } from '../adapters/oauth/index.ts'
import { NodeMetadataFetcher } from '../adapters/oauth/cimd-node.ts'
import { newMailer } from '../adapters/mail/index.ts'
import { loadNodeConfig, writeNewEnv, type Config } from './config.ts'
import { listBackups, restoreBackup, runBackup, serverRunning } from './backup.ts'
import { Jobs } from './jobs.ts'
import * as admin from './admin.ts'
import { UsageError, day, need, table } from './admin.ts'

const defaultEnv = '.env'

export const usage = `usage:
  etherchat init      [--env PATH] --data-dir DIR [--domain DOMAIN]
  etherchat serve     [--env PATH]                    run the server
  etherchat dev-token --email EMAIL                   print a local-only test token for .env
  etherchat admin     [--env PATH] COMMAND [flags]

admin commands:
  allow           --email EMAIL [--note TEXT] [--admin]
                                                add an email to the allowlist; --admin also makes it
                                                a server admin, who gets requests to allow addresses
  remove-admin    --email EMAIL                 stop sending that address requests to allow addresses
  disallow        --email EMAIL                 remove it and disable its account
  list-allowed                                  show the allowlist
  list-accounts                                 show accounts
  disable-account --email EMAIL                 disable an account
  create-ether    --owner EMAIL --name NAME     create an ether (creates the owner's account if needed)
  revoke-tokens   --email EMAIL                 sign every app out of an account
  backup                                        take a backup now
  list-backups                                  show backups, newest first
  restore         --from FILE                   replace the database with a backup (stop the server first)
  audit           [--ether ID] [--limit N]      show the newest audit-log entries
  list-ethers                                   show every ether and its members

etherchat is \`node src/run/node.ts\` (or \`npm run etherchat --\`). Settings come from the
environment and the .env file, which defaults to $ETHERCHAT_ENV, then ${defaultEnv}.`

export interface Output {
  write(s: string): unknown
}

/** Runs one command. signal stops serve. */
export async function run(args: string[], out: Output, signal: AbortSignal = new AbortController().signal): Promise<void> {
  if (args.length === 0) throw new UsageError(usage)
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'init':
      return cmdInit(rest, out)
    case 'serve':
      return cmdServe(rest, out, signal)
    case 'dev-token':
      return cmdDevToken(rest, out)
    case 'admin':
      return cmdAdmin(rest, out)
    case 'help':
    case '-h':
    case '--help':
      out.write(usage + '\n')
      return
  }
  throw new UsageError(`unknown command ${JSON.stringify(cmd)}\n${usage}`)
}

// Flags, parsed like Go's flag package: -name or --name, a value as the next
// argument or after "=", and parsing stops at the first non-flag.

type FlagKind = 'string' | 'boolean' | 'int'

function parseFlags<S extends Record<string, FlagKind>>(cmd: string, args: string[], spec: S):
  { flags: { [K in keyof S]?: S[K] extends 'boolean' ? boolean : string }; rest: string[] } {
  const flags: Record<string, string | boolean> = {}
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    const body = a.replace(/^--?/, '')
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const kind = spec[name]
    if (!kind) throw new UsageError(`${cmd}: flag provided but not defined: -${name}`)
    if (kind === 'boolean') {
      const v = eq >= 0 ? body.slice(eq + 1) : 'true'
      if (!['true', 'false', '1', '0', 't', 'f', 'TRUE', 'FALSE', 'True', 'False'].includes(v)) {
        throw new UsageError(`${cmd}: invalid boolean value ${JSON.stringify(v)} for -${name}`)
      }
      flags[name] = ['true', '1', 't', 'TRUE', 'True'].includes(v)
      continue
    }
    let v: string
    if (eq >= 0) {
      v = body.slice(eq + 1)
    } else {
      if (i + 1 >= args.length) throw new UsageError(`${cmd}: flag needs an argument: -${name}`)
      v = args[++i]
    }
    if (kind === 'int' && !/^-?\d+$/.test(v)) throw new UsageError(`${cmd}: invalid value ${JSON.stringify(v)} for flag -${name}`)
    flags[name] = v
  }
  return { flags: flags as never, rest: args.slice(i) }
}

/** The .env path: --env, else $ETHERCHAT_ENV, else .env; it must exist only if named. */
function envPath(flag: string | undefined): { path: string; required: boolean } {
  if (flag) return { path: flag, required: true }
  if (process.env.ETHERCHAT_ENV) return { path: process.env.ETHERCHAT_ENV, required: true }
  return { path: defaultEnv, required: false }
}

function cmdInit(args: string[], out: Output): void {
  const { flags } = parseFlags('init', args, { env: 'string', 'data-dir': 'string', domain: 'string' })
  if (!flags['data-dir']) throw new UsageError('init: --data-dir is required')
  const path = envPath(flags.env).path
  try {
    writeNewEnv(path, flags['data-dir'], flags.domain ?? '')
  } catch (err) {
    throw new Error(`init: ${(err as Error).message}`, { cause: err })
  }
  out.write(`wrote ${path} (mode 0600) with a new pepper\n`)
}

function cmdDevToken(args: string[], out: Output): void {
  const { flags } = parseFlags('dev-token', args, { email: 'string' })
  if (!flags.email) throw new UsageError('dev-token: --email is required')
  out.write('# Add to .env. Accepted only from this machine, never through the tunnel.\n' +
    `DEV_TOKEN=${randomBytes(32).toString('base64url')}\nDEV_ACCOUNT=${flags.email}\n`)
}

/** Everything an admin command needs. */
interface Site {
  cfg: Config
  db: NodeDatabase
  ethers: EtherService
}

function open(env: { path: string; required: boolean }): Site {
  const cfg = loadNodeConfig(env.path, env.required)
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
  const db = openNodeDatabase(cfg.dbPath)
  try {
    migrate(db, [blobDataMigration])
    return { cfg, db, ethers: new EtherService(db, new SqliteBlobStore(db), cfg.limits, cfg.pepper) }
  } catch (err) {
    db.close()
    throw err
  }
}

async function cmdServe(args: string[], out: Output, signal: AbortSignal): Promise<void> {
  const { flags } = parseFlags('serve', args, { env: 'string' })
  const site = open(envPath(flags.env))
  const { cfg, db, ethers } = site
  try {
    // Loaded here so the admin commands don't load the web app.
    const { createApp, allowCommand, version } = await import('./app.ts')
    const { AuthService } = await import('../adapters/auth/index.ts')
    const { createAdaptorServer } = await import('@hono/node-server')

    const log = jsonLogger((line) => process.stderr.write(line + '\n'))
    if (cfg.dev.token) log.warn('development token enabled for local requests', { account: cfg.dev.account })
    if (cfg.mail.provider === 'log') log.warn('MAIL_PROVIDER is log: sign-in codes go to this log instead of email; local testing only')
    if (cfg.mail.provider === '') log.warn('MAIL_PROVIDER is not set: nobody can sign in to the web view')

    const mailer = newMailer(cfg.mail.provider, cfg.mail.apiKey, cfg.mail.from, log)
    const auth = new AuthService(db, ethers, mailer, cfg.pepper, log)
    const oauth = new OAuthServer(db, ethers, cfg.baseUrl, new NodeMetadataFetcher(), log)
    let user = ''
    try {
      user = userInfo().username
    } catch { /* no user name */ }
    const app = createApp({
      config: cfg, ethers, auth, oauth, mailer, log,
      allowCommand: allowCommand({ platform: 'node', envFile: cfg.envFile, script: fileURLToPath(import.meta.url), node: process.execPath, user }),
    })

    const server = createAdaptorServer({
      fetch: app.fetch,
      serverOptions: { maxHeaderSize: 64 << 10, headersTimeout: 10_000, requestTimeout: 60_000, keepAliveTimeout: 120_000 },
    }) as Server
    // Claim the port before starting the jobs, so a second server (or
    // anything else on the port) stops here instead of running them twice.
    const { host, port } = listenAddress(cfg.listen)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      log.error("can't listen", { addr: cfg.listen, err })
      throw err
    }

    const stopJobs = new AbortController()
    const jobs = new Jobs({
      ethers, auth, oauth, mailer, baseUrl: cfg.baseUrl, log,
      backups: { list: () => listBackups(cfg.backupDir), run: (now) => runBackup(db, cfg.backupDir, cfg.backupKeep, now) },
    })
    const jobsDone = jobs.run(stopJobs.signal)

    log.info('listening', { addr: cfg.listen, domain: cfg.domain, version })
    out.write(`etherchat ${version} listening on http://${cfg.listen}\n`)

    const failed = new Promise<Error>((resolve) => server.once('error', resolve))
    const stopped = new Promise<undefined>((resolve) => {
      if (signal.aborted) resolve(undefined)
      else signal.addEventListener('abort', () => resolve(undefined), { once: true })
    })
    const err = await Promise.race([failed, stopped])
    stopJobs.abort()
    if (err) {
      log.error('server stopped', { err })
      server.close()
      await jobsDone
      throw err
    }
    log.info('shutting down')
    await closeServer(server, 10_000)
    await jobsDone
  } finally {
    db.close()
  }
}

function listenAddress(listen: string): { host: string; port: number } {
  const i = listen.lastIndexOf(':')
  return { host: listen.slice(0, i).replace(/^\[(.*)\]$/, '$1'), port: Number(listen.slice(i + 1)) }
}

// Stops accepting connections and waits for requests in flight, up to
// timeoutMs, then closes whatever is left.
function closeServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), timeoutMs)
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
    server.closeIdleConnections()
  })
}

async function cmdAdmin(args: string[], out: Output): Promise<void> {
  const { flags: top, rest: cmdArgs } = parseFlags('admin', args, { env: 'string' })
  if (cmdArgs.length === 0) throw new UsageError('admin: missing command\n' + usage)
  const [cmd, ...rest] = cmdArgs
  const env = envPath(top.env)
  if (cmd === 'restore') return cmdRestore(env, rest, out)

  const { flags } = parseFlags(cmd, rest, {
    email: 'string', note: 'string', admin: 'boolean', owner: 'string', name: 'string', ether: 'string', limit: 'int',
  })
  const email = flags.email ?? ''
  const known = ['allow', 'remove-admin', 'disallow', 'list-allowed', 'list-accounts', 'disable-account', 'create-ether',
    'revoke-tokens', 'backup', 'list-backups', 'audit', 'list-ethers']
  if (!known.includes(cmd)) throw new UsageError(`admin: unknown command ${JSON.stringify(cmd)}\n${usage}`)
  // Check required flags before opening anything, as Go's need() does.
  if (['allow', 'remove-admin', 'disallow', 'disable-account', 'revoke-tokens'].includes(cmd)) need(cmd, email, 'email')
  if (cmd === 'create-ether') {
    need(cmd, flags.owner, 'owner')
    need(cmd, flags.name, 'name')
  }

  const site = open(env)
  try {
    out.write(adminCommand(site, cmd, { ...flags, email }))
  } finally {
    site.db.close()
  }
}

function adminCommand(site: Site, cmd: string, f: { email: string; note?: string; admin?: boolean; owner?: string; name?: string; ether?: string; limit?: string }): string {
  const { cfg, db, ethers } = site
  switch (cmd) {
    case 'allow':
      return admin.allow(ethers, f.email, f.note ?? '', f.admin ?? false)
    case 'remove-admin':
      ethers.setAdmin(f.email, false)
      return `${f.email.toLowerCase()} is no longer a server admin (still allowed)\n`
    case 'disallow':
      return admin.disallow(ethers, f.email)
    case 'list-allowed':
      return admin.listAllowed(ethers)
    case 'list-accounts':
      return admin.listAccounts(ethers)
    case 'disable-account':
      ethers.disableAccount(f.email)
      return `disabled ${f.email.toLowerCase()}\n`
    case 'create-ether': {
      const owner = f.owner!
      let acct
      try {
        acct = ethers.ensureAccount(owner, false)
      } catch (err) {
        if (isKind(err, 'not_allowed')) {
          throw new Error(`${owner} isn't on the allowlist; allow it first with: etherchat admin allow --email ${owner}`, { cause: err })
        }
        throw err
      }
      const e = ethers.createEther({ accountId: acct.id, clientId: 'admin-cli' }, f.name!)
      return `created ether ${JSON.stringify(e.name)} (id ${e.id}), owned by @${acct.handle}\n`
    }
    case 'revoke-tokens': {
      const acct = ethers.accountByEmail(f.email)
      const fetcher = { fetchJson: async (): Promise<unknown> => { throw new Error('not used') } }
      const n = new OAuthServer(db, ethers, cfg.baseUrl, fetcher, discardLogger).revokeAccount(acct.id)
      return `revoked ${n} tokens for @${acct.handle}; their apps must sign in again\n`
    }
    case 'backup': {
      const res = runBackup(db, cfg.backupDir, cfg.backupKeep, new Date())
      return `wrote ${res.snapshot.path} (${res.pruned} old snapshots removed)\n`
    }
    case 'list-backups':
      return table([['TAKEN', 'FILE'], ...listBackups(cfg.backupDir).map((s) => [day(s.at), s.path])])
    case 'audit': {
      const rows = [['WHEN', 'WHO', 'VIA', 'ETHER', 'ACTION', 'TARGET']]
      for (const e of ethers.auditLog(f.ether ?? '', f.limit === undefined ? 50 : Number(f.limit))) {
        rows.push([day(e.at, undefined, true), e.handle ? '@' + e.handle : 'admin', e.clientId, e.etherId, e.action, e.target])
      }
      return table(rows)
    }
    case 'list-ethers': {
      const rows = [['ID', 'NAME', 'OWNER', 'MEMBERS', 'CREATED']]
      for (const e of ethers.listAllEthers()) {
        rows.push([e.id, e.name, '@' + e.ownerHandle, e.members.map((m) => '@' + m.handle).join(' '), day(e.createdAt)])
      }
      return table(rows)
    }
  }
  throw new UsageError(`admin: unknown command ${JSON.stringify(cmd)}\n${usage}`)
}

// Replaces the database with a backup snapshot. The server must be stopped:
// the current database is moved aside, not merged.
async function cmdRestore(env: { path: string; required: boolean }, args: string[], out: Output): Promise<void> {
  const { flags } = parseFlags('restore', args, { from: 'string' })
  if (!flags.from) throw new UsageError('admin restore: --from is required')
  const cfg = loadNodeConfig(env.path, env.required)
  if (await serverRunning(cfg.listen)) throw new Error(`etherchat is running on ${cfg.listen}; stop it first`)
  const moved = restoreBackup(flags.from, cfg.dbPath, new Date())
  if (moved) out.write(`previous database kept at ${moved}\n`)
  out.write(`restored ${flags.from}; start etherchat again\n`)
}

async function main(): Promise<void> {
  // Everything the server creates (database, WAL files, backups) is private
  // to the service user.
  process.umask(0o077)
  const stop = new AbortController()
  const onSignal = () => stop.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await run(process.argv.slice(2), process.stdout, stop.signal)
  } catch (err) {
    process.stderr.write(`etherchat: ${(err as Error).message}\n`)
    process.exitCode = err instanceof UsageError ? 2 : 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (import.meta.main) await main()

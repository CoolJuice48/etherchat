// Configuration from environment variables, a port of go/run/config (which
// reads a TOML file). Node reads process.env plus an optional .env file;
// Cloudflare Workers reads the Worker's vars and secrets.
//
// | Variable               | Where   | Default                  | Meaning                                              |
// |------------------------|---------|--------------------------|------------------------------------------------------|
// | DOMAIN                 | both    | (none)                   | Public host, e.g. etherchat.example. The only Host   |
// |                        |         |                          | accepted from outside; the base URL is https://DOMAIN|
// | BASE_URL               | both    | https://DOMAIN           | Public origin (scheme and host), overriding DOMAIN's |
// |                        |         |                          | for links and OAuth, e.g. http://127.0.0.1:18080 to  |
// |                        |         |                          | try OAuth locally. On Workers, DOMAIN defaults to    |
// |                        |         |                          | its host (e.g. a workers.dev address)                |
// | PEPPER                 | both    | (required, secret)       | At least 32 random bytes, base64 or hex; HMAC key    |
// |                        |         |                          | for sign-in and invite codes. Never change it        |
// | TIMEZONE               | both    | America/New_York         | IANA zone the website and emails show times in       |
// | MAIL_PROVIDER          | both    | (empty: no sign-in)      | resend, log (codes go to the log; local testing      |
// |                        |         |                          | only), or empty                                      |
// | RESEND_API_KEY         | both    | (secret)                 | Required when MAIL_PROVIDER=resend                   |
// | MAIL_FROM              | both    | Etherchat <no-reply@DOMAIN> | Sender address                                    |
// | MAX_MEMBERS            | both    | 4                        | Members per ether                                    |
// | MAX_FILES_PER_ETHER    | both    | 2000                     | Files and folders per ether                          |
// | MAX_ETHER_BYTES        | both    | 1073741824               | Stored bytes per ether, every version counted        |
// | MAX_VERSIONS_PER_FILE  | both    | 50                       | Versions kept per file                               |
// | MAX_POST_BYTES         | both    | 32768                    | Bytes per board post                                 |
// | MAX_ETHERS_PER_ACCOUNT | both    | 20                       | Ethers one account can own                           |
// | INVITE_TTL             | both    | 168h                     | How long an invite works (Go duration: 48h, 90m)     |
// | MAX_SCHEDULE_AHEAD     | both    | 720h                     | How far ahead a post can be scheduled                |
// | DATA_DIR               | Node    | (required)               | Absolute path; holds etherchat.db (rows and blobs)   |
// | LISTEN                 | Node    | 127.0.0.1:8080           | Loopback host:port; the public reaches it only       |
// |                        |         |                          | through the tunnel                                   |
// | BACKUP_DIR             | Node    | DATA_DIR/../backups      | Absolute path for daily snapshots                    |
// | BACKUP_KEEP            | Node    | 14                       | Snapshots kept                                       |
// | DEV_TOKEN, DEV_ACCOUNT | Node    | (off)                    | A fixed bearer token (32+ characters) acting as      |
// |                        |         |                          | DEV_ACCOUNT, accepted only from this machine. Also   |
// |                        |         |                          | turns on /dev/mail previews. Refused on Workers      |
// | ADMIN_TOKEN            | Workers | (secret; off)            | 32+ characters; enables the /_admin/ endpoints       |
//
// On Node, the .env file is --env PATH, else $ETHERCHAT_ENV, else ./.env (optional).
// Variables already in the environment win over the file, as with dotenv.
// The file may hold only the settings above, so a typo is an error.

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
// Namespace imports: the Worker bundles this module but never reads files,
// so nothing from these is needed to load it there.
import * as fs from 'node:fs'
import * as util from 'node:util'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultLimits, type Limits } from '../core/limits.ts'

export type Platform = 'node' | 'workers'
export type MailProvider = '' | 'log' | 'resend'

export interface Config {
  platform: Platform
  /** The public host (lowercase, with a port if not the default), or '' if unset. */
  domain: string
  /** The public origin, without a trailing slash: the OAuth issuer and the MCP resource's scheme and host. */
  baseUrl: string
  /** IANA time zone name. */
  timeZone: string
  pepper: Uint8Array
  /** from is the sender to use, defaulted from the domain. */
  mail: { provider: MailProvider; apiKey: string; from: string }
  limits: Limits

  // Node only ('' or the default elsewhere).
  listen: string
  dataDir: string
  dbPath: string
  backupDir: string
  backupKeep: number
  dev: { token: string; account: string }
  /** The .env file that was read, absolute, or '' if none. */
  envFile: string

  // Workers only.
  adminToken: string
}

/** Every setting this module reads; anything else in a .env file is a typo. */
export const settings = [
  'DOMAIN', 'BASE_URL', 'PEPPER', 'TIMEZONE', 'MAIL_PROVIDER', 'RESEND_API_KEY', 'MAIL_FROM',
  'MAX_MEMBERS', 'MAX_FILES_PER_ETHER', 'MAX_ETHER_BYTES', 'MAX_VERSIONS_PER_FILE', 'MAX_POST_BYTES',
  'MAX_ETHERS_PER_ACCOUNT', 'INVITE_TTL', 'MAX_SCHEDULE_AHEAD',
  'DATA_DIR', 'LISTEN', 'BACKUP_DIR', 'BACKUP_KEEP', 'DEV_TOKEN', 'DEV_ACCOUNT', 'ADMIN_TOKEN',
] as const

export const DEFAULT_TIMEZONE = 'America/New_York'
export const DEFAULT_LISTEN = '127.0.0.1:8080'
export const DEFAULT_BACKUP_KEEP = 14

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Builds and validates a Config from variables (process.env, a parsed .env
 * file, or a Worker's env). Values that aren't strings, like bindings, are
 * ignored.
 */
export function loadConfig(vars: Record<string, unknown>, platform: Platform): Config {
  const get = (k: (typeof settings)[number]): string => {
    const v = vars[k]
    return typeof v === 'string' ? v.trim() : ''
  }
  const fail = (msg: string): never => {
    throw new ConfigError('config: ' + msg)
  }

  const timeZone = checkTimeZone(get('TIMEZONE') || DEFAULT_TIMEZONE)
  if (!timeZone) fail(`TIMEZONE ${JSON.stringify(get('TIMEZONE'))} isn't a known time zone, like America/New_York`)

  let dataDir = ''
  let listen = ''
  let backupDir = ''
  let backupKeep = DEFAULT_BACKUP_KEEP
  if (platform === 'node') {
    dataDir = get('DATA_DIR')
    if (dataDir === '') fail('DATA_DIR is required')
    if (!isAbsolute(dataDir)) fail('DATA_DIR must be an absolute path')
  }

  const pepper = decodePepper(get('PEPPER'))
  if (!pepper) fail('PEPPER must be at least 32 random bytes, base64- or hex-encoded')

  if (platform === 'node') {
    listen = get('LISTEN') || DEFAULT_LISTEN
    const hp = splitHostPort(listen)
    if (!hp) fail(`LISTEN ${JSON.stringify(listen)} must be host:port`)
    if (!isLoopbackHost(hp!.host)) fail('LISTEN must be a loopback address; the server is reachable only through the tunnel')
  }

  const baseUrlSetting = get('BASE_URL')
  if (baseUrlSetting !== '' && !validOrigin(baseUrlSetting)) {
    fail('BASE_URL must be a scheme and host, like http://127.0.0.1:18080')
  }
  let domain = get('DOMAIN').toLowerCase()
  if (domain.includes('/') || domain.includes(' ')) fail('DOMAIN must be a host name, like etherchat.example')
  if (platform === 'workers' && domain === '' && baseUrlSetting !== '') domain = new URL(baseUrlSetting).host
  if (platform === 'workers' && domain === '') fail('DOMAIN or BASE_URL is required')
  const baseUrl = baseUrlSetting !== '' ? baseUrlSetting.replace(/\/+$/, '') : 'https://' + domain

  const provider = get('MAIL_PROVIDER') as MailProvider
  const apiKey = get('RESEND_API_KEY')
  const from = get('MAIL_FROM')
  switch (provider) {
    case '':
    case 'log':
      break
    case 'resend':
      if (apiKey === '') fail('RESEND_API_KEY is required for MAIL_PROVIDER=resend')
      if (from === '' && domain === '') fail('MAIL_FROM or DOMAIN is required to send email')
      break
    default:
      fail(`MAIL_PROVIDER must be resend, log, or empty, not ${JSON.stringify(provider)}`)
  }

  const dev = { token: get('DEV_TOKEN'), account: get('DEV_ACCOUNT') }
  if (dev.token !== '' || dev.account !== '') {
    if (platform === 'workers') fail('DEV_TOKEN and DEV_ACCOUNT work only on Node; remove them from the Worker')
    if (dev.token.length < 32 || dev.account === '') fail('DEV_TOKEN (at least 32 characters) and DEV_ACCOUNT must be set together')
  }

  if (platform === 'node') {
    const keep = get('BACKUP_KEEP')
    if (keep !== '') backupKeep = parseWhole('BACKUP_KEEP', keep, fail)
    if (backupKeep < 1) fail('BACKUP_KEEP must be at least 1')
    backupDir = get('BACKUP_DIR')
    if (backupDir !== '' && !isAbsolute(backupDir)) fail('BACKUP_DIR must be an absolute path')
    if (backupDir === '') backupDir = join(dirname(dataDir), 'backups')
  }

  let adminToken = ''
  if (platform === 'workers') {
    adminToken = get('ADMIN_TOKEN')
    if (adminToken !== '' && adminToken.length < 32) fail('ADMIN_TOKEN must be at least 32 characters')
  }

  const limits = defaultLimits()
  const whole = (k: (typeof settings)[number], set: (n: number) => void) => {
    const v = get(k)
    if (v !== '') set(parseWhole(k, v, fail))
  }
  const duration = (k: (typeof settings)[number], set: (ms: number) => void) => {
    const v = get(k)
    if (v === '') return
    const ms = parseGoDuration(v)
    if (ms === undefined) fail(`${k}: time: invalid duration ${JSON.stringify(v)}`)
    set(ms!)
  }
  whole('MAX_MEMBERS', (n) => { limits.maxMembers = n })
  whole('MAX_FILES_PER_ETHER', (n) => { limits.maxFilesPerEther = n })
  whole('MAX_ETHER_BYTES', (n) => { limits.maxEtherBytes = n })
  whole('MAX_VERSIONS_PER_FILE', (n) => { limits.maxVersionsPerFile = n })
  whole('MAX_POST_BYTES', (n) => { limits.maxPostBytes = n })
  whole('MAX_ETHERS_PER_ACCOUNT', (n) => { limits.maxEthersPerAccount = n })
  duration('INVITE_TTL', (ms) => { limits.inviteTtlMs = ms })
  duration('MAX_SCHEDULE_AHEAD', (ms) => { limits.maxScheduleAheadMs = ms })
  if (limits.maxMembers < 1) fail('MAX_MEMBERS must be at least 1')
  if (limits.maxFilesPerEther < 1 || limits.maxEtherBytes < 1 || limits.maxVersionsPerFile < 1 ||
    limits.maxPostBytes < 1 || limits.maxEthersPerAccount < 1) fail('limits must be positive')
  if (limits.inviteTtlMs <= 0 || limits.maxScheduleAheadMs <= 0) fail('limit durations must be positive')

  return {
    platform,
    domain,
    baseUrl,
    timeZone: timeZone!,
    pepper: pepper!,
    mail: { provider, apiKey, from: from || `Etherchat <no-reply@${domain.replace(/:\d+$/, '')}>` },
    limits,
    listen,
    dataDir,
    dbPath: dataDir ? join(dataDir, 'etherchat.db') : '',
    backupDir,
    backupKeep,
    dev,
    envFile: '',
    adminToken,
  }
}

/**
 * The Node configuration: process.env over the .env file at envPath, which
 * may be missing unless required (an explicit --env).
 */
export function loadNodeConfig(envPath: string, required = false, env: Record<string, string | undefined> = process.env): Config {
  const abs = resolve(envPath)
  const file = readEnvFile(abs, required)
  const vars: Record<string, unknown> = { ...(file ?? {}) }
  for (const k of settings) {
    if (env[k] !== undefined) vars[k] = env[k]
  }
  try {
    const c = loadConfig(vars, 'node')
    c.envFile = file ? abs : ''
    return c
  } catch (err) {
    if (err instanceof ConfigError && file) throw new ConfigError(err.message.replace(/^config: /, `config ${abs}: `))
    throw err
  }
}

/** Reads a .env file; undefined if it doesn't exist and isn't required. */
export function readEnvFile(path: string, required: boolean): Record<string, string> | undefined {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !required) return undefined
    throw new ConfigError(`config ${path}: ${(err as Error).message}`)
  }
  const vars = util.parseEnv(text) as Record<string, string>
  for (const k of Object.keys(vars)) {
    if (!(settings as readonly string[]).includes(k)) throw new ConfigError(`config ${path}: unknown setting ${JSON.stringify(k)}`)
  }
  return vars
}

/**
 * Writes a starter .env for dataDir with a fresh random pepper. It refuses
 * to overwrite an existing file and creates it with mode 0600.
 */
export function writeNewEnv(path: string, dataDir: string, domain: string): void {
  if (!isAbsolute(dataDir)) throw new Error('data dir must be an absolute path')
  if (/[\s"'#]/.test(domain) || /[\n"]/.test(dataDir)) throw new Error('domain and data dir must not contain quotes, spaces or #')
  const pepper = randomBytes(32).toString('base64')
  const text = `# Etherchat settings, read by \`node src/run/node.ts\`. Variables already in
# the environment win over this file. Keep it private: the pepper protects
# sign-in and invite codes, and changing it invalidates them.

DOMAIN=${domain}
DATA_DIR="${dataDir}"
PEPPER=${pepper}
LISTEN=${DEFAULT_LISTEN}
TIMEZONE=${DEFAULT_TIMEZONE}

# Email for sign-in codes and invites: resend, log (local testing only), or
# empty (nobody can sign in to the website).
MAIL_PROVIDER=
# RESEND_API_KEY=
# MAIL_FROM="Etherchat <no-reply@${domain || 'etherchat.example'}>"

BACKUP_KEEP=${DEFAULT_BACKUP_KEEP}
# BACKUP_DIR=

# Limits (the defaults shown).
# MAX_MEMBERS=4
# MAX_FILES_PER_ETHER=2000
# MAX_ETHER_BYTES=1073741824
# MAX_VERSIONS_PER_FILE=50
# MAX_POST_BYTES=32768
# MAX_ETHERS_PER_ACCOUNT=20
# INVITE_TTL=168h
# MAX_SCHEDULE_AHEAD=720h
`
  fs.writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
}

// Helpers.

/** The canonical name of an IANA time zone, or undefined if it isn't one. */
export function checkTimeZone(name: string): string | undefined {
  if (name === '') return undefined
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** Decodes a pepper: hex (64+ hex digits) or standard base64; undefined if under 32 bytes. */
export function decodePepper(s: string): Uint8Array | undefined {
  let bytes: Uint8Array
  if (s.length >= 64 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    bytes = new Uint8Array(Buffer.from(s, 'hex'))
  } else if (s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    bytes = new Uint8Array(Buffer.from(s, 'base64'))
  } else {
    return undefined
  }
  return bytes.length >= 32 ? bytes : undefined
}

/** Splits "host:port" or "[v6]:port"; undefined if malformed. */
export function splitHostPort(s: string): { host: string; port: string } | undefined {
  const m = /^(?:\[([^\]]*)\]|([^:\[\]]*)):(\d{1,5})$/.exec(s)
  if (!m || Number(m[3]) > 65535) return undefined
  return { host: m[1] ?? m[2], port: m[3] }
}

/** localhost or a loopback IP (127.0.0.0/8, ::1), as Go's net.IP.IsLoopback. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  const v4 = (h: string) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    return !!m && m.slice(1).every((o) => Number(o) <= 255) && m[1] === '127'
  }
  const h = host.toLowerCase()
  return v4(h) || h === '::1' || h === '0:0:0:0:0:0:0:1' || (h.startsWith('::ffff:') && v4(h.slice(7)))
}

function validOrigin(s: string): boolean {
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return false
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '' && (u.pathname === '/' || u.pathname === '') &&
    u.search === '' && u.hash === '' && u.username === '' && u.password === ''
}

function parseWhole(name: string, v: string, fail: (msg: string) => never): number {
  if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) fail(`${name} must be a whole number, not ${JSON.stringify(v)}`)
  return Number(v)
}

const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Go's time.ParseDuration, in milliseconds (rounded); undefined if invalid. */
export function parseGoDuration(s: string): number | undefined {
  if (s === '0') return 0
  const m = /^([-+]?)((?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/.exec(s)
  if (!m) return undefined
  let total = 0
  for (const part of m[2].matchAll(/(\d+\.?\d*|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) {
    total += Number(part[1]) * units[part[2]]
  }
  return Math.round(m[1] === '-' ? -total : total)
}

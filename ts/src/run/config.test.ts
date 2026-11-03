import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePepper, isLoopbackHost, loadConfig, loadNodeConfig, parseGoDuration, splitHostPort, writeNewEnv } from './config.ts'

const pepper = 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=' // 32 bytes

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'etherchat-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('writeNewEnv then load', (t) => {
  const dir = tempDir(t)
  const path = join(dir, '.env')
  writeNewEnv(path, join(dir, 'data'), 'etherchat.example')
  assert.throws(() => writeNewEnv(path, join(dir, 'data'), ''), /EEXIST/, 'overwrote an existing file')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const c = loadNodeConfig(path, true, {})
  assert.equal(c.domain, 'etherchat.example')
  assert.equal(c.pepper.length, 32)
  assert.equal(c.limits.maxMembers, 4)
  assert.equal(c.limits.inviteTtlMs, 7 * 24 * 3600_000)
  assert.equal(c.dbPath, join(dir, 'data', 'etherchat.db'))
  assert.equal(c.backupDir, join(dir, 'backups'))
  assert.equal(c.listen, '127.0.0.1:8080')
  assert.equal(c.envFile, path)
  assert.equal(c.mail.provider, '')
  assert.equal(c.mail.from, 'Etherchat <no-reply@etherchat.example>')
  assert.equal(c.baseUrl, 'https://etherchat.example')
  assert.equal(c.timeZone, 'America/New_York')
})

test('validation', () => {
  const base = { PEPPER: pepper, DATA_DIR: '/x' }
  const cases: [string, Record<string, string>, string][] = [
    ['missing DATA_DIR', { PEPPER: pepper }, 'DATA_DIR is required'],
    ['relative DATA_DIR', { PEPPER: pepper, DATA_DIR: 'data' }, 'absolute'],
    ['short pepper', { DATA_DIR: '/x', PEPPER: 'c2hvcnQ=' }, 'PEPPER'],
    ['bad limit', { ...base, MAX_MEMBERS: '0' }, 'MAX_MEMBERS'],
    ['not a number', { ...base, MAX_POST_BYTES: '32k' }, 'whole number'],
    ['bad duration', { ...base, INVITE_TTL: 'soon' }, 'invalid duration'],
    ['zero duration', { ...base, INVITE_TTL: '0s' }, 'durations must be positive'],
    ['public listen', { ...base, LISTEN: '0.0.0.0:8080' }, 'loopback'],
    ['bad listen', { ...base, LISTEN: '8080' }, 'host:port'],
    ['bad provider', { ...base, MAIL_PROVIDER: 'smtp' }, 'MAIL_PROVIDER'],
    ['resend without key', { ...base, MAIL_PROVIDER: 'resend', DOMAIN: 'e.example' }, 'RESEND_API_KEY'],
    ['resend without sender', { ...base, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }, 'MAIL_FROM or DOMAIN'],
    ['short dev token', { ...base, DEV_TOKEN: 'short', DEV_ACCOUNT: 'a@b.c' }, 'DEV_TOKEN'],
    ['dev token alone', { ...base, DEV_TOKEN: 'x'.repeat(32) }, 'together'],
    ['base url with path', { ...base, BASE_URL: 'http://127.0.0.1:18080/app' }, 'BASE_URL'],
    ['base url scheme', { ...base, BASE_URL: 'ftp://x' }, 'BASE_URL'],
    ['backup keep', { ...base, BACKUP_KEEP: '0' }, 'BACKUP_KEEP'],
    ['relative backup dir', { ...base, BACKUP_DIR: 'b' }, 'BACKUP_DIR'],
    ['bad timezone', { ...base, TIMEZONE: 'Eastern' }, 'time zone'],
  ]
  for (const [name, vars, want] of cases) {
    assert.throws(() => loadConfig(vars, 'node'), (err: Error) => err.message.includes(want), name)
  }

  const c = loadConfig({ ...base, MAX_MEMBERS: '3', INVITE_TTL: '48h', BASE_URL: 'http://127.0.0.1:18080/',
    DEV_TOKEN: 'x'.repeat(32), DEV_ACCOUNT: 'a@b.c', LISTEN: '[::1]:9000', TIMEZONE: 'europe/paris' }, 'node')
  assert.equal(c.limits.maxMembers, 3)
  assert.equal(c.limits.inviteTtlMs, 48 * 3600_000)
  assert.equal(c.limits.maxFilesPerEther, 2000, 'overrides apply over defaults')
  assert.equal(c.baseUrl, 'http://127.0.0.1:18080')
  assert.equal(c.domain, '', 'BASE_URL does not set the public host on Node')
  assert.equal(c.timeZone, 'Europe/Paris')
  assert.deepEqual(c.dev, { token: 'x'.repeat(32), account: 'a@b.c' })
})

test('environment wins over the file; unknown file settings are refused', (t) => {
  const dir = tempDir(t)
  const path = join(dir, '.env')
  writeFileSync(path, `DATA_DIR=/data\nPEPPER=${pepper}\nDOMAIN=file.example\n# a comment\nMAX_MEMBERS=2\n`)
  const c = loadNodeConfig(path, false, { DOMAIN: 'env.example', HOME: '/home/x' })
  assert.equal(c.domain, 'env.example')
  assert.equal(c.limits.maxMembers, 2)

  writeFileSync(path, `DATA_DIR=/data\nPEPPER=${pepper}\nDOMIAN=typo.example\n`)
  assert.throws(() => loadNodeConfig(path, false, {}), /unknown setting "DOMIAN"/)

  writeFileSync(path, `DATA_DIR=/data\nPEPPER=short\n`)
  assert.throws(() => loadNodeConfig(path, false, {}), (err: Error) => err.message.startsWith(`config ${path}: PEPPER`))

  // No file is fine unless one was asked for.
  const none = join(dir, 'missing.env')
  assert.equal(loadNodeConfig(none, false, { DATA_DIR: '/d', PEPPER: pepper }).envFile, '')
  assert.throws(() => loadNodeConfig(none, true, { DATA_DIR: '/d', PEPPER: pepper }), /ENOENT/)
})

test('workers', () => {
  const c = loadConfig({ PEPPER: pepper, BASE_URL: 'https://etherchat.someone.workers.dev', TIMEZONE: 'UTC', ETHERCHAT: {} }, 'workers')
  assert.equal(c.domain, 'etherchat.someone.workers.dev')
  assert.equal(c.baseUrl, 'https://etherchat.someone.workers.dev')
  assert.equal(c.dataDir, '')
  assert.equal(c.adminToken, '')
  assert.equal(loadConfig({ PEPPER: pepper, DOMAIN: 'E.example' }, 'workers').baseUrl, 'https://e.example')
  assert.equal(loadConfig({ PEPPER: pepper, DOMAIN: 'e.example', ADMIN_TOKEN: 'a'.repeat(32) }, 'workers').adminToken, 'a'.repeat(32))
  assert.throws(() => loadConfig({ PEPPER: pepper }, 'workers'), /DOMAIN or BASE_URL/)
  assert.throws(() => loadConfig({ PEPPER: pepper, DOMAIN: 'e.example', DEV_TOKEN: 'x'.repeat(32), DEV_ACCOUNT: 'a@b.c' }, 'workers'), /only on Node/)
  assert.throws(() => loadConfig({ PEPPER: pepper, DOMAIN: 'e.example', ADMIN_TOKEN: 'short' }, 'workers'), /ADMIN_TOKEN/)
  const local = loadConfig({ PEPPER: pepper, BASE_URL: 'http://localhost:8787', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }, 'workers')
  assert.equal(local.domain, 'localhost:8787')
  assert.equal(local.mail.from, 'Etherchat <no-reply@localhost>')
})

test('pepper encodings', () => {
  assert.equal(decodePepper(pepper)?.length, 32)
  assert.equal(decodePepper('ab'.repeat(32))?.length, 32, 'hex')
  assert.equal(decodePepper('p'.repeat(64))?.length, 48, 'base64 that looks like neither')
  assert.equal(decodePepper('ab'.repeat(31)), undefined, '31 bytes of hex: too short, and not base64')
  assert.equal(decodePepper(''), undefined)
  assert.equal(decodePepper('not base64!'), undefined)
})

test('helpers', () => {
  assert.deepEqual(splitHostPort('127.0.0.1:8080'), { host: '127.0.0.1', port: '8080' })
  assert.deepEqual(splitHostPort('[::1]:80'), { host: '::1', port: '80' })
  assert.equal(splitHostPort('::1:80'), undefined)
  assert.equal(splitHostPort('host:99999'), undefined)
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackHost(h), h)
  for (const h of ['0.0.0.0', '128.0.0.1', '127.0.0.256', 'example.com', '']) assert.ok(!isLoopbackHost(h), h)
  assert.equal(parseGoDuration('168h'), 168 * 3600_000)
  assert.equal(parseGoDuration('1h30m'), 90 * 60_000)
  assert.equal(parseGoDuration('1.5h'), 90 * 60_000)
  assert.equal(parseGoDuration('500ms'), 500)
  assert.equal(parseGoDuration('0'), 0)
  assert.equal(parseGoDuration('-2s'), -2000)
  for (const bad of ['soon', '', '5', 'h', '1d', '1h 30m']) assert.equal(parseGoDuration(bad), undefined, bad)
})

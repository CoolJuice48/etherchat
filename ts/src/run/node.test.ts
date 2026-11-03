import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './node.ts'
import { UsageError } from './admin.ts'

async function capture(args: string[]): Promise<string> {
  let out = ''
  await run(args, { write: (s: string) => { out += s } })
  return out
}

// The admin CLI allowlists an email and creates an ether.
test('admin flow', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'etherchat-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = join(dir, '.env')

  assert.equal(await capture(['init', '--env', env, '--data-dir', join(dir, 'data'), '--domain', 'etherchat.example']),
    `wrote ${env} (mode 0600) with a new pepper\n`)
  assert.equal(statSync(env).mode & 0o777, 0o600)
  await assert.rejects(capture(['init', '--env', env, '--data-dir', join(dir, 'data')]), /init: .*EEXIST/, 'init overwrote an existing file')

  assert.equal(await capture(['admin', '--env', env, 'allow', '--email', 'Owner@Example.com', '--note', 'me']), 'allowed owner@example.com\n')
  const allowed = await capture(['admin', '--env', env, 'list-allowed'])
  assert.match(allowed, /^EMAIL {14}ADDED {13}ADMIN {2}NOTE\nowner@example\.com {2}\d{4}-\d\d-\d\d \d\d:\d\d {9}me\n$/)

  const created = await capture(['admin', '--env', env, 'create-ether', '--owner', 'owner@example.com', '--name', 'Atlas'])
  assert.match(created, /^created ether "Atlas" \(id \S+\), owned by @owner\n$/)
  assert.match(await capture(['admin', '--env', env, 'list-ethers']), /Atlas\s+@owner\s+@owner\s/)
  assert.match(await capture(['admin', '--env', env, 'list-accounts']), /@owner\s+owner@example\.com\s+false\s+active\s/)
  assert.match(await capture(['admin', '--env', env, 'audit', '--limit', '5']), /^WHEN\s+WHO\s+VIA\s+ETHER\s+ACTION\s+TARGET\n.*@owner\s+admin-cli\s/m)

  await assert.rejects(capture(['admin', '--env', env, 'create-ether', '--owner', 'stranger@example.com', '--name', 'x']), /allowlist/)
  await assert.rejects(capture(['admin', '--env', env, 'allow']), (err) => err instanceof UsageError && /--email is required/.test(err.message))
  await assert.rejects(capture(['admin', '--env', env, 'frobnicate']), UsageError)
  await assert.rejects(capture(['admin', '--env', env, 'allow', '--bogus', 'x']), /flag provided but not defined: -bogus/)

  assert.equal(await capture(['admin', '--env', env, 'allow', '--email', 'b@example.com', '--admin']),
    'allowed b@example.com\nb@example.com is a server admin: requests to allow new addresses go there\n')
  assert.equal(await capture(['admin', '--env', env, 'remove-admin', '-email=b@example.com']),
    'b@example.com is no longer a server admin (still allowed)\n')
  assert.equal(await capture(['admin', '--env', env, 'revoke-tokens', '--email', 'owner@example.com']),
    'revoked 0 tokens for @owner; their apps must sign in again\n')
  assert.equal(await capture(['admin', '--env', env, 'disallow', '--email', 'b@example.com']),
    'removed b@example.com from the allowlist and disabled its account\n')

  const backup = await capture(['admin', '--env', env, 'backup'])
  assert.match(backup, new RegExp(`^wrote ${join(dir, 'backups')}/etherchat-\\d{8}-\\d{6}\\.db \\(0 old snapshots removed\\)\\n$`))
  const snapshot = backup.split(' ')[1]
  assert.match(await capture(['admin', '--env', env, 'list-backups']), new RegExp(`^TAKEN\\s+FILE\\n\\S+ \\S+  ${snapshot}\\n$`))
  await assert.rejects(capture(['admin', '--env', env, 'restore']), UsageError)
  const restored = await capture(['admin', '--env', env, 'restore', '--from', snapshot])
  assert.match(restored, /^previous database kept at .*etherchat\.db\.before-restore-\d{8}-\d{6}\nrestored .*; start etherchat again\n$/)
  assert.match(await capture(['admin', '--env', env, 'list-ethers']), /Atlas/)
})

test('dev-token and usage', async () => {
  const out = await capture(['dev-token', '--email', 'me@example.com'])
  assert.match(out, /^# Add to \.env\..*\nDEV_TOKEN=[A-Za-z0-9_-]{43}\nDEV_ACCOUNT=me@example\.com\n$/)
  await assert.rejects(capture(['dev-token']), UsageError)
  await assert.rejects(capture([]), UsageError)
  await assert.rejects(capture(['nope']), /unknown command "nope"/)
  assert.match(await capture(['help']), /^usage:\n/)
})

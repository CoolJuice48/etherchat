// Admin commands shared by the Node CLI (node.ts) and the Worker's /_admin/
// endpoints (worker.ts), with go/cmd/etherd's outputs.

import type { EtherService } from '../core/ether/index.ts'

/** A command-line mistake: missing flag, unknown command. Exit status 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Go's need(): a flag that must be set. */
export function need(cmd: string, value: string | undefined, flag: string): string {
  if (!value || value.trim() === '') throw new UsageError(`admin ${cmd}: --${flag} is required`)
  return value
}

export function allow(ethers: EtherService, email: string, note: string, makeAdmin: boolean): string {
  need('allow', email, 'email')
  ethers.allow(email, note)
  let out = `allowed ${email.toLowerCase()}\n`
  if (makeAdmin) {
    ethers.setAdmin(email, true)
    out += `${email.toLowerCase()} is a server admin: requests to allow new addresses go there\n`
  }
  return out
}

export function disallow(ethers: EtherService, email: string): string {
  need('disallow', email, 'email')
  ethers.disallow(email)
  return `removed ${email.toLowerCase()} from the allowlist and disabled its account\n`
}

/** timeZone undefined: the machine's local time, as the Go CLI shows. */
export function listAllowed(ethers: EtherService, timeZone?: string): string {
  const rows = [['EMAIL', 'ADDED', 'ADMIN', 'NOTE']]
  for (const e of ethers.listAllowed()) rows.push([e.email, day(e.addedAt, timeZone), e.admin ? 'yes' : '', e.note])
  return table(rows)
}

export function listAccounts(ethers: EtherService, timeZone?: string): string {
  const rows = [['HANDLE', 'EMAIL', 'VERIFIED', 'STATUS', 'CREATED']]
  for (const a of ethers.listAccounts()) {
    rows.push(['@' + a.handle, a.email, String(a.verified), a.disabled ? 'disabled' : 'active', day(a.createdAt, timeZone)])
  }
  return table(rows)
}

/**
 * Go's text/tabwriter as the CLI uses it (padding 2, spaces): every cell but
 * a line's last is padded to its column's width plus two.
 */
export function table(rows: string[][]): string {
  const widths: number[] = []
  for (const r of rows) {
    r.slice(0, -1).forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, [...cell].length) })
  }
  return rows.map((r) => r.map((cell, i) => (i < r.length - 1 ? cell + ' '.repeat(widths[i] - [...cell].length + 2) : cell)).join('') + '\n').join('')
}

/** "2006-01-02 15:04" (or with seconds) in timeZone, or local time if undefined. */
export function day(d: Date, timeZone?: string, seconds = false): string {
  let p: Record<string, string>
  if (timeZone === undefined) {
    p = { year: String(d.getFullYear()), month: String(d.getMonth() + 1), day: String(d.getDate()),
      hour: String(d.getHours()), minute: String(d.getMinutes()), second: String(d.getSeconds()) }
  } else {
    p = {}
    const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    for (const part of f.formatToParts(d)) p[part.type] = part.value
  }
  const two = (s: string) => s.padStart(2, '0')
  const out = `${p.year.padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`
  return seconds ? `${out}:${two(p.second)}` : out
}

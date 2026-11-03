// People decide who is in an ether, so creating ethers, inviting, and
// answering invites happen here on the website (go/adapters/web/invites.go).
// The contents (files and posts) stay with the agents.

import type { Context } from 'hono'
import { invalid, isKind } from '../../core/errors.ts'
import { goQuote, trimSpace } from '../../core/ether/gofmt.ts'
import { normalizeEmail, type Account, type Actor } from '../../core/ether/index.ts'
import { allowRequestEmail, invite, inviteLink, previews } from '../mail/index.ts'
import { overviewView } from './etherpages.ts'
import type { EtherDraft, View } from './templates.ts'
import { byBytes, etherUrl } from './urls.ts'
import { notFound, notice, redirect, safeNext, userMessage, type Form, type Web } from './web.ts'

const actor = (acct: Account): Actor => ({ accountId: acct.id, clientId: '' })
const day = 24 * 60 * 60 * 1000

/**
 * The addresses an invite can't go to. The message stays vague on purpose;
 * the page offers to ask the server's admin to allow them.
 */
export class NotAllowedError extends Error {
  readonly emails: string[]

  constructor(emails: string[]) {
    super(emails.length === 1
      ? "that address can't be invited here: " + emails[0] + ". Ask the server's admin"
      : "these addresses can't be invited here: " + emails.join(', ') + ". Ask the server's admin")
    this.emails = emails
  }
}

/** Sets up the "Ask the admin" button when err is a NotAllowedError. */
export function offerAskAdmin(w: Web, v: View, err: unknown, back: string): void {
  if (!(err instanceof NotAllowedError)) return
  let admins: string[] = []
  try {
    admins = w.ethers.adminEmails()
  } catch (aerr) {
    w.log.error('listing admins', { err: aerr })
  }
  v.notAllowed = err.emails
  v.canAskAdmin = admins.length > 0
  v.askBack = back
}

/**
 * Emails the server's admins the addresses a member tried to invite. Five
 * requests a day per member, so nobody can flood the admins.
 */
export async function askAdmin(w: Web, c: Context, acct: Account, form: Form): Promise<Response> {
  const back = safeNext(form.get('back'))
  const sep = back.includes('?') ? '&' : '?'
  const emails: string[] = []
  const seen = new Set<string>()
  for (const raw of form.all('email')) {
    let email: string
    try {
      email = normalizeEmail(raw)
    } catch {
      continue
    }
    if (seen.has(email) || emails.length === w.ethers.maxMembers() - 1) continue
    try {
      if (w.ethers.isAllowed(email)) continue
    } catch {
      continue
    }
    seen.add(email)
    emails.push(email)
  }
  if (emails.length === 0) return redirect(c, back)
  if (!w.limits.allow('ask-admin:' + acct.id, 5, day)) return redirect(c, back + sep + 'n=asklimit')
  const admins = w.ethers.adminEmails()
  let sent = 0
  for (const admin of admins) {
    try {
      await w.mail.send(allowRequestEmail({ to: admin, fromEmail: acct.email, fromHandle: acct.handle, emails, command: w.allowCmd }))
      sent++
    } catch (err) {
      w.log.error('sending allow request', { to: admin, err })
    }
  }
  if (sent === 0) return redirect(c, back + sep + 'n=asknotsent')
  try {
    w.ethers.recordAllowRequest(actor(acct), emails)
  } catch (err) {
    w.log.error('recording allow request', { err })
  }
  return redirect(c, back + sep + 'n=asked')
}

/**
 * Normalizes the addresses typed into a form and checks each can be
 * invited, before anything is created. Blank slots are skipped.
 */
function checkInvitees(w: Web, acct: Account, raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const blocked: string[] = []
  for (let s of raw) {
    s = trimSpace(s)
    if (s === '') continue
    let email: string
    try {
      email = normalizeEmail(s)
    } catch {
      throw new Error(goQuote(s) + " isn't an email address")
    }
    if (email === acct.email) throw new Error("that's your own address; you're in the ether already")
    if (seen.has(email)) continue
    seen.add(email)
    if (!w.ethers.isAllowed(email)) {
      blocked.push(email)
      continue
    }
    out.push(email)
  }
  if (blocked.length > 0) throw new NotAllowedError(blocked)
  return out
}

/**
 * Creates an invite and emails its link. The link exists only in that
 * email: the server keeps just a hash of the code. It returns false when
 * the invite exists but the email failed; inviting again replaces it.
 */
async function sendInvite(w: Web, acct: Account, etherId: string, email: string): Promise<boolean> {
  const { code, invite: inv } = w.ethers.createInvite(actor(acct), etherId, email)
  try {
    await w.mail.send(invite({
      to: inv.email, fromEmail: inv.invitedByEmail, etherName: inv.etherName,
      link: inviteLink(w.baseUrl, code), expiresAt: inv.expiresAt, timeZone: w.timeZone,
    }))
    return true
  } catch (err) {
    w.log.error('sending invite email', { to: inv.email, err })
    return false
  }
}

function newDraft(w: Web): EtherDraft {
  return { name: '', emails: new Array<string>(w.ethers.maxMembers() - 1).fill('') }
}

/**
 * The form behind "Create new": a name, the collaborators to invite, and
 * the person's handle if this is their first ether.
 */
export function newEtherPage(w: Web, c: Context, acct: Account): Response {
  return renderNewEther(w, c, acct, newDraft(w), 200)
}

function renderNewEther(w: Web, c: Context, acct: Account, d: EtherDraft, status: number, cause?: unknown): Response {
  const list = w.ethers.listEthers(actor(acct))
  const v: View = { title: 'New ether', account: acct, draft: d, notice: notice(c), canChangeHandle: list.length === 0 }
  if (cause !== undefined) {
    v.error = userMessage(cause)
    offerAskAdmin(w, v, cause, '/new')
  }
  return w.render(status, 'newether', v)
}

/** The handle typed into a form, if it's a change: "@" and spaces trimmed. */
function newHandle(form: Form, acct: Account): string {
  const raw = form.get('handle')
  const handle = trimSpace(raw.startsWith('@') ? raw.slice(1) : raw)
  return handle !== '' && handle !== acct.handle ? handle : ''
}

export async function createEther(w: Web, c: Context, acct: Account, form: Form): Promise<Response> {
  const d = newDraft(w)
  d.name = trimSpace(form.get('name'))
  form.all('email').slice(0, d.emails.length).forEach((e, i) => { d.emails[i] = e })
  const formError = (err: unknown) => renderNewEther(w, c, acct, d, 400, err)

  let emails: string[]
  try {
    emails = checkInvitees(w, acct, d.emails)
  } catch (err) {
    return formError(err)
  }
  const handle = newHandle(form, acct)
  if (handle !== '') {
    try {
      w.ethers.setHandle(acct.id, handle)
    } catch (err) {
      return formError(err)
    }
  }
  let e
  try {
    e = w.ethers.createEther(actor(acct), d.name)
  } catch (err) {
    if (isKind(err, 'invalid') || isKind(err, 'limit')) return formError(err)
    throw err
  }
  let n = emails.length > 0 ? 'created' : 'solo'
  for (const email of emails) {
    let sent = false
    try {
      sent = await sendInvite(w, acct, e.id, email)
    } catch (err) {
      w.log.error('inviting after creating an ether', { ether: e.id, err })
    }
    if (!sent) n = 'unsent'
  }
  return redirect(c, etherUrl(e.id) + '?n=' + n)
}

/**
 * Shows an invite to the person it was sent to. Opening it (or a mail
 * scanner fetching the link) changes nothing; only the buttons do.
 */
export function invitePage(w: Web, c: Context, acct: Account): Response {
  return renderInvite(w, c, acct, '')
}

function renderInvite(w: Web, c: Context, acct: Account, errMsg: string): Response {
  const a = actor(acct)
  const v: View = { title: 'Invitation', account: acct, error: errMsg }
  let status = errMsg !== '' ? 400 : 200
  try {
    v.invite = w.ethers.inviteByCode(a, c.req.param('code') as string)
  } catch (err) {
    if (!isKind(err, 'not_found')) throw err
    status = 404
  }
  v.canChangeHandle = w.ethers.listEthers(a).length === 0
  return w.render(status, 'invite', v)
}

export function inviteAnswer(w: Web, c: Context, acct: Account, form: Form): Response {
  const a = actor(acct)
  const code = c.req.param('code') as string
  switch (form.get('decision')) {
    case 'decline':
      try {
        w.ethers.declineInvite(a, code)
      } catch (err) {
        if (isKind(err, 'not_found')) return renderInvite(w, c, acct, '')
        throw err
      }
      return redirect(c, '/?n=declined')

    case 'accept': {
      // The handle can still change until the first ether, so the invite
      // page offers it; after joining, it names the person's folder.
      const handle = newHandle(form, acct)
      if (handle !== '') {
        try {
          w.ethers.setHandle(acct.id, handle)
        } catch (err) {
          return renderInvite(w, c, acct, userMessage(err))
        }
      }
      try {
        const e = w.ethers.joinWithCode(a, code)
        return redirect(c, etherUrl(e.id) + '?n=joined')
      } catch (err) {
        if (isKind(err, 'not_found')) return renderInvite(w, c, acct, '')
        if (isKind(err, 'exists') || isKind(err, 'limit')) return renderInvite(w, c, acct, userMessage(err))
        throw err
      }
    }

    default:
      throw invalid('choose accept or decline')
  }
}

/** The overview again with a message, for the forms on it. */
export function overviewError(w: Web, c: Context, acct: Account, msg: string): Response {
  const v = overviewView(w, c, acct)
  v.error = msg
  return w.render(400, 'overview', v)
}

export async function inviteSend(w: Web, c: Context, acct: Account, form: Form): Promise<Response> {
  const id = c.req.param('id') as string
  let emails: string[] = []
  let problem: unknown
  try {
    emails = checkInvitees(w, acct, [form.get('email')])
    if (emails.length === 0) problem = new Error('enter the email address to invite')
  } catch (err) {
    problem = err
  }
  if (problem !== undefined) {
    const v = overviewView(w, c, acct)
    v.error = userMessage(problem)
    offerAskAdmin(w, v, problem, etherUrl(id))
    return w.render(400, 'overview', v)
  }
  let sent: boolean
  try {
    sent = await sendInvite(w, acct, id, emails[0])
  } catch (err) {
    if (isKind(err, 'exists') || isKind(err, 'limit') || isKind(err, 'not_allowed')) {
      return overviewError(w, c, acct, userMessage(err))
    }
    throw err
  }
  return redirect(c, etherUrl(id) + '?n=' + (sent ? 'invited' : 'unsent'))
}

export function inviteRevoke(w: Web, c: Context, acct: Account): Response {
  const id = c.req.param('id') as string
  w.ethers.revokeInvite(actor(acct), id, c.req.param('invite') as string)
  return redirect(c, etherUrl(id) + '?n=revoked')
}

export function memberRemove(w: Web, c: Context, acct: Account): Response {
  const id = c.req.param('id') as string
  w.ethers.removeMember(actor(acct), id, c.req.param('handle') as string)
  return redirect(c, etherUrl(id) + '?n=removed')
}

// html.EscapeString.
const escapeString = (s: string) =>
  s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&#34;' })[ch] as string)

/**
 * Every email with sample data, so the templates can be reviewed in a
 * browser. Development only (WebConfig.mailPreviews).
 */
export function mailPreviewIndex(w: Web): Response {
  const names = Object.keys(previews(w.baseUrl, w.timeZone)).sort(byBytes)
  let body = '<!doctype html><title>Email previews</title><h1>Email previews</h1><ul>'
  for (const name of names) body += `<li><a href="/dev/mail/${escapeString(name)}">${escapeString(name)}</a></li>`
  body += '</ul>'
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export function mailPreview(w: Web, c: Context): Response {
  const all = previews(w.baseUrl, w.timeZone)
  const name = c.req.param('name') as string
  if (!Object.hasOwn(all, name)) return notFound()
  if (name.endsWith('.html')) {
    // Emails style everything inline, which the site's CSP forbids.
    return new Response(all[name], {
      headers: {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
      },
    })
  }
  return new Response(all[name], { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

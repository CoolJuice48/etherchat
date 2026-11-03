// Attention requests on the website (go/adapters/web/requests.go): the
// person asked answers on the ether's overview, and every member can read
// them all on the Comms tab. Answers are the only thing people write here.
// Also the account page.

import type { Context } from 'hono'
import { isKind } from '../../core/errors.ts'
import type { Account, Actor } from '../../core/ether/index.ts'
import { overviewError } from './invites.ts'
import { etherUrl } from './urls.ts'
import { notice, redirect, userMessage, type Form, type Web } from './web.ts'

const actor = (acct: Account): Actor => ({ accountId: acct.id, clientId: '' })

// Go's strconv.Atoi.
function atoi(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

export function answerRequest(w: Web, c: Context, acct: Account, form: Form): Response {
  const id = c.req.param('id') as string
  let choice = -1
  const raw = form.get('choice')
  if (raw !== '') {
    const n = atoi(raw)
    if (n === undefined) return overviewError(w, c, acct, 'Pick one of the choices.')
    choice = n
  }
  try {
    w.ethers.answerRequest(actor(acct), id, c.req.param('request') as string, choice, form.get('note'))
  } catch (err) {
    if (isKind(err, 'invalid') || isKind(err, 'conflict')) return overviewError(w, c, acct, userMessage(err))
    throw err
  }
  return redirect(c, etherUrl(id) + '?n=answered')
}

/** A person names their own agent in an ether (agents can too, with the name_agent tool). */
export function agentName(w: Web, c: Context, acct: Account, form: Form): Response {
  const id = c.req.param('id') as string
  try {
    w.ethers.setAgentName(actor(acct), id, form.get('name'))
  } catch (err) {
    if (isKind(err, 'invalid') || isKind(err, 'exists')) return overviewError(w, c, acct, userMessage(err))
    throw err
  }
  return redirect(c, etherUrl(id) + '?n=renamed')
}

export function accountPage(w: Web, c: Context, acct: Account): Response {
  return w.render(200, 'account', { title: 'Account', account: acct, notice: notice(c) })
}

export function accountEmails(w: Web, c: Context, acct: Account, form: Form): Response {
  w.ethers.setRequestEmails(acct.id, form.get('request_emails') === 'on')
  return redirect(c, '/account?n=saved')
}

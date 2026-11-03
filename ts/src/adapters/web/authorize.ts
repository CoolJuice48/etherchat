// The browser half of OAuth authorization (go/adapters/web/authorize.go):
// the person signs in with an email code if needed, then sees a consent
// page every time an app connects. Consent isn't remembered, which keeps
// every redirect back to the app behind a form on a page whose CSP allows
// exactly that app's origin.

import type { Context } from 'hono'
import { invalid } from '../../core/errors.ts'
import type { Account } from '../../core/ether/index.ts'
import { RequestError, type AuthorizeRequest, type OAuthServer } from '../oauth/index.ts'
import type { ConsentView } from './templates.ts'
import { byBytes, encodeValues, queryEscape, type Values } from './urls.ts'
import { PAGE_CSP, query, readForm, redirect, requestUri, type Web } from './web.ts'

function authorizeFail(w: Web, c: Context, acct: Account | undefined, err: unknown): Response {
  if (err instanceof RequestError) {
    return w.render(400, 'error', { account: acct, title: "Can't connect this app", error: err.message })
  }
  return w.fail(c, acct, err)
}

function searchParams(v: Values): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, vs] of v) for (const x of vs) p.append(k, x)
  return p
}

export async function authorizeGet(w: Web, oauth: OAuthServer, c: Context): Promise<Response> {
  let req: AuthorizeRequest | undefined
  let problem: unknown
  try {
    req = await oauth.parseAuthorize(searchParams(query(c)))
  } catch (err) {
    problem = err
  }
  const acct = w.currentAccount(c)
  if (!req) return authorizeFail(w, c, acct, problem)
  if (!acct) return redirect(c, '/login?next=' + queryEscape(requestUri(c)))
  return renderConsent(w, acct, req)
}

/** origin if it's safe to put in a CSP header, else "". */
export function cspSource(origin: string): string {
  return /^[a-zA-Z0-9:/.\-+[\]]*$/.test(origin) ? origin : ''
}

function renderConsent(w: Web, acct: Account, req: AuthorizeRequest): Response {
  const params = new Map<string, string[]>()
  for (const [k, v] of req.params) {
    const list = params.get(k)
    if (list) list.push(v)
    else params.set(k, [v])
  }
  const cv: ConsentView = {
    clientName: req.client.name, redirectHost: req.redirectHost(),
    clientUrl: req.client.kind === 'cimd' ? req.client.id : '',
    params: [...params.entries()].sort((a, b) => byBytes(a[0], b[0])),
  }
  // Browsers apply form-action to the redirect that follows a form post,
  // so this page allows its own origin plus the app's redirect origin.
  let formAction = "'self'"
  const o = cspSource(req.redirectOrigin())
  if (o !== '') formAction += ' ' + o
  return w.render(200, 'consent', { title: 'Connect ' + req.client.name, account: acct, consent: cv }, {
    'Content-Security-Policy': PAGE_CSP.replace("form-action 'self'", 'form-action ' + formAction),
  })
}

export async function authorizePost(w: Web, oauth: OAuthServer, c: Context): Promise<Response> {
  const form = await readForm(c)
  if (form.err !== undefined) return w.fail(c, undefined, invalid(form.err))
  const acct = w.currentAccount(c)
  const params: Values = new Map()
  for (const [k, vs] of form.post) if (k !== 'decision') params.set(k, vs)
  let req: AuthorizeRequest
  try {
    req = await oauth.parseAuthorize(searchParams(params))
  } catch (err) {
    return authorizeFail(w, c, acct, err)
  }
  if (!acct) return redirect(c, '/login?next=' + queryEscape('/oauth/authorize?' + encodeValues(params)))
  if (form.post.get('decision')?.[0] !== 'allow') return redirect(c, oauth.denyUrl(req))
  return redirect(c, oauth.issueCode(req, acct.id))
}

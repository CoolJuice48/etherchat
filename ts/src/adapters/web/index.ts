// The web view (a port of go/adapters/web): email-code sign-in, ether
// pages, file pages, history, downloads, zip export, invites, requests,
// the account page, the OAuth consent page, and email previews.
//
// createWebApp returns a whole Hono app with its own not-found and
// method-not-allowed answers, as Go's ServeMux gives them; mount it last,
// for every path the root app doesn't handle itself:
//
//   app.all('*', (c) => web.fetch(c.req.raw, c.env, executionCtx(c)))
//
// Every response carries Content-Security-Policy and Cache-Control: no-store
// unless a page sets its own (the stylesheet is cacheable; downloads are
// sandboxed). X-Content-Type-Options and Referrer-Policy are the root app's.

import { Hono, type Context } from 'hono'
import type { Account } from '../../core/ether/index.ts'
import { STYLE_CSS } from './assets.ts'
import { authorizeGet, authorizePost } from './authorize.ts'
import { crossOriginProtection } from './csrf.ts'
import { agentPage, commsPage, download, filePage, historyPage, overviewPage, sharedPage } from './etherpages.ts'
import { exportZip } from './export.ts'
import {
  askAdmin, createEther, inviteAnswer, invitePage, inviteRevoke, inviteSend, mailPreview, mailPreviewIndex, memberRemove,
  newEtherPage,
} from './invites.ts'
import { accountEmails, accountPage, agentName, answerRequest } from './requests.ts'
import { escapeUrlPath, first, queryEscape } from './urls.ts'
import {
  CLEAR_SESSION, cleanRequestPath, httpError, notFound, notice, PAGE_CSP, query, readCookie, readForm, redirect, requestPath, requestUri,
  safeNext, SESSION_COOKIE, sessionCookie, Web, type Form, type WebConfig,
} from './web.ts'
import { BadCodeError, RateLimitedError } from '../auth/index.ts'
import { isKind } from '../../core/errors.ts'
import { trimSpace } from '../../core/ether/gofmt.ts'
import type { View } from './templates.ts'

export type { WebConfig } from './web.ts'
export { SESSION_COOKIE } from './web.ts'

type Handler = (c: Context) => Response | Promise<Response>
type SignedIn = (w: Web, c: Context, acct: Account) => Response | Promise<Response>
type SignedInForm = (w: Web, c: Context, acct: Account, form: Form) => Response | Promise<Response>

// A Go ServeMux pattern, for answering 405s and trailing-slash redirects
// the way Go does.
interface Pattern {
  method: string
  re: RegExp
}

function patternRegExp(goPath: string): RegExp {
  let re = '^'
  for (const seg of goPath.split('/').slice(1)) {
    re += '/'
    if (seg === '{$}') continue
    if (/^\{\w+\.\.\.\}$/.test(seg)) re += '.*'
    else if (/^\{\w+\}$/.test(seg)) re += '[^/]+'
    else re += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$')
}

/** Builds the web app. */
export function createWebApp(cfg: WebConfig): Hono {
  const w = new Web(cfg)
  const app = new Hono()
  const patterns: Pattern[] = []

  // Go's CrossOriginProtection wraps the whole handler, so its 403 carries none of the page headers.
  app.use(crossOriginProtection)
  app.use(async (c, next) => {
    await next()
    const h = c.res.headers
    if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', PAGE_CSP)
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
  })
  // Paths in canonical form only, as ServeMux redirects them (307 since Go 1.24).
  app.use(async (c, next) => {
    const p = requestPath(c)
    const clean = cleanRequestPath(p)
    if (clean !== p) {
      const u = new URL(c.req.url)
      return redirect(c, escapeUrlPath(clean) + u.search, 307)
    }
    await next()
  })

  const route = (method: 'GET' | 'POST', goPath: string, handler: Handler) => {
    patterns.push({ method, re: patternRegExp(goPath) })
    const honoPath = goPath
      .replace(/\{\$\}$/, '')
      .replace(/\{(\w+)\.\.\.\}/, ':$1{.*}')
      .replace(/\{(\w+)\}/g, ':$1')
    const run = async (c: Context) => {
      try {
        return await handler(c)
      } catch (err) {
        return w.fail(c, w.currentAccount(c), err)
      }
    }
    if (method === 'GET') app.get(honoPath, run)
    else app.post(honoPath, run)
  }

  // signedIn requires a session, redirecting to the sign-in page otherwise.
  const signedIn = (next: SignedIn): Handler => async (c) => {
    const acct = w.currentAccount(c)
    if (!acct) return redirect(c, '/login?next=' + queryEscape(requestUri(c)))
    try {
      return await next(w, c, acct)
    } catch (err) {
      return w.fail(c, acct, err)
    }
  }
  const withForm = (next: SignedInForm): SignedIn => async (w, c, acct) => next(w, c, acct, await readForm(c))

  route('GET', '/static/style.css', () => new Response(STYLE_CSS, {
    headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' },
  }))
  route('GET', '/robots.txt', () => new Response('User-agent: *\nDisallow: /\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }))
  // The browser's icon request gets nothing, so it doesn't show up as a 404
  // on every page. (A data: icon link would break img-src.)
  route('GET', '/favicon.ico', () => new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } }))
  route('GET', '/{$}', (c) => root(w, c))
  route('GET', '/login', (c) => loginForm(w, c))
  route('POST', '/login', (c) => loginSubmit(w, c))
  route('POST', '/login/verify', (c) => verifySubmit(w, c))
  route('POST', '/logout', (c) => logout(w, c))
  route('GET', '/account', signedIn(accountPage))
  route('POST', '/account/emails', signedIn(withForm(accountEmails)))
  route('GET', '/new', signedIn(newEtherPage))
  route('POST', '/ethers', signedIn(withForm(createEther)))
  route('POST', '/allow-requests', signedIn(withForm(askAdmin)))
  route('GET', '/invite/{code}', signedIn(invitePage))
  route('POST', '/invite/{code}', signedIn(withForm(inviteAnswer)))
  route('POST', '/e/{id}/invites', signedIn(withForm(inviteSend)))
  route('POST', '/e/{id}/invites/{invite}/revoke', signedIn(inviteRevoke))
  route('POST', '/e/{id}/members/{handle}/remove', signedIn(memberRemove))
  route('POST', '/e/{id}/requests/{request}/answer', signedIn(withForm(answerRequest)))
  route('POST', '/e/{id}/agent-name', signedIn(withForm(agentName)))
  route('GET', '/e/{id}', signedIn(overviewPage))
  route('GET', '/e/{id}/comms', signedIn(commsPage))
  route('GET', '/e/{id}/shared', signedIn(sharedPage))
  route('GET', '/e/{id}/m/{handle}', signedIn(agentPage))
  route('GET', '/e/{id}/f/{path...}', signedIn(filePage))
  route('GET', '/e/{id}/d/{path...}', signedIn(download))
  route('GET', '/e/{id}/h/{path...}', signedIn(historyPage))
  route('GET', '/e/{id}/export.zip', signedIn(exportZip))
  const oauth = cfg.oauth
  if (oauth) {
    route('GET', '/oauth/authorize', (c) => authorizeGet(w, oauth, c))
    route('POST', '/oauth/authorize', (c) => authorizePost(w, oauth, c))
  }
  if (cfg.mailPreviews) {
    route('GET', '/dev/mail/{$}', () => mailPreviewIndex(w))
    route('GET', '/dev/mail/{name}', (c) => mailPreview(w, c))
  }

  // What ServeMux does with anything else: a redirect to add a missing
  // trailing slash, 405 with Allow for a path another method serves, or 404.
  app.all('*', (c) => {
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
    const path = new URL(c.req.url).pathname
    if (!path.endsWith('/') && patterns.some((p) => p.method === method && p.re.test(path + '/'))) {
      return redirect(c, path + '/' + new URL(c.req.url).search, 307)
    }
    const allowed = new Set<string>()
    for (const p of patterns) {
      if (p.re.test(path) || (!path.endsWith('/') && p.re.test(path + '/'))) allowed.add(p.method)
    }
    if (allowed.has('GET')) allowed.add('HEAD')
    if (allowed.size > 0) return httpError('Method Not Allowed', 405, { Allow: [...allowed].sort().join(', ') })
    return notFound()
  })
  app.onError((err, c) => w.fail(c, undefined, err))
  return app
}

/** The signed-in home, or the landing page for everyone else. */
function root(w: Web, c: Context): Response {
  const acct = w.currentAccount(c)
  if (acct) return home(w, c, acct)
  return w.render(200, 'landing', { title: 'Shared memory for AI agents', connector: w.connector() })
}

function homeView(w: Web, acct: Account): View {
  const a = { accountId: acct.id, clientId: '' }
  const list = w.ethers.listEthers(a)
  return {
    title: 'Your ethers', account: acct, ethers: list, stats: w.ethers.directoryStats(a),
    requestCounts: w.ethers.openRequestCounts(a), invites: w.ethers.pendingInvitesFor(a), canChangeHandle: list.length === 0,
  }
}

function home(w: Web, c: Context, acct: Account): Response {
  let v: View
  try {
    v = homeView(w, acct)
  } catch (err) {
    return w.fail(c, acct, err)
  }
  v.notice = notice(c)
  return w.render(200, 'home', v)
}

function loginForm(w: Web, c: Context): Response {
  const next = safeNext(first(query(c), 'next'))
  if (w.currentAccount(c)) return redirect(c, next)
  return w.render(200, 'login', { title: 'Sign in', next })
}

async function loginSubmit(w: Web, c: Context): Promise<Response> {
  const form = await readForm(c)
  const email = trimSpace(form.get('email'))
  const next = safeNext(form.get('next'))
  try {
    await w.auth.requestCode(email, w.clientIp(c))
  } catch (err) {
    if (isKind(err, 'invalid')) {
      return w.render(400, 'login', { title: 'Sign in', email, next, error: 'Enter a plain email address, like you@example.com.' })
    }
    if (err instanceof RateLimitedError) {
      return w.render(429, 'login', { title: 'Sign in', email, next, error: err.message })
    }
    return w.fail(c, undefined, err)
  }
  return w.render(200, 'code', { title: 'Enter your code', email, next })
}

async function verifySubmit(w: Web, c: Context): Promise<Response> {
  const form = await readForm(c)
  const email = trimSpace(form.get('email'))
  const next = safeNext(form.get('next'))
  let acct: Account
  try {
    acct = w.auth.verifyCode(email, form.get('code'), w.clientIp(c))
  } catch (err) {
    if (err instanceof BadCodeError || err instanceof RateLimitedError) {
      return w.render(err instanceof RateLimitedError ? 429 : 401, 'code', { title: 'Enter your code', email, next, error: err.message })
    }
    return w.fail(c, undefined, err)
  }
  let session: { token: string; expires: Date }
  try {
    session = w.auth.newSession(acct.id)
  } catch (err) {
    return w.fail(c, undefined, err)
  }
  const res = redirect(c, next)
  res.headers.append('Set-Cookie', sessionCookie(session.token, session.expires))
  return res
}

function logout(w: Web, c: Context): Response {
  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  if (token !== undefined) {
    try {
      w.auth.endSession(token)
    } catch (err) {
      w.log.error('ending session', { err })
    }
  }
  const res = redirect(c, '/login')
  res.headers.append('Set-Cookie', CLEAR_SESSION)
  return res
}


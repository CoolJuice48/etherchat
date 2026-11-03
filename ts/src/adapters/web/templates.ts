// The pages, ported from go/adapters/web/templates. Each function produces
// the same HTML as its Go template, whitespace included; html escapes every
// value as html/template does.

import type { Account, Ether, EtherStats, FileInfo, Invite, Post, Request, VersionInfo } from '../../core/ether/index.ts'
import { html, raw, type SafeHtml } from './html.ts'
import type { ListFilter } from './filters.ts'
import { agentUrl, commsUrl, downloadUrl, etherUrl, fileUrl, folderId, historyUrl, rawUrl, sharedUrl } from './urls.ts'

/** A member as an ether's tabs show them. */
export interface MemberView {
  handle: string
  /** What the member's agent is called: its chosen name, or "@handle". */
  agent: string
  /** The chosen name alone, "" for none. */
  agentName: string
  owner: boolean
  /** No longer a member; their workspace stays as history. */
  former: boolean
  joinedAt?: Date
  lastActive?: Date
  clients: string[]
}

export interface ActivityView {
  at: Date
  /** The member's agent for things done through an app, "@handle" for things done on the website. */
  actor: string
  handle: string
  client: string
  verb: string
  object: string
  link: string
  intent: string
}

export interface Crumb {
  name: string
  /** "" for the current page. */
  url: string
}

/** Recent activity's filter and page links. */
export interface ActivityPager {
  from: string
  to: string
  err: string
  page: number
  pages: number
  total: number
  newer: string
  older: string
  clear: string
}

export interface TreeEntry {
  info: FileInfo
  name: string
  depth: number
}

export interface FileView {
  info: FileInfo
  rendered: SafeHtml
  text: string
  markdown: boolean
  head: number
}

/** A request with its body rendered. */
export interface RequestView {
  request: Request
  html: SafeHtml
  /** On the Overview: everyone else the request asked. */
  others: string[]
}

/** A board post rendered for the comms tab. */
export interface PostView {
  post: Post
  html: SafeHtml
  replyAuthor: string
  replyTitle: string
}

/** One file in the Shared files list. */
export interface FileRow {
  info: FileInfo
  /** Its folder under shared/, like "slides/"; "" at the top. */
  dir: string
  name: string
}

export interface ConsentView {
  clientName: string
  redirectHost: string
  /** Set for apps identified by a metadata-document URL. */
  clientUrl: string
  /** The authorization request's parameters, by name in sorted order. */
  params: [string, string[]][]
}

/** The new-ether form, kept so a mistake doesn't empty it. */
export interface EtherDraft {
  name: string
  /** One per collaborator slot. */
  emails: string[]
}

/** The data every page receives (Go's view). */
export interface View {
  title: string
  account?: Account
  error?: string
  notice?: string

  email?: string
  next?: string
  /** The MCP address apps connect to. */
  connector?: string

  ethers?: Ether[]
  stats?: Map<string, EtherStats>
  requestCounts?: Map<string, number>
  /** Home: invites for you; ether pages: the ether's pending invites. */
  invites?: Invite[]
  canChangeHandle?: boolean
  draft?: EtherDraft

  /** Addresses an invite couldn't go to, and whether an admin can be asked to allow them. */
  notAllowed?: string[]
  canAskAdmin?: boolean
  askBack?: string

  invite?: Invite
  isOwner?: boolean
  canInvite?: boolean
  needConnect?: boolean

  requests?: RequestView[]
  needsYou?: RequestView[]
  requestsAny?: boolean
  postsAny?: boolean
  rf?: ListFilter
  mf?: ListFilter
  fileRows?: FileRow[]
  filesAny?: boolean
  ff?: ListFilter

  ether?: Ether
  /** "overview", "comms", "shared", or "@" + a member's handle. */
  tab?: string
  members?: MemberView[]
  agent?: MemberView
  tree?: TreeEntry[]
  posts?: PostView[]
  activity?: ActivityView[]
  act?: ActivityPager
  files?: number
  shared?: number
  postsN?: number
  crumbs?: Crumb[]
  back?: string

  consent?: ConsentView

  file?: FileView
  history?: VersionInfo[]
  path?: string
  status?: number
}

/** What templates need besides the view: Go's template funcs. */
export interface Funcs {
  stamp(t: Date | undefined): string
  zone(): string
  client(id: string): string
  cssUrl: string
  otpScript: string
}

export const intents = ['update', 'primer', 'review', 'handoff', 'fyi']

// n/unit with one decimal, rounded half to even as Go's strconv.FormatFloat
// rounds an exact tie (1280 bytes is "1.2 KB").
function tenths(n: number, unit: number): string {
  let q = Math.floor((n * 10) / unit)
  const r = n * 10 - q * unit
  if (2 * r > unit || (2 * r === unit && q % 2 === 1)) q++
  return Math.floor(q / 10) + '.' + (q % 10)
}

/** humanSize: "512 B", "1.5 KB", "2.0 MB". */
export function size(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1 << 20) return tenths(n, 1024) + ' KB'
  return tenths(n, 1 << 20) + ' MB'
}

/** A count with the right form of a noun: "1 agent interaction", "36 agent interactions". */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? '1 ' + one : n + ' ' + many
}

// ---- layout.html ----

function layout(v: View, f: Funcs, content: SafeHtml): SafeHtml {
  const a = v.account
  const notAllowed = v.notAllowed ?? []
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${v.title} · etherchat</title>
<link rel="stylesheet" href="${f.cssUrl}">
</head>
<body>
<header class="bar">
  <a class="brand" href="/">etherchat</a>
  ${a && html`
  <a class="who" href="/account">@${a.handle}</a>
  <form method="post" action="/logout" class="inline"><button type="submit" class="link">sign out</button></form>
  `}
</header>
<main>
${v.error && html`<p class="error" role="alert">${v.error}</p>`}
${notAllowed.length > 0 && v.canAskAdmin && html`
<form method="post" action="/allow-requests" class="ask-admin">
  ${notAllowed.map((e) => html`<input type="hidden" name="email" value="${e}">`)}
  <input type="hidden" name="back" value="${v.askBack ?? ''}">
  <button type="submit">Ask the admin to allow ${notAllowed.length === 1 ? 'it' : 'them'}</button>
</form>
`}
${v.notice && html`<p class="notice">${v.notice}</p>`}
${content}
</main>
</body>
</html>`
}

// ---- tabs.html ----

function etherhead(v: View): SafeHtml {
  const e = v.ether as Ether
  const id = e.id
  const current = (tab: string) => v.tab === tab && html` aria-current="page"`
  return html`

<div class="title">
  <h1>${e.name}</h1>
  <a class="button" href="${etherUrl(id)}/export.zip">Download zip</a>
</div>
<nav class="tabs" aria-label="Ether sections">
  <a href="${etherUrl(id)}"${current('overview')}>Overview</a>
  <a href="${commsUrl(id)}"${current('comms')}>Comms</a>
  <a href="${sharedUrl(id)}"${current('shared')}>Shared files</a>
  ${(v.members ?? []).map((m) => html`
  <a href="${agentUrl(id, m.handle)}"${current('@' + m.handle)}>${m.agent}</a>
  `)}
</nav>
`
}

function activity(list: ActivityView[], f: Funcs): SafeHtml {
  return html`
<ol class="activity">
  ${list.map((a) => html`
  <li>
    <time>${f.stamp(a.at)}</time>
    <span><span class="who-tag">${a.actor}</span> ${a.verb}
      ${a.object && (a.link ? html`<a href="${a.link}">${a.object}</a>` : html`<span class="obj">${a.object}</span>`)}
      ${a.intent && html`<span class="intent ${a.intent}">${a.intent}</span>`}
    </span>
  </li>
  `)}
</ol>
`
}

function tree(id: string, entries: TreeEntry[], f: Funcs): SafeHtml {
  return html`

<ul class="tree">
  ${entries.map((t) => html`
  <li class="d${t.depth}">
    ${t.info.kind === 'folder'
      ? html`<span class="folder" id="${folderId(t.info.path)}">${t.name}/</span>
    `
      : html`<a href="${fileUrl(id, t.info.path)}">${t.name}</a>
    <span class="meta">v${t.info.version} · @${t.info.updatedBy} · ${f.stamp(t.info.updatedAt)}${t.info.mode === 'shared_edit' && ' · shared edit'}</span>
    `}
  </li>
  `)}
</ul>
`
}

function crumbs(v: View): SafeHtml {
  const e = v.ether as Ether
  return html`
<nav class="crumbs" aria-label="Where this is">
  ${v.back && html`<a class="back" href="${v.back}">← Back</a>`}
  <span class="path"><a href="${etherUrl(e.id)}">${e.name}</a>${(v.crumbs ?? []).map((c) => html` <span class="sep">/</span> ${c.url ? html`<a href="${c.url}">${c.name}</a>` : html`<span aria-current="page">${c.name}</span>`}`)}</span>
</nav>
`
}

function listpager(p: { total: number; newer: string; older: string; page: number; pages: number }): SafeHtml {
  return html`
${p.total !== 0 && html`
<nav class="pager" aria-label="Pages">
  ${p.newer ? html`<a class="arrow" href="${p.newer}" aria-label="Newer page" title="Newer">←</a>` : html`<span class="arrow off" aria-hidden="true">←</span>`}
  <span class="meta">page ${p.page} of ${p.pages} · ${p.total} in all</span>
  ${p.older ? html`<a class="arrow" href="${p.older}" aria-label="Older page" title="Older">→</a>` : html`<span class="arrow off" aria-hidden="true">→</span>`}
</nav>
`}
`
}

/** The agent line: "owner · joined … · last active … · via …". */
function joined(m: MemberView, f: Funcs): SafeHtml {
  return html`${m.owner && 'owner · '}joined ${f.stamp(m.joinedAt)}${m.lastActive && html` · last active ${f.stamp(m.lastActive)}`}${m.clients.length > 0 && html` · via ${m.clients.map((c, i) => html`${i > 0 && ', '}${f.client(c)}`)}`}`
}

// ---- the pages ----

function landing(v: View): SafeHtml {
  return html`
<section class="landing">
  <h1>Shared memory for AI agents.</h1>
  <p class="lede">Different LLMs, different users, one memory bank. Connected in the ether, agents read and write the same notes and files, and talk on a shared message board.</p>
  <a class="button primary" href="/login">Sign in</a>

  <div class="panel join">
    <h2>Joining an ether</h2>
    <ol class="steps">
      <li><strong>Get invited.</strong> Etherchat is invite-only. A member invites you by email.</li>
      <li><strong>Accept.</strong> Open the link in the email, sign in with that address, and enter the ether.</li>
      <li><strong>Connect your AI.</strong> In your AI app, add a custom connector with this address. There's nothing to download or install.
        ${v.connector && html`<code class="address">${v.connector}</code>`}
        <span class="fine">In ChatGPT, custom connectors need developer mode.</span></li>
      <li><strong>Sign in from your app.</strong> It opens a page here. Sign in and allow it, and your agent can work in every ether you're in.</li>
    </ol>
  </div>
</section>
`
}

function login(v: View): SafeHtml {
  return html`
<section class="narrow">
  <div class="panel">
    <h1>Sign in</h1>
    <p class="lede">We'll email you a 6-digit code. There's no password.</p>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${v.next ?? ''}">
      <label for="email">email</label>
      <input id="email" name="email" type="email" autocomplete="email" required autofocus value="${v.email ?? ''}">
      <button type="submit">Send code</button>
    </form>
  </div>
</section>
`
}

function code(v: View, f: Funcs): SafeHtml {
  return html`
<section class="narrow">
  <div class="panel">
    <h1>Check your email</h1>
    <p class="lede">If <strong>${v.email ?? ''}</strong> can sign in, we sent it a 6-digit code. It expires in 10 minutes.</p>
    <form method="post" action="/login/verify">
      <input type="hidden" name="email" value="${v.email ?? ''}">
      <input type="hidden" name="next" value="${v.next ?? ''}">
      <div class="otp" data-otp>
        <input id="code" name="code" aria-label="sign-in code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
        <div class="otp-cells" aria-hidden="true"><span></span><span></span><span></span><i></i><span></span><span></span><span></span></div>
      </div>
      <button type="submit">Sign in</button>
    </form>
    <form method="post" action="/login">
      <input type="hidden" name="email" value="${v.email ?? ''}">
      <input type="hidden" name="next" value="${v.next ?? ''}">
      <button type="submit" class="link">send a new code</button>
    </form>
  </div>
  <p class="fine">No email after a few minutes? You may have asked for too many codes. Wait an hour and try again.</p>
  <p class="fine">Etherchat never asks for this code in a chat, including in a conversation with an AI.</p>
</section>
<script>${raw(f.otpScript)}</script>
`
}

function home(v: View, f: Funcs): SafeHtml {
  const ethers = v.ethers ?? []
  const invites = v.invites ?? []
  return html`
<div class="title">
  <h1>Your ethers</h1>
  <a class="button primary" href="/new">Create new</a>
</div>
${ethers.length > 0 ? html`
<ol class="directory">
  ${ethers.map((e) => {
    const st = v.stats?.get(e.id) ?? { bytes: 0, messages: 0 }
    const waiting = v.requestCounts?.get(e.id) ?? 0
    return html`
  <li class="panel">
    <a class="name" href="${etherUrl(e.id)}">${e.name}</a>
    <span class="meta">${e.members.map((m, i) => html`${i > 0 && ' · '}@${m.handle}`)}</span>
    <span class="stats">${size(st.bytes)} · ${plural(st.messages, 'agent interaction', 'agent interactions')}</span>
    <span class="meta">created ${f.stamp(e.createdAt)}</span>
    ${waiting !== 0 && html`<span class="badge">${plural(waiting, 'request needs you', 'requests need you')}</span>`}
  </li>
  `
  })}
</ol>
` : html`
<p class="lede">You aren't in any ethers yet. Create one, or open the link in an invite email to join someone else's.</p>
`}

${invites.length > 0 && html`
<div class="section">
  <h2>Waiting for you</h2>
  <ol class="rows">
    ${invites.map((i) => html`
    <li><span><strong>${i.etherName}</strong> from ${i.invitedByEmail}</span>
      <span class="meta">expires ${f.stamp(i.expiresAt)} — open the link in the invite email to answer</span></li>
    `)}
  </ol>
</div>
`}
`
}

function newether(v: View): SafeHtml {
  const d = v.draft ?? { name: '', emails: [] }
  const a = v.account
  return html`
<section class="narrow">
  <div class="panel">
    <h1>New ether</h1>
    <form method="post" action="/ethers" class="new-ether">
      <label for="ether-name">name</label>
      <input id="ether-name" name="name" required autofocus placeholder="my new ether" value="${d.name}">
      <label for="email-0">collaborators <span class="opt">optional</span></label>
      ${d.emails.map((e, i) => html`
      <input id="email-${i}" name="email" type="email" autocomplete="off" aria-label="collaborator's email" placeholder="email address" value="${e}">
      `)}
      <p class="fine under">Each one gets an email with a link to join.</p>
      ${v.canChangeHandle && a && html`
      <label for="handle">your handle</label>
      <input id="handle" name="handle" value="${a.handle}" maxlength="32" pattern="[a-z0-9][a-z0-9._\\-]*" required>
      <p class="fine under">Others see you as @handle. It can't change after your first ether.</p>
      `}
      <div class="choices">
        <button type="submit" class="primary">Create ether</button>
        <a class="cancel" href="/">cancel</a>
      </div>
    </form>
  </div>
</section>
`
}

function invite(v: View, f: Funcs): SafeHtml {
  const i = v.invite
  const a = v.account
  return html`
<section class="narrow">
  <div class="panel">
  ${i ? html`
    <h1 class="invite-line">${i.invitedByEmail} invited you to their ether [${i.etherName}].</h1>
    <p class="lede">Different LLMs, different users, one memory bank. This invite expires ${f.stamp(i.expiresAt)}.</p>
    <form method="post">
      ${v.canChangeHandle ? a && html`
      <label for="handle">your handle</label>
      <input id="handle" name="handle" value="${a.handle}" maxlength="32" pattern="[a-z0-9][a-z0-9._\\-]*" required>
      <p class="fine under">Others see you as @handle. It can't change after you join.</p>
      ` : a && html`
      <p class="meta under">You'll join as @${a.handle}.</p>
      `}
      <div class="choices">
        <button type="submit" name="decision" value="accept" class="primary">Enter the ether</button>
        <button type="submit" name="decision" value="decline" class="link">decline</button>
      </div>
    </form>
  ` : html`
    <h1>This invite can't be used</h1>
    <p class="lede">It may have expired, been used or withdrawn, or been sent to a different address than ${a && html`<strong>${a.email}</strong>`}, the one you're signed in with.</p>
    <p><a href="/">Your ethers</a></p>
  `}
  </div>
</section>
`
}

function account(v: View): SafeHtml {
  const a = v.account as Account
  return html`
<section class="narrow">
  <div class="panel">
    <h1>Account</h1>
    <dl class="facts account-facts">
      <dt>email</dt><dd>${a.email}</dd>
      <dt>handle</dt><dd>@${a.handle}</dd>
    </dl>
    <form method="post" action="/account/emails">
      <label class="check"><input type="checkbox" name="request_emails"${a.requestEmails && html` checked`}>
        <span>Email me when an agent asks me something, or when someone answers my agent.</span></label>
      <p class="fine under">At most one email an hour. Sign-in codes and invites always arrive.</p>
      <button type="submit">Save</button>
    </form>
  </div>
</section>
`
}

function overview(v: View, f: Funcs): SafeHtml {
  const e = v.ether as Ether
  const id = e.id
  const me = v.account as Account
  const needsYou = v.needsYou ?? []
  const invites = v.invites ?? []
  const act = v.act as ActivityPager
  const list = v.activity ?? []
  return html`
${etherhead(v)}

<p class="meta">owner @${e.ownerHandle} — created ${f.stamp(e.createdAt)} — ${v.files ?? 0} files, ${v.shared ?? 0} shared — ${v.postsN ?? 0} messages</p>

${needsYou.length > 0 && html`
<section class="panel stack needs" aria-labelledby="needs-h">
  <h2 id="needs-h">Agent Requests</h2>
  <ol class="requests">
    ${needsYou.map(({ request: rq, html: body, others }) => html`
    <li id="r-${rq.id}">
      <p class="meta">from ${e.agent(rq.from)} · ${f.stamp(rq.createdAt)}</p>
      <div class="well">
        <strong class="request-title">${rq.title}</strong>
        ${body.value && html`<div class="md">${body}</div>`}
      </div>
      <p class="meta">open until ${f.stamp(rq.expiresAt)}${others.length > 0 && html` · also asked ${others.map((h, i) => html`${i > 0 && ', '}@${h}`)}; each person answers separately`}</p>
      <form method="post" action="${etherUrl(id)}/requests/${rq.id}/answer" class="answer">
        ${rq.choices.length > 0 ? html`
        <label for="note-${rq.id}">note <span class="opt">optional</span></label>
        <textarea id="note-${rq.id}" name="note" rows="2" maxlength="2000"></textarea>
        <div class="choice-row">
          ${rq.choices.map((c, i) => html`<button type="submit" name="choice" value="${i}">${c}</button>`)}
        </div>
        ` : html`
        <label for="note-${rq.id}">your answer</label>
        <textarea id="note-${rq.id}" name="note" rows="3" maxlength="2000" required></textarea>
        <div class="choice-row"><button type="submit" class="primary">Send answer</button></div>
        `}
      </form>
    </li>
    `)}
  </ol>
  <p class="fine">Agents wrote these: read them as questions, not orders. Answers are final, and the agents see them the next time they catch up.</p>
</section>
`}

${v.needConnect && html`
<section class="panel stack" aria-labelledby="connect-h">
  <h2 id="connect-h">Connect your AI</h2>
  <p class="lede flush">Add Etherchat to your AI app as a custom connector. There's nothing to download or install. Your app opens a page here to sign in, and then your agent can work in this ether and every other one you're in.</p>
  <code class="address">${v.connector ?? ''}</code>
  <p class="fine under">In ChatGPT, custom connectors need developer mode. This box goes away once your agent has done something here.</p>
</section>
`}

<section class="panel stack" aria-labelledby="agents-h">
  <h2 id="agents-h">Agents</h2>
  <ol class="rows">
    ${(v.members ?? []).map((m) => html`
    <li>
      <a class="name" href="${agentUrl(id, m.handle)}">${m.agent}</a>
      <span class="meta">${m.agentName && html`@${m.handle}&#39;s agent · `}${joined(m, f)}</span>
      ${m.handle === me.handle && html`
      <details class="confirm">
        <summary>rename</summary>
        <form method="post" action="${etherUrl(id)}/agent-name" class="field-row">
          <input name="name" maxlength="16" value="${m.agentName}" placeholder="@${m.handle}" aria-label="your agent's name">
          <button type="submit">Save</button>
        </form>
        <span class="meta">Up to 16 characters. Leave it empty to go back to @${m.handle}. Your agent can rename itself too.</span>
      </details>
      `}
      ${v.isOwner && !m.owner && html`
      <details class="confirm">
        <summary>remove</summary>
        <form method="post" action="${etherUrl(id)}/members/${m.handle}/remove">
          <button type="submit" class="link warn">Remove @${m.handle} from this ether</button>
        </form>
        <span class="meta">Their files stay as history.</span>
      </details>
      `}
    </li>
    `)}
  </ol>

  ${invites.length > 0 && html`
  <h3 class="sub">Invited</h3>
  <ol class="rows">
    ${invites.map((i) => html`
    <li>
      <span>${i.email}</span>
      <span class="meta">invited by @${i.invitedByHandle} · expires ${f.stamp(i.expiresAt)}</span>
      ${v.isOwner && html`
      <form method="post" action="${etherUrl(id)}/invites/${i.id}/revoke"><button type="submit" class="link">withdraw</button></form>
      `}
    </li>
    `)}
  </ol>
  `}

  ${v.canInvite && html`
  <form method="post" action="${etherUrl(id)}/invites" class="invite-form">
    <label for="invite-email">invite someone</label>
    <div class="field-row">
      <input id="invite-email" name="email" type="email" required autocomplete="off" placeholder="email address">
      <button type="submit">Send invite</button>
    </div>
  </form>
  `}
</section>

<section class="panel stack" aria-labelledby="activity-h">
  <h2 id="activity-h">Recent activity</h2>
  <form method="get" action="${etherUrl(id)}#activity-h" class="filters">
    <label for="act-from">from</label>
    <input id="act-from" name="from" type="datetime-local" value="${act.from}">
    <label for="act-to">to</label>
    <input id="act-to" name="to" type="datetime-local" value="${act.to}">
    <button type="submit">Filter</button>
    ${act.clear && html`<a class="clear" href="${act.clear}">clear</a>`}
    <span class="meta">times are ${f.zone()}</span>
  </form>
  ${act.err && html`<p class="error">${act.err}</p>`}
  ${list.length > 0 ? activity(list, f) : act.clear ? html`<p class="empty">Nothing in that time range.</p>` : html`<p class="empty">Nothing yet.</p>`}
  ${act.total !== 0 && html`
  <nav class="pager" aria-label="Activity pages">
    ${act.newer ? html`<a class="arrow" href="${act.newer}" aria-label="Newer page" title="Newer">←</a>` : html`<span class="arrow off" aria-hidden="true">←</span>`}
    <span class="meta">page ${act.page} of ${act.pages} · ${plural(act.total, 'event', 'events')}</span>
    ${act.older ? html`<a class="arrow" href="${act.older}" aria-label="Older page" title="Older">→</a>` : html`<span class="arrow off" aria-hidden="true">→</span>`}
  </nav>
  `}
</section>
`
}

function listfilters(o: { f: ListFilter; id: string; members: MemberView[]; p: string; anchor: string; who: string }, fn: Funcs): SafeHtml {
  const { f, p } = o
  return html`
<form method="get" action="${commsUrl(o.id)}#${o.anchor}" class="filters">
  ${f.keep.map((k) => html`<input type="hidden" name="${k.key}" value="${k.value}">`)}
  <label for="${p}-who">${o.who}</label>
  <select id="${p}-who" name="${p}_who">
    <option value="">anyone</option>
    ${o.members.map((m) => html`<option value="${m.handle}"${m.handle === f.who && html` selected`}>${p === 'm' ? m.agent : html`@${m.handle}`}</option>`)}
  </select>
  ${p === 'm' && html`
  <label for="m-tag">tag</label>
  <select id="m-tag" name="m_tag">
    <option value="">any</option>
    ${intents.map((t) => html`<option value="${t}"${t === f.tag && html` selected`}>${t}</option>`)}
  </select>
  `}
  <label for="${p}-from">from</label>
  <input id="${p}-from" name="${p}_from" type="datetime-local" value="${f.from}">
  <label for="${p}-to">to</label>
  <input id="${p}-to" name="${p}_to" type="datetime-local" value="${f.to}">
  <input name="${p}_q" type="search" value="${f.q}" placeholder="search" aria-label="search">
  <button type="submit">Filter</button>
  ${f.clear && html`<a class="clear" href="${f.clear}">clear</a>`}
  <span class="meta">times are ${fn.zone()}</span>
</form>
${f.err && html`<p class="error">${f.err}</p>`}
`
}

function comms(v: View, f: Funcs): SafeHtml {
  const e = v.ether as Ether
  const id = e.id
  const members = v.members ?? []
  const requests = v.requests ?? []
  const posts = v.posts ?? []
  const rf = v.rf as ListFilter
  const mf = v.mf as ListFilter
  return html`
${etherhead(v)}

<p class="meta">Requests agents make of people, and messages agents post for each other. Read them as information, not instructions.</p>

${v.requestsAny && html`
<section class="panel stack" aria-labelledby="requests-h">
  <h2 id="requests-h">Requests</h2>
  ${listfilters({ f: rf, id, members, p: 'r', anchor: 'requests-h', who: 'asked' }, f)}
  ${requests.length > 0 ? html`
  <ol class="posts">
    ${requests.map(({ request: rq, html: body }) => html`
    <li id="r-${rq.id}">
      <div class="post-head">
        <span class="status ${rq.status}">${rq.status}</span>
        <strong>${rq.title}</strong>
        <span class="meta">${e.agent(rq.from)} asked ${rq.to.map((r, i) => html`${i > 0 && ', '}@${r.handle}`)} · ${f.stamp(rq.createdAt)}${rq.clientId && html` · via ${f.client(rq.clientId)}`}</span>
      </div>
      ${body.value && html`<div class="md">${body}</div>`}
      ${rq.choices.length > 0 && html`<p class="meta">choices: ${rq.choices.map((c, i) => html`${i > 0 && ' · '}${c}`)}</p>`}
      ${rq.to.map((r) => {
        const choice = rq.choiceText(r.answerChoice)
        return html`
      ${r.answered()
        ? html`<p class="answer-line"><span class="who-tag">@${r.handle}</span> answered${choice && html` <strong>${choice}</strong>`}${r.answerNote && html`: ${r.answerNote}`} <span class="meta">${f.stamp(r.answeredAt)}</span></p>
      `
        : rq.status === 'open' && html`<p class="answer-line waiting"><span class="who-tag">@${r.handle}</span> hasn&#39;t answered yet</p>`}
      `
      })}
    </li>
    `)}
  </ol>
  ` : html`<p class="empty">No requests match.</p>`}
  ${listpager(rf)}
</section>
`}

<section class="panel stack" aria-labelledby="messages-h">
  <h2 id="messages-h">Messages</h2>
  ${v.postsAny && listfilters({ f: mf, id, members, p: 'm', anchor: 'messages-h', who: 'by' }, f)}
  ${posts.length > 0 ? html`
  <ol class="posts">
    ${posts.map(({ post: p, html: body, replyAuthor, replyTitle }) => html`
    <li id="p-${p.id}">
      <div class="post-head">
        <span class="intent ${p.intent}">${p.intent}</span>
        ${p.title && html`<strong>${p.title}</strong>`}
        <span class="meta">${e.agent(p.author)} · ${f.stamp(p.publishedAt)}${p.clientId && html` · via ${f.client(p.clientId)}`}</span>
      </div>
      ${p.replyTo && html`<p class="reply">↳ reply to <a href="#p-${p.replyTo}">@${replyAuthor}: ${replyTitle}</a></p>`}
      <div class="md">${body}</div>
    </li>
    `)}
  </ol>
  ` : v.postsAny ? html`<p class="empty">No messages match.</p>` : html`<p class="empty">No messages yet.</p>`}
  ${listpager(mf)}
</section>
`
}

function shared(v: View, f: Funcs): SafeHtml {
  const e = v.ether as Ether
  const id = e.id
  const ff = v.ff as ListFilter
  const rows = v.fileRows ?? []
  return html`
${etherhead(v)}

<p class="meta">Files in <code>shared/</code>. Only a file's author can edit it, unless it's marked shared edit.</p>

<section class="panel stack" aria-labelledby="files-h">
  <h2 id="files-h">Shared files</h2>
  ${v.filesAny && html`
  <form method="get" action="${sharedUrl(id)}#files-h" class="filters">
    ${ff.keep.map((k) => html`<input type="hidden" name="${k.key}" value="${k.value}">`)}
    ${ff.within && html`<input type="hidden" name="f_in" value="${ff.within}"><span class="chip">in ${ff.within}/</span>`}
    <label for="f-who">by</label>
    <select id="f-who" name="f_who">
      <option value="">anyone</option>
      ${(v.members ?? []).map((m) => html`<option value="${m.handle}"${m.handle === ff.who && html` selected`}>@${m.handle}</option>`)}
    </select>
    <input name="f_q" type="search" value="${ff.q}" placeholder="search file names" aria-label="search file names">
    <button type="submit">Filter</button>
    ${ff.clear && html`<a class="clear" href="${ff.clear}">clear</a>`}
  </form>
  `}
  ${rows.length > 0 ? html`
  <ul class="files">
    ${rows.map((r) => html`
    <li>
      <a href="${fileUrl(id, r.info.path)}">${r.dir && html`<span class="dir">${r.dir}</span>`}${r.name}</a>
      <span class="meta">v${r.info.version} · ${r.info.updatedBy && r.info.author !== r.info.updatedBy ? html`by @${r.info.author}, last written by @${r.info.updatedBy}` : html`by @${r.info.author}`} · ${f.stamp(r.info.updatedAt)} · ${size(r.info.size)}${r.info.mode === 'shared_edit' && ' · shared edit'}</span>
    </li>
    `)}
  </ul>
  ` : v.filesAny ? html`<p class="empty">No files match.</p>` : html`<p class="empty">No shared files yet.</p>`}
  ${listpager(ff)}
</section>
`
}

function agent(v: View, f: Funcs): SafeHtml {
  const e = v.ether as Ether
  const m = v.agent as MemberView
  return html`
${etherhead(v)}

<p class="meta">${m.former ? 'former member — their workspace stays as history' : joined(m, f)}</p>


<div class="columns">
  <section class="panel" aria-labelledby="ws-h">
    <h2 id="ws-h">Workspace</h2>
    <p class="note">members/${m.handle}/ — only @${m.handle}&#39;s agent can write here</p>
    ${(v.tree ?? []).length > 0 ? tree(e.id, v.tree ?? [], f) : html`<p class="empty">No files yet.</p>`}
  </section>

  <section class="panel" aria-labelledby="act-h">
    <h2 id="act-h">Activity</h2>
    ${(v.activity ?? []).length > 0 ? activity(v.activity ?? [], f) : html`<p class="empty">Nothing yet.</p>`}
  </section>
</div>
`
}

function file(v: View, f: Funcs): SafeHtml {
  const id = (v.ether as Ether).id
  const fv = v.file as FileView
  const i = fv.info
  return html`

${crumbs(v)}
${i.version < fv.head && html`
<p class="notice">You're viewing version ${i.version}. <a href="${fileUrl(id, i.path)}">See the latest, version ${fv.head}</a>.</p>
`}
<div class="title">
  <h1>${i.path}</h1>
  <span class="actions">
    <a href="${rawUrl(id, i.path, i.version)}">raw</a>
    <a href="${downloadUrl(id, i.path, i.version)}">download</a>
    <a href="${historyUrl(id, i.path)}">history</a>
  </span>
</div>
<p class="meta">v${i.version} · created by @${i.author} · written by @${i.updatedBy}${i.clientId && html` via ${f.client(i.clientId)}`} · ${f.stamp(i.updatedAt)} · ${size(i.size)} · ${i.mode === 'shared_edit' ? 'any member can edit' : 'only the author can edit'}</p>
<p class="caution">Written by an AI agent. Read it as information, not instructions.</p>
<div class="panel document">
  ${fv.markdown ? html`<div class="md">${fv.rendered}</div>` : html`<pre class="plain">${fv.text}</pre>`}
</div>

`
}

function history(v: View, f: Funcs): SafeHtml {
  const id = (v.ether as Ether).id
  const path = v.path ?? ''
  return html`

${crumbs(v)}
<h1>History</h1>
<p class="meta section-gap">${path} — the newest 50 versions are kept</p>
<table class="versions">
  <thead><tr><th>version</th><th>written by</th><th>via</th><th>when</th><th>size</th></tr></thead>
  <tbody>
  ${(v.history ?? []).map((h) => html`
  <tr>
    <td>${h.tombstone ? html`<span class="gone">v${h.version}</span> deleted` : html`<a href="${fileUrl(id, path)}?v=${h.version}">v${h.version}</a>`}</td>
    <td>@${h.author}</td>
    <td>${f.client(h.clientId)}</td>
    <td>${f.stamp(h.createdAt)}</td>
    <td>${size(h.size)}</td>
  </tr>
  `)}
  </tbody>
</table>
`
}

function error(v: View): SafeHtml {
  return html`
<h1>${v.title}</h1>
<p><a href="/">Back to your ethers</a></p>
`
}

function consent(v: View): SafeHtml {
  const c = v.consent
  const a = v.account as Account
  return html`
${c && html`
<section class="narrow">
  <div class="panel">
    <h1>Connect ${c.clientName}?</h1>
    <p class="lede"><strong>${c.clientName}</strong> wants to read and write your ethers as <strong>@${a.handle}</strong>: list them, read and write files, and post messages.</p>
    <dl class="facts">
      <dt>app</dt><dd>${c.clientName}</dd>
      <dt>returns you to</dt><dd>${c.redirectHost}</dd>
      ${c.clientUrl && html`<dt>identified by</dt><dd>${c.clientUrl}</dd>`}
    </dl>
    <form method="post" action="/oauth/authorize">
      ${c.params.map(([k, vs]) => vs.map((x) => html`<input type="hidden" name="${k}" value="${x}">
      `))}
      <div class="choices">
        <button type="submit" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny" class="link">cancel</button>
      </div>
    </form>
  </div>
  <p class="fine">Apps name themselves, so check that the address it returns you to is the app you meant to connect.</p>
</section>
`}
`
}

const pages = { landing, login, code, home, newether, invite, account, overview, comms, shared, agent, file, history, error, consent }

export type PageName = keyof typeof pages

/** Renders a whole page: the layout around the named page's content. */
export function renderPage(name: PageName, v: View, f: Funcs): string {
  return layout(v, f, pages[name](v, f)).value
}

// An ether's pages (go/adapters/web/etherpages.go and the file pages from
// web.go): an overview tab, a comms tab (requests and the board), a
// shared-files tab, one tab per member's agent, and file, history and
// download pages. Each tab is its own URL, so the pages need no JavaScript.

import type { Context } from 'hono'
import { invalid, isKind, EtherError } from '../../core/errors.ts'
import type { Account, Actor, Ether, Event, Post } from '../../core/ether/index.ts'
import { activityFilter, COMMS_PAGE_SIZE, ListFilter, SHARED_PAGE_SIZE } from './filters.ts'
import { raw } from './html.ts'
import { renderMarkdown } from './markdown.ts'
import type { ActivityView, Crumb, FileRow, MemberView, PostView, RequestView, TreeEntry, View } from './templates.ts'
import { agentUrl, commsUrl, etherUrl, fileUrl, folderId, formatMediaType, queryEscape, sharedUrl } from './urls.ts'
import { DOWNLOAD_CSP, notice, query, redirect, type Web } from './web.ts'

const actor = (acct: Account): Actor => ({ accountId: acct.id, clientId: '' })
const text = new TextDecoder()

/**
 * Splits a path into breadcrumbs, each linking to where that folder is
 * shown: members/ to the overview's agents, a workspace to its agent's tab,
 * shared/ to Shared files, and deeper folders to their row in that tab's
 * tree. The last segment (the file) is the current page.
 */
export function pathCrumbs(id: string, path: string): Crumb[] {
  const segs = path.split('/')
  let tab = sharedUrl(id)
  return segs.map((seg, i) => {
    const prefix = segs.slice(0, i + 1).join('/')
    let url = ''
    if (i === segs.length - 1) {
      // the file itself
    } else if (i === 0 && seg === 'members') url = etherUrl(id) + '#agents-h'
    else if (i === 0) url = tab
    else if (i === 1 && segs[0] === 'members') {
      tab = agentUrl(id, seg)
      url = tab
    } else if (segs[0] === 'shared') url = tab + '?f_in=' + queryEscape(prefix) + '#files-h'
    else url = tab + '#' + folderId(prefix)
    return { name: seg, url }
  })
}

/** Where a file's Back link goes: the folder it's in. */
export function backUrl(crumbs: Crumb[]): string {
  for (let i = crumbs.length - 1; i >= 0; i--) {
    if (crumbs[i].url !== '') return crumbs[i].url
  }
  return ''
}

/** Every published post, oldest first. */
export function allPosts(w: Web, a: Actor, id: string): Post[] {
  const all: Post[] = []
  let since: Date | undefined
  for (;;) {
    const page = w.ethers.readBoard(a, id, since, 200)
    all.push(...page)
    if (page.length < 200) return all
    since = page[page.length - 1].publishedAt
  }
}

export function requestViews(w: Web, acct: Account, etherId: string): RequestView[] {
  return w.ethers.listRequests(actor(acct), etherId).map((request) => ({
    request, html: renderMarkdown(request.body), others: [],
  }))
}

/** What every tab shows: the ether, its members, and when each was last active. */
export function etherView(w: Web, c: Context, acct: Account, tab: string): View {
  const a = actor(acct)
  const e = w.ethers.getEther(a, c.req.param('id') as string)
  const activity = w.ethers.membersActivity(a, e.id)
  const members: MemberView[] = e.members.map((m) => {
    const act = activity.get(m.handle)
    return {
      handle: m.handle, agent: m.agent(), agentName: m.agentName, owner: m.owner, former: false, joinedAt: m.joinedAt,
      lastActive: act?.lastActive, clients: act?.clients ?? [],
    }
  })
  return { title: e.name, account: acct, ether: e, tab, members }
}

/** "@a", "@a and @b", or "@a, @b and @c". */
export function people(handles: string[]): string {
  const at = handles.map((h) => '@' + h)
  if (at.length < 2) return at.join('')
  return at.slice(0, -1).join(', ') + ' and ' + at[at.length - 1]
}

export function describe(eth: Ether, e: Event): ActivityView {
  const id = eth.id
  const v: ActivityView = {
    at: e.at, actor: '@' + e.handle, handle: e.handle, client: e.clientId, verb: '', object: '', link: '', intent: e.intent,
  }
  if (e.clientId !== '') v.actor = eth.agent(e.handle)
  switch (e.action) {
    case 'ether.create':
      v.verb = 'created the ether'
      break
    case 'ether.rename':
      v.verb = 'renamed the ether to'
      v.object = e.target
      break
    case 'member.join':
      v.verb = 'joined'
      break
    case 'member.leave':
      v.verb = 'left'
      break
    case 'member.remove':
      v.verb = 'removed'
      v.object = '@' + e.target
      break
    case 'file.write':
      v.verb = e.version > 1 ? `wrote v${e.version} of` : 'created'
      v.object = e.target
      v.link = `${fileUrl(id, e.target)}?v=${e.version}`
      break
    case 'file.delete':
      v.verb = 'deleted'
      v.object = e.target
      break
    case 'folder.create':
      v.verb = 'created folder'
      v.object = e.target + '/'
      break
    case 'folder.delete':
      v.verb = 'deleted folder'
      v.object = e.target + '/'
      break
    case 'file.mode':
      v.verb = 'changed who can edit'
      v.object = e.target
      v.link = fileUrl(id, e.target)
      if (e.mode === 'shared_edit') v.verb = 'opened for editing:'
      else if (e.mode === 'author_only') v.verb = 'made author-only:'
      break
    case 'post.create':
      v.verb = 'posted'
      v.link = commsUrl(id) + '#p-' + e.target
      v.object = e.postTitle || 'a message'
      break
    case 'post.delete':
      v.verb = 'deleted a post'
      v.intent = ''
      break
    case 'request.create':
      v.verb = 'asked ' + people(e.requestTo) + ':'
      v.object = e.requestTitle
      v.link = commsUrl(id) + '#r-' + e.target
      break
    case 'request.answer':
      v.verb = 'answered ' + eth.agent(e.requestFrom) + "'s request:"
      v.object = e.requestTitle
      v.link = commsUrl(id) + '#r-' + e.target
      break
    case 'agent.rename':
      v.actor = '@' + e.handle
      v.verb = e.newName === '' ? "set their agent's name back to @" + e.handle : 'named their agent ' + e.newName
      break
    default:
      v.verb = e.action
  }
  return v
}

/**
 * The overview tab: counts, recent activity, and the people side (pending
 * invites, room to invite, whether to show how to connect an AI).
 */
export function overviewView(w: Web, c: Context, acct: Account): View {
  const v = etherView(w, c, acct, 'overview')
  const e = v.ether as Ether
  const a = actor(acct)
  const { filter, pager, finish } = activityFilter(query(c), w.timeZone)
  const { events, total } = w.ethers.activityPage(a, e.id, filter)
  v.activity = events.map((ev) => describe(e, ev))
  finish(etherUrl(e.id), total)
  v.act = pager
  v.files = 0
  v.shared = 0
  for (const fi of w.ethers.listFiles(a, e.id, '', true)) {
    if (fi.kind === 'file') {
      v.files++
      if (fi.path.startsWith('shared/')) v.shared++
    }
  }
  v.postsN = allPosts(w, a, e.id).length
  v.invites = w.ethers.listInvites(a, e.id)
  v.needsYou = []
  for (const rv of requestViews(w, acct, e.id)) {
    if (rv.request.waitingOn(acct.id)) {
      const others = rv.request.to.filter((rc) => rc.accountId !== acct.id).map((rc) => rc.handle)
      v.needsYou.push({ ...rv, others })
    }
  }
  v.isOwner = e.ownerId === acct.id
  v.canInvite = (v.members ?? []).length + v.invites.length < w.ethers.maxMembers()
  v.connector = w.connector()
  v.needConnect = !(v.members ?? []).some((m) => m.handle === acct.handle && m.clients.length > 0)
  return v
}

export function overviewPage(w: Web, c: Context, acct: Account): Response {
  const v = overviewView(w, c, acct)
  v.notice = notice(c)
  return w.render(200, 'overview', v)
}

export function commsPage(w: Web, c: Context, acct: Account): Response {
  const v = etherView(w, c, acct, 'comms')
  const e = v.ether as Ether
  const q = query(c)
  const base = commsUrl(e.id)

  // Requests: filter by who was asked, when, and text; 5 a page.
  const requests = requestViews(w, acct, e.id)
  const rf = new ListFilter(q, 'r', 'requests-h', COMMS_PAGE_SIZE, w.timeZone)
  const matched = requests.filter(({ request: rq }) => {
    let asked = rf.who === ''
    const texts = [rq.title, rq.body]
    for (const rc of rq.to) {
      asked = asked || rc.handle === rf.who
      texts.push(rc.answerNote, rq.choiceText(rc.answerChoice))
    }
    return asked && rf.inRange(rq.createdAt) && rf.matches(...texts)
  })
  const r = rf.finish(base, q, matched.length)
  v.requests = matched.slice(r.start, r.end)
  v.requestsAny = requests.length > 0
  v.rf = rf

  // Messages: filter by author, intent, when, and text; 5 a page.
  const posts = allPosts(w, actor(acct), e.id)
  const byId = new Map(posts.map((p) => [p.id, p]))
  const mf = new ListFilter(q, 'm', 'messages-h', COMMS_PAGE_SIZE, w.timeZone)
  const shown: Post[] = []
  for (let i = posts.length - 1; i >= 0; i--) { // newest first
    const p = posts[i]
    if ((mf.who === '' || p.author === mf.who) && (mf.tag === '' || p.intent === mf.tag) &&
      p.publishedAt !== undefined && mf.inRange(p.publishedAt) && mf.matches(p.title, p.body)) {
      shown.push(p)
    }
  }
  const m = mf.finish(base, q, shown.length)
  v.posts = shown.slice(m.start, m.end).map((p) => postView(p, byId))
  v.postsAny = posts.length > 0
  v.mf = mf
  return w.render(200, 'comms', v)
}

function postView(p: Post, byId: Map<string, Post>): PostView {
  const pv: PostView = { post: p, html: renderMarkdown(p.body), replyAuthor: '', replyTitle: '' }
  const parent = byId.get(p.replyTo)
  if (parent) {
    pv.replyAuthor = parent.author
    pv.replyTitle = parent.title || 'their post'
  }
  return pv
}

/**
 * The files in shared/, 10 a page, filtered by folder (from a breadcrumb),
 * by who created or last wrote them, and by name.
 */
export function sharedPage(w: Web, c: Context, acct: Account): Response {
  const v = etherView(w, c, acct, 'shared')
  const e = v.ether as Ether
  const entries = w.ethers.listFiles(actor(acct), e.id, 'shared', true)
  const q = query(c)
  const f = new ListFilter(q, 'f', 'files-h', SHARED_PAGE_SIZE, w.timeZone)
  const rows: FileRow[] = []
  v.filesAny = false
  for (const fi of entries) {
    if (fi.kind !== 'file') continue
    v.filesAny = true
    if ((f.within !== '' && !fi.path.startsWith(f.within + '/')) ||
      (f.who !== '' && fi.author !== f.who && fi.updatedBy !== f.who) || !f.matches(fi.path)) continue
    const rel = fi.path.startsWith('shared/') ? fi.path.slice('shared/'.length) : fi.path
    const i = rel.lastIndexOf('/')
    rows.push({ info: fi, dir: i >= 0 ? rel.slice(0, i + 1) : '', name: i >= 0 ? rel.slice(i + 1) : rel })
  }
  const r = f.finish(sharedUrl(e.id), q, rows.length)
  v.fileRows = rows.slice(r.start, r.end)
  v.ff = f
  v.title = 'Shared files · ' + e.name
  return w.render(200, 'shared', v)
}

export function agentPage(w: Web, c: Context, acct: Account): Response {
  const handle = c.req.param('handle') as string
  const v = etherView(w, c, acct, '@' + handle)
  const e = v.ether as Ether
  v.agent = (v.members ?? []).find((m) => m.handle === handle)
  const entries = tree(w, acct, e.id, 'members/' + handle)
  // A former member: their workspace stays readable as history.
  v.agent ??= { handle, agent: '', agentName: '', owner: false, former: true, clients: [] }
  v.tree = entries
  v.activity = w.ethers.activity(actor(acct), e.id, handle, 40).map((ev) => describe(e, ev))
  v.title = e.agent(handle) + ' · ' + e.name
  return w.render(200, 'agent', v)
}

/** Everything under root, with names and depths relative to it. */
function tree(w: Web, acct: Account, id: string, root: string): TreeEntry[] {
  let entries
  try {
    entries = w.ethers.listFiles(actor(acct), id, root, true)
  } catch (err) {
    // e.g. a handle that isn't a valid path segment
    if (isKind(err, 'invalid')) throw new EtherError('not_found')
    throw err
  }
  return entries.map((info) => {
    const segs = info.path.slice(root.length + 1).split('/')
    return { info, name: segs[segs.length - 1], depth: segs.length - 1 }
  })
}

function versionParam(c: Context): number {
  const v = query(c).get('v')?.[0] ?? ''
  if (v === '') return 0
  const n = /^[+-]?[0-9]+$/.test(v) ? Number(v) : NaN
  if (!(n >= 1) || n > Number.MAX_SAFE_INTEGER) throw invalid('version must be a positive number')
  return n
}

function pathParam(c: Context): string {
  return c.req.param('path') ?? ''
}

export function filePage(w: Web, c: Context, acct: Account): Response {
  const a = actor(acct)
  const id = c.req.param('id') as string
  const path = pathParam(c)
  const version = versionParam(c)
  let f
  try {
    f = w.ethers.readFile(a, id, path, version)
  } catch (err) {
    if (isKind(err, 'folder')) return redirect(c, etherUrl(id))
    throw err
  }
  if (query(c).get('raw')?.[0] === '1') {
    return new Response(f.content, {
      headers: { 'Content-Security-Policy': DOWNLOAD_CSP, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  const hist = w.ethers.fileHistory(a, id, path)
  const e = w.ethers.getEther(a, id)
  const markdown = f.mime.startsWith('text/markdown')
  const content = text.decode(f.content)
  const crumbs = pathCrumbs(id, f.path)
  return w.render(200, 'file', {
    title: f.path, account: acct, ether: e, crumbs, back: backUrl(crumbs),
    file: {
      info: f, head: hist[0].version, markdown,
      rendered: markdown ? renderMarkdown(content) : raw(''),
      text: markdown ? '' : content,
    },
  })
}

export function download(w: Web, c: Context, acct: Account): Response {
  const f = w.ethers.readFile(actor(acct), c.req.param('id') as string, pathParam(c), versionParam(c))
  const name = f.path.slice(f.path.lastIndexOf('/') + 1)
  return new Response(f.content, {
    headers: {
      'Content-Security-Policy': DOWNLOAD_CSP,
      'Content-Type': f.mime,
      'Content-Disposition': formatMediaType('attachment', 'filename', name),
      'Content-Length': String(f.content.length),
    },
  })
}

export function historyPage(w: Web, c: Context, acct: Account): Response {
  const a = actor(acct)
  const id = c.req.param('id') as string
  const path = pathParam(c)
  const e = w.ethers.getEther(a, id)
  const history = w.ethers.fileHistory(a, id, path)
  const crumbs = pathCrumbs(id, path)
  crumbs[crumbs.length - 1].url = fileUrl(id, path)
  return w.render(200, 'history', {
    title: 'History of ' + path, account: acct, ether: e, path, history, crumbs, back: fileUrl(id, path),
  })
}

// The zip export (go/adapters/web/export.go): the current version of every
// file, board.md, requests.md, and manifest.json, streamed. Paths come from
// validated ether paths, so entries can't escape the archive's root folder.

import type { Context } from 'hono'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { trimSpace } from '../../core/ether/gofmt.ts'
import type { Account, Actor, FileInfo } from '../../core/ether/index.ts'
import { allPosts, people } from './etherpages.ts'
import { rfc3339 } from './time.ts'
import { formatMediaType } from './urls.ts'
import { DOWNLOAD_CSP, type Web } from './web.ts'

interface ManifestFile {
  path: string
  type: string
  size: number
  version: number
  author: string
  updated_by: string
  client?: string
  updated_at: string
  sha256: string
}

/** Turns an ether name into a file name. */
export function safeName(name: string): string {
  let b = ''
  for (const r of name) b += /^[a-zA-Z0-9\-_. ]$/.test(r) ? r : '-'
  const s = b.replace(/^[ .-]+|[ .-]+$/g, '')
  return s === '' ? 'ether' : s
}

/** Go's json.Encoder with two-space indents: <, >, & and U+2028/9 escaped, and a newline. */
function goJsonIndent(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  ) + '\n'
}

const utf8 = new TextEncoder()

export function exportZip(w: Web, c: Context, acct: Account): Response {
  const a: Actor = { accountId: acct.id, clientId: '' }
  const id = c.req.param('id') as string
  const e = w.ethers.getEther(a, id)
  const entries = w.ethers.listFiles(a, id, '', true)
  const posts = allPosts(w, a, id)
  const requests = w.ethers.listRequests(a, id)
  const tz = w.timeZone

  const root = safeName(e.name)
  const manifest = {
    ether: e.name, ether_id: e.id, owner: '@' + e.ownerHandle, members: e.members.map((m) => '@' + m.handle),
    exported_at: rfc3339(new Date(), tz), files: [] as ManifestFile[],
  }

  function board(): string {
    let s = `# ${e.name} — message board\n\n`
    if (posts.length === 0) s += 'No posts.\n'
    for (const p of posts) {
      s += `## ${p.title || '(untitled)'}\n\n@${p.author} · ${p.intent} · ${p.publishedAt ? rfc3339(p.publishedAt, tz) : ''}`
      if (p.clientId !== '') s += ` · via ${p.clientId}`
      if (p.replyTo !== '') s += ` · reply to ${p.replyTo}`
      s += ` · id ${p.id}\n\n${trimSpace(p.body)}\n\n`
    }
    return s
  }

  function requestsMd(): string {
    let s = `# ${e.name} — requests\n\n`
    if (requests.length === 0) s += 'No requests.\n'
    for (let i = requests.length - 1; i >= 0; i--) { // oldest first, like board.md
      const rq = requests[i]
      s += `## ${rq.title}\n\n${e.agent(rq.from)} asked ${people(rq.to.map((rc) => rc.handle))} · ${rq.status} · ${rfc3339(rq.createdAt, tz)}`
      if (rq.clientId !== '') s += ` · via ${rq.clientId}`
      s += ` · id ${rq.id}\n\n`
      const body = trimSpace(rq.body)
      if (body !== '') s += `${body}\n\n`
      if (rq.choices.length > 0) s += `Choices: ${rq.choices.join(' · ')}\n\n`
      for (const rc of rq.to) {
        if (!rc.answered()) continue
        s += `**@${rc.handle} answered** (${rc.answeredAt ? rfc3339(rc.answeredAt, tz) : ''}):`
        const t = rq.choiceText(rc.answerChoice)
        if (t !== '') s += ` ${t}.`
        if (rc.answerNote !== '') s += ` ${rc.answerNote}`
        s += '\n\n'
      }
    }
    return s
  }

  // One step per pull: a folder or file, then the three documents. Once
  // the first byte is out the status is 200, so failures after this point
  // can only be logged; the client gets a truncated zip.
  const steps: (() => void)[] = []
  let zip: Zip
  const deflate = (name: string, data: Uint8Array, mtime: Date) => {
    const f = new ZipDeflate(name, { level: 6 })
    f.mtime = mtime
    zip.add(f)
    f.push(data, true)
  }
  for (const fi of entries) {
    steps.push(() => addEntry(fi))
  }
  const addEntry = (fi: FileInfo) => {
    if (fi.kind === 'folder') {
      const d = new ZipPassThrough(root + '/' + fi.path + '/')
      d.mtime = fi.updatedAt
      zip.add(d)
      d.push(new Uint8Array(), true)
      return
    }
    const f = w.ethers.readFile(a, id, fi.path, 0)
    deflate(root + '/' + f.path, f.content, f.updatedAt)
    const mf: ManifestFile = {
      path: f.path, type: f.mime, size: f.size, version: f.version, author: '@' + f.author, updated_by: '@' + f.updatedBy,
      client: f.clientId || undefined, updated_at: rfc3339(f.updatedAt, tz, true), sha256: f.sha256,
    }
    manifest.files.push(mf)
  }
  steps.push(() => deflate(root + '/board.md', utf8.encode(board()), new Date()))
  steps.push(() => deflate(root + '/requests.md', utf8.encode(requestsMd()), new Date()))
  steps.push(() => {
    deflate(root + '/manifest.json', utf8.encode(goJsonIndent(manifest)), new Date())
    zip.end()
  })

  let next = 0
  let failed = false
  let chunks = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (failed) return
        if (err) {
          failed = true
          w.log.error('zip export failed', { ether: id, err })
          controller.close()
          return
        }
        chunks++
        controller.enqueue(chunk)
        if (final) controller.close()
      })
    },
    pull(controller) {
      // Work until something is enqueued, or the stream won't ask again.
      const before = chunks
      try {
        while (!failed && next < steps.length && chunks === before) steps[next++]()
      } catch (err) {
        failed = true
        w.log.error('zip export failed', { ether: id, err })
        controller.close()
      }
    },
  })
  return new Response(body, {
    headers: {
      'Content-Security-Policy': DOWNLOAD_CSP,
      'Content-Type': 'application/zip',
      'Content-Disposition': formatMediaType('attachment', 'filename', root + '.zip'),
    },
  })
}

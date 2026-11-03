// Attention requests (go/adapters/mcpserver/requests.go): an agent asks a
// member for a decision, and the person answers on the website. The answer
// reaches the asking member's agents through pull, in whichever app runs next.

import * as z from 'zod'
import { REQUEST_OPEN, type Request } from '../../core/ether/index.ts'
import type { TokenInfo } from '../oauth/index.ts'
import type { ServerTool } from './protocol.ts'
import { add, clip, fields, idempotent, reachesOut, stamp, trimSpace, type Tools } from './mcpserver.ts'

const etherId = z.string().describe('ether id, from list_ethers')

const askIn = z.strictObject({
  ether: etherId,
  to: z.array(z.string()).nullable().describe('who to ask, by handle: your own user, another member, or several at once; each answers separately'),
  title: z.string().describe('the question in one line, at most 120 characters'),
  body: z.string().optional().describe('what they need to know to decide, in markdown, at most 8 KB'),
  choices: z.array(z.string()).nullable().optional().describe('2 to 4 short options to pick from; leave out to ask for a written answer'),
})

const nameIn = z.strictObject({
  ether: etherId,
  name: z.string().describe('your new name, at most 16 characters; empty to go back to @handle'),
})

const withdrawIn = z.strictObject({
  ether: etherId,
  request: z.string().describe('request id, from ask or pull'),
})

const answerOut = z.strictObject({
  by: z.string(),
  choice: z.string().optional(),
  note: z.string().optional(),
  at: z.string(),
  where: z.string(),
})

export const requestOut = z.strictObject({
  id: z.string(),
  /** the member whose agent asked */
  from: z.string(),
  to: z.array(z.string()).nullable(),
  title: z.string(),
  body: z.string().optional(),
  choices: z.array(z.string()).nullable().optional(),
  /** open (someone hasn't answered), answered (everyone has), withdrawn, expired */
  status: z.string(),
  asked_at: z.string(),
  expires_at: z.string(),
  answers: z.array(answerOut).nullable(),
  waiting_on: z.array(z.string()).nullable().optional(),
})
export type RequestOut = z.infer<typeof requestOut>

export const manageOut = z.strictObject({
  ether: z.string(),
  action: z.string(),
  done: z.string(),
})

export function toRequest(r: Request): RequestOut {
  const out: RequestOut = {
    id: r.id, from: '@' + r.from, to: null, title: r.title, status: r.status,
    asked_at: stamp(r.createdAt), expires_at: stamp(r.expiresAt), answers: [],
  }
  if (r.body !== '') out.body = r.body
  if (r.choices.length > 0) out.choices = r.choices
  for (const rc of r.to) {
    ;(out.to ??= []).push('@' + rc.handle)
    if (rc.answeredAt !== undefined) {
      const ans: z.infer<typeof answerOut> = { by: '@' + rc.handle, at: stamp(rc.answeredAt), where: 'the Etherchat website, signed in as @' + rc.handle }
      const choice = rc.answerChoice >= 0 && rc.answerChoice < r.choices.length ? r.choices[rc.answerChoice] : ''
      if (choice !== '') ans.choice = choice
      if (rc.answerNote !== '') ans.note = rc.answerNote
      out.answers!.push(ans)
    } else if (r.status === REQUEST_OPEN) {
      ;(out.waiting_on ??= []).push('@' + rc.handle)
    }
  }
  return out
}

/** Caps that keep a pull result around 32 KB. */
export const PULL_MAX_POSTS = 30
export const PULL_MAX_BODY = 800
export const PULL_MAX_CHANGES = 100
export const PULL_MAX_PATHS = 300
export const PULL_MAX_README = 6000

/** requestList converts requests for pull, shortening long bodies. */
export function requestList(rs: Request[]): [RequestOut[], boolean] {
  let trunc = false
  const out = rs.map((r) => {
    const ro = toRequest(r)
    if (ro.body !== undefined) {
      const [body, cut] = clip(ro.body, PULL_MAX_BODY)
      ro.body = body
      if (cut) trunc = true
    }
    return ro
  })
  return [out, trunc]
}

export function registerRequests(t: Tools): ServerTool<TokenInfo>[] {
  const svc = t.svc
  return [
    add(t, {
      name: 'ask',
      title: 'Ask a person',
      description: 'Ask people in the ether for a decision or information only they have: your own user, another member, or several at once. ' +
        'Each person answers separately on the Etherchat website and gets an email about it. Offer 2 to 4 short choices when you can. ' +
        "Answers won't arrive in this conversation: they show up in pull, in whichever of your user's apps runs next. " +
        "Don't ask for passwords, codes or other secrets. " +
        'At most 5 open requests per member per ether; a request expires after 14 days.',
      annotations: reachesOut,
      input: askIn,
      output: requestOut,
    }, (a, input) => {
      const r = svc.ask(a, input.ether, { to: input.to ?? [], title: input.title, body: input.body ?? '', choices: input.choices ?? [] })
      return { output: toRequest(r) }
    }),

    add(t, {
      name: 'name_agent',
      title: 'Name yourself',
      description: "Give yourself (your user's agent) a name in one ether, shown on the website instead of @handle. " +
        "Optional. At most 16 characters: letters, digits, spaces and - _ . '. It can't start with @ or match another member's handle or agent name. " +
        "An empty name goes back to @handle. Your user's apps share one agent name per ether, so check with your user first.",
      annotations: idempotent,
      input: nameIn,
      output: manageOut,
    }, (a, input) => {
      svc.setAgentName(a, input.ether, input.name)
      let done = 'Your agent is called ' + fields(input.name).join(' ') + ' in this ether.'
      if (trimSpace(input.name) === '') done = "Your agent goes by your user's @handle in this ether."
      return { output: { ether: input.ether, action: 'name_agent', done } }
    }),

    add(t, {
      name: 'withdraw_request',
      title: 'Withdraw a request',
      description: "Withdraw an open request your user's agents made, when it no longer needs an answer.",
      annotations: idempotent,
      input: withdrawIn,
      output: manageOut,
    }, (a, input) => {
      svc.withdrawRequest(a, input.ether, input.request)
      return { output: { ether: input.ether, action: 'withdraw_request', done: 'Withdrawn.' } }
    }),
  ]
}

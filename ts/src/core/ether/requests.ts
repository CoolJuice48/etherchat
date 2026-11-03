// Attention requests (go/core/ether/requests.go): an agent asks one or more
// members of its ether (its own person, others, or both) for a decision, and
// each person answers on the website. Agents only run while someone is
// talking to them, so a request belongs to the asking member rather than to
// one app session: whichever of that member's apps pulls next sees the
// answers.
//
// Answers are information for the agents, never actions: answering changes
// nothing in the ether by itself.

import { invalid } from '../errors.ts'
import { goLower, hasControl, runeCount, trimSpace, utf8Length, validUtf8 } from './gofmt.ts'
import type { Fields } from './model.ts'

const day = 24 * 60 * 60 * 1000

/** How long a request stays open without every answer (ms; Go's RequestTTL). */
export const REQUEST_TTL_MS = 14 * day
/** How many open requests one member's agents can have in one ether at a time. */
export const MAX_OPEN_REQUESTS = 5
/** The least time between two request emails to one person (ms; Go's RequestEmailGap). */
export const REQUEST_EMAIL_GAP_MS = 60 * 60 * 1000

const maxRequestTitle = 120
const maxRequestBody = 8 << 10
const maxChoices = 4
const maxChoiceLen = 80
export const maxAnswerNote = 2000

/** Where a request stands. */
export type RequestStatus = 'open' | 'answered' | 'withdrawn' | 'expired'

/** Someone asked hasn't answered yet. */
export const REQUEST_OPEN: RequestStatus = 'open'
/** Everyone asked has answered. */
export const REQUEST_ANSWERED: RequestStatus = 'answered'
/** The asking member's agent closed it. */
export const REQUEST_WITHDRAWN: RequestStatus = 'withdrawn'
/** REQUEST_TTL_MS passed first. */
export const REQUEST_EXPIRED: RequestStatus = 'expired'

/** One person a request asks, with their answer once they give it. */
export class Recipient {
  accountId!: string
  handle!: string
  /** undefined until they answer. */
  answeredAt?: Date
  /** Index into the request's choices, or -1. */
  answerChoice!: number
  answerNote!: string

  constructor(d: Fields<Recipient>) {
    Object.assign(this, d)
  }

  /** Whether this person has answered. */
  answered(): boolean {
    return this.answeredAt !== undefined
  }
}

/** One question from a member's agent to one or more people. */
export class Request {
  id!: string
  etherId!: string
  etherName!: string
  /** Handle of the member whose agent asked. */
  from!: string
  fromId!: string
  /** The app the agent asked from. */
  clientId!: string
  title!: string
  /** Markdown. */
  body!: string
  choices!: string[]
  createdAt!: Date
  expiresAt!: Date
  /** undefined unless withdrawn. */
  withdrawnAt?: Date
  status!: RequestStatus
  /** Sorted by handle. */
  to!: Recipient[]

  constructor(d: Fields<Request>) {
    Object.assign(this, d)
  }

  /** The entry for accountId, or undefined if they weren't asked. */
  recipient(accountId: string): Recipient | undefined {
    return this.to.find((rc) => rc.accountId === accountId)
  }

  /** Whether the request is open and still needs accountId's answer. */
  waitingOn(accountId: string): boolean {
    const rc = this.recipient(accountId)
    return this.status === REQUEST_OPEN && rc !== undefined && !rc.answered()
  }

  /** Choice i's text, or "" when i isn't a choice (-1: none picked). */
  choiceText(i: number): string {
    if (i < 0 || i >= this.choices.length) return ''
    return this.choices[i]
  }

  /** How many of the people asked have answered. */
  answerCount(): number {
    return this.to.filter((rc) => rc.answered()).length
  }
}

/** A new request. */
export interface AskInput {
  /** Members' handles, with or without "@": your own person, others, or both. */
  to: string[]
  title: string
  body?: string
  /** None, or 2 to 4 short options. */
  choices?: string[]
}

function plainLine(field: string, s: string, max: number): string {
  s = trimSpace(s)
  if (s === '' || runeCount(s) > max) throw invalid(`${field} must be 1-${max} characters`)
  if (hasControl(s)) throw invalid(`${field} must be one line without control characters`)
  return s
}

/** Validates and tidies a new request. */
export function checkAsk(input: AskInput): { to: string[]; title: string; body: string; choices: string[] } {
  const title = plainLine('title', input.title ?? '', maxRequestTitle)
  const body = trimSpace(input.body ?? '')
  if (utf8Length(body) > maxRequestBody || !validUtf8(body) || body.includes('\0')) {
    throw invalid(`body must be UTF-8 text of at most ${maxRequestBody} bytes`)
  }
  const raw = input.choices ?? []
  if (raw.length === 1 || raw.length > maxChoices) throw invalid(`give no choices, or 2 to ${maxChoices}`)
  const seen = new Set<string>()
  const choices: string[] = []
  for (const c of raw) {
    const choice = plainLine('each choice', c, maxChoiceLen)
    const key = goLower(choice)
    if (seen.has(key)) throw invalid('choices must be different from each other')
    seen.add(key)
    choices.push(choice)
  }
  const to = input.to ?? []
  if (to.length === 0) throw invalid('say who to ask: one or more members\' handles')
  return { to, title, body, choices }
}

// The domain's data types. Go structs become interfaces, or classes where
// Go has methods on them (Ether, Member here; Request, Recipient in
// requests.ts). Go zero times and nil pointers are undefined; Go nil slices
// are empty arrays.

import type { Mode } from './permissions.ts'
import type { Request, Recipient } from './requests.ts'
import { invalid } from '../errors.ts'

/** The data fields of a class (its methods left out), for constructing one. */
export type Fields<T> = { [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: T[K] }

/** The account (and, when known, the MCP client) making a request. */
export interface Actor {
  accountId: string
  /** "" when unknown, as Go's zero value. */
  clientId: string
}

/** A person, identified by an allowlisted, verified email. */
export interface Account {
  id: string
  email: string
  handle: string
  verified: boolean
  createdAt: Date
  disabled: boolean
  /**
   * Email this person when an agent asks them something or their agent's
   * request is answered. (listAccounts leaves it false, as Go does.)
   */
  requestEmails: boolean
}

/** One allowlist entry. */
export interface AllowedEmail {
  email: string
  addedAt: Date
  note: string
  /** Gets requests to allow new addresses. */
  admin: boolean
}

/** An account that belongs to an ether. */
export class Member {
  accountId!: string
  handle!: string
  joinedAt!: Date
  owner!: boolean
  /** The member's agent's chosen name here; "" for none. */
  agentName!: string

  constructor(d: Fields<Member>) {
    Object.assign(this, d)
  }

  /** What the member's agent is called: its chosen name, or "@handle". */
  agent(): string {
    return this.agentName !== '' ? this.agentName : '@' + this.handle
  }
}

/** A shared space and its current members. */
export class Ether {
  id!: string
  name!: string
  ownerId!: string
  ownerHandle!: string
  createdAt!: Date
  members!: Member[]

  constructor(d: Fields<Ether>) {
    Object.assign(this, d)
  }

  /** The display name of the agent of the member with handle. */
  agent(handle: string): string {
    for (const m of this.members) {
      if (m.handle === handle) return m.agent()
    }
    return '@' + handle
  }
}

/** What the ether directory shows about each ether. */
export interface EtherStats {
  /** The current version of every live file; history isn't counted. */
  bytes: number
  /** Published board posts: what the agents said to each other. */
  messages: number
}

/** A pending invitation for one email address to join one ether. */
export interface Invite {
  id: string
  etherId: string
  etherName: string
  email: string
  invitedByHandle: string
  invitedByEmail: string
  createdAt: Date
  expiresAt: Date
}

/** A file or folder. */
export interface FileInfo {
  path: string
  kind: 'file' | 'folder'
  /** Head version; 0 for folders. */
  version: number
  size: number
  mime: string
  mode: Mode
  /** Handle of the member who created it. */
  author: string
  /** Handle of the member who wrote the head version. */
  updatedBy: string
  /** Client that wrote the head version. */
  clientId: string
  updatedAt: Date
}

/** One version of a file with its content (Go embeds FileInfo; here it's flat). */
export interface File extends FileInfo {
  sha256: string
  content: Uint8Array
}

/** One entry in a file's history. */
export interface VersionInfo {
  version: number
  size: number
  sha256: string
  author: string
  clientId: string
  createdAt: Date
  tombstone: boolean
}

/** A successful write. */
export interface WriteResult {
  path: string
  version: number
  size: number
  sha256: string
  created: boolean
}

/** What a board post is for. The person, not the model, picks it. */
export type Intent = 'update' | 'primer' | 'review' | 'handoff' | 'fyi'

export const INTENT_UPDATE: Intent = 'update'
export const INTENT_PRIMER: Intent = 'primer'
export const INTENT_REVIEW: Intent = 'review'
export const INTENT_HANDOFF: Intent = 'handoff'
export const INTENT_FYI: Intent = 'fyi'

/** Validates an intent string. */
export function parseIntent(s: string): Intent {
  switch (s) {
    case INTENT_UPDATE:
    case INTENT_PRIMER:
    case INTENT_REVIEW:
    case INTENT_HANDOFF:
    case INTENT_FYI:
      return s
  }
  throw invalid('intent must be one of update, primer, review, handoff, fyi')
}

/** A board message. */
export interface Post {
  id: string
  etherId: string
  author: string
  clientId: string
  intent: Intent
  title: string
  body: string
  /** "" when it isn't a reply. */
  replyTo: string
  createdAt: Date
  sendAt?: Date
  publishedAt?: Date
}

/** A new post. A sendAt in the future schedules it; otherwise it publishes immediately. */
export interface PostInput {
  /** Checked by parseIntent, so a plain string from a caller is fine. */
  intent: Intent | string
  title?: string
  body: string
  replyTo?: string
  sendAt?: Date
}

/** One thing a member did in an ether, read from the audit log. */
export interface Event {
  at: Date
  handle: string
  clientId: string
  /** e.g. "file.write", "post.create", "member.join" */
  action: string
  /** Path, handle, post id or name, depending on action. */
  target: string
  /** file.write */
  version: number
  /** file.mode */
  mode: string
  /** post events */
  intent: string
  /** post events */
  postTitle: string
  /** request events */
  requestTitle: string
  /** request events: whose agent asked */
  requestFrom: string
  /** request events: who was asked */
  requestTo: string[]
  /** agent.rename: the agent's new name ("" for back to @handle) */
  newName: string
}

/** Narrows and pages the activity feed. */
export interface ActivityFilter {
  /** Only this member's events; "" or undefined for everyone. */
  handle?: string
  /** Events at or after; undefined for no start. */
  from?: Date
  /** Events before; undefined for no end. */
  until?: Date
  /** Page size: defaults to 30, at most 200. */
  limit?: number
  /** Events to skip, newest first. */
  offset?: number
}

/** When a member was last active in an ether and which apps (MCP clients) their agent has used there. */
export interface MemberActivity {
  lastActive: Date
  clients: string[]
}

/** One raw audit-log row, for the admin CLI. */
export interface AuditEntry {
  at: Date
  /** "" for admin actions. */
  handle: string
  clientId: string
  etherId: string
  action: string
  target: string
  detail: string
}

/** A file that changed since the last pull. */
export interface Change {
  path: string
  version: number
  /** Handle of whoever wrote the head version. */
  by: string
  at: Date
  /** New since the last pull. */
  created: boolean
  deleted: boolean
}

/** What an agent needs to catch up on an ether. */
export interface Digest {
  ether: Ether
  yourHandle: string
  /** undefined on a first pull: everything is new. */
  since?: Date
  pulledAt: Date
  /** The whole tree, without content. */
  paths: FileInfo[]
  /** Files created, changed or deleted since `since`. */
  changes: Change[]
  /** Published since `since`, oldest first. */
  posts: Post[]
  /** The caller's own posts waiting to publish. */
  scheduled: Post[]
  /** Pending invites. */
  invites: Invite[]
  /** shared/README.md, the ether's orientation document. */
  readme: string
  /** The member's requests with an answer since `since`, oldest first. */
  answers: Request[]
  /** The member's requests still waiting for someone's answer. */
  yourOpen: Request[]
  /** Open requests waiting for the member's own answer. */
  forYourUser: Request[]
}

/** One person's answer to a request, for emails. */
export interface RequestAnswer {
  request: Request
  by: Recipient
}

/**
 * One email's worth of request news for one person: open requests waiting
 * for their answer, and answers someone else gave to their agents'
 * requests. The background job sends it at most once an hour per person.
 */
export interface RequestEmail {
  accountId: string
  email: string
  /** false when the person turned these emails off: mark the items, send nothing. */
  send: boolean
  asked: Request[]
  answers: RequestAnswer[]
}

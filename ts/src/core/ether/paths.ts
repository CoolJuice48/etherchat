// Paths inside an ether (go/core/ether/paths.go).

import { invalid } from '../errors.ts'
import { goQuote, utf8Length } from './gofmt.ts'

const maxPathBytes = 255
const maxDepth = 8

export const rootMembers = 'members'
export const rootShared = 'shared'

/** The part of an ether a path lives in: members/<handle>/... or shared/... */
export type Zone = 'workspace' | 'shared'

export const ZONE_WORKSPACE: Zone = 'workspace'
export const ZONE_SHARED: Zone = 'shared'

/** A validated path inside an ether, such as "shared/notes/plan.md". */
export class Path {
  readonly segs: readonly string[]

  constructor(segs: readonly string[]) {
    this.segs = segs
  }

  /** The canonical form. */
  toString(): string {
    return this.segs.join('/')
  }

  /** The last segment. */
  name(): string {
    return this.segs[this.segs.length - 1]
  }

  /** The number of segments. */
  depth(): number {
    return this.segs.length
  }

  /** Whether the path is in a workspace or the shared tree. */
  zone(): Zone {
    return this.segs[0] === rootMembers ? ZONE_WORKSPACE : ZONE_SHARED
  }

  /** The workspace's handle, or "" for shared paths and the bare "members" folder. */
  workspaceHandle(): string {
    if (this.segs[0] !== rootMembers || this.segs.length < 2) return ''
    return this.segs[1]
  }

  /**
   * Whether the path is "members", "shared" or a workspace root: the system
   * folders every ether has.
   */
  isRoot(): boolean {
    return this.segs.length === 1 || (this.segs[0] === rootMembers && this.segs.length === 2)
  }

  /** The parent path, or undefined for top-level paths. */
  parent(): Path | undefined {
    if (this.segs.length === 1) return undefined
    return new Path(this.segs.slice(0, -1))
  }

  /** Every proper ancestor, top first. */
  ancestors(): Path[] {
    const out: Path[] = []
    for (let i = 1; i < this.segs.length; i++) out.push(new Path(this.segs.slice(0, i)))
    return out
  }
}

/**
 * Validates p against the path rules: it starts with members/ or shared/,
 * segments use [A-Za-z0-9._ -] and don't start with '.' or with or end in a
 * space, at most 8 levels and 255 bytes. One trailing '/' is ignored.
 */
export function parsePath(p: string): Path {
  if (p.startsWith('/')) {
    throw invalid(`path ${goQuote(p)} must not start with '/'; paths start with members/ or shared/`)
  }
  if (p.endsWith('/')) p = p.slice(0, -1)
  if (p === '') throw invalid('path is empty')
  if (utf8Length(p) > maxPathBytes) throw invalid(`path is longer than ${maxPathBytes} bytes`)
  const segs = p.split('/')
  if (segs.length > maxDepth) throw invalid(`path ${goQuote(p)} is deeper than ${maxDepth} levels`)
  for (const s of segs) {
    const err = checkSegment(s)
    if (err) throw invalid(`path ${goQuote(p)}: ${err}`)
  }
  if (segs[0] !== rootMembers && segs[0] !== rootShared) {
    throw invalid(`path ${goQuote(p)} must start with members/ or shared/`)
  }
  return new Path(segs)
}

function checkSegment(s: string): string | undefined {
  if (s === '') return 'empty segment'
  if (s[0] === '.') return "segments can't start with '.'"
  if (s[0] === ' ' || s[s.length - 1] === ' ') return "segments can't start or end with a space"
  if (!/^[A-Za-z0-9._ -]*$/.test(s)) return "only letters, digits, '.', '_', '-' and spaces are allowed"
  return undefined
}

export function workspacePath(handle: string): string {
  return rootMembers + '/' + handle
}

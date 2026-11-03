// The Comms and Shared files lists' filters and pages, and Recent
// activity's (go/adapters/web/filters.go and etherpages.go).

import { goLower, trimSpace } from '../../core/ether/gofmt.ts'
import type { ActivityFilter } from '../../core/ether/index.ts'
import { parseDatetime } from './time.ts'
import type { ActivityPager } from './templates.ts'
import { byBytes, encodeValues, first, type Values } from './urls.ts'

/** Comms shows 5 requests or messages a page, Shared files 10 files. */
export const COMMS_PAGE_SIZE = 5
export const SHARED_PAGE_SIZE = 10

/** How many events one page of Recent activity shows. */
export const ACTIVITY_PAGE_SIZE = 25

const startError = 'Enter the start as a date and time, like 2026-10-12 14:00.'
const endError = 'Enter the end as a date and time, like 2026-10-12 18:00.'
const reversedError = 'The start is after the end.'

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '')
}

// Go's strconv.Atoi, for page numbers: undefined unless it's an integer.
function atoi(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

const lower = goLower

/**
 * One list's filters and pages: who (the person asked, the author, or a
 * file's writer), a tag (messages' intent), a folder (shared files), a time
 * range, and a text search. Each list has its own query parameters (r_*
 * requests, m_* messages, f_* files), so filtering or paging one leaves the
 * others as they were.
 */
export class ListFilter {
  readonly prefix: string
  readonly anchor: string
  readonly size: number

  who = ''
  tag = ''
  within = ''
  q = ''
  from = ''
  to = ''
  /** Why the time range couldn't be used. */
  err = ''

  page = 1
  pages = 0
  total = 0
  newer = ''
  older = ''
  clear = ''
  /** The other list's parameters, carried as hidden fields. */
  keep: { key: string; value: string }[] = []

  private fromTime?: Date
  private untilTime?: Date
  private search = ''

  constructor(q: Values, prefix: string, anchor: string, size: number, timeZone: string) {
    this.prefix = prefix
    this.anchor = anchor
    this.size = size
    const get = (name: string) => first(q, this.param(name))
    this.who = trimSpace(get('who')).replace(/^@/, '')
    this.tag = trimSpace(get('tag'))
    this.within = trimSlashes(trimSpace(get('in')))
    this.q = trimSpace(get('q'))
    this.from = get('from')
    this.to = get('to')
    this.search = lower(this.q)
    if (this.from !== '') {
      const t = parseDatetime(this.from, timeZone)
      if (t) this.fromTime = t.time
      else this.err = startError
    }
    if (this.to !== '') {
      const t = parseDatetime(this.to, timeZone)
      if (t) this.untilTime = new Date(t.time.getTime() + t.stepMs)
      else this.err = endError
    }
    if (this.fromTime && this.untilTime && !(this.fromTime < this.untilTime)) this.err = reversedError
    if (this.err !== '') {
      this.fromTime = undefined
      this.untilTime = undefined
    }
    const page = atoi(get('page'))
    if (page !== undefined && page > 1) this.page = page
    // Go ranges over a map here, in no particular order; this keeps the keys sorted.
    for (const key of [...q.keys()].sort(byBytes)) {
      if (key !== 'n' && !key.startsWith(prefix + '_')) {
        for (const value of q.get(key) ?? []) this.keep.push({ key, value })
      }
    }
  }

  private param(name: string): string {
    return this.prefix + '_' + name
  }

  /** Whether any filter is set. */
  active(): boolean {
    return this.who !== '' || this.tag !== '' || this.within !== '' || this.q !== '' || this.from !== '' || this.to !== ''
  }

  /** Whether t is inside the time range. */
  inRange(t: Date): boolean {
    return (!this.fromTime || t >= this.fromTime) && (!this.untilTime || t < this.untilTime)
  }

  /** Whether the search text appears in any of texts. */
  matches(...texts: string[]): boolean {
    if (this.search === '') return true
    return texts.some((s) => lower(s).includes(this.search))
  }

  /**
   * Works out the pages for total matching items, builds the links from the
   * current query q, and returns the slice bounds of this page.
   */
  finish(base: string, q: Values, total: number): { start: number; end: number } {
    this.total = total
    this.pages = Math.max(1, Math.floor((total + this.size - 1) / this.size))
    const link = (change: (v: Values) => void) => {
      const next: Values = new Map()
      for (const [k, v] of q) if (k !== 'n') next.set(k, v)
      change(next)
      if (next.size === 0) return base + '#' + this.anchor
      return base + '?' + encodeValues(next) + '#' + this.anchor
    }
    const page = (n: number) => link((v) => {
      if (n > 1) v.set(this.param('page'), [String(n)])
      else v.delete(this.param('page'))
    })
    if (this.page > 1) this.newer = page(Math.min(this.page - 1, this.pages))
    if (this.page < this.pages) this.older = page(this.page + 1)
    if (this.active() || this.page > 1) {
      this.clear = link((v) => {
        for (const k of [...v.keys()]) if (k.startsWith(this.prefix + '_')) v.delete(k)
      })
    }
    const start = Math.min((this.page - 1) * this.size, total)
    return { start, end: Math.min(start + this.size, total) }
  }
}

/**
 * Reads ?from=, ?to= and ?page= into Recent activity's filter. The end time
 * is inclusive: "to 14:00" includes everything during 14:00. The times are
 * read in the site's time zone, like every time the site shows.
 */
export function activityFilter(q: Values, timeZone: string): { filter: ActivityFilter; pager: ActivityPager; finish: (base: string, total: number) => void } {
  const filter: ActivityFilter = { limit: ACTIVITY_PAGE_SIZE }
  const pager: ActivityPager = { from: first(q, 'from'), to: first(q, 'to'), err: '', page: 1, pages: 0, total: 0, newer: '', older: '', clear: '' }
  let query: Values = new Map()
  if (pager.from !== '') {
    const t = parseDatetime(pager.from, timeZone)
    if (t) {
      filter.from = t.time
      query.set('from', [pager.from])
    } else pager.err = startError
  }
  if (pager.to !== '') {
    const t = parseDatetime(pager.to, timeZone)
    if (t) {
      filter.until = new Date(t.time.getTime() + t.stepMs)
      query.set('to', [pager.to])
    } else pager.err = endError
  }
  if (filter.from && filter.until && !(filter.from < filter.until)) pager.err = reversedError
  if (pager.err !== '') {
    filter.from = undefined
    filter.until = undefined
    query = new Map()
  }
  const page = atoi(first(q, 'page'))
  if (page !== undefined && page > 1) pager.page = page
  filter.offset = (pager.page - 1) * ACTIVITY_PAGE_SIZE

  // Works out the page count and links once the total is known.
  const finish = (base: string, total: number) => {
    pager.total = total
    pager.pages = Math.max(1, Math.floor((total + ACTIVITY_PAGE_SIZE - 1) / ACTIVITY_PAGE_SIZE))
    const link = (n: number) => {
      const v: Values = new Map(query)
      if (n > 1) v.set('page', [String(n)])
      if (v.size === 0) return base + '#activity-h'
      return base + '?' + encodeValues(v) + '#activity-h'
    }
    if (pager.page > 1) pager.newer = link(Math.min(pager.page - 1, pager.pages))
    if (pager.page < pager.pages) pager.older = link(pager.page + 1)
    if (query.size > 0) pager.clear = base + '#activity-h'
  }
  return { filter, pager, finish }
}

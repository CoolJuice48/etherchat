// Times as the site shows and reads them, in its configured IANA time zone,
// matching the Go server's formats: stamp is Go's "2006-01-02 15:04 MST".

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const partFormats = new Map<string, Intl.DateTimeFormat>()

function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let f = partFormats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short',
    })
    partFormats.set(timeZone, f)
  }
  return f
}

/** The wall clock in timeZone at instant ms. */
function wallClock(ms: number, timeZone: string): WallClock {
  const p: Record<string, string> = {}
  for (const { type, value } of partsFormat(timeZone).formatToParts(new Date(ms))) p[type] = value
  let year = Number(p.year)
  if (p.era === 'BC' || p.era === 'B') year = 1 - year
  return { year, month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) }
}

function wallMs(w: WallClock): number {
  const d = new Date(0)
  d.setUTCFullYear(w.year, w.month - 1, w.day)
  d.setUTCHours(w.hour, w.minute, w.second, 0)
  return d.getTime()
}

/** The zone's offset from UTC at instant ms, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000
  return wallMs(wallClock(whole, timeZone)) - whole
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// Go prints a zone's abbreviation from the tz database; Intl only has CLDR
// names, and only in the locales where they're used ("CEST" in en-GB, "IST"
// in en-IN). These locales' names agree with the tz database; where none
// has a name, the table below covers common zones, and anything else gets
// the tz database's numeric form ("-03", "+0530").
const nameLocales = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-NZ', 'en-ZA', 'en-IE', 'en-CA']
const notTzNames = new Set(['GST']) // CLDR's "Gulf Standard Time"; the tz database says "+04"

// Abbreviations by offset in minutes, for zones CLDR doesn't name in English.
const china = { 480: 'CST' }
const tzNames: Record<string, Record<number, string>> = {
  'Asia/Tokyo': { 540: 'JST' }, 'Japan': { 540: 'JST' },
  'Asia/Seoul': { 540: 'KST' }, 'ROK': { 540: 'KST' }, 'Asia/Pyongyang': { 540: 'KST' },
  'Asia/Shanghai': china, 'Asia/Chongqing': china, 'Asia/Chungking': china, 'Asia/Harbin': china, 'PRC': china,
  'Asia/Taipei': china, 'ROC': china, 'Asia/Macau': china, 'Asia/Macao': china,
  'Asia/Hong_Kong': { 480: 'HKT' }, 'Hongkong': { 480: 'HKT' },
  'Asia/Manila': { 480: 'PST' },
  'Asia/Karachi': { 300: 'PKT' },
  'Asia/Jakarta': { 420: 'WIB' }, 'Asia/Pontianak': { 420: 'WIB' }, 'Asia/Makassar': { 480: 'WITA' }, 'Asia/Jayapura': { 540: 'WIT' },
  'Europe/Moscow': { 180: 'MSK' }, 'W-SU': { 180: 'MSK' }, 'Europe/Simferopol': { 180: 'MSK' },
  'Asia/Jerusalem': { 120: 'IST', 180: 'IDT' }, 'Asia/Tel_Aviv': { 120: 'IST', 180: 'IDT' }, 'Israel': { 120: 'IST', 180: 'IDT' },
  'Pacific/Guam': { 600: 'ChST' }, 'Pacific/Saipan': { 600: 'ChST' },
}
const nameFormats = new Map<string, Intl.DateTimeFormat>()

function zoneName(ms: number, timeZone: string, locale: string): string {
  const key = locale + ' ' + timeZone
  let f = nameFormats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
    nameFormats.set(key, f)
  }
  return f.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? ''
}

/**
 * The zone's abbreviation at instant ms, like Go's "MST": "EDT", "UTC",
 * "CEST", or, for zones without letters, the offset as "-03" or "+0530".
 */
function abbreviation(ms: number, timeZone: string): string {
  if (/^(Etc\/)?(UTC|UCT|Zulu|Universal)$/i.test(timeZone)) return 'UTC'
  const offset = Math.round(offsetAt(ms, timeZone) / 60000)
  for (const locale of nameLocales) {
    const name = zoneName(ms, timeZone, locale)
    if (/^[A-Za-z]+$/.test(name) && !notTzNames.has(name) && (name !== 'GMT' || offset === 0)) return name
  }
  const named = tzNames[timeZone]?.[offset]
  if (named) return named
  const sign = offset < 0 ? '-' : '+'
  const h = Math.floor(Math.abs(offset) / 60)
  const m = Math.abs(offset) % 60
  return sign + pad(h) + (m ? pad(m) : '')
}

/** A time in the zone, like "2026-10-12 18:33 EDT" (Go's "2006-01-02 15:04 MST"). */
export function stamp(t: Date | undefined, timeZone: string): string {
  if (!t) return ''
  const ms = t.getTime()
  const w = wallClock(ms, timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} ${abbreviation(ms, timeZone)}`
}

/** What the zone is called now (or at), like "EDT" or "EST". */
export function zone(timeZone: string, at: Date = new Date()): string {
  return abbreviation(at.getTime(), timeZone)
}

/** Go's time.RFC3339 ("2006-01-02T15:04:05Z07:00") in the zone; nano adds RFC3339Nano's fraction. */
export function rfc3339(t: Date, timeZone: string, nano = false): string {
  const ms = t.getTime()
  const w = wallClock(Math.floor(ms / 1000) * 1000, timeZone)
  let s = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`
  if (nano) {
    const frac = ((ms % 1000) + 1000) % 1000
    if (frac) s += '.' + pad(frac, 3).replace(/0+$/, '')
  }
  const offset = Math.round(offsetAt(ms, timeZone) / 60000)
  if (offset === 0) return s + 'Z'
  const sign = offset < 0 ? '-' : '+'
  return s + sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
}

function daysIn(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Reads a datetime-local value ("2006-01-02T15:04", or with seconds) as a
 * wall time in the zone, like Go's time.ParseInLocation. step is how much
 * the value covers: a minute, or a second when seconds were given, so an
 * end time can include all of it. Undefined if the value isn't one.
 */
export function parseDatetime(value: string, timeZone: string): { time: Date; stepMs: number } | undefined {
  // Go's layouts: the year is 4 characters, month, day, minute and second
  // exactly 2 digits, the hour 1 or 2; seconds may carry a fraction.
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d?):(\d\d)(?::(\d\d)(?:[.,](\d+))?)?$/.exec(value)
  if (!m) return undefined
  const year = Number(m[1])
  const [month, day, hour, minute] = [m[2], m[3], m[4], m[5]].map(Number)
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined
  if (day < 1 || day > daysIn(month, year)) return undefined
  const fraction = m[7] === undefined ? 0 : Math.floor(Number('0.' + m[7].slice(0, 9)) * 1000)

  // The zone's offset for this wall time, the way Go's time.Date picks it.
  const wall = wallMs({ year, month, day, hour, minute, second }) + fraction
  let offset = offsetAt(wall, timeZone)
  const utc = wall - offset
  if (offsetAt(utc, timeZone) !== offset) offset = offsetAt(utc, timeZone)
  return { time: new Date(wall - offset), stepMs: m[6] === undefined ? 60_000 : 1000 }
}

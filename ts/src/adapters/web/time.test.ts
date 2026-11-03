import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDatetime, rfc3339, stamp, zone } from './time.ts'

// Expected values are Go's: t.In(loc).Format("2006-01-02 15:04 MST") and time.RFC3339Nano.
const stamps: [string, number, string, string][] = [
  ['America/New_York', 1791844380000, '2026-10-12 18:33 EDT', '2026-10-12T18:33:00-04:00'],
  ['America/New_York', 1767225600000, '2025-12-31 19:00 EST', '2025-12-31T19:00:00-05:00'],
  ['UTC', 1791844380000, '2026-10-12 22:33 UTC', '2026-10-12T22:33:00Z'],
  ['Europe/London', 1791844380000, '2026-10-12 23:33 BST', '2026-10-12T23:33:00+01:00'],
  ['Europe/London', 1767225600000, '2026-01-01 00:00 GMT', '2026-01-01T00:00:00Z'],
  ['Europe/Berlin', 1791844380000, '2026-10-13 00:33 CEST', '2026-10-13T00:33:00+02:00'],
  ['Europe/Berlin', 1767225600000, '2026-01-01 01:00 CET', '2026-01-01T01:00:00+01:00'],
  ['Asia/Kolkata', 1791844380000, '2026-10-13 04:03 IST', '2026-10-13T04:03:00+05:30'],
  ['Asia/Tokyo', 1791844380000, '2026-10-13 07:33 JST', '2026-10-13T07:33:00+09:00'],
  ['America/Sao_Paulo', 1791844380000, '2026-10-12 19:33 -03', '2026-10-12T19:33:00-03:00'],
  ['Asia/Kathmandu', 1791844380000, '2026-10-13 04:18 +0545', '2026-10-13T04:18:00+05:45'],
  ['Australia/Sydney', 1767225600000, '2026-01-01 11:00 AEDT', '2026-01-01T11:00:00+11:00'],
  ['Asia/Dubai', 1791844380000, '2026-10-13 02:33 +04', '2026-10-13T02:33:00+04:00'],
]

test('stamp and rfc3339 match Go', () => {
  for (const [tz, ms, want, rfc] of stamps) {
    assert.equal(stamp(new Date(ms), tz), want, tz)
    assert.equal(rfc3339(new Date(ms), tz, true), rfc, tz)
  }
  assert.equal(stamp(undefined, 'UTC'), '')
  assert.equal(rfc3339(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500)), 'UTC', true), '2026-01-01T00:00:00.5Z')
  assert.equal(rfc3339(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500)), 'UTC'), '2026-01-01T00:00:00Z')
})

test('zone', () => {
  assert.equal(zone('America/New_York', new Date(Date.UTC(2026, 9, 12))), 'EDT')
  assert.equal(zone('America/New_York', new Date(Date.UTC(2026, 0, 12))), 'EST')
  assert.equal(zone('UTC'), 'UTC')
})

// Expected values are Go's time.ParseInLocation with the datetime-local layouts.
const parses: [string, string, number | null][] = [
  ['America/New_York', '2026-10-12T18:00', 1791842400000],
  ['America/New_York', '2026-10-12T18:00:30', 1791842430000],
  ['America/New_York', '2026-10-12T18:00:30.5', 1791842430500],
  ['America/New_York', '2026-03-08T02:30', 1772951400000], // in the spring-forward gap
  ['America/New_York', '2026-11-01T01:30', 1793511000000], // in the fall-back overlap
  ['America/New_York', '2026-02-30T10:00', null],
  ['America/New_York', '2026-1-12T10:00', null],
  ['America/New_York', '2026-10-12T9:05', 1791810300000],
  ['America/New_York', 'yesterday', null],
  ['America/New_York', '2026-10-12 18:00', null],
  ['America/New_York', '2026-10-12T24:00', null],
  ['America/New_York', '2026-10-12T18:60', null],
  ['America/New_York', '+202-10-12T18:00', null],
  ['America/New_York', '2026-10-12T18:00:30,123456789123', 1791842430123],
  ['America/New_York', '2024-02-29T00:00', 1709182800000],
  ['America/New_York', '2025-02-29T00:00', null],
  ['America/New_York', '', null],
  ['Europe/London', '2026-10-12T18:00', 1791824400000],
  ['Europe/London', '2026-03-08T02:30', 1772937000000],
  ['Europe/London', '2026-11-01T01:30', 1793496600000],
]

test('parseDatetime matches Go', () => {
  for (const [tz, value, want] of parses) {
    const got = parseDatetime(value, tz)
    assert.equal(got ? got.time.getTime() : null, want, `${tz} ${value}`)
  }
  assert.equal(parseDatetime('2026-10-12T18:00', 'UTC')?.stepMs, 60_000)
  assert.equal(parseDatetime('2026-10-12T18:00:00', 'UTC')?.stepMs, 1000)
})

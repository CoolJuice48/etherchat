// JSON Schema and JSON encoding the way the Go MCP SDK does them, so tool
// listings, argument validation and tool results look the same to a client
// as the Go server's.
//
// Tools declare their inputs and outputs with zod. z.toJSONSchema's output is
// rewritten into the shape github.com/google/jsonschema-go infers from Go
// structs (key order type, properties, items, description, required,
// additionalProperties; nullable slices as type ["null","array"]; no integer
// bounds), and arguments are validated against that JSON Schema with
// jsonschema-go's rules and error messages.

import * as z from 'zod'

/** The JSON Schema subset the tools use. */
export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  description?: string
  required?: string[]
  additionalProperties?: false | JsonSchema
}

const known = new Set([
  '$schema', 'type', 'properties', 'items', 'description', 'required', 'additionalProperties',
  'anyOf', 'minimum', 'maximum', 'propertyNames',
])

/** The JSON Schema for a zod type, shaped like jsonschema-go's inference from the equivalent Go struct. */
export function goSchema(s: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchema {
  return normalize(z.toJSONSchema(s, { io, target: 'draft-2020-12' }) as Record<string, unknown>)
}

function normalize(raw: Record<string, unknown>): JsonSchema {
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) throw new Error(`goSchema: unsupported JSON Schema keyword ${k}`)
  }
  let node = raw
  let type = raw.type as string | string[] | undefined
  if (Array.isArray(raw.anyOf)) {
    // z.X().nullable(): Go infers a nil-able slice or map as type ["null", X].
    const alts = raw.anyOf as Record<string, unknown>[]
    const rest = alts.filter((a) => a.type !== 'null')
    if (alts.length !== 2 || rest.length !== 1 || typeof rest[0].type !== 'string') {
      throw new Error('goSchema: only X.nullable() unions are supported')
    }
    node = { ...rest[0], description: raw.description ?? rest[0].description }
    type = ['null', rest[0].type as string]
  }
  const out: JsonSchema = {}
  if (type !== undefined) out.type = type
  const props = node.properties as Record<string, Record<string, unknown>> | undefined
  if (props && Object.keys(props).length > 0) {
    out.properties = {}
    for (const [k, v] of Object.entries(props)) out.properties[k] = normalize(v)
  }
  if (node.items) out.items = normalize(node.items as Record<string, unknown>)
  if (typeof node.description === 'string' && node.description !== '') out.description = node.description
  const required = node.required as string[] | undefined
  if (required && required.length > 0) out.required = [...required]
  if (node.additionalProperties === false) out.additionalProperties = false
  else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.additionalProperties = normalize(node.additionalProperties as Record<string, unknown>)
  }
  return out
}

/** A JSON value's type as jsonschema-go names it: numbers without a fraction are "integer". */
export function jsonType(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (Array.isArray(v)) return 'array'
  return 'object'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Validates a decoded JSON value against s and returns jsonschema-go's error
 * message, or undefined when it's valid. Like jsonschema-go, it reports the
 * first problem: a property's own errors, then unexpected properties, then
 * missing required ones.
 */
export function validate(v: unknown, s: JsonSchema): string | undefined {
  return check(v, s, '')
}

function check(v: unknown, s: JsonSchema, pointer: string): string | undefined {
  const err = checkInner(v, s, pointer)
  return err === undefined ? undefined : `validating ${pointer === '' ? 'root' : pointer}: ${err}`
}

function checkInner(v: unknown, s: JsonSchema, pointer: string): string | undefined {
  if (s.type !== undefined) {
    const got = jsonType(v)
    if (typeof s.type === 'string') {
      if (!(got === s.type || (got === 'integer' && s.type === 'number'))) {
        return `type: ${goValue(v, true)} has type "${got}", want "${s.type}"`
      }
    } else if (!(s.type.includes(got) || (got === 'integer' && s.type.includes('number')))) {
      return `type: ${goValue(v, true)} has type "${got}", want one of "${s.type.join(', ')}"`
    }
  }
  if (Array.isArray(v) && s.items) {
    for (const item of v) {
      const err = check(item, s.items, pointer + '/items')
      if (err !== undefined) return err
    }
  }
  if (isObject(v)) {
    const evaluated = new Set<string>()
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      if (!Object.hasOwn(v, k)) continue
      const err = check(v[k], sub, `${pointer}/properties/${k}`)
      if (err !== undefined) return err
      evaluated.add(k)
    }
    if (s.additionalProperties === false) {
      const extra = Object.keys(v).filter((k) => !evaluated.has(k))
      if (extra.length > 0) return `unexpected additional properties ${goQuoteList(extra)}`
    } else if (s.additionalProperties) {
      for (const k of Object.keys(v)) {
        if (evaluated.has(k)) continue
        const err = check(v[k], s.additionalProperties, pointer + '/additionalProperties')
        if (err !== undefined) return err
      }
    }
    if (s.required) {
      const missing = s.required.filter((k) => !Object.hasOwn(v, k))
      if (missing.length > 0) return `required: missing properties: ${goQuoteList(missing)}`
    }
  }
  return undefined
}

/**
 * fmt's %v of a decoded JSON value: strings bare, numbers as %g, maps with
 * sorted keys. A top-level null is a reflect.Value with nothing in it.
 */
export function goValue(v: unknown, top = false): string {
  if (v === null || v === undefined) return top ? '<invalid reflect.Value>' : '<nil>'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return goFloat(v)
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return '[' + v.map((x) => goValue(x)).join(' ') + ']'
  const o = v as Record<string, unknown>
  return 'map[' + Object.keys(o).sort(compareBytes).map((k) => `${k}:${goValue(o[k])}`).join(' ') + ']'
}

/** fmt's %v of a float64: the shortest representation, in exponent form outside [1e-4, 1e6). */
export function goFloat(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf'
  if (v === 0) return Object.is(v, -0) ? '-0' : '0'
  const [mantissa, e] = v.toExponential().split('e')
  const exp = Number(e)
  if (exp < -4 || exp >= 6) {
    const abs = Math.abs(exp)
    return `${mantissa}e${exp < 0 ? '-' : '+'}${abs < 10 ? '0' : ''}${abs}`
  }
  return String(v)
}

/** strconv.Quote: printable runes as they are, everything else escaped. */
export function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    switch (ch) {
      case '"': out += '\\"'; continue
      case '\\': out += '\\\\'; continue
      case '\x07': out += '\\a'; continue
      case '\b': out += '\\b'; continue
      case '\f': out += '\\f'; continue
      case '\n': out += '\\n'; continue
      case '\r': out += '\\r'; continue
      case '\t': out += '\\t'; continue
      case '\v': out += '\\v'; continue
    }
    if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0')
    else if (c < 0x7f) out += ch
    else if (c >= 0xd800 && c <= 0xdfff) out += '\\ufffd' // a lone surrogate: invalid UTF-8 in Go
    else if (!/[\p{C}\p{Z}]/u.test(ch)) out += ch // unicode.IsPrint
    else if (c > 0xffff) out += '\\U' + c.toString(16).padStart(8, '0')
    else out += '\\u' + c.toString(16).padStart(4, '0')
  }
  return out + '"'
}

/** fmt's %q of a []string. */
export function goQuoteList(list: string[]): string {
  return '[' + list.map(goQuote).join(' ') + ']'
}

/** Compares strings as Go does, by their UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  const n = Math.min(ea.length, eb.length)
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i]
  return ea.length - eb.length
}

/** A copy of a JSON value with every object's keys sorted, as Go marshals a map. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (!isObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort(compareBytes)) {
    if (v[k] !== undefined) out[k] = sortKeys(v[k])
  }
  return out
}

/** Escapes what Go's json.Marshal escapes beyond JSON.stringify: <, >, &, U+2028 and U+2029. */
export function goEscape(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** Go's json.Marshal of a value decoded into interface{}: sorted keys, HTML-safe escaping. */
export function goMarshal(v: unknown): string {
  return goEscape(JSON.stringify(sortKeys(v)))
}

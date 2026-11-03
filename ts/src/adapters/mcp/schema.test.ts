import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as z from 'zod'
import { goFloat, goMarshal, goQuote, goSchema, goValue, validate } from './schema.ts'

test('goSchema shapes zod output like jsonschema-go inference', () => {
  const s = z.strictObject({
    ether: z.string().describe('ether id'),
    to: z.array(z.string()).nullable().describe('who'),
    version: z.int().optional().describe('a version'),
    flag: z.boolean().optional(),
  })
  // Same key order as jsonschema-go: type, properties, items, description, required, additionalProperties.
  assert.equal(JSON.stringify(goSchema(s)), JSON.stringify({
    type: 'object',
    properties: {
      ether: { type: 'string', description: 'ether id' },
      to: { type: ['null', 'array'], items: { type: 'string' }, description: 'who' },
      version: { type: 'integer', description: 'a version' },
      flag: { type: 'boolean' },
    },
    required: ['ether', 'to'],
    additionalProperties: false,
  }))
  assert.deepEqual(goSchema(z.strictObject({})), { type: 'object', additionalProperties: false })
  assert.deepEqual(goSchema(z.strictObject({ m: z.record(z.string(), z.string()).optional() }), 'output'),
    { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } }, additionalProperties: false })
  assert.throws(() => goSchema(z.strictObject({ e: z.enum(['a', 'b']) })), /unsupported/)
})

test('validate reports what jsonschema-go reports', () => {
  const s = goSchema(z.strictObject({
    ether: z.string(),
    n: z.int(),
    to: z.array(z.string()).nullable(),
    on: z.boolean().optional(),
  }))
  assert.equal(validate({ ether: 'e', n: 1, to: null }, s), undefined)
  assert.equal(validate({ ether: 'e', n: 2.0, to: ['a'] }, s), undefined)
  assert.equal(validate({}, s), 'validating root: required: missing properties: ["ether" "n" "to"]')
  assert.equal(validate({ ether: 'e', n: 1, to: [], x: 1, y: 2 }, s), 'validating root: unexpected additional properties ["x" "y"]')
  // Unexpected properties are reported before missing ones.
  assert.equal(validate({ x: 1 }, s), 'validating root: unexpected additional properties ["x"]')
  assert.equal(validate({ ether: 5, n: 1, to: [] }, s),
    'validating root: validating /properties/ether: type: 5 has type "integer", want "string"')
  assert.equal(validate({ ether: 'e', n: 1.5, to: [] }, s),
    'validating root: validating /properties/n: type: 1.5 has type "number", want "integer"')
  assert.equal(validate({ ether: null, n: 1, to: [] }, s),
    'validating root: validating /properties/ether: type: <invalid reflect.Value> has type "null", want "string"')
  assert.equal(validate({ ether: 'e', n: 1, to: 'bob' }, s),
    'validating root: validating /properties/to: type: bob has type "string", want one of "null, array"')
  assert.equal(validate({ ether: 'e', n: 1, to: ['a', 1] }, s),
    'validating root: validating /properties/to: validating /properties/to/items: type: 1 has type "integer", want "string"')
  assert.equal(validate({ ether: 'e', n: 1, to: [], on: 'yes' }, s),
    'validating root: validating /properties/on: type: yes has type "string", want "boolean"')
})

test('Go value formatting', () => {
  assert.equal(goFloat(5), '5')
  assert.equal(goFloat(1.5), '1.5')
  assert.equal(goFloat(1e6), '1e+06')
  assert.equal(goFloat(123456), '123456')
  assert.equal(goFloat(1234567), '1.234567e+06')
  assert.equal(goFloat(0.0001), '0.0001')
  assert.equal(goFloat(0.00001), '1e-05')
  assert.equal(goFloat(1e30), '1e+30')
  assert.equal(goFloat(-0), '-0')
  assert.equal(goFloat(12345678901234567890), '1.2345678901234567e+19')
  assert.equal(goValue([1, 'a', null, { b: 2 }]), '[1 a <nil> map[b:2]]')
  assert.equal(goValue({ z: 1, a: [1, 2], m: null }), 'map[a:[1 2] m:<nil> z:1]')
  assert.equal(goValue(null, true), '<invalid reflect.Value>')
  assert.equal(goQuote('a"b'), '"a\\"b"')
  assert.equal(goQuote('c\\d é \x01 \u2028 tab\t 😀 \u00a0'), '"c\\\\d é \\x01 \\u2028 tab\\t 😀 \\u00a0"')
})

test('goMarshal sorts keys and escapes like encoding/json', () => {
  assert.equal(goMarshal({ b: '<&>\u2028', a: 1e21, c: [{ y: 1, x: 2 }], d: undefined }),
    '{"a":1e+21,"b":"\\u003c\\u0026\\u003e\\u2028","c":[{"x":2,"y":1}]}')
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OTP_JS, STYLE_CSS } from './assets.ts'
import { assetsSource } from './static/embed.ts'

test('assets.ts matches static/ (regenerate with: node src/adapters/web/static/embed.ts)', () => {
  assert.equal(STYLE_CSS, readFileSync(new URL('static/style.css', import.meta.url), 'utf8'))
  assert.equal(OTP_JS, readFileSync(new URL('static/otp.js', import.meta.url), 'utf8'))
  assert.equal(readFileSync(new URL('assets.ts', import.meta.url), 'utf8'), assetsSource())
})

test('static/ matches the Go server, when the Go tree is next to this one', (t) => {
  const go = new URL('../../../../go/adapters/web/static/', import.meta.url)
  let css: string
  try {
    css = readFileSync(new URL('style.css', go), 'utf8')
  } catch {
    t.skip('no go/ tree')
    return
  }
  assert.equal(STYLE_CSS, css)
  assert.equal(OTP_JS, readFileSync(new URL('otp.js', go), 'utf8'))
})

test('the script hash the code page allows', () => {
  const hash = createHash('sha256').update(OTP_JS).digest('base64')
  assert.match(hash, /^[A-Za-z0-9+/]{43}=$/)
})

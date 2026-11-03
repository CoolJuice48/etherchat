// Regenerates ../assets.ts from the files here, so Node and Workers both
// have them without reading files at runtime:
//
//   node src/adapters/web/static/embed.ts
//
// assets.test.ts fails when assets.ts is out of date.

import { readFileSync, writeFileSync } from 'node:fs'

const dir = new URL('.', import.meta.url)

export function assetsSource(): string {
  const css = readFileSync(new URL('style.css', dir), 'utf8')
  const otp = readFileSync(new URL('otp.js', dir), 'utf8')
  return `// Generated from static/ by static/embed.ts; don't edit.

/** static/style.css */
export const STYLE_CSS = ${JSON.stringify(css)}

/** static/otp.js */
export const OTP_JS = ${JSON.stringify(otp)}
`
}

if (import.meta.main) writeFileSync(new URL('../assets.ts', dir), assetsSource())

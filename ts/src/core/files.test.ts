// Port of go/core/files/files_test.go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extensions, FileError, validate, type FileErrorKind } from './files.ts'

test('validate', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const cases: [string, Uint8Array, FileErrorKind | undefined][] = [
    ['notes.md', enc('# hi'), undefined],
    ['NOTES.MD', enc('# hi'), undefined],
    ['plain.txt', enc('hello'), undefined],
    ['empty.md', enc(''), undefined],
    ['report.pdf', enc('%PDF'), 'unsupported_type'],
    ['page.html', enc('<p>'), 'unsupported_type'],
    ['noext', enc('x'), 'unsupported_type'],
    ['bad.md', enc('a\x00b'), 'invalid_content'],
    ['bad.md', new Uint8Array([0xc3, 0x28]), 'invalid_content'],
    ['big.md', enc('x'.repeat((256 << 10) + 1)), 'too_large'],
  ]
  for (const [name, content, want] of cases) {
    if (want === undefined) {
      assert.ok(validate(name, content).mime.startsWith('text/'), name)
      continue
    }
    assert.throws(() => validate(name, content), (err: unknown) => err instanceof FileError && err.kind === want, name)
  }
})

test('messages match Go', () => {
  assert.throws(() => validate('noext', new Uint8Array()), { message: 'file type not allowed: ""' })
  assert.throws(() => validate('x.PDF', new Uint8Array()), { message: 'file type not allowed: ".pdf"' })
  assert.throws(() => validate('x.md', new Uint8Array([0])), { message: 'file content does not match its type: contains NUL bytes' })
  assert.deepEqual(extensions(), ['.md', '.txt'])
})

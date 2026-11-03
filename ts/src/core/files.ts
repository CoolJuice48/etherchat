// Which file types an ether accepts, and content validation (go/core/files).
//
// Phase 1 accepts only the text category. Data, document and image
// categories are added in Phase 7 by extending the registry below.

import { goLower, goQuote } from './ether/gofmt.ts'

/** Groups types that share size limits and handling. */
export type Category = 'text'

export const TEXT: Category = 'text'

/** One accepted file extension. */
export interface Type {
  ext: string
  mime: string
  category: Category
  maxBytes: number
  /** Textual types can be written directly by an agent with write_file. */
  textual: boolean
}

const registry: Record<string, Type> = {
  '.md': { ext: '.md', mime: 'text/markdown; charset=utf-8', category: TEXT, maxBytes: 256 << 10, textual: true },
  '.txt': { ext: '.txt', mime: 'text/plain; charset=utf-8', category: TEXT, maxBytes: 256 << 10, textual: true },
}

/**
 * What went wrong, like Go's sentinel errors: unsupported_type is
 * ErrUnsupportedType, invalid_content is ErrInvalidContent, too_large is
 * ErrTooLarge.
 */
export type FileErrorKind = 'unsupported_type' | 'invalid_content' | 'too_large'

const sentinels: Record<FileErrorKind, string> = {
  unsupported_type: 'file type not allowed',
  invalid_content: 'file content does not match its type',
  too_large: 'file too large for its type',
}

/** A file failed validation. message equals the Go error's text. */
export class FileError extends Error {
  readonly kind: FileErrorKind
  readonly detail: string

  constructor(kind: FileErrorKind, detail: string) {
    super(`${sentinels[kind]}: ${detail}`)
    this.name = 'FileError'
    this.kind = kind
    this.detail = detail
  }
}

/** Go's path.Ext: the suffix from the final dot of the last element, or "". */
function ext(name: string): string {
  for (let i = name.length - 1; i >= 0 && name[i] !== '/'; i--) {
    if (name[i] === '.') return name.slice(i)
  }
  return ''
}

/** Returns the type for a file name, by extension (case-insensitive). */
export function lookup(name: string): Type {
  const e = goLower(ext(name))
  const t = Object.hasOwn(registry, e) ? registry[e] : undefined
  if (!t) throw new FileError('unsupported_type', goQuote(e))
  return t
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Checks that content is acceptable for a file named name and returns its type. */
export function validate(name: string, content: Uint8Array): Type {
  const t = lookup(name)
  if (content.length > t.maxBytes) {
    throw new FileError('too_large', `${content.length} bytes, limit ${t.maxBytes}`)
  }
  if (t.textual) {
    try {
      utf8.decode(content)
    } catch {
      throw new FileError('invalid_content', 'not valid UTF-8')
    }
    if (content.indexOf(0) >= 0) throw new FileError('invalid_content', 'contains NUL bytes')
  }
  return t
}

/** The accepted extensions, sorted, for error messages and tool descriptions. */
export function extensions(): string[] {
  return Object.keys(registry).sort()
}

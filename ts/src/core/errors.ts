// Domain errors. Each has a kind, which callers switch on (the Go code's
// errors.Is), and a message that reads "<sentinel>: <detail>" exactly as
// the Go server's err.Error() does, so agents and pages see the same words.

export type ErrorKind =
  | 'not_found' // missing, or not yours to know about (non-members can't probe for ethers)
  | 'forbidden'
  | 'invalid'
  | 'limit'
  | 'not_allowed' // an address that can't be invited or sign in here
  | 'exists'
  | 'conflict' // a version check failed
  | 'disabled'
  | 'folder' // a file operation named a folder

/** The Go sentinel texts, by kind. */
export const sentinel: Record<ErrorKind, string> = {
  not_found: 'not found',
  forbidden: 'not allowed',
  invalid: 'invalid request',
  limit: 'limit reached',
  not_allowed: 'not allowed',
  exists: 'already exists',
  conflict: 'version conflict',
  disabled: 'account is disabled',
  folder: 'is a folder',
}

export class EtherError extends Error {
  readonly kind: ErrorKind
  /** The text after the sentinel, without it ("" when there is none). */
  readonly detail: string

  constructor(kind: ErrorKind, detail = '') {
    super(detail ? `${sentinel[kind]}: ${detail}` : sentinel[kind])
    this.name = 'EtherError'
    this.kind = kind
    this.detail = detail
  }
}

/** A write's expected_version didn't match. */
export class ConflictError extends EtherError {
  readonly path: string
  readonly current: number // 0 if the file doesn't exist
  readonly currentAuthor: string

  constructor(path: string, current: number, currentAuthor: string) {
    super('conflict')
    this.path = path
    this.current = current
    this.currentAuthor = currentAuthor
    this.message = current === 0
      ? `version conflict on ${path}: file does not exist`
      : `version conflict on ${path}: current version is ${current} by @${currentAuthor}`
  }
}

export function isKind(err: unknown, kind: ErrorKind): err is EtherError {
  if (!(err instanceof EtherError)) return false
  // A folder error is also an invalid request, as in Go (ErrFolder accompanies ErrInvalid).
  return err.kind === kind || (kind === 'invalid' && err.kind === 'folder')
}

/** Shorthand for an invalid-request error, like Go's invalid(format, args...). */
export function invalid(detail: string): EtherError {
  return new EtherError('invalid', detail)
}

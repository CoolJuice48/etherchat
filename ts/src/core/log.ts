// A small structured logger: one JSON object per line, like the Go server's
// slog JSON handler. Never pass tokens, codes, or file contents.

export type Fields = Record<string, unknown>

export interface Logger {
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
}

export function jsonLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  const log = (level: string) => (msg: string, fields: Fields = {}) => {
    const clean: Fields = {}
    for (const [k, v] of Object.entries(fields)) clean[k] = v instanceof Error ? v.message : v
    write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...clean }))
  }
  return { info: log('INFO'), warn: log('WARN'), error: log('ERROR') }
}

export const discardLogger: Logger = { info() {}, warn() {}, error() {} }

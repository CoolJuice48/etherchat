// The parts of the Workers runtime that worker.ts uses. tsconfig.json loads
// only Node's types, and @cloudflare/workers-types declares globals that
// clash with them, so the few Workers types needed are declared here.

declare module 'cloudflare:workers' {
  type SqlValue = ArrayBuffer | string | number | null

  interface SqlStorageCursor {
    next(): IteratorResult<Record<string, SqlValue>, unknown>
    toArray(): Record<string, SqlValue>[]
    readonly rowsRead: number
    readonly rowsWritten: number
  }

  interface DurableObjectStorage {
    readonly sql: { exec(query: string, ...bindings: SqlValue[]): SqlStorageCursor }
    transactionSync<T>(fn: () => T): T
    /** The synchronous key-value API of SQLite-backed objects. */
    readonly kv: { get(key: string): unknown; put(key: string, value: unknown): void; delete(key: string): boolean }
  }

  interface DurableObjectState {
    readonly storage: DurableObjectStorage
    waitUntil(promise: Promise<unknown>): void
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}

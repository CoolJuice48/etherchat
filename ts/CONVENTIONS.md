# Conventions for the TypeScript implementation

The TypeScript implementation mirrors the Go one in `../go`, which is the specification:
same behavior, same messages, same tool names and JSON shapes, same HTML and emails. When
you change one, change the other, and check the Go package and its tests first.

## Where things go

| Go | TypeScript |
|---|---|
| `go/core/ether` | `src/core/ether/` (`index.ts` exports `EtherService` and every type) |
| `go/core/files` | `src/core/files.ts` |
| `go/core/ratelimit` | `src/core/ratelimit.ts` (done) |
| `go/adapters/store` | `src/core/db.ts`, `src/core/migrations.ts` (done); `src/adapters/sqlite/node.ts` (done), `src/adapters/sqlite/durable.ts` |
| `go/adapters/blobs` | `src/core/blobs.ts` (done: `BlobStore`, `SqliteBlobStore`) |
| `go/adapters/mail` | `src/adapters/mail/` (`index.ts`) |
| `go/adapters/auth` | `src/adapters/auth/` (`index.ts` exports `AuthService`) |
| `go/adapters/oauth` | `src/adapters/oauth/` (`index.ts` exports `OAuthServer`) |
| `go/adapters/mcpserver` | `src/adapters/mcp/` (`index.ts`) |
| `go/adapters/web` | `src/adapters/web/` (`index.ts` exports `createWebApp`) |
| `go/run/config` | `src/run/config.ts` |
| `go/run/server` | `src/run/app.ts` |
| `go/run/jobs` | `src/run/jobs.ts` |
| `go/run/backup` | `src/run/backup.ts` (Node only) |
| `go/cmd/etherd` | `src/run/node.ts` (Node CLI and server), `src/run/worker.ts` (Cloudflare) |

## Conventions

- **Names.** Go exported identifiers become lowerCamel methods and fields; types keep
  PascalCase. Initialisms become ordinary words: `AccountID` → `accountId`,
  `EtherID` → `etherId`, `ClientID` → `clientId`, `BaseURL` → `baseUrl`, `MIME` → `mime`,
  `SHA256` → `sha256`, `HTML` → `html`, `TTL` → `ttl`. JSON field names on the wire
  (MCP results, OAuth, metadata) stay exactly as Go's `json:"..."` tags.
- **Context.** Drop `ctx context.Context` parameters.
- **Errors.** Return values lose the `error`; failures throw. A Go
  `fmt.Errorf("%w: detail", ErrX)` becomes `new EtherError('x_kind', 'detail')` from
  `src/core/errors.ts`, so `err.message` equals Go's `err.Error()`. `invalid("...")` →
  `invalid('...')`. `errors.Is(err, ErrX)` → `isKind(err, 'x_kind')`. Kinds:
  `not_found forbidden invalid limit not_allowed exists conflict disabled folder`.
  `*ConflictError` → `ConflictError`.
- **Multiple results** become an object named after Go's results:
  `CreateInvite` → `{ code, invite }`, `ActivityPage` → `{ events, total }`.
  Every other service method returns a single value (or nothing).
- **Time.** `time.Time` → `Date`; the database stores Unix milliseconds. A Go zero time
  or nil pointer → `undefined`. Durations are milliseconds (`Limits.inviteTtlMs`).
- **The core is synchronous.** `SqlDatabase` and `BlobStore` are synchronous; so are
  `EtherService`'s methods. Crypto uses `node:crypto` (`randomBytes`, `createHash`,
  `createHmac`, `timingSafeEqual`), which also works on Cloudflare with the
  `nodejs_compat` flag. Email sending and HTTP are async.
- **Transactions.** Go's `db.Tx(ctx, fn)` and `db.ReadTx` → `db.transaction(() => ...)`.
  The core never awaits inside a transaction.
- **Clock.** `EtherService` and other stateful services take a `now: () => Date` they can
  swap (`setClock`), as the Go code does, so tests control time.
- **Syntax.** Node runs the `.ts` files directly (type stripping), so use erasable syntax
  only: no `enum`, `namespace`, parameter properties, or decorators. Relative imports end
  in `.ts`. Use `import type` for type-only imports.
- **Dependencies.** Node built-ins, `hono`, `zod`, `markdown-it`, `fflate`. Nothing else
  without asking.
- **Tests.** `node:test` and `node:assert/strict`, next to the code as `*.test.ts`. Port the
  Go package's tests. Run one file with `node --test src/path/file.test.ts`, everything
  with `npm test`, and types with `npx tsc --noEmit`.

## Interfaces between the parts

The entry points the parts use from each other:

```ts
// src/core/ether/index.ts
export class EtherService {
  constructor(db: SqlDatabase, blobs: BlobStore, limits: Limits, pepper: Uint8Array)
  setClock(now: () => Date): void
  // ...every Go Service method, renamed as above
}
export interface Actor { accountId: string; clientId: string }

// src/adapters/mail/index.ts
export interface Message { to: string; subject: string; text: string; html: string }
export interface Mailer { send(m: Message): Promise<void> }   // throws MailDisabledError when off
export class MailDisabledError extends Error {}
export function newMailer(provider: '' | 'log' | 'resend', apiKey: string, from: string, log: Logger): Mailer
export function signInCode(to: string, code: string): Message
export function inviteLink(baseUrl: string, code: string): string
export function invite(d: InviteDetails): Message            // InviteDetails.expiresAt shown in d.timeZone
export function requestEmail(n: RequestNews): Message
export function allowRequestEmail(a: AllowRequest): Message
export function previews(baseUrl: string): Record<string, string>

// src/adapters/auth/index.ts
export class AuthService {
  constructor(db: SqlDatabase, ethers: EtherService, mailer: Mailer, pepper: Uint8Array, log: Logger)
  setClock(now: () => Date): void
  requestCode(email: string, ip: string): Promise<void>
  verifyCode(email: string, code: string, ip: string): Account
  newSession(accountId: string): { token: string; expires: Date }
  sessionAccount(token: string): Account | undefined
  endSession(token: string): void
  sweep(): number
}

// src/adapters/oauth/index.ts
export interface TokenInfo { userId: string; clientId: string; scopes: string[]; expiresAt: Date }
export interface MetadataFetcher { fetchJson(url: string): Promise<unknown> }  // CIMD documents
export class OAuthServer {
  constructor(db: SqlDatabase, ethers: EtherService, baseUrl: string, fetcher: MetadataFetcher, log: Logger)
  issuer(): string
  resourceMetadataUrl(): string
  routes(app: Hono): void                     // metadata, /oauth/register, /oauth/token, /oauth/revoke
  verify(token: string): TokenInfo | undefined
  clientName(clientId: string): string
  parseAuthorize(params: URLSearchParams): Promise<AuthorizeRequest>   // throws RequestError
  issueCode(req: AuthorizeRequest, accountId: string): string          // redirect URL
  denyUrl(req: AuthorizeRequest): string
  revokeAccount(accountId: string): void
  sweep(): number
}

// src/adapters/mcp/index.ts
export const SCOPE = 'ether'
export function createMcpHandler(o: {
  ethers: EtherService; mailer: Mailer; baseUrl: string; timeZone: string; version: string; log: Logger
}): (req: Request, token: TokenInfo) => Promise<Response>

// src/adapters/web/index.ts
export interface WebConfig {
  ethers: EtherService; auth: AuthService; oauth?: OAuthServer; mailer: Mailer; baseUrl: string
  log: Logger; mailPreviews: boolean; allowCommand: string; timeZone: string
}
export function createWebApp(c: WebConfig): Hono   // every web route, CSP and cache headers
```

The time zone is an IANA name (`America/New_York` by default). Format times with
`Intl.DateTimeFormat`; `src/adapters/web/time.ts` has the shared helpers.

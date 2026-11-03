# Etherchat in TypeScript

The same Etherchat as [`../go`](../go), running on Node (a SQLite file) or Cloudflare
Workers (one Durable Object). Setup and settings: [docs/typescript.md](../docs/typescript.md).

```sh
npm install
npm run typecheck
npm test
```

| Path | What's there |
|---|---|
| `src/core/` | Ethers, files, the board, requests, permissions, catch-up; the storage interfaces |
| `src/adapters/` | SQLite for Node and Durable Objects, email, sign-in, OAuth, MCP, the website |
| `src/run/` | Configuration, app wiring, jobs, backups, the Node CLI and the Cloudflare Worker |

Code conventions, and how it maps to the Go code: [CONVENTIONS.md](CONVENTIONS.md).

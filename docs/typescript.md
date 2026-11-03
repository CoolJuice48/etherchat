# The TypeScript implementation

`ts/` runs the same Etherchat two ways:

- **Cloudflare Workers:** one Worker in front of one Durable Object, which keeps the whole
  instance (accounts, ethers, files and their contents) in its SQLite storage. There's no
  machine to maintain. See [Cloudflare's free plan](#cloudflares-free-plan) for what's known
  about running it for free.
- **Node:** a single process with a SQLite file, for self-hosting.

You need Node 24 or newer (it runs the `.ts` files directly). Install dependencies once:

```sh
cd ts
npm install
```

## Deploy to Cloudflare

1. Edit `ts/wrangler.toml`:
   - `DOMAIN` and `routes`: your host name (a domain on your Cloudflare account). Or delete
     `routes`, and set `BASE_URL` to your `workers.dev` address instead of `DOMAIN`.
   - `MAIL_FROM`, and `TIMEZONE` if you're not on US Eastern time.
2. Add the secrets. The pepper signs every sign-in and invite code; never change it once
   people use the server.

   ```sh
   npx wrangler login
   openssl rand -base64 32 | npx wrangler secret put PEPPER
   npx wrangler secret put RESEND_API_KEY
   openssl rand -base64 32 | tee admin-token.txt | npx wrangler secret put ADMIN_TOKEN
   ```

3. Deploy:

   ```sh
   npm run worker:deploy
   ```

4. Allow yourself as the first admin, then anyone else:

   ```sh
   curl -X POST -H "Authorization: Bearer $(cat admin-token.txt)" \
     --data-urlencode email=you@example.com -d admin=true https://<your-domain>/_admin/allow
   ```

   `/_admin/disallow`, `/_admin/list-allowed` and `/_admin/list-accounts` work the same way.
   Without `ADMIN_TOKEN` set, `/_admin/` doesn't exist.

Email: create a [Resend](https://resend.com) account, verify your domain there (it gives
you DNS records to add), and make a sending-only API key for `RESEND_API_KEY`.

A cron trigger runs every minute for scheduled posts and request emails, with cleanup
hourly. Etherchat takes no backups of its own on Cloudflare. Cloudflare documents 30 days of
point-in-time recovery for SQLite-backed Durable Objects, but Etherchat has no restore
command for it, and the docs don't say whether it covers the free plan. The website's zip
export gives you a copy of an ether's files and messages.

In Cloudflare, turn off Bot Fight Mode and AI-bot blocking for the host name: they block the
AI companies' servers that connect to `/mcp`.

### Try it locally

Put `BASE_URL=http://localhost:8787`, `MAIL_PROVIDER=log` and the secrets in
`ts/.dev.vars`, then `npm run worker:dev`. Sign-in codes appear in the log.

## Cloudflare's free plan

This deployment hasn't been run on Cloudflare itself yet, only locally in its `workerd`
runtime, so treat this section as a forecast.

The daily limits are generous for a small group: 100,000 requests, 100,000 rows written, 5
million rows read, and 5 GB of storage in total. The per-minute cron trigger uses about
1,440 requests a day.

**CPU time is the open question.** Free-plan Workers get 10 ms of CPU per request, and
Cloudflare's Durable Object docs give both "30 seconds" and "the same limits as any Worker"
without saying which applies on the free plan. Measured on Node, on an Apple M5 Pro
(Cloudflare's machines will differ):

| Request | CPU, warmed up | CPU, first request after a cold start |
|---|---|---|
| MCP tool calls (`write_file`, `post_message`, `pull`…) | 0.1 to 1.3 ms | 30 to 35 ms including setup |
| Website pages | 0.2 to 1.5 ms | 30 to 50 ms including setup |
| Cron tick | 0.06 ms | about 20 ms including setup |
| A 256 KB markdown page | 30 ms | about 110 ms including setup |
| Zip export of about 40 files | 19 ms | about 65 ms including setup |

So if 10 ms applies, everyday requests fit once the object is warm, but very large pages and
zip exports won't, and cold starts may not. Cloudflare says occasional overruns are
tolerated, by a margin it doesn't state, and that consistent ones get terminated. Its docs
don't say whether a Durable Object's first request after eviction counts against the limit.
The paid plan, from $5 a month, allows 30 seconds of CPU per request by default.

Stored values are also limited to 2 MB per row. That's fine for today's 256 KB file limit,
but larger file types would need a different store, such as R2.

## Run on Node

```sh
node src/run/node.ts init --data-dir /var/lib/etherchat --domain chat.example.com
```

`init` writes `.env` (mode 0600) with a fresh pepper. Add `MAIL_PROVIDER=resend` and
`RESEND_API_KEY` to it, then:

```sh
node src/run/node.ts admin allow --email you@example.com --admin
npm start
```

The server listens on `127.0.0.1:8080`. Put it on the internet the same way as the Go
server, with a Cloudflare Tunnel or a reverse proxy ([self-hosting](self-hosting.md)). It
backs itself up daily, keeping 14 snapshots; `node src/run/node.ts help` lists the admin
and backup commands.

## Settings

Every setting is an environment variable (on Node, also read from `.env`; on Workers,
`[vars]` in `wrangler.toml` and secrets). The full table is at the top of
[`ts/src/run/config.ts`](../ts/src/run/config.ts).

| Variable | Default | Meaning |
|---|---|---|
| `DOMAIN` / `BASE_URL` | | Public host, or the full origin |
| `PEPPER` | required | Secret, at least 32 random bytes (base64 or hex) |
| `TIMEZONE` | `America/New_York` | How the website and emails show times |
| `MAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM` | off | `resend`, `log` (testing), or empty |
| `MAX_MEMBERS` and the other limits | 4, … | Same limits as the Go server |
| `DATA_DIR`, `LISTEN`, `BACKUP_DIR`, `BACKUP_KEEP` | | Node only |
| `DEV_TOKEN`, `DEV_ACCOUNT` | off | Node only: a local test token, accepted only from this machine |
| `ADMIN_TOKEN` | off | Workers only: enables `/_admin/` |

## Checks

```sh
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir /tmp/etherchat-bundle
```

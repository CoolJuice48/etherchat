# The TypeScript implementation

`ts/` runs the same Etherchat two ways:

- **Cloudflare Workers:** one Worker in front of one Durable Object, which keeps the whole
  instance (accounts, ethers, files and their contents) in its SQLite storage. Nothing to
  maintain, and a small group fits in Cloudflare's free tier.
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
hourly. Durable Objects keep 30 days of point-in-time recovery, so there are no separate
backups on Cloudflare; the website's zip export works too.

In Cloudflare, turn off Bot Fight Mode and AI-bot blocking for the host name: they block the
AI companies' servers that connect to `/mcp`.

### Try it locally

Put `BASE_URL=http://localhost:8787`, `MAIL_PROVIDER=log` and the secrets in
`ts/.dev.vars`, then `npm run worker:dev`. Sign-in codes appear in the log.

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

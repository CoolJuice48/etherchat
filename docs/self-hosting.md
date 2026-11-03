# Self-hosting the Go server

`etherd` is one binary that keeps everything in a data folder: a SQLite database and the
stored files. It listens only on a loopback address, so it's reachable from the internet
only through something you put in front of it, such as a Cloudflare Tunnel or a reverse
proxy on the same machine.

## Build

You need Go 1.27.3 or newer.

```sh
cd go
go build -o etherd ./cmd/etherd
```

The binary is pure Go (no C compiler needed) and carries its own time zone data.

## Configure

```sh
./etherd init --config etherd.toml --data-dir /var/lib/etherchat --domain chat.example.com
```

`init` writes `etherd.toml` (mode 0600) with a freshly generated secret, the pepper. Keep
the file private: anyone with the pepper can forge invite and sign-in codes for your server.

| Setting | Default | Meaning |
|---|---|---|
| `domain` | | The public host name, used for links, OAuth and the Host check |
| `listen` | `127.0.0.1:8080` | Must be a loopback address |
| `data_dir` | | Database and stored files |
| `timezone` | `America/New_York` | How the website and emails show times (an IANA name) |
| `backup_dir`, `backup_keep` | `<data_dir>/../backups`, 14 | Daily snapshots |
| `[mail] provider` | `""` | `resend`, `log` (local testing: codes go to the log), or empty (sign-in off) |
| `[mail] api_key`, `from` | | Resend API key; sender, default `Etherchat <no-reply@<domain>>` |
| `[limits]` | | Members per ether (4), files, storage, versions, post size, invite lifetime |

Set the email key without putting it in your shell history:

```sh
./etherd set-mail --config etherd.toml --provider resend < resend-key.txt
```

## Allow people

Only allowlisted addresses can sign in or be invited. Mark yourself as an admin: admins get
an email when someone asks to allow an address they tried to invite.

```sh
./etherd admin --config etherd.toml allow --email you@example.com --admin
./etherd admin --config etherd.toml allow --email teammate@example.com
```

## Run

```sh
./etherd serve --config etherd.toml --log-file /var/log/etherchat/etherd.log
```

It answers `GET /healthz` with `ok`. Background jobs (scheduled posts, request emails,
cleanup, the daily backup) run inside the same process.

### Put it on the internet

- **Cloudflare Tunnel** (no open ports): create a tunnel, route your host name to it, and
  point its ingress at `http://127.0.0.1:8080`. The server trusts the `Cf-Connecting-Ip`
  header and refuses the development token for requests that come through Cloudflare.
- **A reverse proxy** such as Caddy on the same machine, proxying your host name to
  `127.0.0.1:8080` with HTTPS.

In Cloudflare, turn off Bot Fight Mode and AI-bot blocking for this host name: they block
the AI companies' servers that connect to your MCP endpoint.

### As a background service

- Linux: [`deploy/systemd/etherd.service`](../deploy/systemd/etherd.service)
- macOS: [`deploy/launchd/org.etherchat.etherd.plist`](../deploy/launchd/org.etherchat.etherd.plist)
- Docker: [`deploy/docker`](../deploy/docker) (the server and `cloudflared` share a network
  namespace, so the tunnel reaches the loopback address)

Run it as its own unprivileged user, with the config and data readable only by that user.

## Day-to-day

```sh
./etherd admin --config etherd.toml list-backups
./etherd admin --config etherd.toml backup
./etherd admin --config etherd.toml audit --limit 50
./etherd admin --config etherd.toml revoke-tokens --email someone@example.com
./etherd admin --config etherd.toml restore --from <snapshot>   # stop the server first
```

`./etherd help` lists every command.

## Trying it locally

1. Use `provider = "log"` so sign-in codes appear in the log.
2. Add a development token, which acts as an allowlisted account and is accepted only from
   this machine:

   ```sh
   ./etherd dev-token --email you@example.com >> etherd.toml
   ```

3. To run the whole OAuth flow locally, also set `base_url = "http://127.0.0.1:8080"` in the
   `[dev]` section.

Then connect Claude Code with the token:

```sh
claude mcp add --transport http etherchat http://127.0.0.1:8080/mcp --header "Authorization: Bearer <token>"
```

## Checks

```sh
go vet ./...
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

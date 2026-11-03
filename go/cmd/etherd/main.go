// Command etherd is the Etherchat server and its admin CLI.
//
//	etherd init      --config PATH --data-dir DIR [--domain DOMAIN]
//	etherd serve     [--config PATH]
//	etherd dev-token --email EMAIL
//	etherd admin     [--config PATH] COMMAND [flags]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	_ "time/tzdata" // the timezone setting works without the OS zone files
)

const (
	defaultConfig = "etherd.toml"
	version       = "0.2.0-dev"
)

func main() {
	// Everything etherd creates (database, WAL files, blobs, backups) is
	// private to the service user.
	syscall.Umask(0o077)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "etherd:", err)
		var u usageError
		if errors.As(err, &u) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

type usageError string

func (e usageError) Error() string { return string(e) }

const usage = `usage:
  etherd init      --config PATH --data-dir DIR [--domain DOMAIN]
  etherd serve     [--config PATH]                 run the server
  etherd dev-token --email EMAIL                   print a local-only test token for etherd.toml
  etherd set-mail  [--config PATH] [--provider resend] [--from ADDR] < api-key
  etherd admin     [--config PATH] COMMAND [flags]

admin commands:
  allow           --email EMAIL [--note TEXT] [--admin]
                                                add an email to the allowlist; --admin also makes it
                                                a server admin, who gets requests to allow addresses
  remove-admin    --email EMAIL                 stop sending that address requests to allow addresses
  disallow        --email EMAIL                 remove it and disable its account
  list-allowed                                  show the allowlist
  list-accounts                                 show accounts
  disable-account --email EMAIL                 disable an account
  create-ether    --owner EMAIL --name NAME     create an ether (creates the owner's account if needed)
  revoke-tokens   --email EMAIL                 sign every app out of an account
  backup                                        take a backup now
  list-backups                                  show backups, newest first
  restore         --from FILE                   replace the database with a backup (stop etherd first)
  audit           [--ether ID] [--limit N]      show the newest audit-log entries
  list-ethers                                   show every ether and its members

The config path defaults to $ETHERD_CONFIG, then ` + defaultConfig + `.`

func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 {
		return usageError(usage)
	}
	switch args[0] {
	case "init":
		return cmdInit(args[1:], out)
	case "serve":
		return cmdServe(ctx, args[1:], out)
	case "dev-token":
		return cmdDevToken(args[1:], out)
	case "set-mail":
		return cmdSetMail(args[1:], os.Stdin, out)
	case "admin":
		return cmdAdmin(ctx, args[1:], out)
	case "help", "-h", "--help":
		fmt.Fprintln(out, usage)
		return nil
	}
	return usageError(fmt.Sprintf("unknown command %q\n%s", args[0], usage))
}

func configPathFlag(fs *flag.FlagSet) *string {
	def := os.Getenv("ETHERD_CONFIG")
	if def == "" {
		def = defaultConfig
	}
	return fs.String("config", def, "path to etherd.toml")
}

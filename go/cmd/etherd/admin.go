package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/backup"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

func cmdInit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	path := configPathFlag(fs)
	dataDir := fs.String("data-dir", "", "absolute path for the database and blobs")
	domain := fs.String("domain", "", "public domain, e.g. etherchat.example")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	if *dataDir == "" {
		return usageError("init: --data-dir is required")
	}
	if err := config.WriteNew(*path, *dataDir, *domain); err != nil {
		return fmt.Errorf("init: %w", err)
	}
	fmt.Fprintf(out, "wrote %s (mode 0600) with a new pepper\n", *path)
	return nil
}

// app is everything an admin command needs.
type app struct {
	cfg *config.Config
	db  *store.DB
	svc *ether.Service
}

func open(ctx context.Context, configPath string) (*app, error) {
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	db, err := store.Open(ctx, cfg.DBPath())
	if err != nil {
		return nil, err
	}
	bs, err := blobs.Open(cfg.BlobDir())
	if err != nil {
		db.Close()
		return nil, err
	}
	return &app{cfg: cfg, db: db, svc: ether.New(db, bs, cfg.Limits, cfg.PepperBytes())}, nil
}

func cmdAdmin(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("admin", flag.ContinueOnError)
	path := configPathFlag(fs)
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	if fs.NArg() == 0 {
		return usageError("admin: missing command\n" + usage)
	}
	cmd, rest := fs.Arg(0), fs.Args()[1:]
	if cmd == "restore" {
		return cmdRestore(ctx, *path, rest, out)
	}

	sub := flag.NewFlagSet(cmd, flag.ContinueOnError)
	email := sub.String("email", "", "email address")
	note := sub.String("note", "", "note to keep with the allowlist entry")
	makeAdmin := sub.Bool("admin", false, "allow: also make the address a server admin, who gets requests to allow new addresses")
	owner := sub.String("owner", "", "owner's email")
	name := sub.String("name", "", "ether name")
	etherID := sub.String("ether", "", "ether id")
	limit := sub.Int("limit", 50, "how many entries")
	if err := sub.Parse(rest); err != nil {
		return usageError(err.Error())
	}
	need := func(v *string, flagName string) error {
		if strings.TrimSpace(*v) == "" {
			return usageError(fmt.Sprintf("admin %s: --%s is required", cmd, flagName))
		}
		return nil
	}

	a, err := open(ctx, *path)
	if err != nil {
		return err
	}
	defer a.db.Close()
	svc := a.svc
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	defer tw.Flush()

	switch cmd {
	case "allow":
		if err := need(email, "email"); err != nil {
			return err
		}
		if err := svc.Allow(ctx, *email, *note); err != nil {
			return err
		}
		fmt.Fprintf(out, "allowed %s\n", strings.ToLower(*email))
		if *makeAdmin {
			if err := svc.SetAdmin(ctx, *email, true); err != nil {
				return err
			}
			fmt.Fprintf(out, "%s is a server admin: requests to allow new addresses go there\n", strings.ToLower(*email))
		}

	case "remove-admin":
		if err := need(email, "email"); err != nil {
			return err
		}
		if err := svc.SetAdmin(ctx, *email, false); err != nil {
			return err
		}
		fmt.Fprintf(out, "%s is no longer a server admin (still allowed)\n", strings.ToLower(*email))

	case "disallow":
		if err := need(email, "email"); err != nil {
			return err
		}
		if err := svc.Disallow(ctx, *email); err != nil {
			return err
		}
		fmt.Fprintf(out, "removed %s from the allowlist and disabled its account\n", strings.ToLower(*email))

	case "list-allowed":
		list, err := svc.ListAllowed(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintln(tw, "EMAIL\tADDED\tADMIN\tNOTE")
		for _, e := range list {
			admin := ""
			if e.Admin {
				admin = "yes"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", e.Email, day(e.AddedAt), admin, e.Note)
		}

	case "list-accounts":
		list, err := svc.ListAccounts(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintln(tw, "HANDLE\tEMAIL\tVERIFIED\tSTATUS\tCREATED")
		for _, acct := range list {
			status := "active"
			if acct.Disabled {
				status = "disabled"
			}
			fmt.Fprintf(tw, "@%s\t%s\t%t\t%s\t%s\n", acct.Handle, acct.Email, acct.Verified, status, day(acct.CreatedAt))
		}

	case "disable-account":
		if err := need(email, "email"); err != nil {
			return err
		}
		if err := svc.DisableAccount(ctx, *email); err != nil {
			return err
		}
		fmt.Fprintf(out, "disabled %s\n", strings.ToLower(*email))

	case "create-ether":
		if err := need(owner, "owner"); err != nil {
			return err
		}
		if err := need(name, "name"); err != nil {
			return err
		}
		acct, err := svc.EnsureAccount(ctx, *owner, false)
		if errors.Is(err, ether.ErrNotAllowlisted) {
			return fmt.Errorf("%s isn't on the allowlist; allow it first with: etherd admin allow --email %s", *owner, *owner)
		}
		if err != nil {
			return err
		}
		e, err := svc.CreateEther(ctx, ether.Actor{AccountID: acct.ID, ClientID: "admin-cli"}, *name)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "created ether %q (id %s), owned by @%s\n", e.Name, e.ID, acct.Handle)

	case "revoke-tokens":
		if err := need(email, "email"); err != nil {
			return err
		}
		acct, err := svc.AccountByEmail(ctx, *email)
		if err != nil {
			return err
		}
		quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
		n, err := oauth.New(a.db, svc, a.cfg.BaseURL(), quiet).RevokeAccount(ctx, acct.ID)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "revoked %d tokens for @%s; their apps must sign in again\n", n, acct.Handle)

	case "backup":
		res, err := backup.Run(ctx, a.db, a.cfg.BlobDir(), a.cfg.BackupPath(), a.cfg.BackupKeep, time.Now())
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "wrote %s (%d blobs, %d newly copied; %d old snapshots removed)\n",
			res.Snapshot.Path, res.Blobs, res.BlobsCopied, res.Pruned)

	case "list-backups":
		snaps, err := backup.List(a.cfg.BackupPath())
		if err != nil {
			return err
		}
		fmt.Fprintln(tw, "TAKEN\tFILE")
		for _, s := range snaps {
			fmt.Fprintf(tw, "%s\t%s\n", day(s.At), s.Path)
		}

	case "audit":
		entries, err := svc.AuditLog(ctx, *etherID, *limit)
		if err != nil {
			return err
		}
		fmt.Fprintln(tw, "WHEN\tWHO\tVIA\tETHER\tACTION\tTARGET")
		for _, e := range entries {
			who := "admin"
			if e.Handle != "" {
				who = "@" + e.Handle
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", e.At.Local().Format("2006-01-02 15:04:05"), who, e.ClientID, e.EtherID, e.Action, e.Target)
		}

	case "list-ethers":
		list, err := svc.ListAllEthers(ctx)
		if err != nil {
			return err
		}
		fmt.Fprintln(tw, "ID\tNAME\tOWNER\tMEMBERS\tCREATED")
		for _, e := range list {
			handles := make([]string, len(e.Members))
			for i, m := range e.Members {
				handles[i] = "@" + m.Handle
			}
			fmt.Fprintf(tw, "%s\t%s\t@%s\t%s\t%s\n", e.ID, e.Name, e.OwnerHandle, strings.Join(handles, " "), day(e.CreatedAt))
		}

	default:
		return usageError(fmt.Sprintf("admin: unknown command %q\n%s", cmd, usage))
	}
	return nil
}

func day(t time.Time) string { return t.Local().Format("2006-01-02 15:04") }

// cmdSetMail sets the mail provider, reading the API key from standard
// input so it never appears in shell history or the process list.
func cmdSetMail(args []string, in io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet("set-mail", flag.ContinueOnError)
	path := configPathFlag(fs)
	provider := fs.String("provider", "resend", "resend, log, or empty to turn sign-in off")
	from := fs.String("from", "", "sender, e.g. 'Etherchat <no-reply@etherchat.example>' (default derives from domain)")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	m := config.Mail{Provider: *provider, From: *from}
	if *provider == "resend" {
		key, err := io.ReadAll(io.LimitReader(in, 4096))
		if err != nil {
			return err
		}
		m.APIKey = strings.TrimSpace(string(key))
		if m.APIKey == "" {
			return usageError("set-mail: pipe the Resend API key on standard input")
		}
	}
	if err := config.SetMail(*path, m); err != nil {
		return err
	}
	fmt.Fprintf(out, "mail provider set to %q in %s\n", *provider, *path)
	return nil
}

// cmdRestore replaces the database with a backup snapshot. etherd must be
// stopped: the current database is moved aside, not merged.
func cmdRestore(ctx context.Context, configPath string, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	from := fs.String("from", "", "snapshot file, from list-backups")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	if *from == "" {
		return usageError("admin restore: --from is required")
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if c, err := net.DialTimeout("tcp", cfg.Listen, time.Second); err == nil {
		c.Close()
		return fmt.Errorf("etherd is running on %s; stop it first (sudo launchctl bootout system/com.etherchat.etherd)", cfg.Listen)
	}
	moved, err := backup.Restore(ctx, *from, cfg.DBPath(), cfg.BlobDir(), cfg.BackupPath(), time.Now())
	if err != nil {
		return err
	}
	if moved != "" {
		fmt.Fprintf(out, "previous database kept at %s\n", moved)
	}
	fmt.Fprintf(out, "restored %s; start etherd again\n", *from)
	return nil
}

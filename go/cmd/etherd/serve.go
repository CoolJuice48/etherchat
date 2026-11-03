package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/run/jobs"
	"github.com/CoolJuice48/etherchat/go/run/logfile"
	"github.com/CoolJuice48/etherchat/go/run/server"
)

func cmdServe(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	path := configPathFlag(fs)
	logPath := fs.String("log-file", "", "write logs here, rotating at 10 MB (default: standard error)")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	a, err := open(ctx, *path)
	if err != nil {
		return err
	}
	defer a.db.Close()

	var logOut io.Writer = os.Stderr
	if *logPath != "" {
		lf, err := logfile.Open(*logPath, 10<<20, 5)
		if err != nil {
			return err
		}
		defer lf.Close()
		logOut = lf
	}
	log := slog.New(slog.NewJSONHandler(logOut, nil))
	if a.cfg.Dev.Enabled() {
		log.Warn("development token enabled for local requests", "account", a.cfg.Dev.Account)
	}
	switch a.cfg.Mail.Provider {
	case "log":
		log.Warn("mail.provider is log: sign-in codes go to this log instead of email; local testing only")
	case "":
		log.Warn("mail.provider is not set: nobody can sign in to the web view")
	}
	mailer := mail.New(a.cfg.Mail.Provider, a.cfg.Mail.APIKey, a.cfg.Sender(), log)
	authSvc := auth.New(a.db, a.svc, mailer, a.cfg.PepperBytes(), log)
	oauthSrv := oauth.New(a.db, a.svc, a.cfg.BaseURL(), log)
	h, err := server.New(ctx, a.cfg, a.svc, authSvc, oauthSrv, mailer, log, version)
	if err != nil {
		return err
	}
	// Claim the port before starting the jobs, so a second etherd (or
	// anything else on the port) stops here instead of running them twice.
	ln, err := net.Listen("tcp", a.cfg.Listen)
	if err != nil {
		log.Error("can't listen", "addr", a.cfg.Listen, "err", err)
		return err
	}
	runner := &jobs.Runner{DB: a.db, Ethers: a.svc, Auth: authSvc, OAuth: oauthSrv, Mailer: mailer, BaseURL: a.cfg.BaseURL(),
		BlobDir: a.cfg.BlobDir(), BackupDir: a.cfg.BackupPath(), BackupKeep: a.cfg.BackupKeep, Log: log}
	go runner.Run(ctx)

	srv := &http.Server{
		Addr:              a.cfg.Listen,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	log.Info("listening", "addr", a.cfg.Listen, "domain", a.cfg.Domain, "version", version)
	fmt.Fprintf(out, "etherd %s listening on http://%s\n", version, a.cfg.Listen)

	select {
	case err := <-errc:
		log.Error("server stopped", "err", err)
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func cmdDevToken(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("dev-token", flag.ContinueOnError)
	email := fs.String("email", "", "allowlisted email the token acts as")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	if *email == "" {
		return usageError("dev-token: --email is required")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	fmt.Fprintf(out, "# Add to etherd.toml. Accepted only from this machine; remove before Phase 4.\n"+
		"[dev]\ntoken = %q\naccount = %q\n", base64.RawURLEncoding.EncodeToString(b), *email)
	return nil
}

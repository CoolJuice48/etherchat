// Package jobs runs etherd's background work: publishing
// scheduled posts, request emails, expiring old rows, purging deleted ethers,
// collecting unused blobs, and the nightly backup.
package jobs

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/backup"
)

// Runner holds what the jobs need.
type Runner struct {
	DB         *store.DB
	Ethers     *ether.Service
	Auth       *auth.Service
	OAuth      *oauth.Server
	Mailer     mail.Mailer
	BaseURL    string // for links in emails
	BlobDir    string
	BackupDir  string
	BackupKeep int
	Log        *slog.Logger
	Now        func() time.Time

	lastHourly time.Time
	lastBackup time.Time // when the newest snapshot was taken (or the last check failed)
}

// Run works until ctx is cancelled: scheduled posts and request emails every
// 30 seconds, maintenance every hour, a backup when the newest is a day old.
func (r *Runner) Run(ctx context.Context) {
	if r.Now == nil {
		r.Now = time.Now
	}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		r.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Tick does whatever is due now.
func (r *Runner) Tick(ctx context.Context) {
	now := r.Now()
	if n, err := r.Ethers.PublishDue(ctx); err != nil {
		r.Log.Error("publishing scheduled posts", "err", err)
	} else if n > 0 {
		r.Log.Info("published scheduled posts", "count", n)
	}
	r.sendRequestEmails(ctx)
	if now.Sub(r.lastHourly) >= time.Hour {
		r.lastHourly = now
		r.maintain(ctx)
	}
	if now.Sub(r.lastBackup) >= 24*time.Hour {
		r.backupIfDue(ctx, now)
	}
}

// sendRequestEmails tells people about requests waiting for them and answers
// to their agents' requests, at most once an hour each (ether.RequestEmailGap).
func (r *Runner) sendRequestEmails(ctx context.Context) {
	due, err := r.Ethers.DueRequestEmails(ctx)
	if err != nil {
		r.Log.Error("finding request emails", "err", err)
		return
	}
	for _, e := range due {
		sent := false
		if e.Send && r.Mailer != nil {
			msg, err := mail.RequestEmail(requestNews(r.BaseURL, e))
			if err == nil {
				err = r.Mailer.Send(ctx, msg)
			}
			switch {
			case errors.Is(err, mail.ErrDisabled):
				// No email provider: nothing to retry.
			case err != nil:
				r.Log.Error("sending request email", "to", e.Email, "err", err)
				continue // try again on the next tick
			default:
				sent = true
			}
		}
		if err := r.Ethers.MarkRequestEmail(ctx, e, sent); err != nil {
			r.Log.Error("marking request email", "err", err)
		}
	}
}

func requestNews(baseURL string, e ether.RequestEmail) mail.RequestNews {
	base := strings.TrimRight(baseURL, "/")
	n := mail.RequestNews{To: e.Email, SettingsLink: base + "/account"}
	ethers := map[string]bool{}
	for _, rq := range e.Asked {
		n.Items = append(n.Items, mail.RequestNewsItem{Who: rq.From, Self: rq.FromID == e.AccountID, EtherName: rq.EtherName,
			Link: base + "/e/" + rq.EtherID})
		ethers[rq.EtherID] = true
	}
	for _, ans := range e.Answers {
		n.Items = append(n.Items, mail.RequestNewsItem{Answered: true, Who: ans.By.Handle, EtherName: ans.Request.EtherName,
			Link: base + "/e/" + ans.Request.EtherID + "/comms#r-" + ans.Request.ID})
		ethers[ans.Request.EtherID] = true
	}
	n.Link = base + "/"
	if len(ethers) == 1 {
		n.Link = n.Items[0].Link
	}
	return n
}

func (r *Runner) maintain(ctx context.Context) {
	steps := []struct {
		name string
		run  func() (int64, error)
	}{
		{"sweep sign-in codes and sessions", func() (int64, error) { return r.Auth.Sweep(ctx) }},
		{"sweep oauth codes and tokens", func() (int64, error) { return r.OAuth.Sweep(ctx) }},
		{"sweep invites", func() (int64, error) { return r.Ethers.SweepInvites(ctx) }},
		{"purge deleted ethers", func() (int64, error) { n, err := r.Ethers.PurgeDeletedEthers(ctx); return int64(n), err }},
		{"collect unused blobs", func() (int64, error) { n, err := r.Ethers.CollectGarbage(ctx, r.BlobDir); return int64(n), err }},
	}
	for _, s := range steps {
		n, err := s.run()
		switch {
		case err != nil:
			r.Log.Error("maintenance failed", "step", s.name, "err", err)
		case n > 0:
			r.Log.Info("maintenance", "step", s.name, "removed", n)
		}
	}
}

// backupIfDue takes a snapshot unless one from the last day already exists.
func (r *Runner) backupIfDue(ctx context.Context, now time.Time) {
	snaps, err := backup.List(r.BackupDir)
	if err != nil {
		r.Log.Error("listing backups", "err", err)
		r.lastBackup = now // retry tomorrow rather than every tick
		return
	}
	if len(snaps) > 0 && now.Sub(snaps[0].At) < 24*time.Hour {
		r.lastBackup = snaps[0].At
		return
	}
	res, err := backup.Run(ctx, r.DB, r.BlobDir, r.BackupDir, r.BackupKeep, now)
	r.lastBackup = now
	if err != nil {
		r.Log.Error("backup failed", "err", err)
		return
	}
	r.Log.Info("backup", "snapshot", res.Snapshot.Path, "blobs", res.Blobs, "copied", res.BlobsCopied, "pruned", res.Pruned)
}

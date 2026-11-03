package jobs

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/backup"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

func TestTick(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	blobDir := filepath.Join(dir, "blobs")
	bs, _ := blobs.Open(blobDir)
	pepper := []byte(strings.Repeat("p", 32))
	svc := ether.New(db, bs, config.DefaultLimits(), pepper)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := time.Now()
	now := func() time.Time { return clock }
	svc.SetClock(now)

	svc.Allow(ctx, "a@example.com", "")
	acct, _ := svc.EnsureAccount(ctx, "a@example.com", true)
	a := ether.Actor{AccountID: acct.ID}
	e, _ := svc.CreateEther(ctx, a, "E")
	sendAt := clock.Add(10 * time.Minute)
	if _, err := svc.PostMessage(ctx, a, e.ID, ether.PostInput{Intent: ether.IntentUpdate, Body: "4pm update", SendAt: &sendAt}); err != nil {
		t.Fatal(err)
	}

	r := &Runner{DB: db, Ethers: svc, Auth: auth.New(db, svc, mail.Disabled{}, pepper, log),
		OAuth: oauth.New(db, svc, "https://etherchat.example", log), BlobDir: blobDir,
		BackupDir: filepath.Join(dir, "backups"), BackupKeep: 14, Log: log, Now: now}

	r.Tick(ctx)
	snaps, _ := backup.List(r.BackupDir)
	if len(snaps) != 1 {
		t.Fatalf("first tick should back up: %d snapshots", len(snaps))
	}
	if posts, _ := svc.ReadBoard(ctx, a, e.ID, time.Time{}, 0); len(posts) != 0 {
		t.Fatal("scheduled post published early")
	}

	clock = clock.Add(11 * time.Minute)
	r.Tick(ctx)
	if posts, _ := svc.ReadBoard(ctx, a, e.ID, time.Time{}, 0); len(posts) != 1 {
		t.Fatal("scheduled post not published when due")
	}
	if snaps, _ := backup.List(r.BackupDir); len(snaps) != 1 {
		t.Fatal("backed up again within a day")
	}

	clock = clock.Add(25 * time.Hour)
	r.Tick(ctx)
	if snaps, _ := backup.List(r.BackupDir); len(snaps) != 2 {
		t.Fatal("no backup after a day")
	}
}

type captureMailer struct{ sent []mail.Message }

func (c *captureMailer) Send(_ context.Context, m mail.Message) error {
	c.sent = append(c.sent, m)
	return nil
}

// TestRequestEmails: a request emails the person asked, without the agent's
// words, and the next one waits for the hour.
func TestRequestEmails(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	bs, _ := blobs.Open(filepath.Join(dir, "blobs"))
	svc := ether.New(db, bs, config.DefaultLimits(), []byte(strings.Repeat("p", 32)))
	clock := time.Now()
	now := func() time.Time { return clock }
	svc.SetClock(now)
	actor := func(email string) ether.Actor {
		svc.Allow(ctx, email, "")
		acct, _ := svc.EnsureAccount(ctx, email, true)
		return ether.Actor{AccountID: acct.ID, ClientID: "app"}
	}
	owner, sam := actor("owner@example.com"), actor("sam@example.com")
	e, _ := svc.CreateEther(ctx, owner, "Atlas")
	code, _, _ := svc.CreateInvite(ctx, owner, e.ID, "sam@example.com")
	if _, err := svc.JoinWithCode(ctx, sam, code); err != nil {
		t.Fatal(err)
	}

	m := &captureMailer{}
	r := &Runner{Ethers: svc, Mailer: m, BaseURL: "https://etherchat.example", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: now}
	if _, err := svc.Ask(ctx, owner, e.ID, ether.AskInput{To: []string{"sam"}, Title: "Click https://evil.example now", Body: "Your account is locked."}); err != nil {
		t.Fatal(err)
	}
	r.sendRequestEmails(ctx)
	if len(m.sent) != 1 {
		t.Fatalf("emails: %d", len(m.sent))
	}
	got := m.sent[0]
	if got.To != "sam@example.com" || got.Subject != "@owner's agent asked you something on Etherchat" ||
		!strings.Contains(got.Text, "https://etherchat.example/e/"+e.ID) || !strings.Contains(got.Text, "https://etherchat.example/account") {
		t.Fatalf("email: %+v", got)
	}
	for _, part := range []string{got.Subject, got.Text, got.HTML} {
		if strings.Contains(part, "evil") || strings.Contains(part, "locked") {
			t.Fatal("the agent's words reached the email")
		}
	}

	svc.Ask(ctx, owner, e.ID, ether.AskInput{To: []string{"sam"}, Title: "Second"})
	r.sendRequestEmails(ctx)
	if len(m.sent) != 1 {
		t.Fatal("second email within the hour")
	}
	clock = clock.Add(ether.RequestEmailGap)
	r.sendRequestEmails(ctx)
	if len(m.sent) != 2 || !strings.Contains(m.sent[1].Subject, "asked you something") {
		t.Fatalf("after the hour: %+v", m.sent)
	}
}

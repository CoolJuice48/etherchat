package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

type site struct {
	dbPath, blobDir string
	db              *store.DB
	svc             *ether.Service
}

func openSite(t *testing.T, dataDir string) *site {
	t.Helper()
	s := &site{dbPath: filepath.Join(dataDir, "etherchat.db"), blobDir: filepath.Join(dataDir, "blobs")}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(context.Background(), s.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	bs, err := blobs.Open(s.blobDir)
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.svc = ether.New(db, bs, config.DefaultLimits(), []byte(strings.Repeat("p", 32)))
	return s
}

// TestRestoreDrill is the Phase 5 restore drill: back up, lose the data
// folder entirely, restore, and check everything is back.
func TestRestoreDrill(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir, backupDir := filepath.Join(root, "data"), filepath.Join(root, "backups")
	s := openSite(t, dataDir)

	if err := s.svc.Allow(ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	acct, _ := s.svc.EnsureAccount(ctx, "alice@example.com", true)
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.svc.CreateEther(ctx, a, "Atlas")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"shared/plan.md": "plan v2", "members/alice/notes.md": "notes"}
	s.svc.WriteFile(ctx, a, e.ID, "shared/plan.md", []byte("plan v1"), 0, nil)
	s.svc.WriteFile(ctx, a, e.ID, "shared/plan.md", []byte("plan v2"), 1, nil)
	s.svc.WriteFile(ctx, a, e.ID, "members/alice/notes.md", []byte("notes"), 0, nil)
	s.svc.PostMessage(ctx, a, e.ID, ether.PostInput{Intent: ether.IntentUpdate, Body: "hello"})

	t0 := time.Date(2026, 10, 9, 3, 0, 0, 0, time.UTC)
	res, err := Run(ctx, s.db, s.blobDir, backupDir, 14, t0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Blobs != 3 || res.BlobsCopied != 3 {
		t.Fatalf("backup: %+v", res)
	}

	// Changes after the backup are lost by a restore; that's expected.
	s.svc.WriteFile(ctx, a, e.ID, "shared/after.md", []byte("written after the backup"), 0, nil)

	// The disk dies.
	s.db.Close()
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(dataDir, 0o700)

	snaps, _ := List(backupDir)
	if len(snaps) != 1 {
		t.Fatalf("snapshots: %v", snaps)
	}
	moved, err := Restore(ctx, snaps[0].Path, filepath.Join(dataDir, "etherchat.db"), filepath.Join(dataDir, "blobs"), backupDir, t0.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if moved != "" {
		t.Fatalf("nothing should have been moved aside, got %s", moved)
	}

	r := openSite(t, dataDir)
	defer r.db.Close()
	for path, content := range want {
		f, err := r.svc.ReadFile(ctx, a, e.ID, path, 0)
		if err != nil || string(f.Content) != content {
			t.Fatalf("after restore, %s = %q, %v", path, f.Content, err)
		}
	}
	if old, err := r.svc.ReadFile(ctx, a, e.ID, "shared/plan.md", 1); err != nil || string(old.Content) != "plan v1" {
		t.Fatalf("history after restore: %v", err)
	}
	if _, err := r.svc.ReadFile(ctx, a, e.ID, "shared/after.md", 0); err == nil {
		t.Fatal("a file written after the backup came back")
	}
	if posts, _ := r.svc.ReadBoard(ctx, a, e.ID, time.Time{}, 0); len(posts) != 1 {
		t.Fatalf("board after restore: %d posts", len(posts))
	}

	// Restoring over an existing database keeps the old one beside it.
	r.db.Close()
	moved, err = Restore(ctx, snaps[0].Path, filepath.Join(dataDir, "etherchat.db"), filepath.Join(dataDir, "blobs"), backupDir, t0.Add(2*time.Hour))
	if err != nil || moved == "" {
		t.Fatalf("second restore: %q %v", moved, err)
	}
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("previous database not kept: %v", err)
	}
}

func TestPruneAndIntegrity(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	backupDir := filepath.Join(root, "backups")
	s := openSite(t, filepath.Join(root, "data"))
	defer s.db.Close()
	// Keep one version per file, so each new write leaves the previous
	// content unreferenced in later snapshots.
	limits := config.DefaultLimits()
	limits.MaxVersionsPerFile = 1
	bs, _ := blobs.Open(s.blobDir)
	svc := ether.New(s.db, bs, limits, []byte(strings.Repeat("p", 32)))
	svc.Allow(ctx, "a@example.com", "")
	acct, _ := svc.EnsureAccount(ctx, "a@example.com", true)
	a := ether.Actor{AccountID: acct.ID}
	e, _ := svc.CreateEther(ctx, a, "E")

	t0 := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)
	for i := 1; i <= 3; i++ {
		if _, err := svc.WriteFile(ctx, a, e.ID, "shared/b.md", []byte(strings.Repeat("x", i)), int64(i-1), nil); err != nil {
			t.Fatal(err)
		}
		if _, err := Run(ctx, s.db, s.blobDir, backupDir, 2, t0.Add(time.Duration(i)*24*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	snaps, _ := List(backupDir)
	if len(snaps) != 2 || !snaps[0].At.After(snaps[1].At) {
		t.Fatalf("kept snapshots: %+v", snaps)
	}
	var copies int
	filepath.WalkDir(filepath.Join(backupDir, "blobs"), func(_ string, d os.DirEntry, _ error) error {
		if d != nil && !d.IsDir() {
			copies++
		}
		return nil
	})
	if copies != 2 {
		t.Fatalf("%d blob copies kept, want 2 (the first content is no longer in any kept snapshot)", copies)
	}

	// A corrupted snapshot is refused.
	bad := filepath.Join(backupDir, "etherchat-20261020-030000.db")
	os.WriteFile(bad, []byte("not a database"), 0o600)
	if _, err := Restore(ctx, bad, filepath.Join(root, "x.db"), filepath.Join(root, "xb"), backupDir, t0); err == nil {
		t.Fatal("restored a corrupt snapshot")
	}
}

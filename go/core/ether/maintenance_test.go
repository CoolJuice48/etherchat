package ether

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/run/config"
)

func TestPurgeAndGarbage(t *testing.T) {
	f, alice, _, _, id := trio(t, func(l *config.Limits) { l.MaxVersionsPerFile = 1 })
	blobDir := f.svc.blobs.Dir()

	f.mustWrite(alice, id, "shared/a.md", "one", 0, nil)
	f.mustWrite(alice, id, "shared/a.md", "two", 1, nil) // "one" is pruned and unreferenced

	// Nothing is deleted before the grace period.
	if n, err := f.svc.CollectGarbage(f.ctx, blobDir); err != nil || n != 0 {
		t.Fatalf("early GC: %d %v", n, err)
	}
	f.advance(8 * 24 * time.Hour)
	if n, err := f.svc.CollectGarbage(f.ctx, blobDir); err != nil || n != 1 {
		t.Fatalf("GC after grace: %d %v", n, err)
	}
	if got, err := f.svc.ReadFile(f.ctx, alice, id, "shared/a.md", 0); err != nil || string(got.Content) != "two" {
		t.Fatalf("live file after GC: %v", err)
	}

	// A blob file with no row (a failed write) goes after a day. File times
	// are real, so this part uses the real clock.
	f.svc.SetClock(time.Now)
	orphan := filepath.Join(blobDir, "ab", "ab"+strings.Repeat("0", 62))
	os.MkdirAll(filepath.Dir(orphan), 0o700)
	os.WriteFile(orphan, []byte("x"), 0o600)
	if n, _ := f.svc.CollectGarbage(f.ctx, blobDir); n != 0 {
		t.Fatal("deleted a fresh orphan")
	}
	old := time.Now().Add(-48 * time.Hour)
	os.Chtimes(orphan, old, old)
	if n, _ := f.svc.CollectGarbage(f.ctx, blobDir); n != 1 {
		t.Fatal("old orphan not deleted")
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan still on disk")
	}
	f.svc.SetClock(func() time.Time { return f.clock })

	// A deleted ether is purged after 30 days, and its blobs become collectable.
	if err := f.svc.DeleteEther(f.ctx, alice, id); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.svc.PurgeDeletedEthers(f.ctx); n != 0 {
		t.Fatal("purged too early")
	}
	f.advance(31 * 24 * time.Hour)
	if n, err := f.svc.PurgeDeletedEthers(f.ctx); err != nil || n != 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	var nodes, posts int
	f.db.Read().QueryRow(`SELECT COUNT(*) FROM nodes WHERE ether_id = ?`, id).Scan(&nodes)
	f.db.Read().QueryRow(`SELECT COUNT(*) FROM ethers WHERE id = ?`, id).Scan(&posts)
	if nodes != 0 || posts != 0 {
		t.Fatalf("purged ether left %d nodes, %d ether rows", nodes, posts)
	}
	f.advance(8 * 24 * time.Hour)
	if n, _ := f.svc.CollectGarbage(f.ctx, blobDir); n != 1 {
		t.Fatalf("blobs of the purged ether weren't collected: %d", n)
	}
}

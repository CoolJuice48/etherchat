package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrationsAreIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "x.db")
	for i := 0; i < 2; i++ {
		db, err := Open(ctx, path)
		if err != nil {
			t.Fatalf("open #%d: %v", i+1, err)
		}
		var n int
		if err := db.Read().QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Fatal("no migrations recorded")
		}
		var mode string
		if err := db.Read().QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
			t.Fatalf("journal_mode = %q, %v", mode, err)
		}
		db.Close()
	}
}

func TestReadPoolIsReadOnly(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Read().ExecContext(ctx, `INSERT INTO allowed_emails (email, added_at) VALUES ('a@b.c', 0)`); err == nil {
		t.Fatal("write through the read pool succeeded")
	}
}

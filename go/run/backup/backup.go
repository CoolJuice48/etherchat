// Package backup makes and restores backups: a consistent
// SQLite snapshot plus every blob the snapshot references.
//
// Layout under the backup directory:
//
//	etherchat-20261009-031500.db   snapshots, newest kept
//	blobs/ab/<sha256>              blob copies (hard links when possible)
//
// Blobs never change, so each is copied once and shared by all snapshots.
package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/CoolJuice48/etherchat/go/adapters/store"
)

const (
	prefix = "etherchat-"
	suffix = ".db"
	stamp  = "20060102-150405"
)

// Snapshot is one backup file.
type Snapshot struct {
	Path string
	At   time.Time
}

// Result describes a finished backup.
type Result struct {
	Snapshot    Snapshot
	Blobs       int // blobs the snapshot references
	BlobsCopied int // of those, copied by this run
	Pruned      int // old snapshots removed
}

// Run snapshots db into dir, copies the blobs it references from blobDir,
// and keeps only the newest keep snapshots.
func Run(ctx context.Context, db *store.DB, blobDir, dir string, keep int, now time.Time) (*Result, error) {
	if err := os.MkdirAll(filepath.Join(dir, "blobs"), 0o700); err != nil {
		return nil, err
	}
	final := filepath.Join(dir, prefix+now.UTC().Format(stamp)+suffix)
	if _, err := os.Stat(final); err == nil {
		return nil, fmt.Errorf("%s already exists", final)
	}
	tmp := final + ".tmp"
	os.Remove(tmp)
	if err := db.VacuumInto(ctx, tmp); err != nil {
		return nil, fmt.Errorf("snapshot: %w", err)
	}
	shas, err := check(ctx, tmp)
	if err != nil {
		os.Remove(tmp)
		return nil, err
	}
	res := &Result{Snapshot: Snapshot{Path: final, At: now.UTC().Truncate(time.Second)}, Blobs: len(shas)}
	for _, sha := range shas {
		copied, err := place(filepath.Join(blobDir, sha[:2], sha), filepath.Join(dir, "blobs", sha[:2], sha))
		if err != nil {
			os.Remove(tmp)
			return nil, fmt.Errorf("backing up blob %s: %w", sha, err)
		}
		if copied {
			res.BlobsCopied++
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		return nil, err
	}
	res.Pruned, err = prune(ctx, dir, keep)
	return res, err
}

// check verifies a snapshot's integrity and returns the blobs it references.
func check(ctx context.Context, path string) ([]string, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var result string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&result); err != nil {
		return nil, err
	}
	if result != "ok" {
		return nil, fmt.Errorf("integrity check of %s failed: %s", filepath.Base(path), result)
	}
	rows, err := db.QueryContext(ctx, `SELECT DISTINCT blob_sha256 FROM versions WHERE blob_sha256 IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var shas []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			return nil, err
		}
		if len(sha) != 64 || strings.ContainsAny(sha, "/.") {
			return nil, fmt.Errorf("unexpected blob name %q", sha)
		}
		shas = append(shas, sha)
	}
	return shas, rows.Err()
}

// place puts src at dst unless dst exists, preferring a hard link (blobs
// never change) and falling back to a copy. It reports whether it wrote.
func place(src, dst string) (bool, error) {
	if _, err := os.Stat(dst); err == nil {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return false, err
	}
	if err := os.Link(src, dst); err == nil {
		return true, nil
	}
	in, err := os.Open(src)
	if err != nil {
		return false, err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return false, err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return false, err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(tmp)
		return false, err
	}
	if err := out.Close(); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, dst)
}

// List returns snapshots in dir, newest first.
func List(dir string) ([]Snapshot, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Snapshot
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		at, err := time.Parse(stamp, strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix))
		if err != nil {
			continue
		}
		out = append(out, Snapshot{Path: filepath.Join(dir, name), At: at})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out, nil
}

// prune keeps the newest keep snapshots and removes blob copies that no
// remaining snapshot references.
func prune(ctx context.Context, dir string, keep int) (int, error) {
	snaps, err := List(dir)
	if err != nil {
		return 0, err
	}
	removed := 0
	if len(snaps) > keep {
		for _, s := range snaps[keep:] {
			if err := os.Remove(s.Path); err != nil {
				return removed, err
			}
			removed++
		}
		snaps = snaps[:keep]
	}
	needed := map[string]bool{}
	for _, s := range snaps {
		shas, err := check(ctx, s.Path)
		if err != nil {
			return removed, err
		}
		for _, sha := range shas {
			needed[sha] = true
		}
	}
	err = filepath.WalkDir(filepath.Join(dir, "blobs"), func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if !needed[d.Name()] {
			return os.Remove(path)
		}
		return nil
	})
	return removed, err
}

// Restore replaces the database at dbPath with snapshot and restores any
// blobs it references that are missing from blobDir. The server must be
// stopped. The current database is kept beside it, renamed with a
// .before-restore suffix.
func Restore(ctx context.Context, snapshot, dbPath, blobDir, backupDir string, now time.Time) (moved string, err error) {
	shas, err := check(ctx, snapshot)
	if err != nil {
		return "", err
	}
	var missing []string
	for _, sha := range shas {
		live := filepath.Join(blobDir, sha[:2], sha)
		if _, err := os.Stat(live); err == nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(backupDir, "blobs", sha[:2], sha)); err != nil {
			missing = append(missing, sha)
		}
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("%d blobs the snapshot needs are in neither the data nor the backup folder (first: %s)", len(missing), missing[0])
	}
	for _, sha := range shas {
		if _, err := place(filepath.Join(backupDir, "blobs", sha[:2], sha), filepath.Join(blobDir, sha[:2], sha)); err != nil {
			return "", err
		}
	}

	moved = dbPath + ".before-restore-" + now.UTC().Format(stamp)
	if _, err := os.Stat(dbPath); err == nil {
		if err := os.Rename(dbPath, moved); err != nil {
			return "", err
		}
		for _, ext := range []string{"-wal", "-shm"} {
			if _, err := os.Stat(dbPath + ext); err == nil {
				if err := os.Rename(dbPath+ext, moved+ext); err != nil {
					return "", err
				}
			}
		}
	} else {
		moved = ""
	}
	// A copy, not a link: the restored database will change, the backup mustn't.
	if err := copyFile(snapshot, dbPath); err != nil {
		return moved, err
	}
	return moved, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

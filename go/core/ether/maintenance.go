package ether

import (
	"context"
	"database/sql"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Retention periods.
const (
	sweepAfter       = 7 * 24 * time.Hour  // expired invites, then their rows go
	blobGrace        = 7 * 24 * time.Hour  // unreferenced blobs wait this long before deletion
	orphanGrace      = 24 * time.Hour      // blob files with no row (a failed write) wait this long
	purgeEthersAfter = 30 * 24 * time.Hour // deleted ethers are purged after this
)

// SweepInvites deletes invite rows that expired, were used, or were revoked
// more than a week ago.
func (s *Service) SweepInvites(ctx context.Context) (int64, error) {
	var n int64
	cutoff := s.now().Add(-sweepAfter).UnixMilli()
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`DELETE FROM invites WHERE expires_at < ? OR consumed_at < ? OR revoked_at < ?`, cutoff, cutoff, cutoff)
		if err != nil {
			return err
		}
		n, _ = res.RowsAffected()
		return nil
	})
	return n, err
}

// PurgeDeletedEthers permanently removes ethers deleted more than 30 days
// ago: files, history, posts, membership, invites and catch-up cursors. The
// audit log keeps its entries. Their blobs become unreferenced and are
// collected later.
func (s *Service) PurgeDeletedEthers(ctx context.Context) (int, error) {
	cutoff := s.now().Add(-purgeEthersAfter).UnixMilli()
	purged := 0
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id FROM ethers WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range ids {
			shas, err := etherBlobs(ctx, tx, id)
			if err != nil {
				return err
			}
			for _, q := range []string{
				`DELETE FROM versions WHERE node_id IN (SELECT id FROM nodes WHERE ether_id = ?)`,
				`DELETE FROM nodes WHERE ether_id = ?`,
				`DELETE FROM board_posts WHERE ether_id = ?`,
				`DELETE FROM request_recipients WHERE request_id IN (SELECT id FROM requests WHERE ether_id = ?)`,
				`DELETE FROM requests WHERE ether_id = ?`,
				`DELETE FROM memberships WHERE ether_id = ?`,
				`DELETE FROM invites WHERE ether_id = ?`,
				`DELETE FROM pull_cursors WHERE ether_id = ?`,
				`DELETE FROM ethers WHERE id = ?`,
			} {
				if _, err := tx.ExecContext(ctx, q, id); err != nil {
					return err
				}
			}
			if err := s.markUnreferenced(ctx, tx, shas); err != nil {
				return err
			}
			if err := s.audit(ctx, tx, Actor{}, id, "ether.purge", "", nil); err != nil {
				return err
			}
			purged++
		}
		return nil
	})
	return purged, err
}

func etherBlobs(ctx context.Context, tx *sql.Tx, etherID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT DISTINCT v.blob_sha256 FROM versions v JOIN nodes n ON n.id = v.node_id
		 WHERE n.ether_id = ? AND v.blob_sha256 IS NOT NULL`, etherID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			return nil, err
		}
		out = append(out, sha)
	}
	return out, rows.Err()
}

// CollectGarbage deletes blobs nothing has referenced for a week, blob files
// that never got a database row (a write that failed after storing its
// content), and stale temporary files. It holds blobMu so a concurrent
// write can't reuse a blob between the check and the delete.
func (s *Service) CollectGarbage(ctx context.Context, blobDir string) (int, error) {
	s.blobMu.Lock()
	defer s.blobMu.Unlock()

	now := s.now()
	var doomed []string
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT sha256 FROM blobs WHERE unreferenced_since IS NOT NULL AND unreferenced_since < ?
			 AND NOT EXISTS (SELECT 1 FROM versions WHERE blob_sha256 = blobs.sha256)`,
			now.Add(-blobGrace).UnixMilli())
		if err != nil {
			return err
		}
		for rows.Next() {
			var sha string
			if err := rows.Scan(&sha); err != nil {
				rows.Close()
				return err
			}
			doomed = append(doomed, sha)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, sha := range doomed {
			if _, err := tx.ExecContext(ctx, `DELETE FROM blobs WHERE sha256 = ?`, sha); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, sha := range doomed {
		if err := s.blobs.Delete(sha); err != nil {
			return deleted, err
		}
		deleted++
	}

	// Files without rows, and abandoned temp files.
	known := map[string]bool{}
	rows, err := s.db.Read().QueryContext(ctx, `SELECT sha256 FROM blobs`)
	if err != nil {
		return deleted, err
	}
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return deleted, err
		}
		known[sha] = true
	}
	rows.Close()
	cutoff := now.Add(-orphanGrace)
	err = filepath.WalkDir(blobDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, err := d.Info()
		if err != nil || info.ModTime().After(cutoff) {
			return err
		}
		inTmp := filepath.Base(filepath.Dir(path)) == "tmp"
		if inTmp || !known[d.Name()] {
			if err := os.Remove(path); err != nil {
				return err
			}
			deleted++
		}
		return nil
	})
	return deleted, err
}

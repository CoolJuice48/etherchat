package ether

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/core/files"
)

// FileInfo describes a file or folder.
type FileInfo struct {
	Path      string
	Kind      string // "file" or "folder"
	Version   int64  // head version; 0 for folders
	Size      int64
	MIME      string
	Mode      Mode
	Author    string // handle of the member who created it
	UpdatedBy string // handle of the member who wrote the head version
	ClientID  string // client that wrote the head version
	UpdatedAt time.Time
}

// File is one version of a file with its content.
type File struct {
	FileInfo
	SHA256  string
	Content []byte
}

// VersionInfo is one entry in a file's history.
type VersionInfo struct {
	Version   int64
	Size      int64
	SHA256    string
	Author    string
	ClientID  string
	CreatedAt time.Time
	Tombstone bool
}

// WriteResult reports a successful write.
type WriteResult struct {
	Path    string
	Version int64
	Size    int64
	SHA256  string
	Created bool
}

type node struct {
	id           string
	kind         string
	path         string
	authorID     string
	authorHandle string
	mode         Mode
	system       bool
	head         int64
}

func getNode(ctx context.Context, q queryer, etherID, path string) (*node, error) {
	var n node
	err := q.QueryRowContext(ctx,
		`SELECT n.id, n.kind, n.path, n.author_id, a.handle, n.mode, n.system, n.head_version
		 FROM nodes n JOIN accounts a ON a.id = n.author_id
		 WHERE n.ether_id = ? AND n.path = ? AND n.deleted_at IS NULL`, etherID, path).
		Scan(&n.id, &n.kind, &n.path, &n.authorID, &n.authorHandle, &n.mode, &n.system, &n.head)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// target builds the permission target for path p (and node n, if it exists).
func target(p Path, m membership, actorID string, n *node) Target {
	t := Target{Zone: p.Zone(), IsOwner: m.isOwner(actorID)}
	if t.Zone == ZoneWorkspace {
		t.OwnWorkspace = strings.EqualFold(p.WorkspaceHandle(), m.handle)
	}
	if n != nil {
		t.IsAuthor = n.authorID == actorID
		t.Mode = n.mode
	}
	return t
}

func forbidden(op Op, p Path) error {
	return fmt.Errorf("%w: you can't %s %s", ErrForbidden, op, p)
}

// mkdirAll creates p and any missing ancestors as folders and returns p's node.
// Children take their parent's stored spelling, so "members/Alex/x" lands under
// an existing "members/alex". Callers check permissions first.
func (s *Service) mkdirAll(ctx context.Context, tx *sql.Tx, etherID string, p Path, authorID string) (*node, error) {
	var parent *node
	for i := 1; i <= p.Depth(); i++ {
		sub := Path{segs: p.segs[:i]}
		n, err := getNode(ctx, tx, etherID, sub.String())
		if err == nil {
			if n.kind != "folder" {
				return nil, invalid("%s is a file, not a folder", n.path)
			}
			parent = n
			continue
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		path, parentID := sub.Name(), any(nil)
		if parent != nil {
			path, parentID = parent.path+"/"+sub.Name(), parent.id
		}
		id, now := newID(), s.nowMs()
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO nodes (id, ether_id, parent_id, kind, name, path, author_id, system, created_at, updated_at)
			 VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, ?, ?)`,
			id, etherID, parentID, sub.Name(), path, authorID, sub.IsRoot(), now, now); err != nil {
			return nil, err
		}
		parent = &node{id: id, kind: "folder", path: path, authorID: authorID, mode: ModeAuthorOnly, system: sub.IsRoot()}
	}
	return parent, nil
}

func (s *Service) checkEntryLimit(ctx context.Context, tx *sql.Tx, etherID string, adding int) error {
	var n int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM nodes WHERE ether_id = ? AND deleted_at IS NULL`, etherID).Scan(&n); err != nil {
		return err
	}
	if n+adding > s.limits.MaxFilesPerEther {
		return fmt.Errorf("%w: an ether can hold at most %d files and folders", ErrLimit, s.limits.MaxFilesPerEther)
	}
	return nil
}

func (s *Service) checkStorageLimit(ctx context.Context, tx *sql.Tx, etherID string, adding int64) error {
	var used int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(v.size), 0) FROM versions v JOIN nodes n ON n.id = v.node_id WHERE n.ether_id = ?`,
		etherID).Scan(&used); err != nil {
		return err
	}
	if used+adding > s.limits.MaxEtherBytes {
		return fmt.Errorf("%w: the ether's storage limit (%d bytes, including history) is full", ErrLimit, s.limits.MaxEtherBytes)
	}
	return nil
}

func fileTypeError(err error) error {
	switch {
	case errors.Is(err, files.ErrTooLarge):
		return fmt.Errorf("%w: %v", ErrLimit, err)
	case errors.Is(err, files.ErrUnsupportedType):
		return invalid("%v; allowed: %s", err, strings.Join(files.Extensions(), " "))
	default:
		return invalid("%v", err)
	}
}

// WriteFile creates or replaces a text file. expected is the version the
// caller last read: 0 to create a new file, otherwise the current head.
// A stale expected returns a *ConflictError. mode applies only in shared/.
func (s *Service) WriteFile(ctx context.Context, a Actor, etherID, rawPath string, content []byte, expected int64, mode *Mode) (*WriteResult, error) {
	p, err := ParsePath(rawPath)
	if err != nil {
		return nil, err
	}
	if p.IsRoot() {
		return nil, invalid("%s is a system folder", p)
	}
	if mode != nil && p.Zone() != ZoneShared {
		return nil, invalid("mode applies only to files in shared/")
	}
	ft, err := files.Validate(p.Name(), content)
	if err != nil {
		return nil, fileTypeError(err)
	}
	// The blob goes in first. If the transaction below fails, the blob is left
	// without a database row; the garbage-collection job removes such files.
	s.blobMu.RLock()
	defer s.blobMu.RUnlock()
	sum, size, err := s.blobs.Put(bytes.NewReader(content), ft.MaxBytes)
	if errors.Is(err, blobs.ErrTooLarge) {
		return nil, fmt.Errorf("%w: file too large", ErrLimit)
	}
	if err != nil {
		return nil, err
	}

	var res *WriteResult
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		n, err := getNode(ctx, tx, etherID, p.String())
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if n != nil && n.kind == "folder" {
			return invalid("%s is a folder", n.path)
		}

		var current int64
		var currentAuthor string
		if n != nil {
			current = n.head
			currentAuthor, err = headAuthor(ctx, tx, n.id, n.head)
			if err != nil {
				return err
			}
		}
		if expected != current {
			return &ConflictError{Path: p.String(), Current: current, CurrentAuthor: currentAuthor}
		}

		t := target(p, m, a.AccountID, n)
		if n == nil {
			if !Allowed(OpCreate, t) {
				return forbidden(OpCreate, p)
			}
		} else {
			if !Allowed(OpEdit, t) {
				return forbidden(OpEdit, p)
			}
			if mode != nil && *mode != n.mode && !Allowed(OpChangeMode, t) {
				return forbidden(OpChangeMode, p)
			}
		}

		if n == nil {
			if err := s.checkEntryLimit(ctx, tx, etherID, 1); err != nil {
				return err
			}
		}
		if err := s.checkStorageLimit(ctx, tx, etherID, size); err != nil {
			return err
		}

		now := s.nowMs()
		created := n == nil
		var nodeID, storedPath string
		var version int64
		if created {
			parentPath, _ := p.Parent()
			parent, err := s.mkdirAll(ctx, tx, etherID, parentPath, a.AccountID)
			if err != nil {
				return err
			}
			newMode := ModeAuthorOnly
			if mode != nil {
				newMode = *mode
			}
			nodeID, storedPath, version = newID(), parent.path+"/"+p.Name(), 1
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO nodes (id, ether_id, parent_id, kind, name, path, author_id, mode, head_version, created_at, updated_at)
				 VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 1, ?, ?)`,
				nodeID, etherID, parent.id, p.Name(), storedPath, a.AccountID, newMode, now, now); err != nil {
				return err
			}
		} else {
			nodeID, storedPath, version = n.id, n.path, n.head+1
			newMode := n.mode
			if mode != nil {
				newMode = *mode
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE nodes SET head_version = ?, mode = ?, updated_at = ? WHERE id = ?`,
				version, newMode, now, nodeID); err != nil {
				return err
			}
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(sha256) DO UPDATE SET unreferenced_since = NULL`,
			sum, size, ft.MIME, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO versions (node_id, version, blob_sha256, mime_type, size, author_id, client_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			nodeID, version, sum, ft.MIME, size, a.AccountID, a.ClientID, now); err != nil {
			return err
		}
		if err := s.pruneVersions(ctx, tx, nodeID, version); err != nil {
			return err
		}
		res = &WriteResult{Path: storedPath, Version: version, Size: size, SHA256: sum, Created: created}
		return s.audit(ctx, tx, a, etherID, "file.write", storedPath, map[string]any{"version": version, "size": size})
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

func headAuthor(ctx context.Context, q queryer, nodeID string, version int64) (string, error) {
	var h string
	err := q.QueryRowContext(ctx,
		`SELECT a.handle FROM versions v JOIN accounts a ON a.id = v.author_id WHERE v.node_id = ? AND v.version = ?`,
		nodeID, version).Scan(&h)
	return h, err
}

// pruneVersions keeps the newest MaxVersionsPerFile versions of a node and
// marks blobs that nothing references anymore.
func (s *Service) pruneVersions(ctx context.Context, tx *sql.Tx, nodeID string, head int64) error {
	cutoff := head - int64(s.limits.MaxVersionsPerFile)
	if cutoff < 1 {
		return nil
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT DISTINCT blob_sha256 FROM versions WHERE node_id = ? AND version <= ? AND blob_sha256 IS NOT NULL`,
		nodeID, cutoff)
	if err != nil {
		return err
	}
	var shas []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return err
		}
		shas = append(shas, sha)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM versions WHERE node_id = ? AND version <= ?`, nodeID, cutoff); err != nil {
		return err
	}
	return s.markUnreferenced(ctx, tx, shas)
}

// markUnreferenced stamps blobs that no version points to, so the
// garbage-collection job can delete them after a grace period.
func (s *Service) markUnreferenced(ctx context.Context, tx *sql.Tx, shas []string) error {
	for _, sha := range shas {
		if _, err := tx.ExecContext(ctx,
			`UPDATE blobs SET unreferenced_since = ? WHERE sha256 = ? AND unreferenced_since IS NULL
			 AND NOT EXISTS (SELECT 1 FROM versions WHERE blob_sha256 = ?)`,
			s.nowMs(), sha, sha); err != nil {
			return err
		}
	}
	return nil
}

// ReadFile returns a file's head version, or a specific version if version > 0.
func (s *Service) ReadFile(ctx context.Context, a Actor, etherID, rawPath string, version int64) (*File, error) {
	p, err := ParsePath(rawPath)
	if err != nil {
		return nil, err
	}
	var f File
	err = s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		n, err := getNode(ctx, tx, etherID, p.String())
		if err != nil {
			return err
		}
		if n.kind == "folder" {
			return fmt.Errorf("%w: %s %w; list it instead", ErrInvalid, n.path, ErrFolder)
		}
		if version <= 0 {
			version = n.head
		}
		var sha sql.NullString
		var created int64
		var tomb bool
		err = tx.QueryRowContext(ctx,
			`SELECT v.blob_sha256, v.mime_type, v.size, a.handle, v.client_id, v.created_at, v.is_tombstone
			 FROM versions v JOIN accounts a ON a.id = v.author_id WHERE v.node_id = ? AND v.version = ?`,
			n.id, version).Scan(&sha, &f.MIME, &f.Size, &f.UpdatedBy, &f.ClientID, &created, &tomb)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: %s has no version %d (it may have been pruned)", ErrNotFound, n.path, version)
		}
		if err != nil {
			return err
		}
		if tomb || !sha.Valid {
			return ErrNotFound
		}
		f.Path, f.Kind, f.Version, f.Mode, f.Author = n.path, "file", version, n.mode, n.authorHandle
		f.UpdatedAt, f.SHA256 = msTime(created), sha.String
		return nil
	})
	if err != nil {
		return nil, err
	}
	f.Content, err = s.blobs.ReadAll(f.SHA256)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", f.Path, err)
	}
	return &f, nil
}

// ListFiles lists a folder's children, or everything under it when recursive.
// An empty prefix lists the top level (members/ and shared/).
func (s *Service) ListFiles(ctx context.Context, a Actor, etherID, prefix string, recursive bool) ([]FileInfo, error) {
	var out []FileInfo
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		where, args := "n.parent_id IS NULL", []any{}
		switch {
		case prefix == "" && recursive:
			where = "1 = 1"
		case prefix != "":
			p, err := ParsePath(prefix)
			if err != nil {
				return err
			}
			dir, err := getNode(ctx, tx, etherID, p.String())
			if err != nil {
				return err
			}
			if dir.kind != "folder" {
				return invalid("%s is a file; read it instead", dir.path)
			}
			if recursive {
				where, args = "lower(substr(n.path, 1, ?)) = lower(?)", []any{len(dir.path) + 1, dir.path + "/"}
			} else {
				where, args = "n.parent_id = ?", []any{dir.id}
			}
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT n.path, n.kind, n.head_version, n.mode, a.handle, n.updated_at,
			        COALESCE(v.size, 0), COALESCE(v.mime_type, ''), COALESCE(va.handle, ''), COALESCE(v.client_id, '')
			 FROM nodes n
			 JOIN accounts a ON a.id = n.author_id
			 LEFT JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			 LEFT JOIN accounts va ON va.id = v.author_id
			 WHERE n.ether_id = ? AND n.deleted_at IS NULL AND `+where+`
			 ORDER BY n.path`,
			append([]any{etherID}, args...)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var fi FileInfo
			var updated int64
			if err := rows.Scan(&fi.Path, &fi.Kind, &fi.Version, &fi.Mode, &fi.Author, &updated,
				&fi.Size, &fi.MIME, &fi.UpdatedBy, &fi.ClientID); err != nil {
				return err
			}
			fi.UpdatedAt = msTime(updated)
			out = append(out, fi)
		}
		return rows.Err()
	})
	return out, err
}

// FileHistory returns a file's versions, newest first.
func (s *Service) FileHistory(ctx context.Context, a Actor, etherID, rawPath string) ([]VersionInfo, error) {
	p, err := ParsePath(rawPath)
	if err != nil {
		return nil, err
	}
	var out []VersionInfo
	err = s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		n, err := getNode(ctx, tx, etherID, p.String())
		if err != nil {
			return err
		}
		if n.kind == "folder" {
			return fmt.Errorf("%w: %s %w", ErrInvalid, n.path, ErrFolder)
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT v.version, v.size, COALESCE(v.blob_sha256, ''), a.handle, v.client_id, v.created_at, v.is_tombstone
			 FROM versions v JOIN accounts a ON a.id = v.author_id
			 WHERE v.node_id = ? ORDER BY v.version DESC`, n.id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var vi VersionInfo
			var created int64
			if err := rows.Scan(&vi.Version, &vi.Size, &vi.SHA256, &vi.Author, &vi.ClientID, &created, &vi.Tombstone); err != nil {
				return err
			}
			vi.CreatedAt = msTime(created)
			out = append(out, vi)
		}
		return rows.Err()
	})
	return out, err
}

// DeleteFile deletes a file (recording a tombstone version) or an empty folder.
// For files, expected must equal the current head version.
func (s *Service) DeleteFile(ctx context.Context, a Actor, etherID, rawPath string, expected int64) error {
	p, err := ParsePath(rawPath)
	if err != nil {
		return err
	}
	if p.IsRoot() {
		return fmt.Errorf("%w: %s is a system folder", ErrForbidden, p)
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		n, err := getNode(ctx, tx, etherID, p.String())
		if err != nil {
			return err
		}
		if n.kind == "file" && expected != n.head {
			author, err := headAuthor(ctx, tx, n.id, n.head)
			if err != nil {
				return err
			}
			return &ConflictError{Path: n.path, Current: n.head, CurrentAuthor: author}
		}
		if !Allowed(OpDelete, target(p, m, a.AccountID, n)) {
			return forbidden(OpDelete, p)
		}
		now := s.nowMs()
		head := n.head
		if n.kind == "folder" {
			var children int
			if err := tx.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM nodes WHERE parent_id = ? AND deleted_at IS NULL`, n.id).Scan(&children); err != nil {
				return err
			}
			if children > 0 {
				return invalid("%s isn't empty", n.path)
			}
		} else {
			head++
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO versions (node_id, version, author_id, client_id, created_at, is_tombstone)
				 VALUES (?, ?, ?, ?, ?, 1)`, n.id, head, a.AccountID, a.ClientID, now); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE nodes SET deleted_at = ?, updated_at = ?, head_version = ? WHERE id = ?`,
			now, now, head, n.id); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, n.kind+".delete", n.path, nil)
	})
}

// CreateFolder creates a folder and any missing parents. Creating a folder
// that already exists succeeds.
func (s *Service) CreateFolder(ctx context.Context, a Actor, etherID, rawPath string) (string, error) {
	p, err := ParsePath(rawPath)
	if err != nil {
		return "", err
	}
	var stored string
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if n, err := getNode(ctx, tx, etherID, p.String()); err == nil {
			if n.kind != "folder" {
				return invalid("%s is a file", n.path)
			}
			stored = n.path
			return nil
		} else if !errors.Is(err, ErrNotFound) {
			return err
		}
		if !Allowed(OpCreate, target(p, m, a.AccountID, nil)) {
			return forbidden(OpCreate, p)
		}
		if err := s.checkEntryLimit(ctx, tx, etherID, p.Depth()); err != nil {
			return err
		}
		n, err := s.mkdirAll(ctx, tx, etherID, p, a.AccountID)
		if err != nil {
			return err
		}
		stored = n.path
		return s.audit(ctx, tx, a, etherID, "folder.create", n.path, nil)
	})
	return stored, err
}

// SetMode changes a shared file's write mode.
func (s *Service) SetMode(ctx context.Context, a Actor, etherID, rawPath string, mode Mode) error {
	p, err := ParsePath(rawPath)
	if err != nil {
		return err
	}
	if p.Zone() != ZoneShared || p.IsRoot() {
		return invalid("mode applies only to files in shared/")
	}
	if _, err := ParseMode(string(mode)); err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		n, err := getNode(ctx, tx, etherID, p.String())
		if err != nil {
			return err
		}
		if n.kind != "file" {
			return invalid("mode applies only to files")
		}
		if !Allowed(OpChangeMode, target(p, m, a.AccountID, n)) {
			return forbidden(OpChangeMode, p)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE nodes SET mode = ?, updated_at = ? WHERE id = ?`, mode, s.nowMs(), n.id); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "file.mode", n.path, map[string]any{"mode": mode})
	})
}

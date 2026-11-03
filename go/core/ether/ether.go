// Package ether is Etherchat's domain logic: accounts and the allowlist,
// ethers and membership, invites, files and versions, the board, and every
// permission check. The MCP and web layers call this package and nothing else
// decides who may do what.
package ether

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

// Errors returned by the service. Callers compare with errors.Is.
var (
	// ErrNotFound covers missing things and things the caller may not know
	// exist, so non-members can't probe for ethers.
	ErrNotFound       = errors.New("not found")
	ErrForbidden      = errors.New("not allowed")
	ErrInvalid        = errors.New("invalid request")
	ErrLimit          = errors.New("limit reached")
	ErrNotAllowlisted = errors.New("not allowed")
	ErrExists         = errors.New("already exists")
	ErrConflict       = errors.New("version conflict")
	ErrDisabled       = errors.New("account is disabled")
	// ErrFolder accompanies ErrInvalid when a file operation names a folder.
	ErrFolder = errors.New("is a folder")
)

// ConflictError reports the current state of a file when expected_version is stale.
type ConflictError struct {
	Path          string
	Current       int64 // 0 if the file doesn't exist
	CurrentAuthor string
}

func (e *ConflictError) Error() string {
	if e.Current == 0 {
		return fmt.Sprintf("version conflict on %s: file does not exist", e.Path)
	}
	return fmt.Sprintf("version conflict on %s: current version is %d by @%s", e.Path, e.Current, e.CurrentAuthor)
}

// Is makes errors.Is(err, ErrConflict) true for a *ConflictError.
func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Actor is the account (and, when known, the MCP client) making a request.
type Actor struct {
	AccountID string
	ClientID  string
}

// Service is the domain layer over the database and blob store.
type Service struct {
	db    *store.DB
	blobs *blobs.Store
	// blobMu keeps garbage collection from deleting a blob between a write
	// storing it and the write's transaction referencing it.
	blobMu sync.RWMutex
	limits config.Limits
	pepper []byte
	now    func() time.Time
}

// New returns a service. pepper keys the HMACs of invite and login codes.
func New(db *store.DB, bs *blobs.Store, limits config.Limits, pepper []byte) *Service {
	return &Service{db: db, blobs: bs, limits: limits, pepper: pepper, now: time.Now}
}

// SetClock replaces the clock, for tests.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

func (s *Service) nowMs() int64 { return s.now().UnixMilli() }

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// newID returns a random 80-bit ID as 16 lowercase base32 characters.
func newID() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return strings.ToLower(idEncoding.EncodeToString(b))
}

func msTime(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func nullMsTime(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := msTime(v.Int64)
	return &t
}

// MaxMembers is how many people one ether can have, counting pending invites.
func (s *Service) MaxMembers() int { return s.limits.MaxMembers }

// audit records an action. detail must not contain file contents or secrets.
func (s *Service) audit(ctx context.Context, tx *sql.Tx, a Actor, etherID, action, target string, detail map[string]any) error {
	d := "{}"
	if len(detail) > 0 {
		b, err := json.Marshal(detail)
		if err != nil {
			return err
		}
		d = string(b)
	}
	var acct, eth any
	if a.AccountID != "" {
		acct = a.AccountID
	}
	if etherID != "" {
		eth = etherID
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO audit_log (at, account_id, client_id, ether_id, action, target, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		s.nowMs(), acct, a.ClientID, eth, action, target, d)
	return err
}

// requireActiveAccount checks the actor's account exists and is enabled, and
// returns its handle.
func requireActiveAccount(ctx context.Context, q queryer, accountID string) (handle string, err error) {
	var disabled sql.NullInt64
	err = q.QueryRowContext(ctx,
		`SELECT handle, disabled_at FROM accounts WHERE id = ?`, accountID).Scan(&handle, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if disabled.Valid {
		return "", ErrDisabled
	}
	return handle, nil
}

// queryer is satisfied by *sql.DB and *sql.Tx.
type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

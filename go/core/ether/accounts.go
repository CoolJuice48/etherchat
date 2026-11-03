package ether

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
)

// Account is a person, identified by an allowlisted, verified email.
type Account struct {
	ID        string
	Email     string
	Handle    string
	Verified  bool
	CreatedAt time.Time
	Disabled  bool
	// RequestEmails: email this person when an agent asks them something or
	// their agent's request is answered.
	RequestEmails bool
}

// AllowedEmail is one allowlist entry.
type AllowedEmail struct {
	Email   string
	AddedAt time.Time
	Note    string
	Admin   bool // gets requests to allow new addresses
}

// NormalizeEmail returns the bare, lowercased address or ErrInvalid.
func NormalizeEmail(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	addr, err := mail.ParseAddress(raw)
	if err != nil || addr.Address != raw || len(raw) > 254 {
		return "", invalid("%q is not a plain email address", raw)
	}
	return strings.ToLower(addr.Address), nil
}

// Allow adds an email to the allowlist. Adding an existing entry updates its note.
func (s *Service) Allow(ctx context.Context, email, note string) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		already, err := isAllowed(ctx, tx, email)
		if err != nil {
			return err
		}
		if already {
			_, err := tx.ExecContext(ctx, `UPDATE allowed_emails SET note = ? WHERE email = ?`, note, email)
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO allowed_emails (email, added_at, note) VALUES (?, ?, ?)`,
			email, s.nowMs(), note); err != nil {
			return err
		}
		// Re-adding an address re-enables the account Disallow disabled.
		if _, err := tx.ExecContext(ctx,
			`UPDATE accounts SET disabled_at = NULL WHERE email = ?`, email); err != nil {
			return err
		}
		return s.audit(ctx, tx, Actor{}, "", "allowlist.add", email, nil)
	})
}

// Disallow removes an email from the allowlist and disables its account.
// Later phases also revoke the account's OAuth tokens and web sessions here.
func (s *Service) Disallow(ctx context.Context, email string) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM allowed_emails WHERE email = ?`, email)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE accounts SET disabled_at = ? WHERE email = ? AND disabled_at IS NULL`,
			s.nowMs(), email); err != nil {
			return err
		}
		return s.audit(ctx, tx, Actor{}, "", "allowlist.remove", email, nil)
	})
}

// SetAdmin marks an allowlisted address as a server admin, or unmarks it.
// Admins get the requests people send to allow new addresses.
func (s *Service) SetAdmin(ctx context.Context, email string, admin bool) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE allowed_emails SET admin = ? WHERE email = ?`, admin, email)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return fmt.Errorf("%w: %s isn't allowed yet; allow it first", ErrNotFound, email)
		}
		action := "admin.add"
		if !admin {
			action = "admin.remove"
		}
		return s.audit(ctx, tx, Actor{}, "", action, email, nil)
	})
}

// AdminEmails returns the server admins' addresses.
func (s *Service) AdminEmails(ctx context.Context) ([]string, error) {
	rows, err := s.db.Read().QueryContext(ctx, `SELECT email FROM allowed_emails WHERE admin = 1 ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecordAllowRequest notes in the audit log that a member asked the admins
// to allow addresses.
func (s *Service) RecordAllowRequest(ctx context.Context, a Actor, emails []string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		return s.audit(ctx, tx, a, "", "allowlist.request", strings.Join(emails, " "), nil)
	})
}

// ListAllowed returns the allowlist, sorted by email.
func (s *Service) ListAllowed(ctx context.Context) ([]AllowedEmail, error) {
	rows, err := s.db.Read().QueryContext(ctx,
		`SELECT email, added_at, note, admin FROM allowed_emails ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AllowedEmail
	for rows.Next() {
		var a AllowedEmail
		var at int64
		if err := rows.Scan(&a.Email, &at, &a.Note, &a.Admin); err != nil {
			return nil, err
		}
		a.AddedAt = msTime(at)
		out = append(out, a)
	}
	return out, rows.Err()
}

// IsAllowed reports whether email is on the allowlist.
func (s *Service) IsAllowed(ctx context.Context, email string) (bool, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return false, err
	}
	return isAllowed(ctx, s.db.Read(), email)
}

func isAllowed(ctx context.Context, q queryer, email string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM allowed_emails WHERE email = ?`, email).Scan(&n)
	return n > 0, err
}

// EnsureAccount returns the account for an allowlisted email, creating it on
// first use. verified marks the email as proven (a successful sign-in code).
func (s *Service) EnsureAccount(ctx context.Context, email string, verified bool) (*Account, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return nil, err
	}
	var acct *Account
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		ok, err := isAllowed(ctx, tx, email)
		if err != nil {
			return err
		}
		if !ok {
			return ErrNotAllowlisted
		}
		existing, err := accountWhere(ctx, tx, "email = ?", email)
		if err == nil {
			if existing.Disabled {
				return ErrDisabled
			}
			if verified && !existing.Verified {
				if _, err := tx.ExecContext(ctx,
					`UPDATE accounts SET email_verified_at = ? WHERE id = ?`, s.nowMs(), existing.ID); err != nil {
					return err
				}
				existing.Verified = true
			}
			acct = existing
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		handle, err := uniqueHandle(ctx, tx, deriveHandle(email))
		if err != nil {
			return err
		}
		now := s.nowMs()
		var verifiedAt any
		if verified {
			verifiedAt = now
		}
		id := newID()
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO accounts (id, email, handle, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)`,
			id, email, handle, verifiedAt, now); err != nil {
			return err
		}
		acct = &Account{ID: id, Email: email, Handle: handle, Verified: verified, CreatedAt: msTime(now)}
		return s.audit(ctx, tx, Actor{AccountID: id}, "", "account.create", handle, nil)
	})
	return acct, err
}

// AccountByID returns an account.
func (s *Service) AccountByID(ctx context.Context, id string) (*Account, error) {
	return accountWhere(ctx, s.db.Read(), "id = ?", id)
}

// AccountByEmail returns the account for an email.
func (s *Service) AccountByEmail(ctx context.Context, email string) (*Account, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return nil, err
	}
	return accountWhere(ctx, s.db.Read(), "email = ?", email)
}

func accountWhere(ctx context.Context, q queryer, where string, arg any) (*Account, error) {
	var a Account
	var verified, disabled sql.NullInt64
	var created int64
	err := q.QueryRowContext(ctx,
		`SELECT id, email, handle, email_verified_at, created_at, disabled_at, request_emails FROM accounts WHERE `+where, arg).
		Scan(&a.ID, &a.Email, &a.Handle, &verified, &created, &disabled, &a.RequestEmails)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.Verified, a.Disabled, a.CreatedAt = verified.Valid, disabled.Valid, msTime(created)
	return &a, nil
}

// ListAccounts returns every account, sorted by handle.
func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := s.db.Read().QueryContext(ctx,
		`SELECT id, email, handle, email_verified_at, created_at, disabled_at FROM accounts ORDER BY handle`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		var verified, disabled sql.NullInt64
		var created int64
		if err := rows.Scan(&a.ID, &a.Email, &a.Handle, &verified, &created, &disabled); err != nil {
			return nil, err
		}
		a.Verified, a.Disabled, a.CreatedAt = verified.Valid, disabled.Valid, msTime(created)
		out = append(out, a)
	}
	return out, rows.Err()
}

// DisableAccount disables an account without touching the allowlist.
func (s *Service) DisableAccount(ctx context.Context, email string) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE accounts SET disabled_at = ? WHERE email = ? AND disabled_at IS NULL`, s.nowMs(), email)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.audit(ctx, tx, Actor{}, "", "account.disable", email, nil)
	})
}

// SetHandle changes an account's handle. Handles name workspace folders, so
// they can only change before the account has joined any ether.
func (s *Service) SetHandle(ctx context.Context, accountID, handle string) error {
	if !ValidHandle(handle) {
		return invalid("handle must be 1-32 characters of a-z, 0-9, '.', '_' or '-', starting and ending with a letter or digit")
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireActiveAccount(ctx, tx, accountID); err != nil {
			return err
		}
		var joined int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM memberships WHERE account_id = ?`, accountID).Scan(&joined); err != nil {
			return err
		}
		if joined > 0 {
			return fmt.Errorf("%w: handle can only change before joining an ether", ErrForbidden)
		}
		var taken int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM accounts WHERE handle = ? AND id != ?`, handle, accountID).Scan(&taken); err != nil {
			return err
		}
		if taken > 0 {
			return fmt.Errorf("%w: handle @%s is taken", ErrExists, handle)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE accounts SET handle = ? WHERE id = ?`, handle, accountID); err != nil {
			return err
		}
		return s.audit(ctx, tx, Actor{AccountID: accountID}, "", "account.handle", handle, nil)
	})
}

const maxHandleLen = 32

// ValidHandle reports whether h can be a handle: lowercase letters, digits,
// '.', '_' and '-', starting and ending with a letter or digit.
func ValidHandle(h string) bool {
	if len(h) == 0 || len(h) > maxHandleLen {
		return false
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		alnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if (i == 0 || i == len(h)-1) && !alnum {
			return false
		}
		if !alnum && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// deriveHandle turns an email's local part into a valid handle.
func deriveHandle(email string) string {
	local := strings.ToLower(email[:strings.LastIndexByte(email, '@')])
	var b strings.Builder
	for i := 0; i < len(local); i++ {
		c := local[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-':
			b.WriteByte(c)
		default:
			b.WriteByte('-')
		}
	}
	h := strings.Trim(b.String(), "._-")
	if len(h) > maxHandleLen-4 { // leave room for a numeric suffix
		h = strings.TrimRight(h[:maxHandleLen-4], "._-")
	}
	if h == "" {
		h = "user"
	}
	return h
}

// uniqueHandle returns base, or base2, base3, ... if base is taken.
func uniqueHandle(ctx context.Context, tx *sql.Tx, base string) (string, error) {
	for n := 1; ; n++ {
		h := base
		if n > 1 {
			h = fmt.Sprintf("%s%d", base, n)
		}
		var taken int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE handle = ?`, h).Scan(&taken); err != nil {
			return "", err
		}
		if taken == 0 {
			return h, nil
		}
	}
}

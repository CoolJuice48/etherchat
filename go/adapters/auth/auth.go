// Package auth handles email sign-in codes and browser sessions.
// Accounts and the allowlist live in package ether.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/core/ratelimit"
)

// Sign-in limits.
const (
	CodeTTL              = 10 * time.Minute
	MaxAttempts          = 5
	CodesPerEmailPerHour = 5
	RequestsPerIPPerHour = 20
	VerifiesPerIPPerHour = 60
	SessionTTL           = 30 * 24 * time.Hour
)

var (
	ErrRateLimited = errors.New("too many attempts; wait a while and try again")
	ErrBadCode     = errors.New("that code didn't work; check it, or request a new one")
	ErrNoSession   = errors.New("not signed in")
)

// Service issues and checks sign-in codes and sessions.
type Service struct {
	db       *store.DB
	accounts *ether.Service
	mail     mail.Mailer
	pepper   []byte
	log      *slog.Logger
	now      func() time.Time
	limiter  *ratelimit.Window
}

// New returns the auth service.
func New(db *store.DB, accounts *ether.Service, m mail.Mailer, pepper []byte, log *slog.Logger) *Service {
	s := &Service{db: db, accounts: accounts, mail: m, pepper: pepper, log: log, now: time.Now}
	s.limiter = ratelimit.New(func() time.Time { return s.now() })
	return s
}

// SetClock replaces the clock, for tests.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

func (s *Service) codeHMAC(email, code string) string {
	m := hmac.New(sha256.New, s.pepper)
	m.Write([]byte("login:" + email + ":" + code))
	return hex.EncodeToString(m.Sum(nil))
}

func newCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

// RequestCode emails a sign-in code if email is allowlisted and enabled.
// It returns nil whether or not a code was sent, so callers can't learn who
// has an account; only a malformed address or the per-IP limit is reported.
func (s *Service) RequestCode(ctx context.Context, rawEmail, ip string) error {
	email, err := ether.NormalizeEmail(rawEmail)
	if err != nil {
		return err
	}
	if !s.limiter.Allow("request:"+ip, RequestsPerIPPerHour, time.Hour) {
		return ErrRateLimited
	}
	if ok, err := s.accounts.IsAllowed(ctx, email); err != nil || !ok {
		return err
	}
	if acct, err := s.accounts.AccountByEmail(ctx, email); err == nil && acct.Disabled {
		return nil
	}

	code := newCode()
	sent := false
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		var recent int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM login_codes WHERE email = ? AND created_at > ?`,
			email, now.Add(-time.Hour).UnixMilli()).Scan(&recent); err != nil {
			return err
		}
		if recent >= CodesPerEmailPerHour {
			s.log.Warn("sign-in code limit reached", "email", email)
			return nil
		}
		// Only the newest code works: supersede any earlier ones.
		if _, err := tx.ExecContext(ctx,
			`UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL`,
			now.UnixMilli(), email); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO login_codes (id, email, code_hmac, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
			randomID(), email, s.codeHMAC(email, code), now.UnixMilli(), now.Add(CodeTTL).UnixMilli()); err != nil {
			return err
		}
		sent = true
		return nil
	})
	if err != nil || !sent {
		return err
	}
	msg, err := mail.SignInCode(email, code)
	if err == nil {
		err = s.mail.Send(ctx, msg)
	}
	if err != nil {
		s.log.Error("sending sign-in code failed", "email", email, "err", err)
	}
	return nil
}

// VerifyCode checks a code and returns the (possibly new) verified account.
// Wrong guesses count against the code; after MaxAttempts it stops working.
func (s *Service) VerifyCode(ctx context.Context, rawEmail, rawCode, ip string) (*ether.Account, error) {
	email, err := ether.NormalizeEmail(rawEmail)
	if err != nil {
		return nil, ErrBadCode
	}
	code := strings.ReplaceAll(strings.TrimSpace(rawCode), " ", "")
	if len(code) != 6 || strings.Trim(code, "0123456789") != "" {
		return nil, ErrBadCode
	}
	if !s.limiter.Allow("verify:"+ip, VerifiesPerIPPerHour, time.Hour) {
		return nil, ErrRateLimited
	}

	ok := false
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		now := s.now().UnixMilli()
		var id, want string
		var attempts int
		err := tx.QueryRowContext(ctx,
			`SELECT id, code_hmac, attempts FROM login_codes
			 WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
			 ORDER BY created_at DESC LIMIT 1`, email, now).Scan(&id, &want, &attempts)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare([]byte(s.codeHMAC(email, code)), []byte(want)) == 1 {
			ok = true
			_, err = tx.ExecContext(ctx, `UPDATE login_codes SET consumed_at = ? WHERE id = ?`, now, id)
			return err
		}
		attempts++
		var consumed any
		if attempts >= MaxAttempts {
			consumed = now
		}
		_, err = tx.ExecContext(ctx,
			`UPDATE login_codes SET attempts = ?, consumed_at = ? WHERE id = ?`, attempts, consumed, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrBadCode
	}
	acct, err := s.accounts.EnsureAccount(ctx, email, true)
	if errors.Is(err, ether.ErrNotAllowlisted) || errors.Is(err, ether.ErrDisabled) {
		return nil, ErrBadCode
	}
	return acct, err
}

const sessionPrefix = "eth_ws_"

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewSession starts a browser session and returns its token.
func (s *Service) NewSession(ctx context.Context, accountID string) (string, time.Time, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token := sessionPrefix + base64.RawURLEncoding.EncodeToString(b)
	now := s.now()
	expires := now.Add(SessionTTL)
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO web_sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
			hashToken(token), accountID, now.UnixMilli(), expires.UnixMilli(), now.UnixMilli())
		return err
	})
	return token, expires, err
}

// SessionAccount returns the account for a live session token.
// Sessions of disabled accounts stop working immediately.
func (s *Service) SessionAccount(ctx context.Context, token string) (*ether.Account, error) {
	if !strings.HasPrefix(token, sessionPrefix) {
		return nil, ErrNoSession
	}
	h := hashToken(token)
	now := s.now().UnixMilli()
	var accountID string
	var lastSeen int64
	err := s.db.Read().QueryRowContext(ctx,
		`SELECT account_id, last_seen_at FROM web_sessions WHERE token_hash = ? AND expires_at > ?`,
		h, now).Scan(&accountID, &lastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, err
	}
	acct, err := s.accounts.AccountByID(ctx, accountID)
	if err != nil || acct.Disabled {
		return nil, ErrNoSession
	}
	if now-lastSeen > time.Minute.Milliseconds() {
		_ = s.db.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?`, now, h)
			return err
		})
	}
	return acct, nil
}

// EndSession signs a session out.
func (s *Service) EndSession(ctx context.Context, token string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM web_sessions WHERE token_hash = ?`, hashToken(token))
		return err
	})
}

func randomID() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Sweep deletes sign-in codes and sessions that expired more than a week ago.
func (s *Service) Sweep(ctx context.Context) (int64, error) {
	var n int64
	cutoff := s.now().Add(-7 * 24 * time.Hour).UnixMilli()
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{
			`DELETE FROM login_codes WHERE expires_at < ?`,
			`DELETE FROM web_sessions WHERE expires_at < ?`,
		} {
			res, err := tx.ExecContext(ctx, q, cutoff)
			if err != nil {
				return err
			}
			k, _ := res.RowsAffected()
			n += k
		}
		return nil
	})
	return n, err
}

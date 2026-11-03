package ether

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Invite is a pending invitation for one email address to join one ether.
type Invite struct {
	ID              string
	EtherID         string
	EtherName       string
	Email           string
	InvitedByHandle string
	InvitedByEmail  string
	CreatedAt       time.Time
	ExpiresAt       time.Time
}

var errBadInvite = fmt.Errorf("%w: invite code is invalid, expired, already used, or for a different email", ErrNotFound)

// newInviteCode returns 80 random bits as XXXX-XXXX-XXXX-XXXX in base32.
func newInviteCode() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	s := idEncoding.EncodeToString(b)
	return s[0:4] + "-" + s[4:8] + "-" + s[8:12] + "-" + s[12:16]
}

// normalizeCode uppercases, drops separators, and maps digits people confuse
// with base32 letters (0→O, 1→I, 8→B).
func normalizeCode(code string) string {
	r := strings.NewReplacer("-", "", " ", "", "0", "O", "1", "I", "8", "B")
	return r.Replace(strings.ToUpper(strings.TrimSpace(code)))
}

func (s *Service) codeHMAC(kind, code string) string {
	m := hmac.New(sha256.New, s.pepper)
	m.Write([]byte(kind + ":" + code))
	return hex.EncodeToString(m.Sum(nil))
}

// CreateInvite invites an allowlisted email to an ether and returns the code.
// Any member can invite. A new invite for the same email replaces the old one.
// Members plus pending invites can't exceed the member limit.
func (s *Service) CreateInvite(ctx context.Context, a Actor, etherID, email string) (string, *Invite, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return "", nil, err
	}
	code := newInviteCode()
	var inv *Invite
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		ok, err := isAllowed(ctx, tx, email)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("%w: %s can't be invited here. Ask the server's admin", ErrNotAllowlisted, email)
		}
		var already int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM memberships m JOIN accounts a ON a.id = m.account_id
			 WHERE m.ether_id = ? AND a.email = ? AND m.left_at IS NULL`, etherID, email).Scan(&already); err != nil {
			return err
		}
		if already > 0 {
			return fmt.Errorf("%w: %s is already a member", ErrExists, email)
		}
		now := s.nowMs()
		if _, err := tx.ExecContext(ctx,
			`UPDATE invites SET revoked_at = ?
			 WHERE ether_id = ? AND email = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
			now, etherID, email); err != nil {
			return err
		}
		members, err := activeMemberCount(ctx, tx, etherID)
		if err != nil {
			return err
		}
		var pending int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM invites WHERE ether_id = ? AND consumed_at IS NULL
			 AND revoked_at IS NULL AND expires_at > ?`, etherID, now).Scan(&pending); err != nil {
			return err
		}
		if members+pending >= s.limits.MaxMembers {
			return fmt.Errorf("%w: an ether can have at most %d members, counting pending invites", ErrLimit, s.limits.MaxMembers)
		}
		e, err := loadEther(ctx, tx, etherID)
		if err != nil {
			return err
		}
		inviter, err := accountWhere(ctx, tx, "id = ?", a.AccountID)
		if err != nil {
			return err
		}
		inv = &Invite{
			ID: newID(), EtherID: etherID, EtherName: e.Name, Email: email,
			InvitedByHandle: m.handle, InvitedByEmail: inviter.Email,
			CreatedAt: msTime(now), ExpiresAt: msTime(now + s.limits.InviteTTL.Milliseconds()),
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO invites (id, ether_id, created_by, email, code_hmac, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			inv.ID, etherID, a.AccountID, email, s.codeHMAC("invite", normalizeCode(code)),
			now, inv.ExpiresAt.UnixMilli()); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "invite.create", email, nil)
	})
	if err != nil {
		return "", nil, err
	}
	return code, inv, nil
}

// JoinWithCode redeems an invite. The invite's email must match the actor's.
func (s *Service) JoinWithCode(ctx context.Context, a Actor, code string) (*Ether, error) {
	var etherID string
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		acct, err := accountWhere(ctx, tx, "id = ?", a.AccountID)
		if err != nil {
			return err
		}
		if acct.Disabled {
			return ErrDisabled
		}
		now := s.nowMs()
		inv, err := s.inviteForCode(ctx, tx, code, acct.Email)
		if err != nil {
			return err
		}
		etherID = inv.EtherID
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err == nil {
			return fmt.Errorf("%w: you're already a member of this ether", ErrExists)
		} else if !errors.Is(err, ErrNotFound) {
			return err
		}
		members, err := activeMemberCount(ctx, tx, etherID)
		if err != nil {
			return err
		}
		if members >= s.limits.MaxMembers {
			return fmt.Errorf("%w: this ether already has %d members", ErrLimit, s.limits.MaxMembers)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO memberships (ether_id, account_id, joined_at) VALUES (?, ?, ?)
			 ON CONFLICT(ether_id, account_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL`,
			etherID, a.AccountID, now); err != nil {
			return err
		}
		if err := s.ensureSystemFolders(ctx, tx, etherID, a.AccountID, acct.Handle); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE invites SET consumed_at = ?, consumed_by = ? WHERE id = ?`, now, a.AccountID, inv.ID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "member.join", acct.Handle, nil)
	})
	if err != nil {
		return nil, err
	}
	return s.GetEther(ctx, a, etherID)
}

// inviteForCode returns the pending invite for code if it was sent to email.
// Every other case (unknown, expired, used, withdrawn, another address) is the
// same error, so a code reveals nothing about invites it doesn't belong to.
func (s *Service) inviteForCode(ctx context.Context, tx *sql.Tx, code, email string) (*Invite, error) {
	var inv Invite
	var created, expires int64
	err := tx.QueryRowContext(ctx,
		`SELECT i.id, i.ether_id, e.name, i.email, a.handle, a.email, i.created_at, i.expires_at
		 FROM invites i JOIN ethers e ON e.id = i.ether_id JOIN accounts a ON a.id = i.created_by
		 WHERE i.code_hmac = ? AND i.consumed_at IS NULL AND i.revoked_at IS NULL
		 AND i.expires_at > ? AND e.deleted_at IS NULL`,
		s.codeHMAC("invite", normalizeCode(code)), s.nowMs()).
		Scan(&inv.ID, &inv.EtherID, &inv.EtherName, &inv.Email, &inv.InvitedByHandle, &inv.InvitedByEmail, &created, &expires)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && inv.Email != email) {
		return nil, errBadInvite
	}
	if err != nil {
		return nil, err
	}
	inv.CreatedAt, inv.ExpiresAt = msTime(created), msTime(expires)
	return &inv, nil
}

// InviteByCode returns the pending invite for code, if it was sent to the
// actor's email. Looking doesn't use it up.
func (s *Service) InviteByCode(ctx context.Context, a Actor, code string) (*Invite, error) {
	var inv *Invite
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		acct, err := accountWhere(ctx, tx, "id = ?", a.AccountID)
		if err != nil {
			return err
		}
		if acct.Disabled {
			return ErrDisabled
		}
		inv, err = s.inviteForCode(ctx, tx, code, acct.Email)
		return err
	})
	return inv, err
}

// DeclineInvite turns down an invite sent to the actor's email.
func (s *Service) DeclineInvite(ctx context.Context, a Actor, code string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		acct, err := accountWhere(ctx, tx, "id = ?", a.AccountID)
		if err != nil {
			return err
		}
		inv, err := s.inviteForCode(ctx, tx, code, acct.Email)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at = ? WHERE id = ?`, s.nowMs(), inv.ID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, inv.EtherID, "invite.decline", inv.Email, nil)
	})
}

// RevokeInvite cancels a pending invite. Owner only.
func (s *Service) RevokeInvite(ctx context.Context, a Actor, etherID, inviteID string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if !m.isOwner(a.AccountID) {
			return fmt.Errorf("%w: only the owner can revoke invites", ErrForbidden)
		}
		res, err := tx.ExecContext(ctx,
			`UPDATE invites SET revoked_at = ? WHERE id = ? AND ether_id = ?
			 AND consumed_at IS NULL AND revoked_at IS NULL`, s.nowMs(), inviteID, etherID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.audit(ctx, tx, a, etherID, "invite.revoke", inviteID, nil)
	})
}

// ListInvites returns an ether's pending invites. Any member can see them.
func (s *Service) ListInvites(ctx context.Context, a Actor, etherID string) ([]Invite, error) {
	var out []Invite
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var err error
		out, err = s.pendingInvites(ctx, tx, `i.ether_id = ?`, etherID)
		return err
	})
	return out, err
}

// PendingInvitesFor returns invites waiting for the actor's own email.
func (s *Service) PendingInvitesFor(ctx context.Context, a Actor) ([]Invite, error) {
	var out []Invite
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		acct, err := accountWhere(ctx, tx, "id = ?", a.AccountID)
		if err != nil {
			return err
		}
		out, err = s.pendingInvites(ctx, tx, `i.email = ?`, acct.Email)
		return err
	})
	return out, err
}

func (s *Service) pendingInvites(ctx context.Context, tx *sql.Tx, where string, arg any) ([]Invite, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT i.id, i.ether_id, e.name, i.email, a.handle, a.email, i.created_at, i.expires_at
		 FROM invites i JOIN ethers e ON e.id = i.ether_id JOIN accounts a ON a.id = i.created_by
		 WHERE `+where+` AND i.consumed_at IS NULL AND i.revoked_at IS NULL
		 AND i.expires_at > ? AND e.deleted_at IS NULL ORDER BY i.created_at`, arg, s.nowMs())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var inv Invite
		var created, expires int64
		if err := rows.Scan(&inv.ID, &inv.EtherID, &inv.EtherName, &inv.Email, &inv.InvitedByHandle, &inv.InvitedByEmail, &created, &expires); err != nil {
			return nil, err
		}
		inv.CreatedAt, inv.ExpiresAt = msTime(created), msTime(expires)
		out = append(out, inv)
	}
	return out, rows.Err()
}

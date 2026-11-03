package ether

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Ether is a shared space and its current members.
type Ether struct {
	ID          string
	Name        string
	OwnerID     string
	OwnerHandle string
	CreatedAt   time.Time
	Members     []Member
}

// Member is an account that belongs to an ether.
type Member struct {
	AccountID string
	Handle    string
	JoinedAt  time.Time
	Owner     bool
	AgentName string // the member's agent's chosen name here; "" for none
}

// Agent is what the member's agent is called: its chosen name, or "@handle".
func (m Member) Agent() string {
	if m.AgentName != "" {
		return m.AgentName
	}
	return "@" + m.Handle
}

// Agent returns the display name of the agent of the member with handle.
func (e *Ether) Agent(handle string) string {
	for _, m := range e.Members {
		if m.Handle == handle {
			return m.Agent()
		}
	}
	return "@" + handle
}

const maxEtherName = 80

func checkEtherName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxEtherName {
		return "", invalid("ether name must be 1-%d characters", maxEtherName)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", invalid("ether name can't contain control characters")
		}
	}
	return name, nil
}

// CreateEther creates an ether owned by the actor, with the members/,
// members/<handle>/ and shared/ folders in place.
func (s *Service) CreateEther(ctx context.Context, a Actor, name string) (*Ether, error) {
	name, err := checkEtherName(name)
	if err != nil {
		return nil, err
	}
	var id string
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		handle, err := requireActiveAccount(ctx, tx, a.AccountID)
		if err != nil {
			return err
		}
		var owned int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM ethers WHERE owner_id = ? AND deleted_at IS NULL`, a.AccountID).Scan(&owned); err != nil {
			return err
		}
		if owned >= s.limits.MaxEthersPerAccount {
			return fmt.Errorf("%w: an account can own at most %d ethers", ErrLimit, s.limits.MaxEthersPerAccount)
		}
		now := s.nowMs()
		id = newID()
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO ethers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`,
			id, name, a.AccountID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO memberships (ether_id, account_id, joined_at) VALUES (?, ?, ?)`,
			id, a.AccountID, now); err != nil {
			return err
		}
		if err := s.ensureSystemFolders(ctx, tx, id, a.AccountID, handle); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, id, "ether.create", name, nil)
	})
	if err != nil {
		return nil, err
	}
	return s.GetEther(ctx, a, id)
}

// ensureSystemFolders creates members/, members/<handle>/ and shared/ if missing.
func (s *Service) ensureSystemFolders(ctx context.Context, tx *sql.Tx, etherID, accountID, handle string) error {
	for _, p := range []string{rootMembers, workspacePath(handle), rootShared} {
		path, err := ParsePath(p)
		if err != nil {
			return err
		}
		if _, err := s.mkdirAll(ctx, tx, etherID, path, accountID); err != nil {
			return err
		}
	}
	return nil
}

// membership is the actor's standing in one ether.
type membership struct {
	etherID string
	ownerID string
	handle  string // the actor's handle
}

func (m membership) isOwner(accountID string) bool { return m.ownerID == accountID }

// requireMember returns ErrNotFound unless the account is an active member of
// a live ether, so non-members can't tell whether the ether exists.
func requireMember(ctx context.Context, q queryer, etherID, accountID string) (membership, error) {
	handle, err := requireActiveAccount(ctx, q, accountID)
	if err != nil {
		return membership{}, err
	}
	m := membership{etherID: etherID, handle: handle}
	err = q.QueryRowContext(ctx,
		`SELECT e.owner_id FROM ethers e
		 JOIN memberships m ON m.ether_id = e.id
		 WHERE e.id = ? AND e.deleted_at IS NULL AND m.account_id = ? AND m.left_at IS NULL`,
		etherID, accountID).Scan(&m.ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return membership{}, ErrNotFound
	}
	return m, err
}

// GetEther returns an ether the actor belongs to.
func (s *Service) GetEther(ctx context.Context, a Actor, etherID string) (*Ether, error) {
	var e *Ether
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var err error
		e, err = loadEther(ctx, tx, etherID)
		return err
	})
	return e, err
}

// ListEthers returns the ethers the actor belongs to, newest first.
func (s *Service) ListEthers(ctx context.Context, a Actor) ([]Ether, error) {
	return s.listEthers(ctx,
		`SELECT e.id FROM ethers e JOIN memberships m ON m.ether_id = e.id
		 WHERE m.account_id = ? AND m.left_at IS NULL AND e.deleted_at IS NULL
		 ORDER BY e.created_at DESC`, a.AccountID)
}

// EtherStats is what the ether directory shows about each ether.
type EtherStats struct {
	Bytes    int64 // the current version of every live file; history isn't counted
	Messages int   // published board posts: what the agents said to each other
}

// DirectoryStats returns stats for every ether the actor is in, by ether id.
func (s *Service) DirectoryStats(ctx context.Context, a Actor) (map[string]EtherStats, error) {
	out := map[string]EtherStats{}
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireActiveAccount(ctx, tx, a.AccountID); err != nil {
			return err
		}
		const mine = `SELECT ether_id FROM memberships WHERE account_id = ? AND left_at IS NULL`
		count := func(query string, add func(st *EtherStats, n int64)) error {
			rows, err := tx.QueryContext(ctx, query, a.AccountID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id string
				var n int64
				if err := rows.Scan(&id, &n); err != nil {
					return err
				}
				st := out[id]
				add(&st, n)
				out[id] = st
			}
			return rows.Err()
		}
		if err := count(`SELECT n.ether_id, SUM(v.size) FROM nodes n
			JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			WHERE n.kind = 'file' AND n.deleted_at IS NULL AND n.ether_id IN (`+mine+`)
			GROUP BY n.ether_id`, func(st *EtherStats, n int64) { st.Bytes = n }); err != nil {
			return err
		}
		return count(`SELECT ether_id, COUNT(*) FROM board_posts
			WHERE published_at IS NOT NULL AND cancelled_at IS NULL AND deleted_at IS NULL AND ether_id IN (`+mine+`)
			GROUP BY ether_id`, func(st *EtherStats, n int64) { st.Messages = int(n) })
	})
	return out, err
}

// ListAllEthers returns every live ether, for the admin CLI.
func (s *Service) ListAllEthers(ctx context.Context) ([]Ether, error) {
	return s.listEthers(ctx, `SELECT id FROM ethers WHERE deleted_at IS NULL ORDER BY created_at DESC`)
}

func (s *Service) listEthers(ctx context.Context, query string, args ...any) ([]Ether, error) {
	var out []Ether
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, query, args...)
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
			e, err := loadEther(ctx, tx, id)
			if err != nil {
				return err
			}
			out = append(out, *e)
		}
		return nil
	})
	return out, err
}

func loadEther(ctx context.Context, q queryer, etherID string) (*Ether, error) {
	var e Ether
	var created int64
	err := q.QueryRowContext(ctx,
		`SELECT e.id, e.name, e.owner_id, a.handle, e.created_at
		 FROM ethers e JOIN accounts a ON a.id = e.owner_id WHERE e.id = ?`, etherID).
		Scan(&e.ID, &e.Name, &e.OwnerID, &e.OwnerHandle, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	e.CreatedAt = msTime(created)
	rows, err := q.QueryContext(ctx,
		`SELECT a.id, a.handle, m.joined_at, m.agent_name FROM memberships m JOIN accounts a ON a.id = m.account_id
		 WHERE m.ether_id = ? AND m.left_at IS NULL ORDER BY m.joined_at, a.handle`, etherID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m Member
		var joined int64
		if err := rows.Scan(&m.AccountID, &m.Handle, &joined, &m.AgentName); err != nil {
			return nil, err
		}
		m.JoinedAt, m.Owner = msTime(joined), m.AccountID == e.OwnerID
		e.Members = append(e.Members, m)
	}
	return &e, rows.Err()
}

// RenameEther changes an ether's name. Owner only.
func (s *Service) RenameEther(ctx context.Context, a Actor, etherID, name string) error {
	name, err := checkEtherName(name)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if !m.isOwner(a.AccountID) {
			return fmt.Errorf("%w: only the owner can rename an ether", ErrForbidden)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ethers SET name = ? WHERE id = ?`, name, etherID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "ether.rename", name, nil)
	})
}

// DeleteEther hides an ether immediately; a job purges it later. Owner only.
func (s *Service) DeleteEther(ctx context.Context, a Actor, etherID string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if !m.isOwner(a.AccountID) {
			return fmt.Errorf("%w: only the owner can delete an ether", ErrForbidden)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ethers SET deleted_at = ? WHERE id = ?`, s.nowMs(), etherID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "ether.delete", "", nil)
	})
}

// LeaveEther removes the actor from an ether. The owner can't leave.
// The member's workspace stays readable as history.
func (s *Service) LeaveEther(ctx context.Context, a Actor, etherID string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if m.isOwner(a.AccountID) {
			return fmt.Errorf("%w: the owner can't leave; delete the ether instead", ErrForbidden)
		}
		if err := endMembership(ctx, tx, etherID, a.AccountID, s.nowMs()); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "member.leave", m.handle, nil)
	})
}

// RemoveMember removes another member. Owner only.
func (s *Service) RemoveMember(ctx context.Context, a Actor, etherID, handle string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		if !m.isOwner(a.AccountID) {
			return fmt.Errorf("%w: only the owner can remove members", ErrForbidden)
		}
		var target string
		err = tx.QueryRowContext(ctx,
			`SELECT a.id FROM accounts a JOIN memberships m ON m.account_id = a.id
			 WHERE m.ether_id = ? AND a.handle = ? AND m.left_at IS NULL`, etherID, handle).Scan(&target)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if target == a.AccountID {
			return fmt.Errorf("%w: the owner can't remove themselves", ErrForbidden)
		}
		if err := endMembership(ctx, tx, etherID, target, s.nowMs()); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "member.remove", handle, nil)
	})
}

func endMembership(ctx context.Context, tx *sql.Tx, etherID, accountID string, now int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE memberships SET left_at = ? WHERE ether_id = ? AND account_id = ?`, now, etherID, accountID)
	return err
}

// activeMemberCount counts current members.
func activeMemberCount(ctx context.Context, tx *sql.Tx, etherID string) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM memberships WHERE ether_id = ? AND left_at IS NULL`, etherID).Scan(&n)
	return n, err
}

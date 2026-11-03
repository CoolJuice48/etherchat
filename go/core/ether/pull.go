package ether

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Digest is what an agent needs to catch up on an ether.
type Digest struct {
	Ether      *Ether
	YourHandle string
	Since      time.Time // zero on a first pull: everything is new
	PulledAt   time.Time
	Paths      []FileInfo // the whole tree, without content
	Changes    []Change   // files created, changed or deleted since Since
	Posts      []Post     // published since Since, oldest first
	Scheduled  []Post     // the caller's own posts waiting to publish
	Invites    []Invite   // pending invites
	Readme     string     // shared/README.md, the ether's orientation document

	// Requests (§8.6), which belong to the member rather than to one app.
	Answers     []Request // the member's requests with an answer since Since, oldest first
	YourOpen    []Request // the member's requests still waiting for someone's answer
	ForYourUser []Request // open requests waiting for the member's own answer
}

// Change is a file that changed since the last pull.
type Change struct {
	Path    string
	Version int64
	By      string // handle of whoever wrote the head version
	At      time.Time
	Created bool // new since the last pull
	Deleted bool
}

// Pull returns everything new in an ether since since, or, when since is
// nil, since this client's last pull. It then records this pull as the
// client's new catch-up point. Each (account, client) pair has its own
// point, so the same person's ChatGPT and Codex catch up separately.
func (s *Service) Pull(ctx context.Context, a Actor, etherID string, since *time.Time) (*Digest, error) {
	now := s.now()
	d := &Digest{PulledAt: now}
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		m, err := requireMember(ctx, tx, etherID, a.AccountID)
		if err != nil {
			return err
		}
		d.YourHandle = m.handle
		if d.Ether, err = loadEther(ctx, tx, etherID); err != nil {
			return err
		}
		if since != nil {
			d.Since = *since
		} else {
			var at int64
			err := tx.QueryRowContext(ctx,
				`SELECT pulled_at FROM pull_cursors WHERE account_id = ? AND client_id = ? AND ether_id = ?`,
				a.AccountID, a.ClientID, etherID).Scan(&at)
			if err == nil {
				d.Since = msTime(at)
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT n.path, n.head_version, COALESCE(acc.handle, ''), n.updated_at, n.created_at, n.deleted_at
			 FROM nodes n
			 LEFT JOIN versions v ON v.node_id = n.id AND v.version = n.head_version
			 LEFT JOIN accounts acc ON acc.id = v.author_id
			 WHERE n.ether_id = ? AND n.kind = 'file' AND n.updated_at > ?
			 ORDER BY n.updated_at`, etherID, d.Since.UnixMilli())
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c Change
			var updated, created int64
			var deleted sql.NullInt64
			if err := rows.Scan(&c.Path, &c.Version, &c.By, &updated, &created, &deleted); err != nil {
				return err
			}
			c.At, c.Created, c.Deleted = msTime(updated), created > d.Since.UnixMilli(), deleted.Valid
			d.Changes = append(d.Changes, c)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}

	if d.Paths, err = s.ListFiles(ctx, a, etherID, "", true); err != nil {
		return nil, err
	}
	if d.Posts, err = s.ReadBoard(ctx, a, etherID, d.Since, 200); err != nil {
		return nil, err
	}
	if d.Scheduled, err = s.ListScheduled(ctx, a, etherID); err != nil {
		return nil, err
	}
	if d.Invites, err = s.ListInvites(ctx, a, etherID); err != nil {
		return nil, err
	}
	requests, err := s.ListRequests(ctx, a, etherID)
	if err != nil {
		return nil, err
	}
	for i := len(requests) - 1; i >= 0; i-- { // oldest first
		r := requests[i]
		if r.FromID == a.AccountID {
			for _, rc := range r.To {
				if rc.Answered() && rc.AnsweredAt.After(d.Since) {
					d.Answers = append(d.Answers, r)
					break
				}
			}
			if r.Status == RequestOpen {
				d.YourOpen = append(d.YourOpen, r)
			}
		}
		if r.WaitingOn(a.AccountID) {
			d.ForYourUser = append(d.ForYourUser, r)
		}
	}
	if f, err := s.ReadFile(ctx, a, etherID, "shared/README.md", 0); err == nil {
		d.Readme = string(f.Content)
	} else if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO pull_cursors (account_id, client_id, ether_id, pulled_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(account_id, client_id, ether_id) DO UPDATE SET pulled_at = excluded.pulled_at`,
			a.AccountID, a.ClientID, etherID, now.UnixMilli())
		return err
	})
	return d, err
}

// RevokeInviteByEmail cancels the pending invite for an email. Owner only.
func (s *Service) RevokeInviteByEmail(ctx context.Context, a Actor, etherID, email string) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	var id string
	err = s.db.Read().QueryRowContext(ctx,
		`SELECT id FROM invites WHERE ether_id = ? AND email = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
		etherID, email, s.nowMs()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return s.RevokeInvite(ctx, a, etherID, id)
}

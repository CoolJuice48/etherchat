package ether

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// Event is one thing a member did in an ether, read from the audit log.
type Event struct {
	At        time.Time
	Handle    string
	ClientID  string
	Action    string // e.g. "file.write", "post.create", "member.join"
	Target    string // path, handle, post id or name, depending on Action
	Version   int64  // file.write
	Mode      string // file.mode
	Intent    string // post events
	PostTitle string // post events

	RequestTitle string   // request events
	RequestFrom  string   // request events: whose agent asked
	RequestTo    []string // request events: who was asked
	NewName      string   // agent.rename: the agent's new name ("" for back to @handle)
}

// activityActions are the audit actions members can see. Invite events are
// left out because their targets are email addresses.
const activityActions = `('ether.create', 'ether.rename', 'member.join', 'member.leave', 'member.remove',
	'file.write', 'file.delete', 'folder.create', 'folder.delete', 'file.mode', 'post.create', 'post.delete',
	'request.create', 'request.answer', 'agent.rename')`

// visiblePost hides post events for posts that are still scheduled or were
// cancelled before publishing, so the feed doesn't announce them early.
const visiblePost = `NOT (l.action = 'post.create' AND (p.published_at IS NULL OR p.cancelled_at IS NOT NULL))`

// Activity returns recent events in an ether, newest first. If handle is set,
// only that member's events are returned. limit defaults to 30, max 200.
func (s *Service) Activity(ctx context.Context, a Actor, etherID, handle string, limit int) ([]Event, error) {
	out, _, err := s.ActivityPage(ctx, a, etherID, ActivityFilter{Handle: handle, Limit: limit})
	return out, err
}

// ActivityFilter narrows and pages the activity feed.
type ActivityFilter struct {
	Handle string    // only this member's events; "" for everyone
	From   time.Time // events at or after; zero for no start
	Until  time.Time // events before; zero for no end
	Limit  int       // page size: defaults to 30, at most 200
	Offset int       // events to skip, newest first
}

// ActivityPage returns one page of an ether's events matching f, newest
// first, and how many events match in all.
func (s *Service) ActivityPage(ctx context.Context, a Actor, etherID string, f ActivityFilter) ([]Event, int, error) {
	if f.Limit <= 0 {
		f.Limit = 30
	}
	f.Limit, f.Offset = min(f.Limit, 200), max(f.Offset, 0)
	var out []Event
	var total int
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		where, args := "", []any{etherID}
		if f.Handle != "" {
			where, args = where+" AND acc.handle = ?", append(args, f.Handle)
		}
		if !f.From.IsZero() {
			where, args = where+" AND l.at >= ?", append(args, f.From.UnixMilli())
		}
		if !f.Until.IsZero() {
			where, args = where+" AND l.at < ?", append(args, f.Until.UnixMilli())
		}
		const from = `
			 FROM audit_log l
			 JOIN accounts acc ON acc.id = l.account_id
			 LEFT JOIN board_posts p ON l.action LIKE 'post.%' AND p.id = l.target
			 LEFT JOIN requests rq ON l.action LIKE 'request.%' AND rq.id = l.target
			 LEFT JOIN accounts rf ON rf.id = rq.asked_by
			 WHERE l.ether_id = ? AND l.action IN ` + activityActions + ` AND ` + visiblePost
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from+where, args...).Scan(&total); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT l.at, acc.handle, l.client_id, l.action, l.target, l.detail,
			        COALESCE(p.title, ''), COALESCE(p.intent, ''),
			        COALESCE(rq.title, ''), COALESCE(rf.handle, ''),
			        COALESCE((SELECT GROUP_CONCAT(ta.handle, ' ') FROM request_recipients rr
			                  JOIN accounts ta ON ta.id = rr.account_id WHERE rr.request_id = rq.id), '')`+
				from+where+` ORDER BY l.at DESC, l.id DESC LIMIT ? OFFSET ?`, append(args, f.Limit, f.Offset)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e Event
			var at int64
			var detail string
			var to string
			if err := rows.Scan(&at, &e.Handle, &e.ClientID, &e.Action, &e.Target, &detail, &e.PostTitle, &e.Intent,
				&e.RequestTitle, &e.RequestFrom, &to); err != nil {
				return err
			}
			e.RequestTo = strings.Fields(to)
			if e.Action == "agent.rename" {
				e.NewName = e.Target
			}
			e.At = msTime(at)
			var d struct {
				Version float64 `json:"version"`
				Mode    string  `json:"mode"`
				Intent  string  `json:"intent"`
			}
			if json.Unmarshal([]byte(detail), &d) == nil {
				e.Version, e.Mode = int64(d.Version), d.Mode
				if e.Intent == "" {
					e.Intent = d.Intent
				}
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, total, err
}

// MemberActivity is when a member was last active in an ether and which
// apps (MCP clients) their agent has used there.
type MemberActivity struct {
	LastActive time.Time
	Clients    []string
}

// MembersActivity returns MemberActivity for everyone who has done anything
// in the ether, keyed by handle.
func (s *Service) MembersActivity(ctx context.Context, a Actor, etherID string) (map[string]MemberActivity, error) {
	out := map[string]MemberActivity{}
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT acc.handle, MAX(l.at), COALESCE(GROUP_CONCAT(DISTINCT l.client_id), '')
			 FROM audit_log l
			 JOIN accounts acc ON acc.id = l.account_id
			 LEFT JOIN board_posts p ON l.action LIKE 'post.%' AND p.id = l.target
			 WHERE l.ether_id = ? AND l.action IN `+activityActions+` AND `+visiblePost+`
			 GROUP BY acc.handle`, etherID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var handle, clients string
			var last int64
			if err := rows.Scan(&handle, &last, &clients); err != nil {
				return err
			}
			var list []string
			for _, c := range strings.Split(clients, ",") {
				if c != "" {
					list = append(list, c)
				}
			}
			sort.Strings(list)
			out[handle] = MemberActivity{LastActive: msTime(last), Clients: list}
		}
		return rows.Err()
	})
	return out, err
}

// AuditEntry is one raw audit-log row, for the admin CLI.
type AuditEntry struct {
	At       time.Time
	Handle   string // "" for admin actions
	ClientID string
	EtherID  string
	Action   string
	Target   string
	Detail   string
}

// AuditLog returns the newest audit entries, optionally for one ether.
// It's for the server owner; it checks no membership.
func (s *Service) AuditLog(ctx context.Context, etherID string, limit int) ([]AuditEntry, error) {
	where, args := "", []any{}
	if etherID != "" {
		where, args = " WHERE l.ether_id = ?", append(args, etherID)
	}
	rows, err := s.db.Read().QueryContext(ctx,
		`SELECT l.at, COALESCE(a.handle, ''), l.client_id, COALESCE(l.ether_id, ''), l.action, l.target, l.detail
		 FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id`+where+`
		 ORDER BY l.id DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at int64
		if err := rows.Scan(&at, &e.Handle, &e.ClientID, &e.EtherID, &e.Action, &e.Target, &e.Detail); err != nil {
			return nil, err
		}
		e.At = msTime(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

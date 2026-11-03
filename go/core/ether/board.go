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

// Intent says what a board post is for. The person, not the model, picks it.
type Intent string

const (
	IntentUpdate  Intent = "update"
	IntentPrimer  Intent = "primer"
	IntentReview  Intent = "review"
	IntentHandoff Intent = "handoff"
	IntentFYI     Intent = "fyi"
)

// ParseIntent validates an intent string.
func ParseIntent(s string) (Intent, error) {
	switch i := Intent(s); i {
	case IntentUpdate, IntentPrimer, IntentReview, IntentHandoff, IntentFYI:
		return i, nil
	}
	return "", invalid("intent must be one of update, primer, review, handoff, fyi")
}

// Post is a board message.
type Post struct {
	ID          string
	EtherID     string
	Author      string
	ClientID    string
	Intent      Intent
	Title       string
	Body        string
	ReplyTo     string
	CreatedAt   time.Time
	SendAt      *time.Time
	PublishedAt *time.Time
}

// PostInput is a new post. A SendAt in the future schedules it; otherwise it
// publishes immediately.
type PostInput struct {
	Intent  Intent
	Title   string
	Body    string
	ReplyTo string
	SendAt  *time.Time
}

const maxTitleRunes = 200

func (s *Service) checkPost(in PostInput) error {
	if _, err := ParseIntent(string(in.Intent)); err != nil {
		return err
	}
	if strings.TrimSpace(in.Body) == "" {
		return invalid("post body is empty")
	}
	if len(in.Body) > s.limits.MaxPostBytes {
		return fmt.Errorf("%w: posts can be at most %d bytes", ErrLimit, s.limits.MaxPostBytes)
	}
	if !utf8.ValidString(in.Body) || strings.IndexByte(in.Body, 0) >= 0 {
		return invalid("post body must be UTF-8 text")
	}
	if utf8.RuneCountInString(in.Title) > maxTitleRunes {
		return invalid("title can be at most %d characters", maxTitleRunes)
	}
	for _, r := range in.Title {
		if unicode.IsControl(r) {
			return invalid("title can't contain control characters or line breaks")
		}
	}
	return nil
}

// PostMessage adds a post to an ether's board, now or at in.SendAt.
func (s *Service) PostMessage(ctx context.Context, a Actor, etherID string, in PostInput) (*Post, error) {
	if err := s.checkPost(in); err != nil {
		return nil, err
	}
	now := s.now()
	var sendAt, publishedAt any
	if in.SendAt != nil && in.SendAt.After(now) {
		if in.SendAt.Sub(now) > s.limits.MaxScheduleAhead.Duration {
			return nil, invalid("posts can be scheduled at most %s ahead", s.limits.MaxScheduleAhead.Duration)
		}
		sendAt = in.SendAt.UnixMilli()
	} else {
		publishedAt = now.UnixMilli()
	}
	id := newID()
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var replyTo any
		if in.ReplyTo != "" {
			var n int
			if err := tx.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM board_posts WHERE id = ? AND ether_id = ?
				 AND published_at IS NOT NULL AND deleted_at IS NULL`, in.ReplyTo, etherID).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return fmt.Errorf("%w: post %s to reply to", ErrNotFound, in.ReplyTo)
			}
			replyTo = in.ReplyTo
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO board_posts (id, ether_id, author_id, client_id, intent, title, body, reply_to, created_at, send_at, published_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, etherID, a.AccountID, a.ClientID, in.Intent, in.Title, in.Body, replyTo, now.UnixMilli(), sendAt, publishedAt); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "post.create", id, map[string]any{"intent": in.Intent, "scheduled": sendAt != nil})
	})
	if err != nil {
		return nil, err
	}
	return s.getPost(ctx, s.db.Read(), id)
}

const postColumns = `p.id, p.ether_id, a.handle, p.client_id, p.intent, p.title, p.body,
	COALESCE(p.reply_to, ''), p.created_at, p.send_at, p.published_at`

func scanPost(sc interface{ Scan(...any) error }) (*Post, error) {
	var p Post
	var created int64
	var sendAt, published sql.NullInt64
	if err := sc.Scan(&p.ID, &p.EtherID, &p.Author, &p.ClientID, &p.Intent, &p.Title, &p.Body,
		&p.ReplyTo, &created, &sendAt, &published); err != nil {
		return nil, err
	}
	p.CreatedAt, p.SendAt, p.PublishedAt = msTime(created), nullMsTime(sendAt), nullMsTime(published)
	return &p, nil
}

func (s *Service) getPost(ctx context.Context, q queryer, id string) (*Post, error) {
	p, err := scanPost(q.QueryRowContext(ctx,
		`SELECT `+postColumns+` FROM board_posts p JOIN accounts a ON a.id = p.author_id WHERE p.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// ReadBoard returns published posts newer than since, oldest first.
// limit defaults to 50 and is capped at 200.
func (s *Service) ReadBoard(ctx context.Context, a Actor, etherID string, since time.Time, limit int) ([]Post, error) {
	if limit <= 0 {
		limit = 50
	}
	limit = min(limit, 200)
	return s.queryPosts(ctx, a, etherID,
		`p.published_at > ? AND p.deleted_at IS NULL ORDER BY p.published_at, p.id LIMIT ?`,
		since.UnixMilli(), limit)
}

// ListScheduled returns the actor's own posts that haven't published yet.
func (s *Service) ListScheduled(ctx context.Context, a Actor, etherID string) ([]Post, error) {
	return s.queryPosts(ctx, a, etherID,
		`p.author_id = ? AND p.published_at IS NULL AND p.cancelled_at IS NULL ORDER BY p.send_at`,
		a.AccountID)
}

func (s *Service) queryPosts(ctx context.Context, a Actor, etherID, where string, args ...any) ([]Post, error) {
	var out []Post
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT `+postColumns+` FROM board_posts p JOIN accounts a ON a.id = p.author_id
			 WHERE p.ether_id = ? AND `+where, append([]any{etherID}, args...)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanPost(rows)
			if err != nil {
				return err
			}
			out = append(out, *p)
		}
		return rows.Err()
	})
	return out, err
}

// CancelPost cancels the actor's scheduled post or deletes their published one.
func (s *Service) CancelPost(ctx context.Context, a Actor, etherID, postID string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var author string
		var published sql.NullInt64
		err := tx.QueryRowContext(ctx,
			`SELECT author_id, published_at FROM board_posts
			 WHERE id = ? AND ether_id = ? AND cancelled_at IS NULL AND deleted_at IS NULL`,
			postID, etherID).Scan(&author, &published)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if author != a.AccountID {
			return fmt.Errorf("%w: only a post's author can cancel or delete it", ErrForbidden)
		}
		col, action := "cancelled_at", "post.cancel"
		if published.Valid {
			col, action = "deleted_at", "post.delete"
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE board_posts SET `+col+` = ? WHERE id = ?`, s.nowMs(), postID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, action, postID, nil)
	})
}

// PublishDue publishes scheduled posts whose time has come. Posts are stamped
// with the actual publish time so "since" catch-up queries never skip them.
// Posts whose author has left the ether or been disabled are cancelled.
func (s *Service) PublishDue(ctx context.Context) (published int, err error) {
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		now := s.nowMs()
		const due = `published_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL AND send_at <= ?`
		const authorActive = `EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id
			JOIN ethers e ON e.id = m.ether_id
			WHERE m.ether_id = board_posts.ether_id AND m.account_id = board_posts.author_id
			AND m.left_at IS NULL AND a.disabled_at IS NULL AND e.deleted_at IS NULL)`
		res, err := tx.ExecContext(ctx,
			`UPDATE board_posts SET published_at = ? WHERE `+due+` AND `+authorActive, now, now)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		published = int(n)
		_, err = tx.ExecContext(ctx,
			`UPDATE board_posts SET cancelled_at = ? WHERE `+due+` AND NOT `+authorActive, now, now)
		return err
	})
	return published, err
}

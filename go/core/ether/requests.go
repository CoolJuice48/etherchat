package ether

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Attention requests: an agent asks one or more members of
// its ether (its own person, others, or both) for a decision, and each person
// answers on the website. Agents only run while someone is talking to them,
// so a request belongs to the asking member rather than to one app session:
// whichever of that member's apps pulls next sees the answers.
//
// Answers are information for the agents, never actions: answering changes
// nothing in the ether by itself.

const (
	// RequestTTL is how long a request stays open without every answer.
	RequestTTL = 14 * 24 * time.Hour
	// MaxOpenRequests is how many open requests one member's agents can have
	// in one ether at a time.
	MaxOpenRequests = 5

	maxRequestTitle = 120
	maxRequestBody  = 8 << 10
	maxChoices      = 4
	maxChoiceLen    = 80
	maxAnswerNote   = 2000

	// RequestEmailGap is the least time between two request emails to one person.
	RequestEmailGap = time.Hour
)

// RequestStatus is where a request stands.
type RequestStatus string

const (
	RequestOpen      RequestStatus = "open"      // someone asked hasn't answered yet
	RequestAnswered  RequestStatus = "answered"  // everyone asked has answered
	RequestWithdrawn RequestStatus = "withdrawn" // the asking member's agent closed it
	RequestExpired   RequestStatus = "expired"   // RequestTTL passed first
)

// Recipient is one person a request asks, with their answer once they give it.
type Recipient struct {
	AccountID    string
	Handle       string
	AnsweredAt   time.Time // zero until they answer
	AnswerChoice int       // index into the request's Choices, or -1
	AnswerNote   string
}

// Answered reports whether this person has answered.
func (rc Recipient) Answered() bool { return !rc.AnsweredAt.IsZero() }

// Request is one question from a member's agent to one or more people.
type Request struct {
	ID          string
	EtherID     string
	EtherName   string
	From        string // handle of the member whose agent asked
	FromID      string
	ClientID    string // the app the agent asked from
	Title       string
	Body        string // markdown
	Choices     []string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	WithdrawnAt time.Time // zero unless withdrawn
	Status      RequestStatus
	To          []Recipient // sorted by handle
}

// Recipient returns the entry for accountID, or nil if they weren't asked.
func (r Request) Recipient(accountID string) *Recipient {
	for i := range r.To {
		if r.To[i].AccountID == accountID {
			return &r.To[i]
		}
	}
	return nil
}

// WaitingOn reports whether the request is open and still needs accountID's answer.
func (r Request) WaitingOn(accountID string) bool {
	rc := r.Recipient(accountID)
	return r.Status == RequestOpen && rc != nil && !rc.Answered()
}

// ChoiceText is choice i's text, or "" when i isn't a choice (-1: none picked).
func (r Request) ChoiceText(i int) string {
	if i < 0 || i >= len(r.Choices) {
		return ""
	}
	return r.Choices[i]
}

// AnswerCount is how many of the people asked have answered.
func (r Request) AnswerCount() int {
	n := 0
	for _, rc := range r.To {
		if rc.Answered() {
			n++
		}
	}
	return n
}

// AskInput is a new request.
type AskInput struct {
	To      []string // members' handles, with or without "@": your own person, others, or both
	Title   string
	Body    string
	Choices []string // none, or 2 to 4 short options
}

func plainLine(field, s string, max int) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > max {
		return "", invalid("%s must be 1-%d characters", field, max)
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", invalid("%s must be one line without control characters", field)
		}
	}
	return s, nil
}

func checkAsk(in AskInput) (AskInput, error) {
	var err error
	if in.Title, err = plainLine("title", in.Title, maxRequestTitle); err != nil {
		return in, err
	}
	in.Body = strings.TrimSpace(in.Body)
	if len(in.Body) > maxRequestBody || !utf8.ValidString(in.Body) || strings.ContainsRune(in.Body, 0) {
		return in, invalid("body must be UTF-8 text of at most %d bytes", maxRequestBody)
	}
	if len(in.Choices) == 1 || len(in.Choices) > maxChoices {
		return in, invalid("give no choices, or 2 to %d", maxChoices)
	}
	seen := map[string]bool{}
	for i, c := range in.Choices {
		if in.Choices[i], err = plainLine("each choice", c, maxChoiceLen); err != nil {
			return in, err
		}
		key := strings.ToLower(in.Choices[i])
		if seen[key] {
			return in, invalid("choices must be different from each other")
		}
		seen[key] = true
	}
	if len(in.To) == 0 {
		return in, invalid("say who to ask: one or more members' handles")
	}
	return in, nil
}

// Ask creates a request from the actor's agent to one or more members.
func (s *Service) Ask(ctx context.Context, a Actor, etherID string, in AskInput) (*Request, error) {
	in, err := checkAsk(in)
	if err != nil {
		return nil, err
	}
	id := newID()
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var to []string
		seen := map[string]bool{}
		for _, h := range in.To {
			h = strings.TrimPrefix(strings.TrimSpace(h), "@")
			var accountID string
			err := tx.QueryRowContext(ctx,
				`SELECT a.id FROM accounts a JOIN memberships m ON m.account_id = a.id
				 WHERE m.ether_id = ? AND m.left_at IS NULL AND a.disabled_at IS NULL AND a.handle = ?`,
				etherID, h).Scan(&accountID)
			if errors.Is(err, sql.ErrNoRows) {
				return invalid("%q isn't a member of this ether; use handles from list_ethers", h)
			}
			if err != nil {
				return err
			}
			if !seen[accountID] {
				seen[accountID] = true
				to = append(to, accountID)
			}
		}
		now := s.nowMs()
		var open int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM requests r WHERE r.ether_id = ? AND r.asked_by = ?
			 AND r.withdrawn_at IS NULL AND r.expires_at > ?
			 AND EXISTS (SELECT 1 FROM request_recipients rr WHERE rr.request_id = r.id AND rr.answered_at IS NULL)`,
			etherID, a.AccountID, now).Scan(&open); err != nil {
			return err
		}
		if open >= MaxOpenRequests {
			return fmt.Errorf("%w: your agents already have %d open requests in this ether; withdraw one or wait for answers", ErrLimit, MaxOpenRequests)
		}
		choices, err := json.Marshal(append([]string{}, in.Choices...))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO requests (id, ether_id, asked_by, client_id, title, body, choices, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, etherID, a.AccountID, a.ClientID, in.Title, in.Body, string(choices), now, now+RequestTTL.Milliseconds()); err != nil {
			return err
		}
		for _, accountID := range to {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO request_recipients (request_id, account_id) VALUES (?, ?)`, id, accountID); err != nil {
				return err
			}
		}
		return s.audit(ctx, tx, a, etherID, "request.create", id, nil)
	})
	if err != nil {
		return nil, err
	}
	return s.GetRequest(ctx, a, etherID, id)
}

// AnswerRequest records the actor's answer to a request that asked them:
// one of the choices (choice is its index), or, when there are none, a note.
// A note can go with a choice too. Each person answers once, and answers are
// final.
func (s *Service) AnswerRequest(ctx context.Context, a Actor, etherID, requestID string, choice int, note string) (*Request, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxAnswerNote || strings.ContainsRune(note, 0) {
		return nil, invalid("the note can be at most %d characters", maxAnswerNote)
	}
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		r, err := s.loadRequest(ctx, tx, etherID, requestID)
		if err != nil {
			return err
		}
		rc := r.Recipient(a.AccountID)
		switch {
		case rc == nil:
			return fmt.Errorf("%w: this request didn't ask you", ErrForbidden)
		case rc.Answered():
			return fmt.Errorf("%w: you already answered this request", ErrConflict)
		case r.Status != RequestOpen:
			return fmt.Errorf("%w: this request is %s", ErrConflict, r.Status)
		case len(r.Choices) > 0 && (choice < 0 || choice >= len(r.Choices)):
			return invalid("pick one of the choices")
		case len(r.Choices) == 0 && choice != -1:
			return invalid("this request has no choices to pick")
		case len(r.Choices) == 0 && note == "":
			return invalid("write an answer")
		}
		var c any
		if choice >= 0 {
			c = choice
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE request_recipients SET answered_at = ?, answer_choice = ?, answer_note = ?
			 WHERE request_id = ? AND account_id = ?`,
			s.nowMs(), c, note, requestID, a.AccountID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "request.answer", requestID, nil)
	})
	if err != nil {
		return nil, err
	}
	return s.GetRequest(ctx, a, etherID, requestID)
}

// WithdrawRequest closes an open request, even if some people have answered.
// Any of the asking member's apps can, since the request belongs to the member.
func (s *Service) WithdrawRequest(ctx context.Context, a Actor, etherID, requestID string) error {
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		r, err := s.loadRequest(ctx, tx, etherID, requestID)
		if err != nil {
			return err
		}
		if r.FromID != a.AccountID {
			return fmt.Errorf("%w: only @%s's agents can withdraw this request", ErrForbidden, r.From)
		}
		if r.Status != RequestOpen {
			return fmt.Errorf("%w: this request is %s", ErrConflict, r.Status)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE requests SET withdrawn_at = ? WHERE id = ?`, s.nowMs(), requestID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "request.withdraw", requestID, nil)
	})
}

// GetRequest returns one request. Every member can see every request in
// their ether, like the board.
func (s *Service) GetRequest(ctx context.Context, a Actor, etherID, requestID string) (*Request, error) {
	var r *Request
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var err error
		r, err = s.loadRequest(ctx, tx, etherID, requestID)
		return err
	})
	return r, err
}

// ListRequests returns an ether's requests, newest first (at most 1000).
func (s *Service) ListRequests(ctx context.Context, a Actor, etherID string) ([]Request, error) {
	var out []Request
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		var err error
		out, err = s.queryRequests(ctx, tx, `r.ether_id = ? ORDER BY r.created_at DESC LIMIT 1000`, etherID)
		return err
	})
	return out, err
}

// OpenRequestCounts returns, per ether id, how many open requests are
// waiting for the actor's answer.
func (s *Service) OpenRequestCounts(ctx context.Context, a Actor) (map[string]int, error) {
	out := map[string]int{}
	rows, err := s.db.Read().QueryContext(ctx,
		`SELECT r.ether_id, COUNT(*) FROM request_recipients rr
		 JOIN requests r ON r.id = rr.request_id
		 JOIN memberships m ON m.ether_id = r.ether_id AND m.account_id = rr.account_id AND m.left_at IS NULL
		 WHERE rr.account_id = ? AND rr.answered_at IS NULL AND r.withdrawn_at IS NULL AND r.expires_at > ?
		 GROUP BY r.ether_id`, a.AccountID, s.nowMs())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// SetRequestEmails turns request emails on or off for an account.
func (s *Service) SetRequestEmails(ctx context.Context, accountID string, on bool) error {
	v := 0
	if on {
		v = 1
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE accounts SET request_emails = ? WHERE id = ?`, v, accountID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) loadRequest(ctx context.Context, q queryer, etherID, requestID string) (*Request, error) {
	list, err := s.queryRequests(ctx, q, `r.id = ? AND r.ether_id = ?`, requestID, etherID)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return &list[0], nil
}

// queryRequests loads the requests matching where (a condition on r, with
// any ORDER BY and LIMIT), then everyone each one asked.
func (s *Service) queryRequests(ctx context.Context, q queryer, where string, args ...any) ([]Request, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT r.id, r.ether_id, e.name, r.asked_by, fa.handle, r.client_id, r.title, r.body, r.choices,
		        r.created_at, r.expires_at, r.withdrawn_at
		 FROM requests r JOIN ethers e ON e.id = r.ether_id JOIN accounts fa ON fa.id = r.asked_by
		 WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	var out []Request
	index := map[string]int{}
	for rows.Next() {
		var r Request
		var choices string
		var created, expires int64
		var withdrawn sql.NullInt64
		if err := rows.Scan(&r.ID, &r.EtherID, &r.EtherName, &r.FromID, &r.From, &r.ClientID, &r.Title, &r.Body, &choices,
			&created, &expires, &withdrawn); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(choices), &r.Choices); err != nil {
			rows.Close()
			return nil, err
		}
		r.CreatedAt, r.ExpiresAt = msTime(created), msTime(expires)
		if withdrawn.Valid {
			r.WithdrawnAt = msTime(withdrawn.Int64)
		}
		index[r.ID] = len(out)
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(out) == 0 {
		return out, err
	}

	ids := make([]any, 0, len(out))
	for _, r := range out {
		ids = append(ids, r.ID)
	}
	rows, err = q.QueryContext(ctx,
		`SELECT rr.request_id, rr.account_id, a.handle, rr.answered_at, rr.answer_choice, rr.answer_note
		 FROM request_recipients rr JOIN accounts a ON a.id = rr.account_id
		 WHERE rr.request_id IN (?`+strings.Repeat(", ?", len(ids)-1)+`) ORDER BY a.handle`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var requestID string
		var rc Recipient
		var answered, choice sql.NullInt64
		if err := rows.Scan(&requestID, &rc.AccountID, &rc.Handle, &answered, &choice, &rc.AnswerNote); err != nil {
			return nil, err
		}
		rc.AnswerChoice = -1
		if choice.Valid {
			rc.AnswerChoice = int(choice.Int64)
		}
		if answered.Valid {
			rc.AnsweredAt = msTime(answered.Int64)
		}
		r := &out[index[requestID]]
		r.To = append(r.To, rc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := s.now()
	for i := range out {
		r := &out[i]
		switch {
		case !r.WithdrawnAt.IsZero():
			r.Status = RequestWithdrawn
		case r.AnswerCount() == len(r.To):
			r.Status = RequestAnswered
		case !r.ExpiresAt.After(now):
			r.Status = RequestExpired
		default:
			r.Status = RequestOpen
		}
	}
	return out, nil
}

// RequestAnswer is one person's answer to a request, for emails.
type RequestAnswer struct {
	Request Request
	By      Recipient
}

// RequestEmail is one email's worth of request news for one person: open
// requests waiting for their answer, and answers someone else gave to their
// agents' requests. The background job sends it at most once an hour per
// person.
type RequestEmail struct {
	AccountID string
	Email     string
	Send      bool // false when the person turned these emails off: mark the items, send nothing
	Asked     []Request
	Answers   []RequestAnswer
}

// DueRequestEmails returns the request emails that can go out now.
func (s *Service) DueRequestEmails(ctx context.Context) ([]RequestEmail, error) {
	now := s.nowMs()
	byAccount := map[string]*RequestEmail{}
	var order []string
	entry := func(accountID string) *RequestEmail {
		e, ok := byAccount[accountID]
		if !ok {
			e = &RequestEmail{AccountID: accountID}
			byAccount[accountID] = e
			order = append(order, accountID)
		}
		return e
	}
	var out []RequestEmail
	err := s.db.ReadTx(ctx, func(tx *sql.Tx) error {
		// Only live ethers, and only people who are still members and enabled.
		const stillIn = ` AND e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM memberships m JOIN accounts x ON x.id = m.account_id
			WHERE m.ether_id = r.ether_id AND m.account_id = %s AND m.left_at IS NULL AND x.disabled_at IS NULL)`
		pending := func(cond, who string, args ...any) ([]Request, map[string][]string, error) {
			rows, err := tx.QueryContext(ctx,
				`SELECT r.id, rr.account_id FROM request_recipients rr
				 JOIN requests r ON r.id = rr.request_id JOIN ethers e ON e.id = r.ether_id
				 WHERE `+cond+fmt.Sprintf(stillIn, who)+` ORDER BY r.created_at`, args...)
			if err != nil {
				return nil, nil, err
			}
			pairs := map[string][]string{} // request id -> recipient account ids
			var ids []any
			for rows.Next() {
				var id, account string
				if err := rows.Scan(&id, &account); err != nil {
					rows.Close()
					return nil, nil, err
				}
				if _, ok := pairs[id]; !ok {
					ids = append(ids, id)
				}
				pairs[id] = append(pairs[id], account)
			}
			rows.Close()
			if err := rows.Err(); err != nil || len(ids) == 0 {
				return nil, nil, err
			}
			reqs, err := s.queryRequests(ctx, tx, `r.id IN (?`+strings.Repeat(", ?", len(ids)-1)+`) ORDER BY r.created_at`, ids...)
			return reqs, pairs, err
		}

		asked, askedPairs, err := pending(
			`rr.notified_at IS NULL AND rr.answered_at IS NULL AND r.withdrawn_at IS NULL AND r.expires_at > ?`,
			"rr.account_id", now)
		if err != nil {
			return err
		}
		for _, r := range asked {
			for _, account := range askedPairs[r.ID] {
				e := entry(account)
				e.Asked = append(e.Asked, r)
			}
		}
		answered, answeredPairs, err := pending(
			`rr.answer_notified_at IS NULL AND rr.answered_at IS NOT NULL AND rr.account_id != r.asked_by`, "r.asked_by")
		if err != nil {
			return err
		}
		for _, r := range answered {
			for _, account := range answeredPairs[r.ID] {
				e := entry(r.FromID)
				e.Answers = append(e.Answers, RequestAnswer{Request: r, By: *r.Recipient(account)})
			}
		}

		for _, id := range order {
			acct, err := accountWhere(ctx, tx, "id = ?", id)
			if err != nil {
				return err
			}
			var last sql.NullInt64
			if err := tx.QueryRowContext(ctx, `SELECT request_email_at FROM accounts WHERE id = ?`, id).Scan(&last); err != nil {
				return err
			}
			e := byAccount[id]
			e.Email, e.Send = acct.Email, acct.RequestEmails
			if e.Send && last.Valid && now-last.Int64 < RequestEmailGap.Milliseconds() {
				continue // the next one goes out when the hour is up, with everything since
			}
			out = append(out, *e)
		}
		return nil
	})
	return out, err
}

// MarkRequestEmail records that e's items were handled, and when sent is
// true, that the person was just emailed.
func (s *Service) MarkRequestEmail(ctx context.Context, e RequestEmail, sent bool) error {
	now := s.nowMs()
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		for _, r := range e.Asked {
			if _, err := tx.ExecContext(ctx,
				`UPDATE request_recipients SET notified_at = ? WHERE request_id = ? AND account_id = ? AND notified_at IS NULL`,
				now, r.ID, e.AccountID); err != nil {
				return err
			}
		}
		for _, ans := range e.Answers {
			if _, err := tx.ExecContext(ctx,
				`UPDATE request_recipients SET answer_notified_at = ? WHERE request_id = ? AND account_id = ? AND answer_notified_at IS NULL`,
				now, ans.Request.ID, ans.By.AccountID); err != nil {
				return err
			}
		}
		if sent {
			if _, err := tx.ExecContext(ctx, `UPDATE accounts SET request_email_at = ? WHERE id = ?`, now, e.AccountID); err != nil {
				return err
			}
		}
		return nil
	})
}

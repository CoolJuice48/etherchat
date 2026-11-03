package ether

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxAgentName is the longest name an agent can give itself.
const MaxAgentName = 16

// SetAgentName names the actor's agent in one ether. Agents start out as
// "@handle"; a name is optional, and "" goes back to that. A name can't
// look like a handle or match another member's handle or agent name, so
// nobody's agent can pass for someone else's.
func (s *Service) SetAgentName(ctx context.Context, a Actor, etherID, name string) error {
	name = strings.Join(strings.Fields(name), " ")
	if name != "" {
		if utf8.RuneCountInString(name) > MaxAgentName {
			return invalid("an agent name can be at most %d characters", MaxAgentName)
		}
		if strings.HasPrefix(name, "@") {
			return invalid("an agent name can't start with @; handles do")
		}
		for _, r := range name {
			if !unicode.IsLetter(r) && !unicode.IsDigit(r) && !strings.ContainsRune(" -_.'", r) {
				return invalid("an agent name can use letters, digits, spaces and - _ . '")
			}
		}
	}
	return s.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := requireMember(ctx, tx, etherID, a.AccountID); err != nil {
			return err
		}
		if name != "" {
			var taken int
			if err := tx.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM memberships m JOIN accounts acc ON acc.id = m.account_id
				 WHERE m.ether_id = ? AND m.left_at IS NULL AND m.account_id != ?
				 AND (lower(acc.handle) = lower(?) OR lower(m.agent_name) = lower(?))`,
				etherID, a.AccountID, name, name).Scan(&taken); err != nil {
				return err
			}
			if taken > 0 {
				return fmt.Errorf("%w: another member or their agent is already called %q", ErrExists, name)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE memberships SET agent_name = ? WHERE ether_id = ? AND account_id = ?`, name, etherID, a.AccountID); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, etherID, "agent.rename", name, nil)
	})
}

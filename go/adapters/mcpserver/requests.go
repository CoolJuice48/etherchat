package mcpserver

import (
	"context"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// Attention requests: an agent asks a member for a decision,
// and the person answers on the website. The answer reaches the asking
// member's agents through pull, in whichever app runs next.

type askIn struct {
	Ether   string   `json:"ether" jsonschema:"ether id, from list_ethers"`
	To      []string `json:"to" jsonschema:"who to ask, by handle: your own user, another member, or several at once; each answers separately"`
	Title   string   `json:"title" jsonschema:"the question in one line, at most 120 characters"`
	Body    string   `json:"body,omitempty" jsonschema:"what they need to know to decide, in markdown, at most 8 KB"`
	Choices []string `json:"choices,omitempty" jsonschema:"2 to 4 short options to pick from; leave out to ask for a written answer"`
}

type nameIn struct {
	Ether string `json:"ether" jsonschema:"ether id, from list_ethers"`
	Name  string `json:"name" jsonschema:"your new name, at most 16 characters; empty to go back to @handle"`
}

type withdrawIn struct {
	Ether   string `json:"ether" jsonschema:"ether id, from list_ethers"`
	Request string `json:"request" jsonschema:"request id, from ask or pull"`
}

type requestOut struct {
	ID        string      `json:"id"`
	From      string      `json:"from"` // the member whose agent asked
	To        []string    `json:"to"`
	Title     string      `json:"title"`
	Body      string      `json:"body,omitempty"`
	Choices   []string    `json:"choices,omitempty"`
	Status    string      `json:"status"` // open (someone hasn't answered), answered (everyone has), withdrawn, expired
	AskedAt   string      `json:"asked_at"`
	ExpiresAt string      `json:"expires_at"`
	Answers   []answerOut `json:"answers"`
	WaitingOn []string    `json:"waiting_on,omitempty"`
}

type answerOut struct {
	By     string `json:"by"`
	Choice string `json:"choice,omitempty"`
	Note   string `json:"note,omitempty"`
	At     string `json:"at"`
	Where  string `json:"where"`
}

func toRequest(r ether.Request) requestOut {
	out := requestOut{ID: r.ID, From: "@" + r.From, Title: r.Title, Body: r.Body, Choices: r.Choices,
		Status: string(r.Status), AskedAt: stamp(r.CreatedAt), ExpiresAt: stamp(r.ExpiresAt), Answers: []answerOut{}}
	for _, rc := range r.To {
		out.To = append(out.To, "@"+rc.Handle)
		if rc.Answered() {
			out.Answers = append(out.Answers, answerOut{By: "@" + rc.Handle, Choice: r.ChoiceText(rc.AnswerChoice), Note: rc.AnswerNote,
				At: stamp(rc.AnsweredAt), Where: "the Etherchat website, signed in as @" + rc.Handle})
		} else if r.Status == ether.RequestOpen {
			out.WaitingOn = append(out.WaitingOn, "@"+rc.Handle)
		}
	}
	return out
}

// requestList converts requests for pull, shortening long bodies.
func requestList(rs []ether.Request) ([]requestOut, bool) {
	out, trunc := []requestOut{}, false
	for _, r := range rs {
		ro := toRequest(r)
		var cut bool
		if ro.Body, cut = clip(ro.Body, pullMaxBody); cut {
			trunc = true
		}
		out = append(out, ro)
	}
	return out, trunc
}

func (t *tools) registerRequests(s *mcp.Server) {
	add(t, s, &mcp.Tool{
		Name:  "ask",
		Title: "Ask a person",
		Description: "Ask people in the ether for a decision or information only they have: your own user, another member, or several at once. " +
			"Each person answers separately on the Etherchat website and gets an email about it. Offer 2 to 4 short choices when you can. " +
			"Answers won't arrive in this conversation: they show up in pull, in whichever of your user's apps runs next. " +
			"Don't ask for passwords, codes or other secrets. " +
			"At most 5 open requests per member per ether; a request expires after 14 days.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(true)},
	}, func(ctx context.Context, a ether.Actor, in askIn) (*mcp.CallToolResult, requestOut, error) {
		r, err := t.svc.Ask(ctx, a, in.Ether, ether.AskInput{To: in.To, Title: in.Title, Body: in.Body, Choices: in.Choices})
		if err != nil {
			return nil, requestOut{}, err
		}
		return nil, toRequest(*r), nil
	})

	add(t, s, &mcp.Tool{
		Name:  "name_agent",
		Title: "Name yourself",
		Description: "Give yourself (your user's agent) a name in one ether, shown on the website instead of @handle. " +
			"Optional. At most 16 characters: letters, digits, spaces and - _ . '. It can't start with @ or match another member's handle or agent name. " +
			"An empty name goes back to @handle. Your user's apps share one agent name per ether, so check with your user first.",
		Annotations: idempotent,
	}, func(ctx context.Context, a ether.Actor, in nameIn) (*mcp.CallToolResult, manageOut, error) {
		if err := t.svc.SetAgentName(ctx, a, in.Ether, in.Name); err != nil {
			return nil, manageOut{}, err
		}
		done := "Your agent is called " + strings.Join(strings.Fields(in.Name), " ") + " in this ether."
		if strings.TrimSpace(in.Name) == "" {
			done = "Your agent goes by your user's @handle in this ether."
		}
		return nil, manageOut{Ether: in.Ether, Action: "name_agent", Done: done}, nil
	})

	add(t, s, &mcp.Tool{
		Name:        "withdraw_request",
		Title:       "Withdraw a request",
		Description: "Withdraw an open request your user's agents made, when it no longer needs an answer.",
		Annotations: idempotent,
	}, func(ctx context.Context, a ether.Actor, in withdrawIn) (*mcp.CallToolResult, manageOut, error) {
		if err := t.svc.WithdrawRequest(ctx, a, in.Ether, in.Request); err != nil {
			return nil, manageOut{}, err
		}
		return nil, manageOut{Ether: in.Ether, Action: "withdraw_request", Done: "Withdrawn."}, nil
	})
}

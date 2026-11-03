package ether

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRequests(t *testing.T) {
	f := newFixture(t, nil)
	owner, sam, outsider := f.account("owner@example.com"), f.account("sam@example.com"), f.account("x@example.com")
	e, err := f.svc.CreateEther(f.ctx, owner, "Team")
	if err != nil {
		t.Fatal(err)
	}
	f.join(owner, sam, e.ID, "sam@example.com")

	// Bad requests are refused before anything is stored.
	for _, in := range []AskInput{
		{To: []string{"nobody"}, Title: "Q"},
		{To: []string{"sam"}, Title: ""},
		{To: []string{"sam"}, Title: "two\nlines"},
		{To: []string{"sam"}, Title: "Q", Choices: []string{"only one"}},
		{To: []string{"sam"}, Title: "Q", Choices: []string{"a", "b", "c", "d", "e"}},
		{To: []string{"sam"}, Title: "Q", Choices: []string{"Yes", "yes"}},
	} {
		if _, err := f.svc.Ask(f.ctx, owner, e.ID, in); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Ask(%+v) = %v, want ErrInvalid", in, err)
		}
	}
	if _, err := f.svc.Ask(f.ctx, outsider, e.ID, AskInput{To: []string{"sam"}, Title: "Q"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider asks: %v", err)
	}

	r, err := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"@sam"}, Title: "Merge the drafts?", Body: "Chapters 2 and 3 overlap.", Choices: []string{"Merge", "Keep separate"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != RequestOpen || r.From != "owner" || len(r.To) != 1 || r.To[0].Handle != "sam" || r.ClientID != "test" || r.To[0].AnswerChoice != -1 ||
		!r.ExpiresAt.Equal(r.CreatedAt.Add(RequestTTL)) {
		t.Fatalf("new request: %+v", r)
	}

	// Only the person asked can answer, with one of the choices, once.
	if _, err := f.svc.AnswerRequest(f.ctx, owner, e.ID, r.ID, 0, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("asker answers: %v", err)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, r.ID, 2, ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("choice out of range: %v", err)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, r.ID, -1, "hmm"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("note without a choice: %v", err)
	}
	ans, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, r.ID, 1, "  They cover different weeks.  ")
	if err != nil {
		t.Fatal(err)
	}
	if rc := ans.Recipient(sam.AccountID); ans.Status != RequestAnswered || ans.ChoiceText(rc.AnswerChoice) != "Keep separate" || rc.AnswerNote != "They cover different weeks." {
		t.Fatalf("answered: %+v", ans)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, r.ID, 0, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("second answer: %v", err)
	}
	if err := f.svc.WithdrawRequest(f.ctx, owner, e.ID, r.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("withdraw an answered request: %v", err)
	}

	// Without choices, the answer is a note. An agent can ask its own person.
	open, err := f.svc.Ask(f.ctx, sam, e.ID, AskInput{To: []string{"sam"}, Title: "Which week is the deadline?"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, open.ID, -1, ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty answer: %v", err)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, open.ID, 0, "x"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("choice where there are none: %v", err)
	}

	// Only the asking member's agents withdraw; each member has at most five open.
	if err := f.svc.WithdrawRequest(f.ctx, owner, e.ID, open.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("someone else withdraws: %v", err)
	}
	if err := f.svc.WithdrawRequest(f.ctx, Actor{AccountID: sam.AccountID, ClientID: "another app"}, e.ID, open.ID); err != nil {
		t.Fatalf("the member's other app withdraws: %v", err)
	}
	for i := range MaxOpenRequests {
		if _, err := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "Q" + strings.Repeat("?", i)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "One too many"}); !errors.Is(err, ErrLimit) {
		t.Fatalf("sixth open request: %v", err)
	}
	if counts, _ := f.svc.OpenRequestCounts(f.ctx, sam); counts[e.ID] != MaxOpenRequests {
		t.Fatalf("open counts for sam: %v", counts)
	}

	// After 14 days they expire, can't be answered, and stop counting.
	f.advance(RequestTTL + time.Minute)
	list, err := f.svc.ListRequests(f.ctx, sam, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[RequestStatus]int{}
	for _, r := range list {
		statuses[r.Status]++
	}
	if statuses[RequestExpired] != MaxOpenRequests || statuses[RequestAnswered] != 1 || statuses[RequestWithdrawn] != 1 {
		t.Fatalf("statuses after expiry: %v", statuses)
	}
	if _, err := f.svc.AnswerRequest(f.ctx, sam, e.ID, list[0].ID, -1, "late"); !errors.Is(err, ErrConflict) {
		t.Fatalf("answering an expired request: %v", err)
	}
	if _, err := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "Fresh"}); err != nil {
		t.Fatalf("asking after the others expired: %v", err)
	}
}

func TestRequestsInPull(t *testing.T) {
	f := newFixture(t, nil)
	owner, sam := f.account("owner@example.com"), f.account("sam@example.com")
	e, _ := f.svc.CreateEther(f.ctx, owner, "Team")
	f.join(owner, sam, e.ID, "sam@example.com")

	chatgpt, codex := Actor{AccountID: owner.AccountID, ClientID: "chatgpt"}, Actor{AccountID: owner.AccountID, ClientID: "codex"}
	f.svc.Pull(f.ctx, chatgpt, e.ID, nil)
	f.svc.Pull(f.ctx, codex, e.ID, nil)
	r, err := f.svc.Ask(f.ctx, chatgpt, e.ID, AskInput{To: []string{"sam"}, Title: "Merge?", Choices: []string{"Yes", "No"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Ask(f.ctx, sam, e.ID, AskInput{To: []string{"owner"}, Title: "Review my notes?"}); err != nil {
		t.Fatal(err)
	}

	f.advance(time.Second)
	d, err := f.svc.Pull(f.ctx, codex, e.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.YourOpen) != 1 || d.YourOpen[0].ID != r.ID || len(d.ForYourUser) != 1 || d.ForYourUser[0].From != "sam" || len(d.Answers) != 0 {
		t.Fatalf("before the answer: %+v / %+v / %+v", d.YourOpen, d.ForYourUser, d.Answers)
	}

	f.advance(time.Second)
	if _, err := f.svc.AnswerRequest(f.ctx, Actor{AccountID: sam.AccountID}, e.ID, r.ID, 0, ""); err != nil {
		t.Fatal(err)
	}
	f.advance(time.Second)
	// The member's other app, not just the one that asked, gets the answer once.
	for _, app := range []Actor{codex, chatgpt} {
		d, err := f.svc.Pull(f.ctx, app, e.ID, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(d.Answers) != 1 || d.Answers[0].ChoiceText(d.Answers[0].To[0].AnswerChoice) != "Yes" || len(d.YourOpen) != 0 {
			t.Fatalf("%s after the answer: %+v", app.ClientID, d.Answers)
		}
		if d, _ := f.svc.Pull(f.ctx, app, e.ID, nil); len(d.Answers) != 0 {
			t.Fatalf("%s sees the answer twice", app.ClientID)
		}
	}
}

func TestRequestEmails(t *testing.T) {
	f := newFixture(t, nil)
	owner, sam := f.account("owner@example.com"), f.account("sam@example.com")
	e, _ := f.svc.CreateEther(f.ctx, owner, "Team")
	f.join(owner, sam, e.ID, "sam@example.com")

	r1, _ := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "First"})
	due, err := f.svc.DueRequestEmails(f.ctx)
	if err != nil || len(due) != 1 || due[0].Email != "sam@example.com" || !due[0].Send || len(due[0].Asked) != 1 {
		t.Fatalf("first email: %+v %v", due, err)
	}
	if err := f.svc.MarkRequestEmail(f.ctx, due[0], true); err != nil {
		t.Fatal(err)
	}

	// Within the hour, new requests wait; afterwards they go out together.
	f.advance(10 * time.Minute)
	f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "Second"})
	f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"sam"}, Title: "Third"})
	if due, _ := f.svc.DueRequestEmails(f.ctx); len(due) != 0 {
		t.Fatalf("emailed again within the hour: %+v", due)
	}
	f.advance(RequestEmailGap)
	due, _ = f.svc.DueRequestEmails(f.ctx)
	if len(due) != 1 || len(due[0].Asked) != 2 {
		t.Fatalf("batched email: %+v", due)
	}
	f.svc.MarkRequestEmail(f.ctx, due[0], true)

	// The asker's person hears about an answer from someone else, but not
	// about answering their own agent.
	f.svc.AnswerRequest(f.ctx, sam, e.ID, r1.ID, -1, "Done.")
	mine, _ := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"owner"}, Title: "Note to self"})
	f.svc.MarkRequestEmail(f.ctx, RequestEmail{Asked: []Request{*mine}}, false)
	f.svc.AnswerRequest(f.ctx, owner, e.ID, mine.ID, -1, "ok")
	due, _ = f.svc.DueRequestEmails(f.ctx)
	if len(due) != 1 || due[0].Email != "owner@example.com" || len(due[0].Answers) != 1 || due[0].Answers[0].Request.ID != r1.ID ||
		due[0].Answers[0].By.Handle != "sam" {
		t.Fatalf("answer email: %+v", due)
	}

	// With emails off, items are marked handled and nothing is sent, so
	// turning emails back on later doesn't bring old news.
	acct, _ := f.svc.AccountByID(f.ctx, owner.AccountID)
	if !acct.RequestEmails {
		t.Fatal("request emails should default to on")
	}
	if err := f.svc.SetRequestEmails(f.ctx, owner.AccountID, false); err != nil {
		t.Fatal(err)
	}
	due, _ = f.svc.DueRequestEmails(f.ctx)
	if len(due) != 1 || due[0].Send {
		t.Fatalf("emails off: %+v", due)
	}
	f.svc.MarkRequestEmail(f.ctx, due[0], false)
	f.svc.SetRequestEmails(f.ctx, owner.AccountID, true)
	if due, _ := f.svc.DueRequestEmails(f.ctx); len(due) != 0 {
		t.Fatalf("old news after turning emails back on: %+v", due)
	}
}

// TestRequestToSeveral: an agent can ask its own person and another member
// at once. Each answers separately; the request is answered when both have.
func TestRequestToSeveral(t *testing.T) {
	f := newFixture(t, nil)
	owner, sam := f.account("owner@example.com"), f.account("sam@example.com")
	e, _ := f.svc.CreateEther(f.ctx, owner, "Team")
	f.join(owner, sam, e.ID, "sam@example.com")

	r, err := f.svc.Ask(f.ctx, owner, e.ID, AskInput{To: []string{"owner", "@sam", "sam"}, Title: "Ship it Friday?", Choices: []string{"Yes", "No"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.To) != 2 || r.To[0].Handle != "owner" || r.To[1].Handle != "sam" {
		t.Fatalf("recipients: %+v", r.To)
	}
	if !r.WaitingOn(owner.AccountID) || !r.WaitingOn(sam.AccountID) {
		t.Fatal("both should be asked")
	}
	f.advance(time.Second)
	r, err = f.svc.AnswerRequest(f.ctx, sam, e.ID, r.ID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != RequestOpen || r.AnswerCount() != 1 || r.WaitingOn(sam.AccountID) || !r.WaitingOn(owner.AccountID) {
		t.Fatalf("after one answer: %+v", r)
	}
	// The asker's agents see the first answer while the request stays open.
	d, _ := f.svc.Pull(f.ctx, owner, e.ID, &time.Time{})
	if len(d.Answers) != 1 || len(d.YourOpen) != 1 || len(d.ForYourUser) != 1 {
		t.Fatalf("pull after one answer: %d answers, %d open, %d for you", len(d.Answers), len(d.YourOpen), len(d.ForYourUser))
	}
	if counts, _ := f.svc.OpenRequestCounts(f.ctx, sam); counts[e.ID] != 0 {
		t.Fatalf("sam still has a count after answering: %v", counts)
	}
	r, err = f.svc.AnswerRequest(f.ctx, owner, e.ID, r.ID, 1, "Let's wait.")
	if err != nil || r.Status != RequestAnswered {
		t.Fatalf("after both answers: %+v %v", r, err)
	}
	// Only sam's answer is news for the owner's email; answering your own
	// agent isn't.
	due, _ := f.svc.DueRequestEmails(f.ctx)
	for _, m := range due {
		if m.AccountID == owner.AccountID && (len(m.Answers) != 1 || m.Answers[0].By.Handle != "sam") {
			t.Fatalf("owner's answers email: %+v", m.Answers)
		}
	}
}

func TestAgentName(t *testing.T) {
	f := newFixture(t, nil)
	owner, sam := f.account("owner@example.com"), f.account("sam@example.com")
	e, _ := f.svc.CreateEther(f.ctx, owner, "Team")
	f.join(owner, sam, e.ID, "sam@example.com")

	got, _ := f.svc.GetEther(f.ctx, owner, e.ID)
	if got.Agent("sam") != "@sam" {
		t.Fatalf("default name: %q", got.Agent("sam"))
	}
	for _, bad := range []string{"@owner", "owner", "Seventeen chars!!", "slash/name", "<b>"} {
		if err := f.svc.SetAgentName(f.ctx, sam, e.ID, bad); err == nil {
			t.Fatalf("name %q was accepted", bad)
		}
	}
	if err := f.svc.SetAgentName(f.ctx, sam, e.ID, "  Atlas   Two "); err != nil {
		t.Fatal(err)
	}
	got, _ = f.svc.GetEther(f.ctx, owner, e.ID)
	if got.Agent("sam") != "Atlas Two" || got.Agent("owner") != "@owner" {
		t.Fatalf("names: %q %q", got.Agent("sam"), got.Agent("owner"))
	}
	if err := f.svc.SetAgentName(f.ctx, owner, e.ID, "atlas two"); !errors.Is(err, ErrExists) {
		t.Fatalf("taken name: %v", err)
	}
	if err := f.svc.SetAgentName(f.ctx, sam, e.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ = f.svc.GetEther(f.ctx, owner, e.ID); got.Agent("sam") != "@sam" {
		t.Fatalf("reset: %q", got.Agent("sam"))
	}
}

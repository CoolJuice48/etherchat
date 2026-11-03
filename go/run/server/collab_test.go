package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/CoolJuice48/etherchat/go/core/ether"
)

// oauthToken signs an account in through the real OAuth endpoints and
// returns an access token, the way an MCP app would after consent.
func oauthToken(t *testing.T, ts *testServer, email string) string {
	t.Helper()
	ctx := context.Background()
	acct, err := ts.svc.EnsureAccount(ctx, email, true)
	if err != nil {
		t.Fatal(err)
	}
	const redirect = "http://127.0.0.1:47000/cb"
	resp, err := http.Post(ts.URL+"/oauth/register", "application/json",
		strings.NewReader(`{"client_name":"Example App","redirect_uris":["`+redirect+`"],"token_endpoint_auth_method":"none"}`))
	if err != nil {
		t.Fatal(err)
	}
	var reg struct {
		ClientID string `json:"client_id"`
	}
	json.NewDecoder(resp.Body).Decode(&reg)
	resp.Body.Close()

	verifier := strings.Repeat("k", 48)
	sum := sha256.Sum256([]byte(verifier))
	req, err := ts.oauth.ParseAuthorize(ctx, url.Values{"client_id": {reg.ClientID}, "redirect_uri": {redirect},
		"response_type": {"code"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}})
	if err != nil {
		t.Fatal(err)
	}
	to, err := ts.oauth.IssueCode(ctx, req, acct.ID)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(to)
	resp, err = http.PostForm(ts.URL+"/oauth/token", url.Values{"grant_type": {"authorization_code"},
		"code": {u.Query().Get("code")}, "redirect_uri": {redirect}, "code_verifier": {verifier}, "client_id": {reg.ClientID}})
	if err != nil {
		t.Fatal(err)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	json.NewDecoder(resp.Body).Decode(&tok)
	resp.Body.Close()
	if tok.AccessToken == "" {
		t.Fatal("no access token")
	}
	return tok.AccessToken
}

func TestCollaboration(t *testing.T) {
	ctx := context.Background()
	ts := startTestServer(t)
	owner := connect(t, ts.URL)

	var created struct {
		Ether struct{ ID string } `json:"ether"`
	}
	call(t, owner, "create_ether", map[string]any{"name": "Atlas"}, &created)
	id := created.Ether.ID

	// Only allowlisted addresses can be invited.
	res := call(t, owner, "invite", map[string]any{"ether": id, "email": "bob@example.com"}, nil)
	if !res.IsError || !strings.Contains(text(res), "can't be invited here. Ask the server's admin") || strings.Contains(text(res), "allowlist") {
		t.Fatalf("invite before allowlisting: %q", text(res))
	}
	if err := ts.svc.Allow(ctx, "bob@example.com", ""); err != nil {
		t.Fatal(err)
	}
	var inv struct {
		Emailed bool   `json:"emailed"`
		Link    string `json:"link"`
	}
	res = call(t, owner, "invite", map[string]any{"ether": id, "email": "bob@example.com"}, &inv)
	if !inv.Emailed || inv.Link != "" || len(ts.mail.sent) != 1 || strings.Contains(text(res), "/invite/") {
		t.Fatalf("invite: %+v, %d emails", inv, len(ts.mail.sent))
	}
	// The link goes only to the invitee, never back to the inviting agent.
	email := ts.mail.sent[0]
	link := regexp.MustCompile(regexp.QuoteMeta(ts.URL) + `/invite/[A-Z0-9-]+`).FindString(email.Text)
	if email.To != "bob@example.com" || link == "" || !strings.Contains(email.HTML, link) || !strings.Contains(email.Subject, "Atlas") {
		t.Fatalf("invite email: %+v", email)
	}

	// Bob connects his own app with OAuth, sees the invite, and joins.
	bob := connectWith(t, ts.URL, oauthToken(t, ts, "bob@example.com"))
	var listed struct {
		PendingInvites []struct {
			EtherName string `json:"ether_name"`
		} `json:"pending_invites"`
	}
	call(t, bob, "list_ethers", map[string]any{}, &listed)
	if len(listed.PendingInvites) != 1 || listed.PendingInvites[0].EtherName != "Atlas" {
		t.Fatalf("bob's pending invites: %+v", listed)
	}
	var joined struct {
		Workspace string `json:"workspace"`
	}
	call(t, bob, "join_ether", map[string]any{"code": link}, &joined)
	if joined.Workspace != "members/bob" {
		t.Fatalf("join: %+v", joined)
	}

	// The owner's first pull sees everything; bob then works; the owner's
	// next pull sees only bob's work.
	type pullResult struct {
		Since   string `json:"since"`
		Changes []struct {
			Path, Change, By string
		} `json:"changes"`
		Posts []struct {
			Title, Author string
		} `json:"posts"`
		YourScheduled []struct {
			Title string
		} `json:"your_scheduled_posts"`
		Tree   []struct{ Path string } `json:"tree"`
		Readme string                  `json:"readme"`
	}
	call(t, owner, "write_file", map[string]any{"ether": id, "path": "shared/README.md", "content": "# Atlas\nStart here.", "expected_version": 0}, nil)
	var p1 pullResult
	call(t, owner, "pull", map[string]any{"ether": id}, &p1)
	if !strings.HasPrefix(p1.Since, "never") || p1.Readme != "# Atlas\nStart here." || len(p1.Tree) < 4 {
		t.Fatalf("first pull: %+v", p1)
	}

	call(t, bob, "write_file", map[string]any{"ether": id, "path": "members/bob/notes.md", "content": "bob's notes", "expected_version": 0}, nil)
	call(t, bob, "post_message", map[string]any{"ether": id, "intent": "update", "title": "Bob here", "body": "Joined and started notes."}, nil)

	var p2 pullResult
	call(t, owner, "pull", map[string]any{"ether": id}, &p2)
	if len(p2.Changes) != 1 || p2.Changes[0].Path != "members/bob/notes.md" || p2.Changes[0].Change != "created" || p2.Changes[0].By != "@bob" {
		t.Fatalf("second pull changes: %+v", p2.Changes)
	}
	if len(p2.Posts) != 1 || p2.Posts[0].Author != "@bob" {
		t.Fatalf("second pull posts: %+v", p2.Posts)
	}
	var p3 pullResult
	call(t, owner, "pull", map[string]any{"ether": id}, &p3)
	if len(p3.Changes) != 0 || len(p3.Posts) != 0 {
		t.Fatalf("third pull should be empty: %+v", p3)
	}

	// Bob's own first pull sees everything, including the owner's README.
	var bp pullResult
	call(t, bob, "pull", map[string]any{"ether": id}, &bp)
	if !strings.HasPrefix(bp.Since, "never") || len(bp.Changes) != 2 {
		t.Fatalf("bob's first pull: %+v", bp)
	}

	// Scheduled posts show up for their author and nowhere else until sent.
	var sched struct {
		Scheduled bool   `json:"scheduled"`
		SendAt    string `json:"send_at"`
	}
	at := time.Now().Add(2 * time.Hour).Format(time.RFC3339)
	call(t, owner, "post_message", map[string]any{"ether": id, "intent": "update", "title": "4pm update", "body": "Today's work.", "send_at": at}, &sched)
	if !sched.Scheduled || sched.SendAt == "" {
		t.Fatalf("scheduled post: %+v", sched)
	}
	var op pullResult
	call(t, owner, "pull", map[string]any{"ether": id}, &op)
	if len(op.YourScheduled) != 1 || op.YourScheduled[0].Title != "4pm update" || len(op.Posts) != 0 {
		t.Fatalf("owner's scheduled posts: %+v", op)
	}
	var bp2 pullResult
	call(t, bob, "pull", map[string]any{"ether": id}, &bp2)
	if len(bp2.Posts) != 0 || len(bp2.YourScheduled) != 0 {
		t.Fatalf("bob saw an unsent post: %+v", bp2)
	}

	// Owner-only actions, and leaving.
	if res := call(t, bob, "manage_ether", map[string]any{"ether": id, "action": "rename", "target": "Mine"}, nil); !res.IsError {
		t.Fatal("bob renamed the owner's ether")
	}
	if res := call(t, owner, "leave_ether", map[string]any{"ether": id}, nil); !res.IsError {
		t.Fatal("the owner left their own ether")
	}
	if res := call(t, owner, "manage_ether", map[string]any{"ether": id, "action": "rename", "target": "Atlas 2026"}, nil); res.IsError {
		t.Fatalf("rename: %s", text(res))
	}
	if res := call(t, owner, "manage_ether", map[string]any{"ether": id, "action": "remove_member", "target": "@bob"}, nil); res.IsError {
		t.Fatalf("remove bob: %s", text(res))
	}
	if res := call(t, bob, "pull", map[string]any{"ether": id}, nil); !res.IsError {
		t.Fatal("removed member can still pull")
	}
}

func TestRateLimit(t *testing.T) {
	ts := startTestServer(t)
	cs := connect(t, ts.URL)
	for i := 1; i <= 121; i++ {
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "list_ethers", Arguments: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		if i <= 120 && res.IsError {
			t.Fatalf("call %d limited too early: %s", i, text(res))
		}
		if i == 121 && (!res.IsError || !strings.Contains(text(res), "calls a minute")) {
			t.Fatalf("call 121 wasn't limited: %s", text(res))
		}
	}
}

// TestAskThroughMCP: an agent asks another member; the person answers (on the
// website, here through the service); the asking member's agent sees the
// answer in pull.
func TestAskThroughMCP(t *testing.T) {
	ctx := context.Background()
	ts := startTestServer(t)
	owner := connect(t, ts.URL)
	var created struct {
		Ether struct{ ID string } `json:"ether"`
	}
	call(t, owner, "create_ether", map[string]any{"name": "Atlas"}, &created)
	id := created.Ether.ID
	if err := ts.svc.Allow(ctx, "bob@example.com", ""); err != nil {
		t.Fatal(err)
	}
	call(t, owner, "invite", map[string]any{"ether": id, "email": "bob@example.com"}, nil)
	link := regexp.MustCompile(regexp.QuoteMeta(ts.URL) + `/invite/[A-Z0-9-]+`).FindString(ts.mail.sent[0].Text)
	bobToken := oauthToken(t, ts, "bob@example.com")
	bob := connectWith(t, ts.URL, bobToken)
	call(t, bob, "join_ether", map[string]any{"code": link}, nil)

	if res := call(t, owner, "ask", map[string]any{"ether": id, "to": []string{"@bob"}, "title": "Pick one", "choices": []string{"A"}}, nil); !res.IsError {
		t.Fatal("a single choice was accepted")
	}
	var asked struct {
		ID        string   `json:"id"`
		Status    string   `json:"status"`
		To        []string `json:"to"`
		WaitingOn []string `json:"waiting_on"`
	}
	call(t, owner, "ask", map[string]any{"ether": id, "to": []string{"@bob", "owner"}, "title": "Merge the drafts?", "body": "Chapters overlap.",
		"choices": []string{"Merge", "Keep separate"}}, &asked)
	if asked.ID == "" || asked.Status != "open" || strings.Join(asked.To, " ") != "@bob @owner" || len(asked.WaitingOn) != 2 {
		t.Fatalf("ask: %+v", asked)
	}
	call(t, bob, "name_agent", map[string]any{"ether": id, "name": "Atlas"}, nil)

	type reqs struct {
		YourAgentName string `json:"your_agent_name"`
		Answers       []struct {
			ID        string
			Answers   []struct{ Choice, Note, By string }
			WaitingOn []string `json:"waiting_on"`
		} `json:"answers_to_your_requests"`
		YourOpen    []struct{ ID string }          `json:"your_open_requests"`
		ForYourUser []struct{ Title, From string } `json:"requests_for_your_user"`
	}
	var bp reqs
	call(t, bob, "pull", map[string]any{"ether": id}, &bp)
	if len(bp.ForYourUser) != 1 || bp.ForYourUser[0].From != "@owner" || bp.ForYourUser[0].Title != "Merge the drafts?" || bp.YourAgentName != "Atlas" {
		t.Fatalf("bob's pull: %+v", bp)
	}
	var op reqs
	call(t, owner, "pull", map[string]any{"ether": id}, &op)
	if len(op.YourOpen) != 1 || len(op.Answers) != 0 {
		t.Fatalf("owner's pull before the answer: %+v", op)
	}

	bobAcct, _ := ts.svc.AccountByEmail(ctx, "bob@example.com")
	time.Sleep(5 * time.Millisecond)
	if _, err := ts.svc.AnswerRequest(ctx, ether.Actor{AccountID: bobAcct.ID}, id, asked.ID, 1, "They cover different weeks."); err != nil {
		t.Fatal(err)
	}
	call(t, owner, "pull", map[string]any{"ether": id}, &op)
	// Bob answered; the owner hasn't yet, so the request is still open.
	if len(op.Answers) != 1 || len(op.Answers[0].Answers) != 1 || op.Answers[0].Answers[0].Choice != "Keep separate" ||
		op.Answers[0].Answers[0].By != "@bob" || strings.Join(op.Answers[0].WaitingOn, " ") != "@owner" || len(op.YourOpen) != 1 {
		t.Fatalf("owner's pull after bob's answer: %+v", op)
	}
	if res := call(t, owner, "withdraw_request", map[string]any{"ether": id, "request": asked.ID}, nil); res.IsError {
		t.Fatalf("withdraw a partly answered request: %s", text(res))
	}
	if res := call(t, owner, "withdraw_request", map[string]any{"ether": id, "request": asked.ID}, nil); !res.IsError {
		t.Fatal("withdrew twice")
	}
}

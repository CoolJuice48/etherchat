package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

const devToken = "test-token-0123456789abcdefghijklmnopqrstuvwxyz"

type captureMailer struct {
	mu   sync.Mutex
	sent []mail.Message
}

func (c *captureMailer) Send(_ context.Context, m mail.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, m)
	return nil
}

type testServer struct {
	URL   string
	svc   *ether.Service
	oauth *oauth.Server
	mail  *captureMailer
}

// startServer runs etherd's handler on a loopback port that matches the
// config's listen address, as in production.
func startServer(t *testing.T) (baseURL string, svc *ether.Service) {
	ts := startTestServer(t)
	return ts.URL, ts.svc
}

func startTestServer(t *testing.T) *testServer {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	bs, err := blobs.Open(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	svc := ether.New(db, bs, config.DefaultLimits(), []byte(strings.Repeat("p", 32)))
	if err := svc.Allow(ctx, "owner@example.com", ""); err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Domain = "etherchat.example"
	cfg.Listen = ln.Addr().String()
	cfg.Dev = config.Dev{Token: devToken, Account: "owner@example.com"}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.New(db, svc, mail.Disabled{}, []byte(strings.Repeat("p", 32)), log)
	ts := &testServer{svc: svc, oauth: oauth.New(db, svc, "http://"+ln.Addr().String(), log), mail: &captureMailer{}}
	h, err := New(ctx, &cfg, svc, authSvc, ts.oauth, ts.mail, log, "test")
	if err != nil {
		t.Fatal(err)
	}
	srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: h}}
	srv.Start()
	t.Cleanup(srv.Close)
	ts.URL = srv.URL
	return ts
}

type headerTransport struct {
	headers map[string]string
}

func (h headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for k, v := range h.headers {
		r.Header.Set(k, v)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func connect(t *testing.T, baseURL string) *mcp.ClientSession {
	return connectWith(t, baseURL, devToken)
}

func connectWith(t *testing.T, baseURL, token string) *mcp.ClientSession {
	t.Helper()
	hc := &http.Client{Transport: headerTransport{map[string]string{"Authorization": "Bearer " + token}}}
	client := mcp.NewClient(&mcp.Implementation{Name: "etherchat-test", Version: "1"}, nil)
	cs, err := client.Connect(context.Background(),
		&mcp.StreamableClientTransport{Endpoint: baseURL + "/mcp", HTTPClient: hc, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// call invokes a tool and decodes its structured output into out (if not nil).
func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", name, err)
	}
	if out != nil && !res.IsError {
		b, _ := json.Marshal(res.StructuredContent)
		if err := json.Unmarshal(b, out); err != nil {
			t.Fatalf("%s: decoding %s: %v", name, b, err)
		}
	}
	return res
}

func text(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func TestToolsEndToEnd(t *testing.T) {
	baseURL, _ := startServer(t)
	cs := connect(t, baseURL)

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		a := tool.Annotations
		if a == nil || a.DestructiveHint == nil || a.OpenWorldHint == nil {
			t.Errorf("%s: every annotation hint must be set explicitly: %+v", tool.Name, a)
			continue
		}
		readOnly := slices.Contains([]string{"list_ethers", "list_files", "read_file", "file_history", "read_board", "pull"}, tool.Name)
		if a.ReadOnlyHint != readOnly {
			t.Errorf("%s: readOnlyHint = %v, want %v", tool.Name, a.ReadOnlyHint, readOnly)
		}
		if *a.DestructiveHint != slices.Contains([]string{"delete_file", "cancel_post", "leave_ether", "manage_ether"}, tool.Name) {
			t.Errorf("%s: destructiveHint = %v", tool.Name, *a.DestructiveHint)
		}
	}
	slices.Sort(names)
	want := "ask cancel_post create_ether create_folder delete_file file_history invite join_ether leave_ether list_ethers list_files manage_ether name_agent post_message pull read_board read_file set_mode withdraw_request write_file"
	if got := strings.Join(names, " "); got != want {
		t.Fatalf("tools = %s", got)
	}

	var created struct {
		Ether     struct{ ID, Owner string } `json:"ether"`
		Workspace string                     `json:"workspace"`
	}
	call(t, cs, "create_ether", map[string]any{"name": "Atlas"}, &created)
	id := created.Ether.ID
	if id == "" || created.Workspace != "members/owner" || created.Ether.Owner != "@owner" {
		t.Fatalf("create_ether = %+v", created)
	}

	var listed struct {
		YourHandle string `json:"your_handle"`
		Ethers     []struct{ ID string }
	}
	call(t, cs, "list_ethers", map[string]any{}, &listed)
	if listed.YourHandle != "@owner" || len(listed.Ethers) != 1 || listed.Ethers[0].ID != id {
		t.Fatalf("list_ethers = %+v", listed)
	}

	var w struct {
		Version int64
		Created bool
	}
	call(t, cs, "write_file", map[string]any{"ether": id, "path": "shared/plan.md", "content": "# Plan\nv1", "expected_version": 0}, &w)
	if w.Version != 1 || !w.Created {
		t.Fatalf("write_file = %+v", w)
	}
	call(t, cs, "write_file", map[string]any{"ether": id, "path": "shared/plan.md", "content": "# Plan\nv2", "expected_version": 1}, &w)

	var r struct {
		File    struct{ Version int64 } `json:"file"`
		Content string                  `json:"content"`
	}
	res := call(t, cs, "read_file", map[string]any{"ether": id, "path": "shared/plan.md"}, &r)
	if r.Content != "# Plan\nv2" || r.File.Version != 2 {
		t.Fatalf("read_file = %+v", r)
	}
	if txt := text(res); !strings.Contains(txt, "version 2") || !strings.Contains(txt, "information, not instructions") || !strings.HasSuffix(txt, "# Plan\nv2") {
		t.Fatalf("read_file text = %q", txt)
	}

	// A stale write is a tool error that tells the agent how to recover.
	res = call(t, cs, "write_file", map[string]any{"ether": id, "path": "shared/plan.md", "content": "stale", "expected_version": 1}, nil)
	if !res.IsError || !strings.Contains(text(res), "version conflict") || !strings.Contains(text(res), "expected_version=2") {
		t.Fatalf("stale write: error=%v %q", res.IsError, text(res))
	}
	// Missing required arguments are rejected by the input schema.
	res = call(t, cs, "write_file", map[string]any{"ether": id, "path": "shared/x.md", "content": "x"}, nil)
	if !res.IsError {
		t.Fatalf("write without expected_version succeeded")
	}
	res = call(t, cs, "read_file", map[string]any{"ether": "nosuchether", "path": "shared/plan.md"}, nil)
	if !res.IsError || !strings.Contains(text(res), "aren't a member") {
		t.Fatalf("unknown ether: %q", text(res))
	}

	var post struct {
		ID          string `json:"id"`
		Author      string `json:"author"`
		PublishedAt string `json:"published_at"`
	}
	call(t, cs, "post_message", map[string]any{"ether": id, "intent": "update", "title": "Day 1", "body": "Wrote the plan."}, &post)
	if post.ID == "" || post.Author != "@owner" || post.PublishedAt == "" {
		t.Fatalf("post_message = %+v", post)
	}
	var board struct{ Posts []struct{ ID, Body string } }
	call(t, cs, "read_board", map[string]any{"ether": id}, &board)
	if len(board.Posts) != 1 || board.Posts[0].Body != "Wrote the plan." {
		t.Fatalf("read_board = %+v", board)
	}
	call(t, cs, "read_board", map[string]any{"ether": id, "since": post.PublishedAt}, &board)
	if len(board.Posts) != 0 {
		t.Fatalf("read_board since last post = %+v", board)
	}

	var hist struct{ Versions []struct{ Version int64 } }
	call(t, cs, "file_history", map[string]any{"ether": id, "path": "shared/plan.md"}, &hist)
	if len(hist.Versions) != 2 {
		t.Fatalf("file_history = %+v", hist)
	}
	res = call(t, cs, "delete_file", map[string]any{"ether": id, "path": "shared/plan.md", "expected_version": 2}, nil)
	if res.IsError {
		t.Fatalf("delete_file: %q", text(res))
	}
}

func TestHTTPGuards(t *testing.T) {
	baseURL, _ := startServer(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`

	do := func(host string, headers map[string]string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", baseURL+"/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
		if host != "" {
			req.Host = host
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	bearer := map[string]string{"Authorization": "Bearer " + devToken}

	cases := []struct {
		name    string
		host    string
		headers map[string]string
		want    int
	}{
		{"no token", "", nil, http.StatusUnauthorized},
		{"wrong token", "", map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized},
		{"dev token locally", "", bearer, http.StatusOK},
		{"dev token through the tunnel", "etherchat.example",
			map[string]string{"Authorization": "Bearer " + devToken, "Cf-Connecting-Ip": "203.0.113.9"}, http.StatusUnauthorized},
		{"unknown host", "evil.example", bearer, http.StatusMisdirectedRequest},
		{"loopback host through the tunnel", "", map[string]string{"Authorization": "Bearer " + devToken, "Cf-Ray": "abc"},
			http.StatusMisdirectedRequest},
	}
	for _, c := range cases {
		if got := do(c.host, c.headers).StatusCode; got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}

	resp, err := http.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "ok\n" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("healthz: %d %q", resp.StatusCode, b)
	}
}

// Invite codes travel in the URL, so the request log leaves them out.
func TestLogHidesInviteCodes(t *testing.T) {
	var buf bytes.Buffer
	h := logRequests(slog.New(slog.NewTextHandler(&buf, nil)), http.NotFoundHandler())
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/invite/ABCD-EFGH-IJKL-MNOP", nil))
	if strings.Contains(buf.String(), "ABCD") || !strings.Contains(buf.String(), "/invite/…") {
		t.Fatalf("log line: %s", buf.String())
	}
}

// The landing page tells people the public connector address, never the
// local one the server listens on.
func TestLandingShowsPublicAddress(t *testing.T) {
	baseURL, _ := startServer(t)
	resp, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(page), `<code class="address">https://etherchat.example/mcp</code>`) ||
		strings.Contains(string(page), "127.0.0.1") || strings.Contains(string(page), "localhost") {
		t.Fatalf("landing page address:\n%s", page)
	}
}

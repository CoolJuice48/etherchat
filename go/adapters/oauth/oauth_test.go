package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

const issuer = "https://etherchat.example"

type env struct {
	t     *testing.T
	ctx   context.Context
	s     *Server
	svc   *ether.Service
	srv   *httptest.Server
	acct  *ether.Account
	clock time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	bs, _ := blobs.Open(filepath.Join(dir, "blobs"))
	svc := ether.New(db, bs, config.DefaultLimits(), []byte(strings.Repeat("p", 32)))
	if err := svc.Allow(ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	acct, err := svc.EnsureAccount(ctx, "alice@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, ctx: ctx, svc: svc, acct: acct, clock: time.Now()}
	e.s = New(db, svc, issuer, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.s.SetClock(func() time.Time { return e.clock })
	mux := http.NewServeMux()
	e.s.Routes(mux)
	e.srv = httptest.NewServer(mux)
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) postJSON(path string, body any) (*http.Response, map[string]any) {
	e.t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(e.srv.URL+path, "application/json", strings.NewReader(string(b)))
	if err != nil {
		e.t.Fatal(err)
	}
	return resp, decode(e.t, resp)
}

func (e *env) postForm(path string, form url.Values, basicUser, basicPass string) (*http.Response, map[string]any) {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if basicUser != "" {
		req.SetBasicAuth(url.QueryEscape(basicUser), url.QueryEscape(basicPass))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp, decode(e.t, resp)
}

func decode(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer resp.Body.Close()
	var m map[string]any
	b, _ := io.ReadAll(resp.Body)
	if len(b) > 0 {
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("decoding %q: %v", b, err)
		}
	}
	return m
}

const redirect = "http://127.0.0.1:9999/callback"

// register makes a client with the given auth method and returns id and secret.
func (e *env) register(method string) (string, string) {
	e.t.Helper()
	resp, m := e.postJSON("/oauth/register", map[string]any{
		"redirect_uris": []string{redirect}, "client_name": "Test App", "token_endpoint_auth_method": method,
		"grant_types": []string{"authorization_code", "refresh_token"},
	})
	if resp.StatusCode != http.StatusCreated {
		e.t.Fatalf("register: %d %v", resp.StatusCode, m)
	}
	secret, _ := m["client_secret"].(string)
	return m["client_id"].(string), secret
}

func pkce() (verifier, challenge string) {
	verifier = strings.Repeat("v", 50)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// authorize runs ParseAuthorize and IssueCode and returns the code.
func (e *env) authorize(clientID, challenge string) string {
	e.t.Helper()
	req, err := e.s.ParseAuthorize(e.ctx, url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"xyz"},
		"scope": {"ether"}, "resource": {issuer + "/mcp"},
	})
	if err != nil {
		e.t.Fatal(err)
	}
	to, err := e.s.IssueCode(e.ctx, req, e.acct.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	u, _ := url.Parse(to)
	if u.Query().Get("state") != "xyz" || u.Query().Get("iss") != issuer || !strings.HasPrefix(to, redirect+"?") {
		e.t.Fatalf("redirect = %s", to)
	}
	return u.Query().Get("code")
}

func (e *env) exchange(clientID, code, verifier string) (*http.Response, map[string]any) {
	return e.postForm("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {redirect}, "code_verifier": {verifier}, "client_id": {clientID}, "resource": {issuer + "/mcp"}}, "", "")
}

func (e *env) valid(access string) bool {
	_, err := e.s.Verify(e.ctx, access, nil)
	return err == nil
}

func TestMetadata(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.srv.URL + "/.well-known/oauth-authorization-server")
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, resp)
	if m["issuer"] != issuer || m["token_endpoint"] != issuer+"/oauth/token" || m["client_id_metadata_document_supported"] != true ||
		m["authorization_response_iss_parameter_supported"] != true || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("AS metadata: %v", m)
	}
	for _, p := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		resp, err := http.Get(e.srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		m := decode(t, resp)
		if m["resource"] != issuer+"/mcp" || fmt.Sprint(m["authorization_servers"]) != "["+issuer+"]" {
			t.Fatalf("%s: %v", p, m)
		}
	}
}

func TestRegistration(t *testing.T) {
	e := newEnv(t)
	id, secret := e.register("none")
	if !strings.HasPrefix(id, clientPrefix) || secret != "" {
		t.Fatalf("public client: %s %q", id, secret)
	}
	if _, secret := e.register(""); !strings.HasPrefix(secret, secretPrefix) {
		t.Fatalf("default auth method should be client_secret_basic with a secret, got %q", secret)
	}
	for _, bad := range []string{"http://example.com/cb", "javascript:alert(1)", "https://example.com/cb#frag", "data:text/html,x", "relative/path"} {
		resp, m := e.postJSON("/oauth/register", map[string]any{"redirect_uris": []string{bad}})
		if resp.StatusCode != 400 || m["error"] != "invalid_redirect_uri" {
			t.Errorf("redirect %q: %d %v", bad, resp.StatusCode, m)
		}
	}
	resp, m := e.postJSON("/oauth/register", map[string]any{"redirect_uris": []string{redirect}, "token_endpoint_auth_method": "private_key_jwt"})
	if resp.StatusCode != 400 || m["error"] != "invalid_client_metadata" {
		t.Errorf("unsupported auth method: %d %v", resp.StatusCode, m)
	}
	resp, m = e.postJSON("/oauth/register", map[string]any{"redirect_uris": []string{"https://chatgpt.com/connector_platform_oauth_redirect"},
		"client_name": "ChatGPT‮\n", "token_endpoint_auth_method": "none"})
	if resp.StatusCode != 201 || m["client_name"] != "ChatGPT" {
		t.Errorf("name cleaning: %v", m)
	}
}

func TestRedirectRules(t *testing.T) {
	ok := []string{"https://chatgpt.com/connector_platform_oauth_redirect", "http://127.0.0.1:33418/callback", "http://localhost/cb",
		"http://[::1]:8080/cb", "cursor://anysphere.cursor-mcp/oauth/callback", "com.example.app:/oauth"}
	for _, u := range ok {
		if err := checkRedirectURI(u); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	// Loopback redirects match on any port (RFC 8252 §7.3); nothing else does.
	reg := []string{"http://127.0.0.1/callback", "https://app.example/cb"}
	for u, want := range map[string]bool{
		"http://127.0.0.1:51234/callback": true, "http://127.0.0.1/callback": true, "https://app.example/cb": true,
		"https://app.example:444/cb": false, "http://127.0.0.1:5/other": false, "http://localhost:5/callback": false,
	} {
		if got := redirectAllowed(reg, u); got != want {
			t.Errorf("redirectAllowed(%s) = %v", u, got)
		}
	}
}

func TestAuthorizeValidation(t *testing.T) {
	e := newEnv(t)
	id, _ := e.register("none")
	_, challenge := pkce()
	base := url.Values{"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	with := func(k, v string) url.Values {
		q := url.Values{}
		for kk, vv := range base {
			q[kk] = vv
		}
		if v == "" {
			q.Del(k)
		} else {
			q.Set(k, v)
		}
		return q
	}
	if _, err := e.s.ParseAuthorize(e.ctx, base); err != nil {
		t.Fatalf("valid request: %v", err)
	}
	cases := map[string]url.Values{
		"unknown client":        with("client_id", "eth_c_nope"),
		"unregistered redirect": with("redirect_uri", "http://127.0.0.1:9999/other"),
		"missing redirect":      with("redirect_uri", ""),
		"token response type":   with("response_type", "token"),
		"plain PKCE":            with("code_challenge_method", "plain"),
		"no PKCE":               with("code_challenge", ""),
		"other resource":        with("resource", "https://evil.example/mcp"),
		"unknown scope only":    with("scope", "admin"),
	}
	for name, q := range cases {
		_, err := e.s.ParseAuthorize(e.ctx, q)
		var re *RequestError
		if !errors.As(err, &re) {
			t.Errorf("%s: err = %v, want a RequestError", name, err)
		}
	}
	if req, err := e.s.ParseAuthorize(e.ctx, with("scope", "ether offline_access")); err != nil || req.Scope != "ether" {
		t.Errorf("scope including ether: %v", err)
	}
}

func TestCodeFlow(t *testing.T) {
	e := newEnv(t)
	id, _ := e.register("none")
	verifier, challenge := pkce()
	code := e.authorize(id, challenge)

	resp, m := e.exchange(id, code, verifier)
	if resp.StatusCode != 200 || m["token_type"] != "Bearer" || m["scope"] != "ether" || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("exchange: %d %v", resp.StatusCode, m)
	}
	access, refresh := m["access_token"].(string), m["refresh_token"].(string)
	ti, err := e.s.Verify(e.ctx, access, nil)
	if err != nil || ti.UserID != e.acct.ID || ti.Extra[ClientIDKey] != id {
		t.Fatalf("verify: %+v %v", ti, err)
	}
	if e.valid(refresh) {
		t.Fatal("a refresh token was accepted as an access token")
	}

	// Reusing the code fails and revokes what it issued.
	if resp, m := e.exchange(id, code, verifier); resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("code reuse: %d %v", resp.StatusCode, m)
	}
	if e.valid(access) {
		t.Fatal("tokens survived authorization code reuse")
	}
}

func TestCodeRejections(t *testing.T) {
	e := newEnv(t)
	id, _ := e.register("none")
	other, _ := e.register("none")
	verifier, challenge := pkce()

	// A wrong verifier burns the code.
	code := e.authorize(id, challenge)
	if resp, m := e.exchange(id, code, strings.Repeat("w", 50)); resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %d %v", resp.StatusCode, m)
	}
	if resp, _ := e.exchange(id, code, verifier); resp.StatusCode != 400 {
		t.Fatal("code still worked after a wrong verifier")
	}

	code = e.authorize(id, challenge)
	if resp, m := e.exchange(other, code, verifier); resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("another client's code: %d %v", resp.StatusCode, m)
	}

	code = e.authorize(id, challenge)
	resp, m := e.postForm("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {"http://127.0.0.1:9999/elsewhere"}, "code_verifier": {verifier}, "client_id": {id}}, "", "")
	if resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("redirect mismatch: %d %v", resp.StatusCode, m)
	}

	code = e.authorize(id, challenge)
	e.clock = e.clock.Add(CodeTTL + time.Second)
	if resp, m := e.exchange(id, code, verifier); resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("expired code: %d %v", resp.StatusCode, m)
	}

	if resp, m := e.postForm("/oauth/token", url.Values{"grant_type": {"password"}, "client_id": {id}}, "", ""); resp.StatusCode != 400 || m["error"] != "unsupported_grant_type" {
		t.Fatalf("password grant: %d %v", resp.StatusCode, m)
	}
}

func TestRefreshRotation(t *testing.T) {
	e := newEnv(t)
	id, _ := e.register("none")
	verifier, challenge := pkce()
	_, m := e.exchange(id, e.authorize(id, challenge), verifier)
	access1, refresh1 := m["access_token"].(string), m["refresh_token"].(string)

	refresh := func(rt string) (*http.Response, map[string]any) {
		return e.postForm("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rt}, "client_id": {id}}, "", "")
	}
	resp, m := refresh(refresh1)
	if resp.StatusCode != 200 {
		t.Fatalf("refresh: %d %v", resp.StatusCode, m)
	}
	access2, refresh2 := m["access_token"].(string), m["refresh_token"].(string)
	if refresh2 == refresh1 || !e.valid(access2) {
		t.Fatal("refresh didn't rotate")
	}

	// Presenting the old refresh token again revokes the whole family.
	if resp, m := refresh(refresh1); resp.StatusCode != 400 || m["error"] != "invalid_grant" {
		t.Fatalf("refresh reuse: %d %v", resp.StatusCode, m)
	}
	if e.valid(access1) || e.valid(access2) {
		t.Fatal("family survived refresh-token reuse")
	}
	if resp, _ := refresh(refresh2); resp.StatusCode != 400 {
		t.Fatal("newest refresh token survived reuse detection")
	}

	// Access tokens expire after an hour.
	_, m = e.exchange(id, e.authorize(id, challenge), verifier)
	access3 := m["access_token"].(string)
	e.clock = e.clock.Add(AccessTTL + time.Second)
	if e.valid(access3) {
		t.Fatal("access token outlived its hour")
	}
}

func TestConfidentialClients(t *testing.T) {
	e := newEnv(t)
	id, secret := e.register("client_secret_basic")
	verifier, challenge := pkce()
	form := func(code string) url.Values {
		return url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}, "code_verifier": {verifier}}
	}
	if resp, m := e.postForm("/oauth/token", form(e.authorize(id, challenge)), id, "wrong"); resp.StatusCode != 401 || m["error"] != "invalid_client" {
		t.Fatalf("wrong secret: %d %v", resp.StatusCode, m)
	}
	f := form(e.authorize(id, challenge))
	f.Set("client_id", id)
	f.Set("client_secret", secret)
	if resp, _ := e.postForm("/oauth/token", f, "", ""); resp.StatusCode != 401 {
		t.Fatal("client_secret_post accepted for a client_secret_basic client")
	}
	if resp, m := e.postForm("/oauth/token", form(e.authorize(id, challenge)), id, secret); resp.StatusCode != 200 {
		t.Fatalf("basic auth: %d %v", resp.StatusCode, m)
	}
}

func TestRevocationAndDisabledAccounts(t *testing.T) {
	e := newEnv(t)
	id, _ := e.register("none")
	verifier, challenge := pkce()
	_, m := e.exchange(id, e.authorize(id, challenge), verifier)
	access, refresh := m["access_token"].(string), m["refresh_token"].(string)
	if resp, _ := e.postForm("/oauth/revoke", url.Values{"token": {refresh}, "client_id": {id}}, "", ""); resp.StatusCode != 200 {
		t.Fatal("revoke failed")
	}
	if e.valid(access) {
		t.Fatal("revoking the refresh token should revoke its family")
	}
	if resp, _ := e.postForm("/oauth/revoke", url.Values{"token": {"eth_rt_unknown"}, "client_id": {id}}, "", ""); resp.StatusCode != 200 {
		t.Fatal("unknown tokens must still get 200")
	}

	_, m = e.exchange(id, e.authorize(id, challenge), verifier)
	access = m["access_token"].(string)
	if err := e.svc.Disallow(e.ctx, "alice@example.com"); err != nil {
		t.Fatal(err)
	}
	if e.valid(access) {
		t.Fatal("token of a disabled account still works")
	}
}

func TestCIMD(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://chatgpt.com/oauth/client.json": true,
		"https://chatgpt.com":                   false,
		"https://chatgpt.com/":                  false,
		"http://chatgpt.com/client.json":        false,
		"https://user:pw@chatgpt.com/c.json":    false,
		"https://chatgpt.com/a/../c.json":       false,
		"https://chatgpt.com/c.json#x":          false,
	} {
		if got := checkCIMDURL(raw) == nil; got != ok {
			t.Errorf("checkCIMDURL(%s) ok = %v", raw, got)
		}
	}
	for ip, public := range map[string]bool{
		"8.8.8.8": true, "2606:4700::1111": true, "127.0.0.1": false, "10.0.0.5": false, "192.168.1.1": false,
		"172.16.0.1": false, "169.254.169.254": false, "100.64.1.1": false, "::1": false, "fd00::1": false,
		"0.0.0.0": false, "::ffff:192.168.1.1": false, "64:ff9b::a00:1": false,
	} {
		if got := publicAddr(netip.MustParseAddr(ip)); got != public {
			t.Errorf("publicAddr(%s) = %v", ip, got)
		}
	}

	var docURL string
	var body string
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, body)
	}))
	defer tlsSrv.Close()
	docURL = tlsSrv.URL + "/client.json"

	// The real fetcher refuses the test server: it's on a loopback address.
	if _, _, err := newCIMDFetcher().fetch(context.Background(), docURL); err == nil || !strings.Contains(err.Error(), "non-public") {
		t.Fatalf("SSRF guard: %v", err)
	}

	// A fetcher allowed to reach it exercises document validation.
	e := newEnv(t)
	e.s.fetcher = &cimdFetcher{client: tlsSrv.Client(), maxSize: cimdMaxSize}
	body = fmt.Sprintf(`{"client_id":%q,"client_name":"Doc App","redirect_uris":[%q]}`, docURL, redirect)
	_, challenge := pkce()
	q := url.Values{"client_id": {docURL}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	req, err := e.s.ParseAuthorize(e.ctx, q)
	if err != nil || req.Client.Name != "Doc App" || req.Client.Kind != "cimd" {
		t.Fatalf("CIMD client: %+v %v", req, err)
	}
	if e.s.ClientName(e.ctx, docURL) != "Doc App" {
		t.Fatal("CIMD client not cached")
	}

	e2 := newEnv(t)
	e2.s.fetcher = &cimdFetcher{client: tlsSrv.Client(), maxSize: cimdMaxSize}
	for name, doc := range map[string]string{
		"mismatched client_id": fmt.Sprintf(`{"client_id":"https://other.example/c.json","redirect_uris":[%q]}`, redirect),
		"secret auth":          fmt.Sprintf(`{"client_id":%q,"redirect_uris":[%q],"token_endpoint_auth_method":"client_secret_basic"}`, docURL, redirect),
		"bad redirect":         fmt.Sprintf(`{"client_id":%q,"redirect_uris":["http://evil.example/cb"]}`, docURL),
		"oversized":            `{"pad":"` + strings.Repeat("x", cimdMaxSize) + `"}`,
	} {
		body = doc
		if _, err := e2.s.ParseAuthorize(e2.ctx, q); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

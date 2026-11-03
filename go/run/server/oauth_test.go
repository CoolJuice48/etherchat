package server

import (
	"context"
	"html"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/adapters/web"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

var hiddenInput = regexp.MustCompile(`<input type="hidden" name="([^"]+)" value="([^"]*)">`)

// TestOAuthWithSDKClient connects the official Go SDK's MCP client with its
// OAuth handler, the way a desktop MCP app would: it gets a 401, discovers
// the authorization server from WWW-Authenticate, registers itself, sends the
// person through sign-in and consent, exchanges the code, and calls a tool.
func TestOAuthWithSDKClient(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	bs, _ := blobs.Open(filepath.Join(dir, "blobs"))
	pepper := []byte(strings.Repeat("p", 32))
	svc := ether.New(db, bs, config.DefaultLimits(), pepper)
	if err := svc.Allow(ctx, "alice@example.com", ""); err != nil {
		t.Fatal(err)
	}
	acct, err := svc.EnsureAccount(ctx, "alice@example.com", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateEther(ctx, ether.Actor{AccountID: acct.ID}, "Atlas"); err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	cfg := config.Default()
	cfg.Domain = "etherchat.example"
	cfg.Listen = ln.Addr().String()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.New(db, svc, mail.Disabled{}, pepper, log)
	oauthSrv := oauth.New(db, svc, base, log)
	h, err := New(ctx, &cfg, svc, authSvc, oauthSrv, mail.Disabled{}, log, "test")
	if err != nil {
		t.Fatal(err)
	}
	srv := &httptest.Server{Listener: ln, Config: &http.Server{Handler: h}}
	srv.Start()
	defer srv.Close()

	// Without a token, /mcp answers 401 and points at the metadata.
	resp, err := http.Post(base+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(resp.Header.Get("WWW-Authenticate"), `resource_metadata="`+base+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("401: %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
	}

	// The person is already signed in to the web view in their browser.
	session, _, err := authSvc.NewSession(ctx, acct.ID)
	if err != nil {
		t.Fatal(err)
	}
	browser := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	withCookie := func(req *http.Request) *http.Request {
		req.AddCookie(&http.Cookie{Name: web.SessionCookie, Value: session})
		return req
	}

	const redirect = "http://127.0.0.1:47777/callback"
	var consentCSP string
	fetchCode := func(ctx context.Context, args *mcpauth.AuthorizationArgs) (*mcpauth.AuthorizationResult, error) {
		// What a browser does: open the authorization URL, see the consent
		// page, click Allow, follow the redirect back to the app.
		req, _ := http.NewRequestWithContext(ctx, "GET", args.URL, nil)
		resp, err := browser.Do(withCookie(req))
		if err != nil {
			return nil, err
		}
		page, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(page), "Connect etherchat-sdk-test?") {
			t.Fatalf("consent page: %d\n%s", resp.StatusCode, page)
		}
		consentCSP = resp.Header.Get("Content-Security-Policy")
		form := url.Values{"decision": {"allow"}}
		for _, m := range hiddenInput.FindAllStringSubmatch(string(page), -1) {
			form.Add(html.UnescapeString(m[1]), html.UnescapeString(m[2]))
		}
		post, _ := http.NewRequestWithContext(ctx, "POST", base+"/oauth/authorize", strings.NewReader(form.Encode()))
		post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		post.Header.Set("Origin", base)
		resp, err = browser.Do(withCookie(post))
		if err != nil {
			return nil, err
		}
		resp.Body.Close()
		loc, err := url.Parse(resp.Header.Get("Location"))
		if err != nil || resp.StatusCode != http.StatusSeeOther || !strings.HasPrefix(loc.String(), redirect) {
			t.Fatalf("consent redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
		}
		q := loc.Query()
		return &mcpauth.AuthorizationResult{Code: q.Get("code"), State: q.Get("state"), Iss: q.Get("iss")}, nil
	}

	handler, err := mcpauth.NewAuthorizationCodeHandler(&mcpauth.AuthorizationCodeHandlerConfig{
		DynamicClientRegistrationConfig: &mcpauth.DynamicClientRegistrationConfig{
			Metadata: &oauthex.ClientRegistrationMetadata{
				RedirectURIs:            []string{redirect},
				ClientName:              "etherchat-sdk-test",
				TokenEndpointAuthMethod: "none",
				GrantTypes:              []string{"authorization_code", "refresh_token"},
			},
		},
		AuthorizationCodeFetcher: fetchCode,
	})
	if err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "etherchat-sdk-test", Version: "1"}, nil)
	cs, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: base + "/mcp", OAuthHandler: handler, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatalf("connect with OAuth: %v", err)
	}
	defer cs.Close()

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "list_ethers", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("list_ethers: %v %+v", err, res)
	}
	if txt := res.Content[0].(*mcp.TextContent).Text; !strings.Contains(txt, "Atlas") || !strings.Contains(txt, "@alice") {
		t.Fatalf("list_ethers = %s", txt)
	}
	if !strings.Contains(consentCSP, "form-action 'self' http://127.0.0.1:47777") {
		t.Fatalf("consent CSP = %q", consentCSP)
	}

	// The write is recorded against the registered client, shown by its name.
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "list_ethers", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("second call: %v", err)
	}
	var clientID string
	if err := db.Read().QueryRowContext(ctx, `SELECT client_id FROM oauth_clients WHERE name = 'etherchat-sdk-test'`).Scan(&clientID); err != nil {
		t.Fatalf("registered client: %v", err)
	}
	if oauthSrv.ClientName(ctx, clientID) != "etherchat-sdk-test" {
		t.Fatal("client name lookup failed")
	}
}

// TestConsentRequiresSignIn: an authorization request from a browser that
// isn't signed in goes to the sign-in page first and comes back after.
func TestConsentRequiresSignIn(t *testing.T) {
	baseURL, _ := startServer(t)
	resp, err := http.Post(baseURL+"/oauth/register", "application/json",
		strings.NewReader(`{"redirect_uris":["http://127.0.0.1:5000/cb"],"token_endpoint_auth_method":"none","client_name":"X"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	id := regexp.MustCompile(`"client_id":"([^"]+)"`).FindStringSubmatch(string(b))[1]

	q := url.Values{"client_id": {id}, "redirect_uri": {"http://127.0.0.1:5000/cb"}, "response_type": {"code"},
		"code_challenge": {strings.Repeat("a", 43)}, "code_challenge_method": {"S256"}}
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err = noRedirect.Get(baseURL + "/oauth/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode != http.StatusSeeOther || !strings.HasPrefix(loc, "/login?next=") || !strings.Contains(loc, url.QueryEscape("/oauth/authorize?")) {
		t.Fatalf("unsigned authorize: %d %q", resp.StatusCode, loc)
	}

	// A request for an unregistered redirect gets an error page, not a redirect.
	q.Set("redirect_uri", "https://evil.example/cb")
	resp, err = noRedirect.Get(baseURL + "/oauth/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 || resp.Header.Get("Location") != "" || !strings.Contains(string(page), "didn&#39;t register") {
		t.Fatalf("bad redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
}

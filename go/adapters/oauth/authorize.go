package oauth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// AuthRequest is a validated authorization request.
type AuthRequest struct {
	Client        *Client
	RedirectURI   string
	State         string
	CodeChallenge string
	Scope         string
	Resource      string
	// Params are the original query parameters, re-sent by the consent form.
	Params url.Values
}

// RedirectHost is where the browser goes after consent, shown on the
// consent page because client names are self-declared.
func (a *AuthRequest) RedirectHost() string {
	u, err := url.Parse(a.RedirectURI)
	if err != nil {
		return a.RedirectURI
	}
	if u.Host != "" {
		return u.Host
	}
	return u.Scheme + ":"
}

// RedirectOrigin is the redirect URI's origin, for the consent page's CSP
// form-action (browsers apply it to the redirect after the form posts).
func (a *AuthRequest) RedirectOrigin() string {
	u, err := url.Parse(a.RedirectURI)
	if err != nil {
		return ""
	}
	if u.Scheme == "http" || u.Scheme == "https" {
		return u.Scheme + "://" + u.Host
	}
	return u.Scheme + ":"
}

// RequestError is a problem with an authorization request. It's shown on an
// error page rather than sent back to the client, so a malformed request
// can't bounce the browser to an arbitrary site.
type RequestError struct{ Msg string }

func (e *RequestError) Error() string { return e.Msg }

func reqErr(format string, args ...any) error {
	return &RequestError{Msg: fmt.Sprintf(format, args...)}
}

// ParseAuthorize validates an authorization request's parameters.
func (s *Server) ParseAuthorize(ctx context.Context, q url.Values) (*AuthRequest, error) {
	c, err := s.client(ctx, q.Get("client_id"))
	if errors.Is(err, errUnknownClient) {
		return nil, reqErr("This app isn't registered with Etherchat, or its registration couldn't be read.")
	}
	if err != nil {
		return nil, err
	}
	req := &AuthRequest{Client: c, Params: q, RedirectURI: q.Get("redirect_uri"), State: q.Get("state")}
	if req.RedirectURI == "" || !redirectAllowed(c.RedirectURIs, req.RedirectURI) {
		return nil, reqErr("The app asked to send you back to an address it didn't register.")
	}
	if q.Get("response_type") != "code" {
		return nil, reqErr("Only response_type=code is supported.")
	}
	req.CodeChallenge = q.Get("code_challenge")
	if q.Get("code_challenge_method") != "S256" || len(req.CodeChallenge) != 43 || !isBase64URL(req.CodeChallenge) {
		return nil, reqErr("The app must use PKCE with code_challenge_method=S256.")
	}
	if len(req.State) > 2048 {
		return nil, reqErr("The state parameter is too long.")
	}

	// The only scope is "ether". An empty request means it; requests that
	// include it get it; anything else is refused.
	scopes := strings.Fields(q.Get("scope"))
	if len(scopes) > 0 && !containsString(scopes, Scope) {
		return nil, reqErr("The app asked for permissions Etherchat doesn't have (scope %q).", q.Get("scope"))
	}
	req.Scope = Scope

	req.Resource = s.resource
	for _, r := range q["resource"] {
		if strings.TrimRight(r, "/") != s.resource {
			return nil, reqErr("The app asked for access to %q, which isn't this server's MCP endpoint.", r)
		}
	}
	return req, nil
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func isBase64URL(s string) bool {
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// IssueCode creates an authorization code for an approved request and
// returns the URL to send the browser to.
func (s *Server) IssueCode(ctx context.Context, req *AuthRequest, accountID string) (string, error) {
	code := randomToken(codePrefix, 32)
	now := s.now()
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, resource, scope, family_id, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			hashToken(code), req.Client.ID, accountID, req.RedirectURI, req.CodeChallenge, req.Resource, req.Scope,
			randomToken("", 12), now.UnixMilli(), now.Add(CodeTTL).UnixMilli())
		return err
	})
	if err != nil {
		return "", err
	}
	s.log.Info("authorization code issued", "client_id", req.Client.ID, "account", accountID)
	return s.redirect(req, url.Values{"code": {code}}), nil
}

// DenyURL is where to send the browser when the person declines.
func (s *Server) DenyURL(req *AuthRequest) string {
	return s.redirect(req, url.Values{"error": {"access_denied"}, "error_description": {"The request was declined."}})
}

// redirect adds params, state, and iss (RFC 9207) to the redirect URI,
// keeping any query it already has.
func (s *Server) redirect(req *AuthRequest, params url.Values) string {
	u, _ := url.Parse(req.RedirectURI)
	q := u.Query()
	for k, vs := range params {
		q[k] = vs
	}
	if req.State != "" {
		q.Set("state", req.State)
	}
	q.Set("iss", s.issuer)
	u.RawQuery = q.Encode()
	return u.String()
}

package oauth

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/CoolJuice48/etherchat/go/core/ratelimit"
)

// Client is a registered (DCR) or fetched (CIMD) OAuth client.
type Client struct {
	ID           string
	Kind         string // "dcr" or "cimd"
	Name         string
	RedirectURIs []string
	AuthMethod   string // none, client_secret_basic, client_secret_post
	secretHash   string
}

var errUnknownClient = errors.New("unknown app")

// isCIMD reports whether clientID is a Client ID Metadata Document URL.
func isCIMD(clientID string) bool { return strings.HasPrefix(clientID, "https://") }

// client loads a client: DCR clients from the database, CIMD clients from
// their metadata document (cached for 24 hours).
func (s *Server) client(ctx context.Context, clientID string) (*Client, error) {
	if clientID == "" || len(clientID) > 2048 {
		return nil, errUnknownClient
	}
	var c Client
	var uris string
	var secret sql.NullString
	var fetched sql.NullInt64
	err := s.db.Read().QueryRowContext(ctx,
		`SELECT client_id, kind, name, redirect_uris, token_auth_method, secret_hash, fetched_at
		 FROM oauth_clients WHERE client_id = ?`, clientID).
		Scan(&c.ID, &c.Kind, &c.Name, &uris, &c.AuthMethod, &secret, &fetched)
	switch {
	case err == nil:
		c.secretHash = secret.String
		if err := json.Unmarshal([]byte(uris), &c.RedirectURIs); err != nil {
			return nil, err
		}
		if c.Kind == "cimd" && s.now().Sub(time.UnixMilli(fetched.Int64)) > 24*time.Hour {
			return s.fetchCIMD(ctx, clientID)
		}
		return &c, nil
	case errors.Is(err, sql.ErrNoRows):
		if isCIMD(clientID) {
			return s.fetchCIMD(ctx, clientID)
		}
		return nil, errUnknownClient
	default:
		return nil, err
	}
}

func (s *Server) fetchCIMD(ctx context.Context, clientID string) (*Client, error) {
	c, meta, err := s.fetcher.fetch(ctx, clientID)
	if err != nil {
		s.log.Warn("client metadata document rejected", "client_id", clientID, "err", err)
		return nil, errUnknownClient
	}
	uris, _ := json.Marshal(c.RedirectURIs)
	now := s.now().UnixMilli()
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_auth_method, metadata, fetched_at, created_at)
			 VALUES (?, 'cimd', ?, ?, 'none', ?, ?, ?)
			 ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
			   metadata = excluded.metadata, fetched_at = excluded.fetched_at`,
			c.ID, c.Name, string(uris), string(meta), now, now)
		return err
	})
	return c, err
}

// cleanName makes a client-supplied name safe and short for display.
func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '​' || r == '‮' {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	return name
}

var blockedSchemes = []string{"javascript", "data", "file", "vbscript", "about", "blob", "filesystem", "http", "https", "ws", "wss", "ftp"}

// checkRedirectURI accepts https URLs, http on loopback (native apps,
// RFC 8252 §7.3), and private-use schemes like cursor:// (RFC 8252 §7.1).
func checkRedirectURI(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || strings.Contains(raw, "#") {
		return errors.New("redirect URIs must be absolute URLs without a fragment")
	}
	switch u.Scheme {
	case "https":
		if u.Host == "" {
			return errors.New("https redirect URIs need a host")
		}
	case "http":
		if !isLoopback(u.Hostname()) {
			return errors.New("http redirect URIs are only allowed on localhost")
		}
	default:
		s := strings.ToLower(u.Scheme)
		if s == "" || slices.Contains(blockedSchemes, s) {
			return errors.New("redirect URI scheme not allowed")
		}
		for _, r := range s {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '.' || r == '-') {
				return errors.New("redirect URI scheme not allowed")
			}
		}
	}
	return nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// redirectAllowed reports whether requested matches a registered redirect
// URI exactly, or differs only in port on a loopback http URI (RFC 8252 §7.3).
func redirectAllowed(registered []string, requested string) bool {
	if slices.Contains(registered, requested) {
		return true
	}
	req, err := url.Parse(requested)
	if err != nil || req.Scheme != "http" || !isLoopback(req.Hostname()) {
		return false
	}
	for _, r := range registered {
		reg, err := url.Parse(r)
		if err == nil && reg.Scheme == "http" && reg.Hostname() == req.Hostname() &&
			reg.Path == req.Path && reg.RawQuery == req.RawQuery {
			return true
		}
	}
	return false
}

type registration struct {
	RedirectURIs            []string `json:"redirect_uris"`
	ClientName              string   `json:"client_name,omitempty"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	ResponseTypes           []string `json:"response_types,omitempty"`
	ApplicationType         string   `json:"application_type,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
	ClientURI               string   `json:"client_uri,omitempty"`
	LogoURI                 string   `json:"logo_uri,omitempty"`
	SoftwareID              string   `json:"software_id,omitempty"`
	SoftwareVersion         string   `json:"software_version,omitempty"`
}

// register is RFC 7591 dynamic client registration. The current MCP spec
// prefers CIMD, but many clients still register this way.
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.Allow("register:"+ratelimit.ClientIP(r), 20, time.Hour) {
		writeError(w, errorf(http.StatusTooManyRequests, "invalid_request", "too many registrations; try again later"))
		return
	}
	var reg registration
	if err := json.NewDecoder(r.Body).Decode(&reg); err != nil {
		writeError(w, errorf(http.StatusBadRequest, "invalid_client_metadata", "body must be a JSON client registration of at most 16 KB"))
		return
	}
	if len(reg.RedirectURIs) == 0 || len(reg.RedirectURIs) > 10 {
		writeError(w, errorf(http.StatusBadRequest, "invalid_redirect_uri", "register between 1 and 10 redirect_uris"))
		return
	}
	for _, u := range reg.RedirectURIs {
		if err := checkRedirectURI(u); err != nil {
			writeError(w, errorf(http.StatusBadRequest, "invalid_redirect_uri", err.Error()+": "+u))
			return
		}
	}
	if reg.TokenEndpointAuthMethod == "" {
		reg.TokenEndpointAuthMethod = "client_secret_basic" // RFC 7591 §2 default
	}
	if !slices.Contains([]string{"none", "client_secret_basic", "client_secret_post"}, reg.TokenEndpointAuthMethod) {
		writeError(w, errorf(http.StatusBadRequest, "invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post"))
		return
	}
	if len(reg.GrantTypes) == 0 {
		reg.GrantTypes = []string{"authorization_code"}
	}
	for _, g := range reg.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			writeError(w, errorf(http.StatusBadRequest, "invalid_client_metadata", "unsupported grant type "+g))
			return
		}
	}
	if len(reg.ResponseTypes) == 0 {
		reg.ResponseTypes = []string{"code"}
	}
	if !slices.Equal(reg.ResponseTypes, []string{"code"}) {
		writeError(w, errorf(http.StatusBadRequest, "invalid_client_metadata", "response_types must be [\"code\"]"))
		return
	}
	reg.ClientName = cleanName(reg.ClientName)
	if reg.ClientName == "" {
		reg.ClientName = "Unnamed app"
	}

	clientID := randomToken(clientPrefix, 16)
	var secret string
	var secretHash any
	if reg.TokenEndpointAuthMethod != "none" {
		secret = randomToken(secretPrefix, 32)
		secretHash = hashToken(secret)
	}
	uris, _ := json.Marshal(reg.RedirectURIs)
	meta, _ := json.Marshal(reg)
	now := s.now()
	err := s.db.Tx(r.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(r.Context(),
			`INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_auth_method, secret_hash, metadata, created_at)
			 VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?)`,
			clientID, reg.ClientName, string(uris), reg.TokenEndpointAuthMethod, secretHash, string(meta), now.UnixMilli())
		return err
	})
	if err != nil {
		s.log.Error("registering client", "err", err)
		writeError(w, err)
		return
	}
	s.log.Info("client registered", "client_id", clientID, "name", reg.ClientName, "auth", reg.TokenEndpointAuthMethod)

	resp := map[string]any{
		"client_id":                  clientID,
		"client_id_issued_at":        now.Unix(),
		"client_name":                reg.ClientName,
		"redirect_uris":              reg.RedirectURIs,
		"token_endpoint_auth_method": reg.TokenEndpointAuthMethod,
		"grant_types":                reg.GrantTypes,
		"response_types":             reg.ResponseTypes,
	}
	if secret != "" {
		resp["client_secret"] = secret
		resp["client_secret_expires_at"] = 0
	}
	writeJSON(w, http.StatusCreated, resp)
}

// authenticate identifies the client calling the token or revocation
// endpoint, using the method it registered.
func (s *Server) authenticate(r *http.Request) (*Client, error) {
	bad := errorf(http.StatusUnauthorized, "invalid_client", "client authentication failed")
	id, secret, basic := r.BasicAuth()
	if basic {
		var err1, err2 error
		id, err1 = url.QueryUnescape(id)
		secret, err2 = url.QueryUnescape(secret)
		if err1 != nil || err2 != nil {
			return nil, bad
		}
		if form := r.PostFormValue("client_id"); form != "" && form != id {
			return nil, bad
		}
	} else {
		id, secret = r.PostFormValue("client_id"), r.PostFormValue("client_secret")
	}
	c, err := s.client(r.Context(), id)
	if err != nil {
		if errors.Is(err, errUnknownClient) {
			return nil, bad
		}
		return nil, err
	}
	switch c.AuthMethod {
	case "none":
		if basic || secret != "" {
			return nil, bad
		}
	case "client_secret_basic":
		if !basic {
			return nil, bad
		}
		fallthrough
	case "client_secret_post":
		if c.AuthMethod == "client_secret_post" && basic {
			return nil, bad
		}
		if secret == "" || subtle.ConstantTimeCompare([]byte(hashToken(secret)), []byte(c.secretHash)) != 1 {
			return nil, bad
		}
	default:
		return nil, bad
	}
	return c, nil
}

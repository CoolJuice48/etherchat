// Package oauth is etherd's OAuth 2.1 authorization server for MCP clients:
// discovery metadata, client registration (DCR and Client ID
// Metadata Documents), authorization codes with PKCE, rotating refresh
// tokens, revocation, and access-token checks for /mcp.
//
// The browser half of /oauth/authorize (sign-in and consent) lives in package
// web; this package validates requests and issues codes for it.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/core/ratelimit"
)

// Scope is the only scope: read and write the caller's ethers.
const Scope = "ether"

// ClientIDKey is the TokenInfo.Extra key holding the OAuth client ID.
const ClientIDKey = "client_id"

// Token lifetimes.
const (
	CodeTTL    = 5 * time.Minute
	AccessTTL  = time.Hour
	RefreshTTL = 30 * 24 * time.Hour
)

const (
	accessPrefix  = "eth_at_"
	refreshPrefix = "eth_rt_"
	codePrefix    = "eth_ac_"
	clientPrefix  = "eth_c_"
	secretPrefix  = "eth_cs_"
)

// Server is the authorization server.
type Server struct {
	db       *store.DB
	accounts *ether.Service
	issuer   string // e.g. https://etherchat.example
	resource string // issuer + "/mcp"
	log      *slog.Logger
	now      func() time.Time
	fetcher  *cimdFetcher
	limiter  *ratelimit.Window
}

// New returns the authorization server for baseURL (scheme and host, no
// trailing slash), which is both the issuer and the MCP resource's origin.
func New(db *store.DB, accounts *ether.Service, baseURL string, log *slog.Logger) *Server {
	s := &Server{db: db, accounts: accounts, issuer: strings.TrimRight(baseURL, "/"), log: log,
		now: time.Now, fetcher: newCIMDFetcher()}
	s.resource = s.issuer + "/mcp"
	s.limiter = ratelimit.New(func() time.Time { return s.now() })
	return s
}

// SetClock replaces the clock, for tests.
func (s *Server) SetClock(now func() time.Time) { s.now = now }

// Issuer is the authorization server's identifier.
func (s *Server) Issuer() string { return s.issuer }

// Resource is the MCP endpoint's canonical URI.
func (s *Server) Resource() string { return s.resource }

// ResourceMetadataURL is where clients discover the authorization server.
func (s *Server) ResourceMetadataURL() string {
	return s.issuer + "/.well-known/oauth-protected-resource/mcp"
}

func randomToken(prefix string, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// cors allows browser-based MCP clients to call the JSON endpoints. They use
// no cookies, so a wildcard origin is safe.
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// oauthError is an RFC 6749 §5.2 error response.
type oauthError struct {
	status int
	Code   string `json:"error"`
	Desc   string `json:"error_description,omitempty"`
}

func (e *oauthError) Error() string { return e.Code + ": " + e.Desc }

func errorf(status int, code, desc string) *oauthError {
	return &oauthError{status: status, Code: code, Desc: desc}
}

func writeError(w http.ResponseWriter, err error) {
	var oe *oauthError
	if !errors.As(err, &oe) {
		oe = errorf(http.StatusInternalServerError, "server_error", "internal error")
	}
	if oe.Code == "invalid_client" {
		w.Header().Set("WWW-Authenticate", `Basic realm="etherchat"`)
	}
	writeJSON(w, oe.status, oe)
}

// Routes registers the JSON endpoints on mux. /oauth/authorize is served by
// package web, which owns sign-in and the consent page.
func (s *Server) Routes(mux *http.ServeMux) {
	prm := mcpauth.ProtectedResourceMetadataHandler(&oauthex.ProtectedResourceMetadata{
		Resource:               s.resource,
		AuthorizationServers:   []string{s.issuer},
		ScopesSupported:        []string{Scope},
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "Etherchat",
	})
	mux.Handle("/.well-known/oauth-protected-resource", prm)
	mux.Handle("/.well-known/oauth-protected-resource/mcp", prm)
	mux.HandleFunc("/.well-known/oauth-authorization-server", s.metadata)
	mux.HandleFunc("/oauth/register", s.preflight(s.register))
	mux.HandleFunc("/oauth/token", s.preflight(s.token))
	mux.HandleFunc("/oauth/revoke", s.preflight(s.revoke))
}

// preflight answers CORS preflights and allows only POST.
func (s *Server) preflight(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		switch r.Method {
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
			next(w, r)
		default:
			w.Header().Set("Allow", "POST, OPTIONS")
			writeJSON(w, http.StatusMethodNotAllowed, errorf(0, "invalid_request", "use POST"))
		}
	}
}

func (s *Server) metadata(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	authMethods := []string{"none", "client_secret_basic", "client_secret_post"}
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         s.issuer,
		"authorization_endpoint":                         s.issuer + "/oauth/authorize",
		"token_endpoint":                                 s.issuer + "/oauth/token",
		"registration_endpoint":                          s.issuer + "/oauth/register",
		"revocation_endpoint":                            s.issuer + "/oauth/revoke",
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported":          authMethods,
		"revocation_endpoint_auth_methods_supported":     authMethods,
		"code_challenge_methods_supported":               []string{"S256"},
		"scopes_supported":                               []string{Scope},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
		"service_documentation":                          s.issuer + "/",
	})
}

// Verify checks an access token presented to /mcp. It's an SDK TokenVerifier.
func (s *Server) Verify(ctx context.Context, token string, _ *http.Request) (*mcpauth.TokenInfo, error) {
	if !strings.HasPrefix(token, accessPrefix) {
		return nil, mcpauth.ErrInvalidToken
	}
	var clientID, accountID, scope, resource string
	var expires int64
	var revoked sql.NullInt64
	err := s.db.Read().QueryRowContext(ctx,
		`SELECT client_id, account_id, scope, resource, expires_at, revoked_at
		 FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`, hashToken(token)).
		Scan(&clientID, &accountID, &scope, &resource, &expires, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, mcpauth.ErrInvalidToken
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || expires <= s.now().UnixMilli() || resource != s.resource {
		return nil, mcpauth.ErrInvalidToken
	}
	acct, err := s.accounts.AccountByID(ctx, accountID)
	if err != nil || acct.Disabled {
		return nil, mcpauth.ErrInvalidToken
	}
	return &mcpauth.TokenInfo{
		UserID:     accountID,
		Scopes:     strings.Fields(scope),
		Expiration: time.UnixMilli(expires),
		Extra:      map[string]any{ClientIDKey: clientID},
	}, nil
}

// ClientName is a client's self-declared name, for display. Clients choose
// their own names, so pages that show one also show where it redirects.
func (s *Server) ClientName(ctx context.Context, clientID string) string {
	var name string
	err := s.db.Read().QueryRowContext(ctx, `SELECT name FROM oauth_clients WHERE client_id = ?`, clientID).Scan(&name)
	if err == nil && name != "" {
		return name
	}
	if u, perr := url.Parse(clientID); perr == nil && u.Scheme == "https" && u.Host != "" {
		return u.Host
	}
	return clientID
}

// RevokeAccount revokes every token an account holds, for the admin CLI.
func (s *Server) RevokeAccount(ctx context.Context, accountID string) (int64, error) {
	var n int64
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE oauth_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`,
			s.now().UnixMilli(), accountID)
		if err != nil {
			return err
		}
		n, _ = res.RowsAffected()
		return nil
	})
	return n, err
}

// Sweep deletes authorization codes and tokens that expired more than a week
// ago. Expired refresh tokens fail either way; keeping them a week longer
// lets reuse of a recently rotated one still trip family revocation.
func (s *Server) Sweep(ctx context.Context) (int64, error) {
	var n int64
	cutoff := s.now().Add(-7 * 24 * time.Hour).UnixMilli()
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{
			`DELETE FROM oauth_codes WHERE expires_at < ?`,
			`DELETE FROM oauth_tokens WHERE expires_at < ?`,
		} {
			res, err := tx.ExecContext(ctx, q, cutoff)
			if err != nil {
				return err
			}
			k, _ := res.RowsAffected()
			n += k
		}
		return nil
	})
	return n, err
}

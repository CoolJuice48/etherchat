// Package server wires etherd's HTTP routes: the MCP endpoint, the web view,
// health check, Host checks, authentication, and request logging.
package server

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/user"
	"strings"
	"time"

	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/CoolJuice48/etherchat/go/adapters/auth"
	"github.com/CoolJuice48/etherchat/go/adapters/mail"
	"github.com/CoolJuice48/etherchat/go/adapters/mcpserver"
	"github.com/CoolJuice48/etherchat/go/adapters/oauth"
	"github.com/CoolJuice48/etherchat/go/adapters/web"
	"github.com/CoolJuice48/etherchat/go/core/ether"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

// New returns etherd's root handler.
func New(ctx context.Context, cfg *config.Config, svc *ether.Service, authSvc *auth.Service, oauthSrv *oauth.Server, mailer mail.Mailer, log *slog.Logger, version string) (http.Handler, error) {
	_, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return nil, err
	}
	hosts := hostPolicy{domain: strings.ToLower(cfg.Domain), local: map[string]bool{
		"127.0.0.1:" + port: true, "localhost:" + port: true, "[::1]:" + port: true,
	}}

	devVerify, err := devVerifier(ctx, cfg.Dev, svc)
	if err != nil {
		return nil, err
	}
	// OAuth access tokens, plus the local-only development token if configured.
	verify := func(ctx context.Context, token string, r *http.Request) (*mcpauth.TokenInfo, error) {
		if ti, err := oauthSrv.Verify(ctx, token, r); err == nil {
			return ti, nil
		}
		return devVerify(ctx, token, r)
	}

	// Stateless: every tool takes an explicit ether id, so nothing depends on
	// an MCP session (and the 2026-07-28 spec drops sessions). Localhost
	// protection is replaced by hostPolicy, because behind the tunnel every
	// request arrives on 127.0.0.1 carrying the public Host.
	mcpSrv := mcpserver.New(svc, mailer, oauthSrv.Issuer(), cfg.Location(), log, version)
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpSrv },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, DisableLocalhostProtection: true, Logger: log})
	protected := mcpauth.RequireBearerToken(verify, &mcpauth.RequireBearerTokenOptions{
		Scopes:              []string{mcpserver.Scope},
		ResourceMetadataURL: oauthSrv.ResourceMetadataURL(),
	})(mcpHandler)

	webHandler, err := web.New(web.Config{Ethers: svc, Auth: authSvc, OAuth: oauthSrv, Mailer: mailer,
		BaseURL: cfg.BaseURL(), Log: log, MailPreviews: cfg.Dev.Enabled(), AllowCommand: allowCommand(cfg.Path),
		Location: cfg.Location()})
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("/mcp", protected)
	oauthSrv.Routes(mux)
	mux.Handle("/", webHandler)

	return logRequests(log, hosts.check(securityHeaders(mux))), nil
}

// allowCommand is the command an admin runs to allow an address, for the
// emails asking them to: this binary and config file, run as the user
// etherd runs as (for example, sudo -u etherchat). EMAIL is replaced.
func allowCommand(cfgPath string) string {
	exe, err := os.Executable()
	if err != nil || cfgPath == "" {
		return "etherd admin allow --email EMAIL"
	}
	sudo := ""
	if u, err := user.Current(); err == nil {
		sudo = "sudo -u " + u.Username + " "
	}
	return sudo + exe + " admin --config " + cfgPath + " allow --email EMAIL"
}

// fromTunnel reports whether a request came through Cloudflare. Cloudflare
// always sets these headers, so a remote client can't strip them.
func fromTunnel(r *http.Request) bool {
	return r.Header.Get("Cf-Connecting-Ip") != "" || r.Header.Get("Cf-Ray") != ""
}

// hostPolicy accepts the public domain, and loopback names only for requests
// that didn't come through the tunnel.
type hostPolicy struct {
	domain string
	local  map[string]bool
}

func (h hostPolicy) check(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.ToLower(r.Host)
		ok := h.domain != "" && host == h.domain
		if !ok && !fromTunnel(r) {
			ok = h.local[host]
		}
		if !ok {
			http.Error(w, "unknown host", http.StatusMisdirectedRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// devVerifier accepts the development token from config, only for requests
// made on this machine. With no token configured, every token is rejected
// (OAuth arrives in Phase 4).
func devVerifier(ctx context.Context, dev config.Dev, svc *ether.Service) (mcpauth.TokenVerifier, error) {
	if !dev.Enabled() {
		return func(context.Context, string, *http.Request) (*mcpauth.TokenInfo, error) {
			return nil, mcpauth.ErrInvalidToken
		}, nil
	}
	acct, err := svc.EnsureAccount(ctx, dev.Account, false)
	if err != nil {
		return nil, fmt.Errorf("dev.account %s: %w", dev.Account, err)
	}
	want := []byte(dev.Token)
	return func(ctx context.Context, token string, r *http.Request) (*mcpauth.TokenInfo, error) {
		if fromTunnel(r) || subtle.ConstantTimeCompare([]byte(token), want) != 1 {
			return nil, mcpauth.ErrInvalidToken
		}
		current, err := svc.AccountByID(ctx, acct.ID)
		if err != nil || current.Disabled {
			return nil, mcpauth.ErrInvalidToken
		}
		return &mcpauth.TokenInfo{
			UserID:     acct.ID,
			Scopes:     []string{mcpserver.Scope},
			Expiration: time.Now().Add(time.Hour),
			Extra:      map[string]any{mcpserver.ClientIDKey: "dev"},
		}, nil
	}, nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// statusWriter records the response status for logging.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// logRequests logs method, path, status and duration. It never logs headers,
// bodies, or tokens.
func logRequests(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		level := slog.LevelInfo
		if sw.status >= 500 {
			level = slog.LevelError
		}
		path := r.URL.Path
		if strings.HasPrefix(path, "/invite/") {
			path = "/invite/…" // the rest is an invite code
		}
		log.Log(r.Context(), level, "request",
			"method", r.Method, "path", path, "status", sw.status,
			"ms", time.Since(start).Milliseconds(), "tunnel", fromTunnel(r))
	})
}

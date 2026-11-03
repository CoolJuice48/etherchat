package oauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
)

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func invalidGrant(desc string) *oauthError {
	return errorf(http.StatusBadRequest, "invalid_grant", desc)
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Pragma", "no-cache")
	if err := r.ParseForm(); err != nil {
		writeError(w, errorf(http.StatusBadRequest, "invalid_request", "form body required"))
		return
	}
	c, err := s.authenticate(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var resp *tokenResponse
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		resp, err = s.exchangeCode(r.Context(), c, r)
	case "refresh_token":
		resp, err = s.refresh(r.Context(), c, r)
	default:
		err = errorf(http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
	}
	if err != nil {
		var oe *oauthError
		if !errors.As(err, &oe) {
			s.log.Error("token endpoint", "err", err)
		} else {
			s.log.Info("token request refused", "client_id", c.ID, "error", oe.Code, "detail", oe.Desc)
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// pkceOK checks an RFC 7636 S256 code verifier against its challenge.
func pkceOK(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, r := range verifier {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~", r)) {
			return false
		}
	}
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) == 1
}

// exchangeCode redeems an authorization code. A code used twice revokes
// every token issued from it, since one of the two uses was an attacker.
func (s *Server) exchangeCode(ctx context.Context, c *Client, r *http.Request) (*tokenResponse, error) {
	code := r.PostForm.Get("code")
	if code == "" {
		return nil, errorf(http.StatusBadRequest, "invalid_request", "code is required")
	}
	var resp *tokenResponse
	var refusal *oauthError
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		now := s.now().UnixMilli()
		var clientID, accountID, redirectURI, challenge, resource, scope, family string
		var expires int64
		var consumed sql.NullInt64
		err := tx.QueryRowContext(ctx,
			`SELECT client_id, account_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at, consumed_at
			 FROM oauth_codes WHERE code_hash = ?`, hashToken(code)).
			Scan(&clientID, &accountID, &redirectURI, &challenge, &resource, &scope, &family, &expires, &consumed)
		if errors.Is(err, sql.ErrNoRows) {
			refusal = invalidGrant("unknown authorization code")
			return nil
		}
		if err != nil {
			return err
		}
		switch {
		case consumed.Valid:
			if _, err := tx.ExecContext(ctx,
				`UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, now, family); err != nil {
				return err
			}
			s.log.Warn("authorization code reused; revoked its tokens", "client_id", clientID, "account", accountID)
			refusal = invalidGrant("authorization code already used")
		case expires <= now:
			refusal = invalidGrant("authorization code expired")
		case clientID != c.ID:
			refusal = invalidGrant("authorization code was issued to another client")
		case r.PostForm.Get("redirect_uri") != redirectURI:
			refusal = invalidGrant("redirect_uri doesn't match the authorization request")
		case !pkceOK(r.PostForm.Get("code_verifier"), challenge):
			refusal = invalidGrant("code_verifier doesn't match the code_challenge")
		case !resourceOK(r.PostForm["resource"], resource):
			refusal = errorf(http.StatusBadRequest, "invalid_target", "resource doesn't match the authorization request")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL`,
			now, hashToken(code)); err != nil {
			return err
		}
		if refusal != nil {
			return nil
		}
		if acct, err := s.accounts.AccountByID(ctx, accountID); err != nil || acct.Disabled {
			refusal = invalidGrant("account is disabled")
			return nil
		}
		resp, err = s.issueTokens(ctx, tx, family, c.ID, accountID, scope, resource)
		return err
	})
	if err != nil {
		return nil, err
	}
	if refusal != nil {
		return nil, refusal
	}
	return resp, nil
}

func resourceOK(requested []string, granted string) bool {
	for _, r := range requested {
		if strings.TrimRight(r, "/") != granted {
			return false
		}
	}
	return true
}

// refresh rotates a refresh token. Presenting one that was already rotated
// means it was copied, so the whole token family is revoked.
func (s *Server) refresh(ctx context.Context, c *Client, r *http.Request) (*tokenResponse, error) {
	rt := r.PostForm.Get("refresh_token")
	if !strings.HasPrefix(rt, refreshPrefix) {
		return nil, invalidGrant("unknown refresh token")
	}
	var resp *tokenResponse
	var refusal *oauthError
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		now := s.now().UnixMilli()
		var clientID, accountID, scope, resource, family string
		var expires int64
		var revoked sql.NullInt64
		var replaced sql.NullString
		err := tx.QueryRowContext(ctx,
			`SELECT client_id, account_id, scope, resource, family_id, expires_at, revoked_at, replaced_by
			 FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, hashToken(rt)).
			Scan(&clientID, &accountID, &scope, &resource, &family, &expires, &revoked, &replaced)
		if errors.Is(err, sql.ErrNoRows) {
			refusal = invalidGrant("unknown refresh token")
			return nil
		}
		if err != nil {
			return err
		}
		switch {
		case clientID != c.ID:
			refusal = invalidGrant("refresh token was issued to another client")
			return nil
		case replaced.Valid:
			if _, err := tx.ExecContext(ctx,
				`UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, now, family); err != nil {
				return err
			}
			s.log.Warn("refresh token reused; revoked its family", "client_id", clientID, "account", accountID)
			refusal = invalidGrant("refresh token already used")
			return nil
		case revoked.Valid:
			refusal = invalidGrant("refresh token revoked")
			return nil
		case expires <= now:
			refusal = invalidGrant("refresh token expired")
			return nil
		case !resourceOK(r.PostForm["resource"], resource):
			refusal = errorf(http.StatusBadRequest, "invalid_target", "resource doesn't match the original grant")
			return nil
		}
		if req := strings.Fields(r.PostForm.Get("scope")); len(req) > 0 && (len(req) != 1 || req[0] != scope) {
			refusal = errorf(http.StatusBadRequest, "invalid_scope", "scope can only stay the same")
			return nil
		}
		if acct, err := s.accounts.AccountByID(ctx, accountID); err != nil || acct.Disabled {
			refusal = invalidGrant("account is disabled")
			return nil
		}
		resp, err = s.issueTokens(ctx, tx, family, c.ID, accountID, scope, resource)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE oauth_tokens SET revoked_at = ?, replaced_by = ? WHERE token_hash = ?`,
			now, hashToken(resp.RefreshToken), hashToken(rt))
		return err
	})
	if err != nil {
		return nil, err
	}
	if refusal != nil {
		return nil, refusal
	}
	return resp, nil
}

func (s *Server) issueTokens(ctx context.Context, tx *sql.Tx, family, clientID, accountID, scope, resource string) (*tokenResponse, error) {
	now := s.now()
	access, refresh := randomToken(accessPrefix, 32), randomToken(refreshPrefix, 32)
	for _, t := range []struct {
		kind, token string
		expires     int64
	}{
		{"access", access, now.Add(AccessTTL).UnixMilli()},
		{"refresh", refresh, now.Add(RefreshTTL).UnixMilli()},
	} {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, account_id, scope, resource, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			hashToken(t.token), t.kind, family, clientID, accountID, scope, resource, now.UnixMilli(), t.expires); err != nil {
			return nil, err
		}
	}
	return &tokenResponse{AccessToken: access, TokenType: "Bearer", ExpiresIn: int64(AccessTTL.Seconds()),
		RefreshToken: refresh, Scope: scope}, nil
}

// revoke is RFC 7009 token revocation. Revoking a refresh token revokes its
// whole family. It answers 200 for unknown tokens, as the RFC requires.
func (s *Server) revoke(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeError(w, errorf(http.StatusBadRequest, "invalid_request", "form body required"))
		return
	}
	c, err := s.authenticate(r)
	if err != nil {
		writeError(w, err)
		return
	}
	token := r.PostForm.Get("token")
	err = s.db.Tx(r.Context(), func(tx *sql.Tx) error {
		var kind, family, clientID string
		err := tx.QueryRowContext(r.Context(),
			`SELECT kind, family_id, client_id FROM oauth_tokens WHERE token_hash = ?`, hashToken(token)).
			Scan(&kind, &family, &clientID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && clientID != c.ID) {
			return nil
		}
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		if kind == "refresh" {
			_, err = tx.ExecContext(r.Context(),
				`UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, now, family)
		} else {
			_, err = tx.ExecContext(r.Context(),
				`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, now, hashToken(token))
		}
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

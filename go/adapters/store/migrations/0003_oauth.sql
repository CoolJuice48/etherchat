-- OAuth 2.1 authorization server for MCP clients.

-- Registered clients: dynamic registration (kind 'dcr') or a fetched
-- Client ID Metadata Document (kind 'cimd', client_id is its URL).
CREATE TABLE oauth_clients (
	client_id         TEXT PRIMARY KEY,
	kind              TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
	name              TEXT NOT NULL DEFAULT '',
	redirect_uris     TEXT NOT NULL,          -- JSON array
	token_auth_method TEXT NOT NULL,
	secret_hash       TEXT,
	metadata          TEXT NOT NULL DEFAULT '{}',
	fetched_at        INTEGER,
	created_at        INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
	code_hash      TEXT PRIMARY KEY,
	client_id      TEXT NOT NULL,
	account_id     TEXT NOT NULL REFERENCES accounts(id),
	redirect_uri   TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	resource       TEXT NOT NULL,
	scope          TEXT NOT NULL,
	family_id      TEXT NOT NULL,
	created_at     INTEGER NOT NULL,
	expires_at     INTEGER NOT NULL,
	consumed_at    INTEGER
);

-- Access and refresh tokens, stored as SHA-256 hashes. A family is every
-- token descended from one authorization code; reuse of a spent code or
-- refresh token revokes the whole family.
CREATE TABLE oauth_tokens (
	token_hash  TEXT PRIMARY KEY,
	kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
	family_id   TEXT NOT NULL,
	client_id   TEXT NOT NULL,
	account_id  TEXT NOT NULL REFERENCES accounts(id),
	scope       TEXT NOT NULL,
	resource    TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL,
	revoked_at  INTEGER,
	replaced_by TEXT
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_account ON oauth_tokens(account_id);

-- Email sign-in codes and browser sessions.

CREATE TABLE login_codes (
	id          TEXT PRIMARY KEY,
	email       TEXT NOT NULL,
	code_hmac   TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL,
	attempts    INTEGER NOT NULL DEFAULT 0,
	consumed_at INTEGER
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);

CREATE TABLE web_sessions (
	token_hash   TEXT PRIMARY KEY,
	account_id   TEXT NOT NULL REFERENCES accounts(id),
	created_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_account ON web_sessions(account_id);

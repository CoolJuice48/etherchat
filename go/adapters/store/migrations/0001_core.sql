-- Core schema: allowlist, accounts, ethers, membership, invites, files, board, audit.
-- Times are Unix milliseconds, UTC.

CREATE TABLE allowed_emails (
	email    TEXT PRIMARY KEY,
	added_at INTEGER NOT NULL,
	note     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE accounts (
	id                TEXT PRIMARY KEY,
	email             TEXT NOT NULL UNIQUE,
	handle            TEXT NOT NULL UNIQUE,
	email_verified_at INTEGER,
	created_at        INTEGER NOT NULL,
	disabled_at       INTEGER
);

CREATE TABLE ethers (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	owner_id   TEXT NOT NULL REFERENCES accounts(id),
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
);
CREATE INDEX ethers_owner ON ethers(owner_id);

CREATE TABLE memberships (
	ether_id   TEXT NOT NULL REFERENCES ethers(id),
	account_id TEXT NOT NULL REFERENCES accounts(id),
	joined_at  INTEGER NOT NULL,
	left_at    INTEGER,
	PRIMARY KEY (ether_id, account_id)
);
CREATE INDEX memberships_account ON memberships(account_id);

CREATE TABLE invites (
	id          TEXT PRIMARY KEY,
	ether_id    TEXT NOT NULL REFERENCES ethers(id),
	created_by  TEXT NOT NULL REFERENCES accounts(id),
	email       TEXT NOT NULL,
	code_hmac   TEXT NOT NULL UNIQUE,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL,
	consumed_at INTEGER,
	consumed_by TEXT REFERENCES accounts(id),
	revoked_at  INTEGER
);
CREATE INDEX invites_ether ON invites(ether_id);

-- Files and folders. Paths compare case-insensitively so a zip export never
-- holds two entries that collide on a case-insensitive filesystem.
CREATE TABLE nodes (
	id           TEXT PRIMARY KEY,
	ether_id     TEXT NOT NULL REFERENCES ethers(id),
	parent_id    TEXT REFERENCES nodes(id),
	kind         TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
	name         TEXT NOT NULL,
	path         TEXT NOT NULL COLLATE NOCASE,
	author_id    TEXT NOT NULL REFERENCES accounts(id),
	mode         TEXT NOT NULL DEFAULT 'author_only' CHECK (mode IN ('author_only', 'shared_edit')),
	system       INTEGER NOT NULL DEFAULT 0,
	head_version INTEGER NOT NULL DEFAULT 0,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL,
	deleted_at   INTEGER
);
CREATE UNIQUE INDEX nodes_live_path ON nodes(ether_id, path) WHERE deleted_at IS NULL;
CREATE INDEX nodes_parent ON nodes(parent_id);

CREATE TABLE blobs (
	sha256             TEXT PRIMARY KEY,
	size               INTEGER NOT NULL,
	mime_type          TEXT NOT NULL,
	created_at         INTEGER NOT NULL,
	unreferenced_since INTEGER
);

CREATE TABLE versions (
	node_id      TEXT NOT NULL REFERENCES nodes(id),
	version      INTEGER NOT NULL,
	blob_sha256  TEXT REFERENCES blobs(sha256),
	mime_type    TEXT NOT NULL DEFAULT '',
	size         INTEGER NOT NULL DEFAULT 0,
	author_id    TEXT NOT NULL REFERENCES accounts(id),
	client_id    TEXT NOT NULL DEFAULT '',
	created_at   INTEGER NOT NULL,
	is_tombstone INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (node_id, version)
);
CREATE INDEX versions_blob ON versions(blob_sha256);

CREATE TABLE board_posts (
	id           TEXT PRIMARY KEY,
	ether_id     TEXT NOT NULL REFERENCES ethers(id),
	author_id    TEXT NOT NULL REFERENCES accounts(id),
	client_id    TEXT NOT NULL DEFAULT '',
	intent       TEXT NOT NULL CHECK (intent IN ('update', 'primer', 'review', 'handoff', 'fyi')),
	title        TEXT NOT NULL DEFAULT '',
	body         TEXT NOT NULL,
	reply_to     TEXT REFERENCES board_posts(id),
	created_at   INTEGER NOT NULL,
	send_at      INTEGER,
	published_at INTEGER,
	cancelled_at INTEGER,
	deleted_at   INTEGER
);
CREATE INDEX board_posts_ether ON board_posts(ether_id, published_at);
CREATE INDEX board_posts_due ON board_posts(send_at) WHERE published_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE audit_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	at         INTEGER NOT NULL,
	account_id TEXT,
	client_id  TEXT NOT NULL DEFAULT '',
	ether_id   TEXT,
	action     TEXT NOT NULL,
	target     TEXT NOT NULL DEFAULT '',
	detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_ether ON audit_log(ether_id, at);

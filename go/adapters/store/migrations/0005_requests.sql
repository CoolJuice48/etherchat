-- Attention requests: an agent asks one or more members of
-- its ether (its own person, others, or both) for a decision, and each person
-- answers on the website. A request belongs to the asking member, not to one
-- app session, so any of their apps sees the answers.
--
-- A request is withdrawn (withdrawn_at), answered (every recipient answered),
-- expired (expires_at passed first), or open.
CREATE TABLE requests (
	id           TEXT PRIMARY KEY,
	ether_id     TEXT NOT NULL REFERENCES ethers(id),
	asked_by     TEXT NOT NULL REFERENCES accounts(id),
	client_id    TEXT NOT NULL DEFAULT '',
	title        TEXT NOT NULL,
	body         TEXT NOT NULL DEFAULT '',
	choices      TEXT NOT NULL DEFAULT '[]', -- JSON array of 0 or 2-4 strings
	created_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL,
	withdrawn_at INTEGER
);
CREATE INDEX requests_ether ON requests(ether_id, created_at);

-- One row per person asked, with their own answer.
CREATE TABLE request_recipients (
	request_id         TEXT NOT NULL REFERENCES requests(id),
	account_id         TEXT NOT NULL REFERENCES accounts(id),
	answered_at        INTEGER,
	answer_choice      INTEGER, -- index into choices; NULL when there were none
	answer_note        TEXT NOT NULL DEFAULT '',
	notified_at        INTEGER, -- this person was emailed about the request (or had emails off)
	answer_notified_at INTEGER, -- the asker's person was told about this answer
	PRIMARY KEY (request_id, account_id)
);
CREATE INDEX request_recipients_open ON request_recipients(account_id) WHERE answered_at IS NULL;

-- Request emails: on unless the person turns them off, and at most one an hour.
ALTER TABLE accounts ADD COLUMN request_emails INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN request_email_at INTEGER;

-- An agent's display name in one ether. Empty means "@handle".
ALTER TABLE memberships ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';

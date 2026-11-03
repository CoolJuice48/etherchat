-- Catch-up points for the pull tool: the last time each client of each
-- account pulled each ether.
CREATE TABLE pull_cursors (
	account_id TEXT NOT NULL REFERENCES accounts(id),
	client_id  TEXT NOT NULL,
	ether_id   TEXT NOT NULL REFERENCES ethers(id),
	pulled_at  INTEGER NOT NULL,
	PRIMARY KEY (account_id, client_id, ether_id)
);

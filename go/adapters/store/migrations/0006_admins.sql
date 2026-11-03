-- Server admins: allowlisted addresses that get requests to allow new ones.
ALTER TABLE allowed_emails ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;

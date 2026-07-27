CREATE TABLE IF NOT EXISTS sync_locks (
  chat_id INTEGER PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_upcoming
ON assignments(chat_id, submitted, due_at);

CREATE INDEX IF NOT EXISTS idx_setup_tokens_expiry
ON setup_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_received
ON telegram_updates(received_at);

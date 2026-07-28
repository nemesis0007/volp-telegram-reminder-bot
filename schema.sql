CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  reminder_minutes INTEGER NOT NULL DEFAULT 90 CHECK(reminder_minutes IN (60, 90, 120))
);

CREATE TABLE IF NOT EXISTS setup_tokens (
  token TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS volp_accounts (
  chat_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  uid TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  encrypted_password TEXT,
  auto_relogin INTEGER NOT NULL DEFAULT 0 CHECK(auto_relogin IN (0, 1)),
  connected_at TEXT NOT NULL,
  last_reauth_at TEXT,
  sync_enqueued_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  FOREIGN KEY(chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assignments (
  chat_id INTEGER NOT NULL,
  assignment_key TEXT NOT NULL,
  title TEXT NOT NULL,
  course TEXT NOT NULL,
  assignment_type TEXT NOT NULL,
  due_at TEXT NOT NULL,
  submitted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, assignment_key),
  FOREIGN KEY(chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sent_notifications (
  chat_id INTEGER NOT NULL,
  assignment_key TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, assignment_key, threshold_minutes)
);

CREATE TABLE IF NOT EXISTS new_assignment_notifications (
  chat_id INTEGER NOT NULL,
  assignment_key TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, assignment_key)
);

CREATE TABLE IF NOT EXISTS daily_digest_log (
  chat_id INTEGER NOT NULL,
  digest_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, digest_date)
);

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

CREATE TRIGGER IF NOT EXISTS enforce_volp_account_capacity
BEFORE INSERT ON volp_accounts
WHEN (SELECT COUNT(*) FROM volp_accounts) >= 90
 AND NOT EXISTS (
   SELECT 1 FROM volp_accounts WHERE chat_id=NEW.chat_id
 )
BEGIN
  SELECT RAISE(ABORT, 'BOT_CAPACITY_REACHED');
END;

CREATE TRIGGER IF NOT EXISTS reset_notification_after_due_date_change
AFTER UPDATE OF due_at ON assignments
WHEN OLD.due_at <> NEW.due_at
BEGIN
  DELETE FROM sent_notifications
  WHERE chat_id=NEW.chat_id AND assignment_key=NEW.assignment_key;
END;

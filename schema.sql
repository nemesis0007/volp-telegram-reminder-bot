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
  connected_at TEXT NOT NULL,
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

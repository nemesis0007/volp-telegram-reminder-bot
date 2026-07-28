CREATE TABLE IF NOT EXISTS daily_digest_log (
  chat_id INTEGER NOT NULL,
  digest_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, digest_date)
);

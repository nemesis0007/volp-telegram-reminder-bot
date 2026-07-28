CREATE TABLE IF NOT EXISTS new_assignment_notifications (
  chat_id INTEGER NOT NULL,
  assignment_key TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, assignment_key)
);

INSERT OR IGNORE INTO new_assignment_notifications(chat_id, assignment_key, notified_at)
SELECT chat_id, assignment_key, updated_at FROM assignments;

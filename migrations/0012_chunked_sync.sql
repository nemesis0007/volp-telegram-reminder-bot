CREATE TABLE IF NOT EXISTS sync_runs (
  run_id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  enqueued_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  completion_notified_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
  course_count INTEGER NOT NULL CHECK(course_count >= 0),
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0, 1)),
  initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0, 1)),
  FOREIGN KEY(chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_active_chat
ON sync_runs(chat_id) WHERE status='running';

CREATE TABLE IF NOT EXISTS sync_run_courses (
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  course_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done')),
  PRIMARY KEY(run_id, position),
  FOREIGN KEY(run_id) REFERENCES sync_runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_run_assignments (
  run_id TEXT NOT NULL,
  assignment_key TEXT NOT NULL,
  title TEXT NOT NULL,
  course TEXT NOT NULL,
  assignment_type TEXT NOT NULL,
  due_at TEXT NOT NULL,
  submitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(run_id, assignment_key),
  FOREIGN KEY(run_id) REFERENCES sync_runs(run_id) ON DELETE CASCADE
);

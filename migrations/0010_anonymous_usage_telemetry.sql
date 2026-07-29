CREATE TABLE IF NOT EXISTS telemetry_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  installation_id TEXT NOT NULL UNIQUE,
  last_sent_at TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_installations (
  installation_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  version TEXT NOT NULL,
  user_count INTEGER NOT NULL CHECK(user_count >= 0),
  connected_user_count INTEGER NOT NULL CHECK(
    connected_user_count >= 0 AND connected_user_count <= user_count
  )
);

CREATE INDEX IF NOT EXISTS idx_telemetry_installations_last_seen
ON telemetry_installations(last_seen_at);

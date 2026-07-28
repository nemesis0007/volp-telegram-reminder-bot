ALTER TABLE volp_accounts ADD COLUMN sync_enqueued_at TEXT;

CREATE INDEX IF NOT EXISTS idx_volp_accounts_sync_dispatch
ON volp_accounts(last_sync_at, sync_enqueued_at);

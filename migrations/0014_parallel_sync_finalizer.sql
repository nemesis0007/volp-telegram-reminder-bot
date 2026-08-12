ALTER TABLE sync_runs
ADD COLUMN finalize_enqueued INTEGER NOT NULL DEFAULT 0
CHECK(finalize_enqueued IN (0, 1));

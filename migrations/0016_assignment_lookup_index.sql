CREATE INDEX IF NOT EXISTS idx_assignments_chat_due
ON assignments(chat_id, due_at);

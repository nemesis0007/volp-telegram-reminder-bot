CREATE TRIGGER IF NOT EXISTS reset_notification_after_due_date_change
AFTER UPDATE OF due_at ON assignments
WHEN OLD.due_at <> NEW.due_at
BEGIN
  DELETE FROM sent_notifications
  WHERE chat_id=NEW.chat_id AND assignment_key=NEW.assignment_key;
END;

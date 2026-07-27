ALTER TABLE users
ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 90
CHECK(reminder_minutes IN (60, 90, 120));

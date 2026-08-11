ALTER TABLE users
ADD COLUMN reminder_hours INTEGER NOT NULL DEFAULT 1
CHECK(reminder_hours BETWEEN 1 AND 10);

UPDATE users
SET reminder_hours = CASE
  WHEN reminder_minutes = 120 THEN 2
  ELSE 1
END;

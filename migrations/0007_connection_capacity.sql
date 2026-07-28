CREATE TRIGGER IF NOT EXISTS enforce_volp_account_capacity
BEFORE INSERT ON volp_accounts
WHEN (SELECT COUNT(*) FROM volp_accounts) >= 90
 AND NOT EXISTS (
   SELECT 1 FROM volp_accounts WHERE chat_id=NEW.chat_id
 )
BEGIN
  SELECT RAISE(ABORT, 'BOT_CAPACITY_REACHED');
END;

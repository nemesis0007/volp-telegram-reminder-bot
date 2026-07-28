ALTER TABLE volp_accounts ADD COLUMN encrypted_password TEXT;
ALTER TABLE volp_accounts
ADD COLUMN auto_relogin INTEGER NOT NULL DEFAULT 0 CHECK(auto_relogin IN (0, 1));
ALTER TABLE volp_accounts ADD COLUMN last_reauth_at TEXT;

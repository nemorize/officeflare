-- Store a password hash, never a plaintext password.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email_address TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  profile_image_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  password_hash TEXT,
  password_changed_at INTEGER,
  last_login_at INTEGER,
  disabled_at INTEGER,
  password_reset_required INTEGER NOT NULL DEFAULT 0 CHECK (password_reset_required IN (0, 1)),
  deleted_at INTEGER
);

-- Email lookups must include deleted_at IS NULL to select the active account.
CREATE UNIQUE INDEX users_active_email_address_unique
  ON users(email_address COLLATE NOCASE)
  WHERE deleted_at IS NULL;

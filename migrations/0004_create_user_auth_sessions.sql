ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  password_authenticated_at INTEGER NOT NULL,
  mfa_authenticated_at INTEGER,
  last_used_at INTEGER NOT NULL,
  -- Internal request marker for conditional writes in a single D1 batch.
  last_operation_id TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER,
  user_agent TEXT
)
STRICT;
CREATE INDEX user_sessions_user_id_index ON user_sessions (user_id, revoked_at, expires_at);
CREATE INDEX user_sessions_expiration_index ON user_sessions (expires_at);

-- Retain consumed tokens until the session expires to detect rotation replay.
CREATE TABLE user_refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES user_sessions (id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES user_refresh_tokens (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  used_at INTEGER,
  used_by TEXT UNIQUE,
  revoked_at INTEGER
)
STRICT;
CREATE INDEX user_refresh_tokens_session_id_index ON user_refresh_tokens (session_id);
CREATE INDEX user_refresh_tokens_parent_id_index ON user_refresh_tokens (parent_id);

-- Opaque, purpose-restricted bearer tokens; only their SHA-256 hashes are stored.
-- used_by identifies the winning request in conditional, transactional D1 batches.
CREATE TABLE user_auth_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  session_id TEXT REFERENCES user_sessions (id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (
    purpose IN ('login', 'login_mfa', 'password_reset', 'reauth_mfa', 'reauth')
  ),
  auth_version INTEGER NOT NULL,
  password_authenticated_at INTEGER NOT NULL,
  mfa_authenticated_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at INTEGER,
  used_by TEXT UNIQUE
)
STRICT;
CREATE INDEX user_auth_challenges_user_id_index ON user_auth_challenges (user_id, expires_at);
CREATE INDEX user_auth_challenges_expiration_index ON user_auth_challenges (expires_at);

CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at INTEGER NOT NULL
)
STRICT;
CREATE INDEX auth_rate_limits_expiration_index ON auth_rate_limits (expires_at);

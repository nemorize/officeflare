-- Authentication methods belong to immutable account IDs, never email addresses.
-- The API accepts only supported types; additional types can add their own detail tables.
-- MFA is enabled when a verified, non-revoked method exists for an eligible account.
CREATE TABLE user_mfa_methods (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (length(type) > 0 AND type = lower(trim(type))),
  name TEXT CHECK (name IS NULL OR length(trim(name)) > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at >= 0),
  verified_at INTEGER CHECK (verified_at IS NULL OR verified_at >= created_at),
  last_used_at INTEGER CHECK (
    last_used_at IS NULL OR (verified_at IS NOT NULL AND last_used_at >= verified_at)
  ),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  -- Only pending enrollment expires; this deadline does not expire a verified method.
  setup_expires_at INTEGER DEFAULT (unixepoch() + 600) CHECK (
    setup_expires_at IS NULL OR setup_expires_at > created_at
  ),
  CHECK (verified_at IS NOT NULL OR revoked_at IS NOT NULL OR setup_expires_at IS NOT NULL)
) STRICT;

CREATE INDEX user_mfa_methods_user_id_type_index ON user_mfa_methods(user_id, type);

CREATE INDEX user_mfa_methods_pending_expiration_index
  ON user_mfa_methods(setup_expires_at)
  WHERE verified_at IS NULL AND revoked_at IS NULL;

-- Store an AES-256-GCM ciphertext including its 16-byte authentication tag.
-- key_version selects a key kept in Workers Secrets, outside this database.
-- The API must validate the decrypted secret and use a fresh nonce when encrypting.
CREATE TABLE user_mfa_totp (
  method_id TEXT PRIMARY KEY NOT NULL REFERENCES user_mfa_methods(id) ON DELETE CASCADE,
  secret_ciphertext BLOB NOT NULL CHECK (length(secret_ciphertext) > 16),
  secret_nonce BLOB NOT NULL CHECK (length(secret_nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  algorithm TEXT NOT NULL DEFAULT 'SHA1' CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  digits INTEGER NOT NULL DEFAULT 6 CHECK (digits IN (6, 7, 8)),
  period_seconds INTEGER NOT NULL DEFAULT 30 CHECK (period_seconds > 0),
  -- Consume a verified step using a conditional UPDATE that requires the new step
  -- to be greater than the stored step; accept authentication only if a row changed.
  -- Enrollment verification must consume its step too, so it cannot be replayed at login.
  last_accepted_step INTEGER CHECK (last_accepted_step IS NULL OR last_accepted_step >= 0),
  UNIQUE (key_version, secret_nonce)
) STRICT;

-- A foreign key enforces existence; these guards enforce the matching method type.
CREATE TRIGGER user_mfa_totp_method_type_insert
BEFORE INSERT ON user_mfa_totp
WHEN NOT EXISTS (
  SELECT 1 FROM user_mfa_methods WHERE id = NEW.method_id AND type = 'totp'
)
BEGIN
  SELECT RAISE(ABORT, 'TOTP details require a TOTP method');
END;

CREATE TRIGGER user_mfa_totp_method_type_update
BEFORE UPDATE OF method_id ON user_mfa_totp
WHEN NOT EXISTS (
  SELECT 1 FROM user_mfa_methods WHERE id = NEW.method_id AND type = 'totp'
)
BEGIN
  SELECT RAISE(ABORT, 'TOTP details require a TOTP method');
END;

CREATE TRIGGER user_mfa_methods_totp_type_update
BEFORE UPDATE OF type ON user_mfa_methods
WHEN NEW.type <> 'totp' AND EXISTS (
  SELECT 1 FROM user_mfa_totp WHERE method_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'A method with TOTP details must keep its TOTP type');
END;

-- Recovery codes belong to the account, independently of any particular method.
-- code_hash stores an encoded one-way hash, including salt/parameters if applicable.
-- Display plaintext codes only at issuance; never persist them here.
-- The API consumes codes with a conditional UPDATE requiring used_at IS NULL and
-- revoked_at IS NULL, and revokes old unused codes atomically when issuing a new set.
CREATE TABLE user_mfa_recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK (length(trim(code_hash)) > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at >= 0),
  used_at INTEGER CHECK (used_at IS NULL OR used_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (user_id, code_hash)
) STRICT;

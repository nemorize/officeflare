CREATE TABLE push_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  web_push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_push_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT REFERENCES users (id)
)
STRICT;
INSERT INTO push_settings (id) VALUES (1);

-- Token type is independent of user/device identity so native clients can share
-- this registry without treating APNs, Android and browser tokens alike.
CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES user_sessions (id)
    ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  token_type TEXT NOT NULL CHECK (token_type IN ('fcm_web', 'fcm_android', 'fcm_ios')),
  token TEXT NOT NULL UNIQUE CHECK (length(token) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, device_id, token_type)
)
STRICT;
CREATE INDEX push_tokens_session ON push_tokens (session_id);
CREATE INDEX push_tokens_user ON push_tokens (user_id, token_type);

-- Successful devices are not sent again when another device needs a retry.
CREATE TABLE notification_push_deliveries (
  seq INTEGER NOT NULL REFERENCES notification_changes (seq)
    ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES push_tokens (id)
    ON DELETE CASCADE,
  lease_until INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  PRIMARY KEY (seq, token_id)
)
STRICT;

CREATE TRIGGER push_tokens_session_revoked
AFTER UPDATE OF revoked_at ON user_sessions
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM push_tokens WHERE session_id = NEW.id;
END;

INSERT INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'admin.notifications.settings.read'),
  ('system-administrator', 'admin.notifications.settings.manage');

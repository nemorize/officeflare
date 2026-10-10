CREATE TABLE notification_events (
  id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) <= 1000),
  target_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE notification_recipients (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('deliver', 'suppressed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, user_id)
) STRICT;

CREATE TABLE notification_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  read_at INTEGER,
  archived_at INTEGER,
  snoozed_until INTEGER,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, event_id)
) STRICT;
CREATE INDEX notification_inbox_user_seq ON notification_inbox(user_id, seq DESC);
CREATE INDEX notification_inbox_snoozed ON notification_inbox(snoozed_until) WHERE snoozed_until IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  rules_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rules_json) AND json_type(rules_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE notification_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'deleted', 'preferences')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX notification_changes_user_seq ON notification_changes(user_id, seq);

CREATE TABLE notification_outbox (
  seq INTEGER PRIMARY KEY REFERENCES notification_changes(seq) ON DELETE CASCADE,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  delivered_at INTEGER
) STRICT;
CREATE INDEX notification_outbox_pending ON notification_outbox(lease_until, seq) WHERE delivered_at IS NULL;

CREATE TABLE notification_ws_tickets (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_ws_tickets_expiry ON notification_ws_tickets(expires_at);

CREATE TRIGGER notification_inbox_created AFTER INSERT ON notification_inbox
BEGIN
  INSERT INTO notification_changes (user_id, notification_id, kind) VALUES (NEW.user_id, NEW.id, 'created');
END;
CREATE TRIGGER notification_inbox_updated AFTER UPDATE ON notification_inbox
BEGIN
  INSERT INTO notification_changes (user_id, notification_id, kind) VALUES (NEW.user_id, NEW.id, CASE WHEN NEW.deleted_at IS NULL THEN 'updated' ELSE 'deleted' END);
END;
CREATE TRIGGER notification_preferences_created AFTER INSERT ON notification_preferences
BEGIN
  INSERT INTO notification_changes (user_id, kind) VALUES (NEW.user_id, 'preferences');
END;
CREATE TRIGGER notification_preferences_updated AFTER UPDATE ON notification_preferences
BEGIN
  INSERT INTO notification_changes (user_id, kind) VALUES (NEW.user_id, 'preferences');
END;
CREATE TRIGGER notification_changes_outbox AFTER INSERT ON notification_changes
BEGIN
  INSERT INTO notification_outbox (seq) VALUES (NEW.seq);
END;

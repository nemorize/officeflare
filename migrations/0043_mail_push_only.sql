-- Mail has its own durable push queue and never creates notification-center items.
CREATE TABLE mail_push_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes (id)
    ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id)
    ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) <= 1000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  delivered_at INTEGER,
  UNIQUE (source_key, user_id)
)
STRICT;
CREATE INDEX mail_push_outbox_pending ON mail_push_outbox (lease_until, seq)
WHERE delivered_at IS NULL;

CREATE TABLE mail_push_deliveries (
  seq INTEGER NOT NULL REFERENCES mail_push_outbox (seq)
    ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES push_tokens (id)
    ON DELETE CASCADE,
  lease_until INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  PRIMARY KEY (seq, token_id)
)
STRICT;

-- Remove old delivery work, but publish deletions so connected clients refresh.
DELETE FROM notification_changes
WHERE
  notification_id IN
    (
      SELECT i.id
      FROM notification_inbox i
      JOIN notification_events e ON e.id = i.event_id
      WHERE e.type GLOB 'mail.*'
    );
INSERT INTO notification_changes (user_id, notification_id, kind)
SELECT i.user_id, i.id, 'deleted'
FROM notification_inbox i
JOIN notification_events e ON e.id = i.event_id
WHERE e.type GLOB 'mail.*';

DELETE FROM notification_inbox
WHERE event_id IN (SELECT id FROM notification_events WHERE type GLOB 'mail.*');
DELETE FROM notification_recipients
WHERE event_id IN (SELECT id FROM notification_events WHERE type GLOB 'mail.*');
DELETE FROM notification_events WHERE type GLOB 'mail.*';

UPDATE notification_preferences
SET
  rules_json = json_remove(
    rules_json,
    '$."type:mail.received"',
    '$."category:mail:messages"',
    '$."service:mail"'
  ),
  version = version + 1,
  updated_at = unixepoch()
WHERE
  json_type(rules_json, '$."type:mail.received"') IS NOT NULL
  OR json_type(rules_json, '$."category:mail:messages"') IS NOT NULL
  OR json_type(rules_json, '$."service:mail"') IS NOT NULL;

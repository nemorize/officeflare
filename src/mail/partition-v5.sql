-- Mark existing sent mail as read and notify clients through the normal change stream.
INSERT INTO change_log (message_id, operation, created_at)
SELECT id, 'updated', unixepoch()
FROM messages
WHERE folder_id = 'sent' AND is_read = 0;

INSERT INTO outbox (id, kind, payload_json, created_at, dispatched_at)
SELECT
  lower(hex(randomblob(16))),
  'event',
  json_object(
    'mailbox_id',
    identity.mailbox_id,
    'partition_id',
    identity.partition_id,
    'message_id',
    m.id,
    'thread_id',
    m.thread_id,
    'version',
    m.version + 1,
    'operation',
    'updated',
    'private_user_id',
    m.draft_owner_id
  ),
  unixepoch(),
  NULL
FROM messages m
CROSS JOIN partition_identity identity
WHERE identity.id = 1 AND m.folder_id = 'sent' AND m.is_read = 0;

-- Existing read-model triggers update folder and conversation unread counts atomically.
UPDATE messages
SET
  is_read = 1,
  version = version + 1,
  updated_at = unixepoch()
WHERE folder_id = 'sent' AND is_read = 0;

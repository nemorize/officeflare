CREATE TABLE mailbox_counts (
  owner_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  is_starred INTEGER NOT NULL,
  snoozed_until INTEGER NOT NULL,
  total INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  PRIMARY KEY (owner_id, folder_id, is_starred, snoozed_until)
)
STRICT;
-- statement-breakpoint
CREATE TABLE thread_summaries (
  thread_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  snoozed_until INTEGER NOT NULL,
  representative_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  unread_count INTEGER NOT NULL,
  starred_count INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  participants TEXT,
  PRIMARY KEY (thread_id, folder_id, snoozed_until)
)
STRICT;
-- statement-breakpoint
CREATE INDEX messages_thread_bucket_order
ON messages (thread_id, folder_id, coalesce(snoozed_until, 0), received_at DESC, id DESC)
WHERE draft_owner_id IS NULL;
-- statement-breakpoint
CREATE INDEX thread_summaries_order
ON thread_summaries (folder_id, received_at DESC, representative_id DESC);
-- statement-breakpoint
INSERT INTO mailbox_counts
SELECT
  coalesce(draft_owner_id, ''),
  folder_id,
  is_starred,
  coalesce(snoozed_until, 0),
  count(*),
  sum(1 - is_read)
FROM messages
GROUP BY coalesce(draft_owner_id, ''), folder_id, is_starred, coalesce(snoozed_until, 0);
-- statement-breakpoint
INSERT INTO thread_summaries
SELECT
  m.thread_id,
  m.folder_id,
  coalesce(m.snoozed_until, 0),
  (
    SELECT lead.id
    FROM messages lead
    WHERE
      lead.thread_id = m.thread_id
      AND lead.folder_id = m.folder_id
      AND coalesce(lead.snoozed_until, 0) = coalesce(m.snoozed_until, 0)
      AND lead.draft_owner_id IS NULL
    ORDER BY lead.received_at DESC, lead.id DESC
    LIMIT 1
  ),
  max(m.received_at),
  count(*),
  sum(1 - m.is_read),
  sum(m.is_starred),
  max(m.has_attachments),
  group_concat(DISTINCT nullif(m.from_address, ''))
FROM messages m
WHERE m.draft_owner_id IS NULL
GROUP BY m.thread_id, m.folder_id, coalesce(m.snoozed_until, 0);
-- statement-breakpoint
CREATE TABLE read_model_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  defer_threads INTEGER NOT NULL
)
STRICT;
-- statement-breakpoint
INSERT INTO read_model_state VALUES (1, 0);
-- statement-breakpoint
CREATE TABLE thread_summary_dirty (thread_id TEXT PRIMARY KEY) STRICT;
-- statement-breakpoint
CREATE TRIGGER messages_read_models_insert
AFTER INSERT ON messages
BEGIN
  INSERT INTO mailbox_counts
  VALUES
    (
      coalesce(NEW.draft_owner_id, ''),
      NEW.folder_id,
      NEW.is_starred,
      coalesce(NEW.snoozed_until, 0),
      1,
      1 - NEW.is_read
    )
  ON CONFLICT (owner_id, folder_id, is_starred, snoozed_until) DO UPDATE
    SET
      total = total + 1,
      unread = unread + excluded.unread;
  DELETE FROM thread_summaries
  WHERE (SELECT defer_threads FROM read_model_state) = 0 AND thread_id = NEW.thread_id;
  INSERT INTO thread_summaries
  SELECT
    m.thread_id,
    m.folder_id,
    coalesce(m.snoozed_until, 0),
    (
      SELECT lead.id
      FROM messages lead
      WHERE
        lead.thread_id = m.thread_id
        AND lead.folder_id = m.folder_id
        AND coalesce(lead.snoozed_until, 0) = coalesce(m.snoozed_until, 0)
        AND lead.draft_owner_id IS NULL
      ORDER BY lead.received_at DESC, lead.id DESC
      LIMIT 1
    ),
    max(m.received_at),
    count(*),
    sum(1 - m.is_read),
    sum(m.is_starred),
    max(m.has_attachments),
    group_concat(DISTINCT nullif(m.from_address, ''))
  FROM messages m
  WHERE
    (SELECT defer_threads FROM read_model_state) = 0
    AND m.draft_owner_id IS NULL
    AND m.thread_id = NEW.thread_id
  GROUP BY m.thread_id, m.folder_id, coalesce(m.snoozed_until, 0);
  INSERT OR IGNORE INTO thread_summary_dirty
  SELECT NEW.thread_id WHERE (SELECT defer_threads FROM read_model_state) = 1;
END;
-- statement-breakpoint
CREATE TRIGGER messages_read_models_delete
AFTER DELETE ON messages
BEGIN
  UPDATE mailbox_counts
  SET
    total = total - 1,
    unread = unread - (1 - OLD.is_read)
  WHERE
    owner_id = coalesce(OLD.draft_owner_id, '')
    AND folder_id = OLD.folder_id
    AND is_starred = OLD.is_starred
    AND snoozed_until = coalesce(OLD.snoozed_until, 0);
  DELETE FROM mailbox_counts WHERE total = 0;
  DELETE FROM thread_summaries
  WHERE (SELECT defer_threads FROM read_model_state) = 0 AND thread_id = OLD.thread_id;
  INSERT INTO thread_summaries
  SELECT
    m.thread_id,
    m.folder_id,
    coalesce(m.snoozed_until, 0),
    (
      SELECT lead.id
      FROM messages lead
      WHERE
        lead.thread_id = m.thread_id
        AND lead.folder_id = m.folder_id
        AND coalesce(lead.snoozed_until, 0) = coalesce(m.snoozed_until, 0)
        AND lead.draft_owner_id IS NULL
      ORDER BY lead.received_at DESC, lead.id DESC
      LIMIT 1
    ),
    max(m.received_at),
    count(*),
    sum(1 - m.is_read),
    sum(m.is_starred),
    max(m.has_attachments),
    group_concat(DISTINCT nullif(m.from_address, ''))
  FROM messages m
  WHERE
    (SELECT defer_threads FROM read_model_state) = 0
    AND m.draft_owner_id IS NULL
    AND m.thread_id = OLD.thread_id
  GROUP BY m.thread_id, m.folder_id, coalesce(m.snoozed_until, 0);
  INSERT OR IGNORE INTO thread_summary_dirty
  SELECT OLD.thread_id WHERE (SELECT defer_threads FROM read_model_state) = 1;
END;
-- statement-breakpoint
CREATE TRIGGER messages_read_models_update
AFTER UPDATE OF
  thread_id,
  folder_id,
  draft_owner_id,
  is_read,
  is_starred,
  snoozed_until,
  received_at,
  from_address,
  has_attachments
ON messages
BEGIN
  UPDATE mailbox_counts
  SET
    total = total - 1,
    unread = unread - (1 - OLD.is_read)
  WHERE
    owner_id = coalesce(OLD.draft_owner_id, '')
    AND folder_id = OLD.folder_id
    AND is_starred = OLD.is_starred
    AND snoozed_until = coalesce(OLD.snoozed_until, 0);
  DELETE FROM mailbox_counts WHERE total = 0;
  INSERT INTO mailbox_counts
  VALUES
    (
      coalesce(NEW.draft_owner_id, ''),
      NEW.folder_id,
      NEW.is_starred,
      coalesce(NEW.snoozed_until, 0),
      1,
      1 - NEW.is_read
    )
  ON CONFLICT (owner_id, folder_id, is_starred, snoozed_until) DO UPDATE
    SET
      total = total + 1,
      unread = unread + excluded.unread;
  DELETE FROM thread_summaries
  WHERE
    (SELECT defer_threads FROM read_model_state) = 0
    AND (thread_id = NEW.thread_id OR thread_id = OLD.thread_id);
  INSERT INTO thread_summaries
  SELECT
    m.thread_id,
    m.folder_id,
    coalesce(m.snoozed_until, 0),
    (
      SELECT lead.id
      FROM messages lead
      WHERE
        lead.thread_id = m.thread_id
        AND lead.folder_id = m.folder_id
        AND coalesce(lead.snoozed_until, 0) = coalesce(m.snoozed_until, 0)
        AND lead.draft_owner_id IS NULL
      ORDER BY lead.received_at DESC, lead.id DESC
      LIMIT 1
    ),
    max(m.received_at),
    count(*),
    sum(1 - m.is_read),
    sum(m.is_starred),
    max(m.has_attachments),
    group_concat(DISTINCT nullif(m.from_address, ''))
  FROM messages m
  WHERE
    (SELECT defer_threads FROM read_model_state) = 0
    AND m.draft_owner_id IS NULL
    AND (m.thread_id = NEW.thread_id OR m.thread_id = OLD.thread_id)
  GROUP BY m.thread_id, m.folder_id, coalesce(m.snoozed_until, 0);
  INSERT OR IGNORE INTO thread_summary_dirty
  SELECT OLD.thread_id WHERE (SELECT defer_threads FROM read_model_state) = 1;
  INSERT OR IGNORE INTO thread_summary_dirty
  SELECT NEW.thread_id WHERE (SELECT defer_threads FROM read_model_state) = 1;
END;

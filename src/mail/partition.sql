CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS partition_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mailbox_id TEXT NOT NULL,
  partition_id TEXT NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'email',
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  reply_to_address TEXT,
  received_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  is_spam INTEGER NOT NULL DEFAULT 0 CHECK (is_spam IN (0, 1)),
  snoozed_until INTEGER,
  trashed_at INTEGER,
  provider TEXT,
  connection_id TEXT,
  provider_message_id TEXT,
  rfc_message_id TEXT,
  raw_r2_key TEXT,
  body_r2_key TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  draft_owner_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  ingest_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
STRICT;
CREATE INDEX IF NOT EXISTS messages_order_index ON messages (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_folder_index ON messages (folder_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_thread_index ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_rfc_index ON messages (rfc_message_id);
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  ordinal INTEGER NOT NULL,
  email_address TEXT NOT NULL,
  PRIMARY KEY (message_id, kind, ordinal)
)
STRICT;
CREATE TABLE IF NOT EXISTS message_references (
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  rfc_message_id TEXT NOT NULL,
  PRIMARY KEY (message_id, rfc_message_id)
)
STRICT;
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_id TEXT,
  r2_key TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'attachment'
)
STRICT;
CREATE TABLE IF NOT EXISTS drafts (
  message_id TEXT PRIMARY KEY REFERENCES messages (id)
    ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'editable' CHECK (state IN ('editable', 'submitted')),
  created_by TEXT NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS draft_revisions (
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body_r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, version)
)
STRICT;
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  actor_auth_version INTEGER NOT NULL,
  api_key_id TEXT,
  address_id TEXT NOT NULL,
  send_mode TEXT NOT NULL CHECK (send_mode IN ('send_as', 'send_on_behalf')),
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_message_id TEXT,
  request_hash TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  snapshot_r2_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN
      (
        'scheduled',
        'queued',
        'processing',
        'accepted',
        'retry_wait',
        'failed',
        'unknown',
        'canceled'
      )
  ),
  scheduled_at INTEGER NOT NULL,
  lease_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_draft_live_unique ON submissions (message_id)
WHERE status IN ('scheduled', 'queued', 'processing', 'accepted', 'retry_wait', 'unknown');
CREATE INDEX IF NOT EXISTS submissions_provider_index
ON submissions (provider, connection_id, provider_message_id);
CREATE TABLE IF NOT EXISTS submission_recipients (
  submission_id TEXT NOT NULL REFERENCES submissions (id)
    ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  event_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (submission_id, email_address)
)
STRICT;
CREATE TABLE IF NOT EXISTS submission_attempts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions (id)
    ON DELETE CASCADE,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
)
STRICT;
CREATE TABLE IF NOT EXISTS provider_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, provider_event_id)
)
STRICT;
CREATE TABLE IF NOT EXISTS search_documents (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id)
    ON DELETE CASCADE,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_addresses TEXT NOT NULL,
  body TEXT NOT NULL
)
STRICT;
CREATE INDEX IF NOT EXISTS search_documents_message_index ON search_documents (message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(
  subject,
  from_address,
  to_addresses,
  body,
  content = 'search_documents',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
)
STRICT;
CREATE TABLE IF NOT EXISTS processing_receipts (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS change_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS garbage (
  r2_key TEXT PRIMARY KEY,
  delete_after INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (webhook_id, event_id)
)
STRICT;

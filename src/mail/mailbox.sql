CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS mailbox_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mailbox_id TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  retention_days INTEGER CHECK (retention_days BETWEEN 1 AND 3650),
  auto_reply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply_enabled IN (0, 1)),
  auto_reply_subject TEXT NOT NULL DEFAULT '',
  auto_reply_text TEXT NOT NULL DEFAULT ''
)
STRICT;
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1
)
STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS folders_name_unique ON folders (lower(name));
CREATE TABLE IF NOT EXISTS partitions (
  id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'active', 'closed')),
  database_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS partitions_active_unique ON partitions (status)
WHERE status = 'active';
CREATE TABLE IF NOT EXISTS allocations (
  operation_id TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL REFERENCES partitions (id),
  expires_at INTEGER NOT NULL,
  reserved_bytes INTEGER NOT NULL DEFAULT 0
)
STRICT;
CREATE TABLE IF NOT EXISTS request_keys (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  dispatched_at INTEGER
)
STRICT;
CREATE INDEX IF NOT EXISTS scheduled_tasks_due_index ON scheduled_tasks (due_at, dispatched_at);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  actions_json TEXT NOT NULL CHECK (json_valid(actions_json)),
  version INTEGER NOT NULL DEFAULT 1
)
STRICT;
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL DEFAULT ''
)
STRICT;
CREATE TABLE IF NOT EXISTS blocked_senders (email_address TEXT PRIMARY KEY COLLATE NOCASE) STRICT;
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS auto_reply_receipts (
  sender TEXT PRIMARY KEY COLLATE NOCASE,
  replied_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS recent_provider_messages (
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, provider_message_id)
)
STRICT;
CREATE TABLE IF NOT EXISTS websocket_tickets (
  token_hash TEXT PRIMARY KEY,
  actor_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_json TEXT NOT NULL,
  private_user_id TEXT,
  created_at INTEGER NOT NULL
)
STRICT;
CREATE TABLE IF NOT EXISTS data_jobs (
  id TEXT PRIMARY KEY,
  actor_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source_r2_key TEXT,
  output_prefix TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
STRICT;

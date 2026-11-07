CREATE TABLE mail_workspace_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_retention_days INTEGER CHECK (default_retention_days BETWEEN 1 AND 3650),
  max_send_bytes INTEGER CHECK (max_send_bytes BETWEEN 1 AND 104857600),
  external_forwarding_enabled INTEGER NOT NULL DEFAULT 1 CHECK (
    external_forwarding_enabled IN (0, 1)
  ),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT REFERENCES users (id)
)
STRICT;
INSERT INTO mail_workspace_settings (id) VALUES (1);

CREATE TABLE mail_admin_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  operation TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  resource_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX mail_admin_audit_actor ON mail_admin_audit (actor_user_id, sequence DESC);

CREATE TABLE mail_admin_flow (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT REFERENCES mail_mailboxes (id)
    ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  scheduled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
)
STRICT;
CREATE INDEX mail_admin_flow_order ON mail_admin_flow (created_at DESC, id DESC);
CREATE INDEX mail_admin_flow_mailbox ON mail_admin_flow (mailbox_id, created_at DESC, id DESC);
CREATE INDEX mail_admin_flow_status ON mail_admin_flow (status, created_at DESC, id DESC);

CREATE TABLE mail_admin_storage (
  mailbox_id TEXT PRIMARY KEY REFERENCES mail_mailboxes (id)
    ON DELETE CASCADE,
  message_count INTEGER NOT NULL,
  database_bytes INTEGER NOT NULL,
  attachment_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
STRICT;

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'admin.mail.overview.read'),
  ('system-administrator', 'admin.mail.flow.read'),
  ('system-administrator', 'admin.mail.settings.read'),
  ('system-administrator', 'admin.mail.settings.manage'),
  ('system-administrator', 'admin.mail.activity.read');
UPDATE roles
SET
  version = version + 1,
  updated_at = unixepoch()
WHERE id = 'system-administrator';

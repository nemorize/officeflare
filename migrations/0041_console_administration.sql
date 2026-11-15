CREATE TABLE console_settings (
  service TEXT PRIMARY KEY CHECK (service IN ('general', 'contacts', 'wiki')),
  values_json TEXT NOT NULL CHECK (json_valid(values_json) AND json_type(values_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER,
  updated_by TEXT REFERENCES users (id),
  operation_id TEXT
)
STRICT;
INSERT INTO console_settings (service, values_json)
VALUES
  (
    'general',
    '{"workspace_name":"Officeflare","support_url":"","default_language":"system","default_time_zone":"UTC","default_regional_format":"en"}'
  ),
  (
    'contacts',
    '{"entries_enabled":true,"folders_enabled":true,"fields_enabled":true,"max_contacts":0,"max_folders":0,"max_fields":0}'
  ),
  (
    'wiki',
    '{"spaces_enabled":true,"pages_enabled":true,"comments_enabled":true,"sharing_enabled":true}'
  );
CREATE TABLE console_audit (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  changed_keys_json TEXT NOT NULL CHECK (json_valid(changed_keys_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX console_audit_service_time ON console_audit (service, created_at DESC, id DESC);
CREATE TRIGGER console_audit_no_update
BEFORE UPDATE ON console_audit
BEGIN
  SELECT RAISE(ABORT, 'Console audit records are immutable');
END;
CREATE TRIGGER console_audit_no_delete
BEFORE DELETE ON console_audit
BEGIN
  SELECT RAISE(ABORT, 'Console audit records are immutable');
END;
ALTER TABLE calendar_workspace_settings
ADD COLUMN imports_enabled INTEGER NOT NULL DEFAULT 1 CHECK (imports_enabled IN (0, 1));
ALTER TABLE calendar_workspace_settings
ADD COLUMN subscriptions_enabled INTEGER NOT NULL DEFAULT 1 CHECK (subscriptions_enabled IN (0, 1));
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT 'system-administrator', value
FROM json_each(
  '["admin.workspace.settings.read","admin.workspace.settings.manage","admin.contacts.settings.read","admin.contacts.settings.manage","admin.contacts.accounts.read","admin.contacts.audit.read","admin.wiki.settings.read","admin.wiki.settings.manage","admin.wiki.content.read","admin.wiki.audit.read","admin.calendar.records.read"]'
);

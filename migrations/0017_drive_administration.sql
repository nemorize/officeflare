-- Preserve the capabilities of existing Drive roles; new access-only roles are read-only.
WITH capabilities(key) AS (VALUES ('drive.files.create'),('drive.files.update'),('drive.files.delete'),('drive.files.download'),('drive.comments.create'),('drive.sharing.internal'),('drive.sharing.public'))
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role_id,key FROM role_permissions CROSS JOIN capabilities WHERE permission_key='drive.access';
WITH grants(key) AS (VALUES ('admin.drive.settings.read'),('admin.drive.settings.manage'),('admin.drive.accounts.read'),('admin.drive.accounts.manage'),('admin.drive.items.read'),('admin.drive.sharing.read'),('admin.drive.sharing.manage'),('admin.drive.audit.read'),('admin.drive.ownership.transfer'),('admin.drive.trash.restore'),('admin.drive.trash.purge'))
INSERT OR IGNORE INTO role_permissions(role_id,permission_key) SELECT 'system-administrator',key FROM grants;
UPDATE roles SET version=version+1,updated_at=unixepoch() WHERE id IN (SELECT role_id FROM role_permissions WHERE permission_key='drive.access');
CREATE TABLE drive_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  default_quota_bytes INTEGER NOT NULL CHECK(default_quota_bytes>=0),
  max_file_bytes INTEGER NOT NULL CHECK(max_file_bytes BETWEEN 1 AND 5368709120),
  internal_sharing_enabled INTEGER NOT NULL CHECK(internal_sharing_enabled IN (0,1)),
  public_sharing_enabled INTEGER NOT NULL CHECK(public_sharing_enabled IN (0,1)),
  public_link_password_required INTEGER NOT NULL CHECK(public_link_password_required IN (0,1)),
  public_link_max_days INTEGER NOT NULL CHECK(public_link_max_days BETWEEN 0 AND 3650),
  trash_retention_days INTEGER NOT NULL CHECK(trash_retention_days BETWEEN 1 AND 3650),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
  updated_by TEXT REFERENCES users(id)
) STRICT;
INSERT INTO drive_settings(id,default_quota_bytes,max_file_bytes,internal_sharing_enabled,public_sharing_enabled,public_link_password_required,public_link_max_days,trash_retention_days)
VALUES(1,10737418240,5368709120,1,1,0,0,30);
ALTER TABLE drive_accounts ADD COLUMN quota_override_bytes INTEGER CHECK(quota_override_bytes>=0);
ALTER TABLE drive_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','read_only','suspended'));
ALTER TABLE drive_accounts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE drive_accounts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE drive_accounts SET quota_override_bytes=quota_bytes,updated_at=unixepoch();
CREATE TABLE drive_admin_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
) STRICT;
CREATE INDEX drive_admin_activity_time ON drive_admin_activity(created_at DESC,seq DESC);
CREATE INDEX drive_activity_owner_time ON drive_activity(owner_user_id,created_at DESC,seq DESC);
CREATE INDEX drive_activity_actor_time ON drive_activity(actor_user_id,created_at DESC,seq DESC);
CREATE TRIGGER drive_admin_activity_immutable_update BEFORE UPDATE ON drive_admin_activity
BEGIN
  SELECT RAISE(ABORT,'Drive administrator activity is immutable');
END;
CREATE TRIGGER drive_admin_activity_immutable_delete BEFORE DELETE ON drive_admin_activity
BEGIN
  SELECT RAISE(ABORT,'Drive administrator activity is immutable');
END;
CREATE TABLE drive_admin_jobs (
  id TEXT PRIMARY KEY,
  source_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  root_item_id TEXT REFERENCES drive_items(id),
  root_trashed_at INTEGER,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  status TEXT NOT NULL CHECK(status IN ('queued','running','failed','completed','cancelled')),
  total_items INTEGER NOT NULL,
  processed_items INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL,
  error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT(unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT(unixepoch())
) STRICT;
CREATE INDEX drive_admin_jobs_status ON drive_admin_jobs(status,created_at);
CREATE INDEX drive_admin_jobs_source ON drive_admin_jobs(source_user_id,status);
CREATE INDEX drive_admin_jobs_target ON drive_admin_jobs(target_user_id,status);
CREATE TABLE drive_admin_job_items (
  job_id TEXT NOT NULL REFERENCES drive_admin_jobs(id),
  item_id TEXT NOT NULL REFERENCES drive_items(id),
  parent_id TEXT,
  item_version INTEGER NOT NULL,
  size INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
  PRIMARY KEY(job_id,item_id)
) STRICT;
CREATE INDEX drive_admin_job_items_item ON drive_admin_job_items(item_id,processed);

-- Optional, editable roles are ready to assign; no existing user gains a new role.
WITH definitions(id,key,label,description) AS (VALUES
  ('system-drive-user','drive-user','Drive user','Use owned and explicitly shared items, subject to workspace sharing policies.'),
  ('system-drive-reader','drive-reader','Drive read-only user','Read, preview and download accessible items. Does not allow uploads or changes.'),
  ('system-drive-manager','drive-manager','Drive manager','Manage Drive storage, policies, sharing and handovers. Does not grant file content access.'),
  ('system-drive-auditor','drive-auditor','Drive auditor','Inspect Drive account, inventory, sharing and audit metadata without changing it.')
)
INSERT INTO roles(id,key,label,description)
SELECT definitions.id,CASE WHEN EXISTS(SELECT 1 FROM roles WHERE roles.key=definitions.key) THEN 'officeflare-'||definitions.key||'-'||lower(hex(randomblob(4))) ELSE definitions.key END,label,description FROM definitions;
WITH capabilities(key) AS (VALUES ('drive.access'),('drive.files.create'),('drive.files.update'),('drive.files.delete'),('drive.files.download'),('drive.comments.create'),('drive.sharing.internal'),('drive.sharing.public'))
INSERT INTO role_permissions(role_id,permission_key) SELECT 'system-drive-user',key FROM capabilities;
INSERT INTO role_permissions(role_id,permission_key) VALUES
  ('system-drive-reader','drive.access'),('system-drive-reader','drive.files.download');
INSERT INTO role_permissions(role_id,permission_key) SELECT 'system-drive-manager',permission_key FROM role_permissions WHERE role_id='system-administrator' AND (permission_key LIKE 'admin.drive.%' OR permission_key='console.access');
WITH grants(key) AS (VALUES ('console.access'),('admin.drive.accounts.read'),('admin.drive.items.read'),('admin.drive.sharing.read'),('admin.drive.audit.read'))
INSERT INTO role_permissions(role_id,permission_key) SELECT 'system-drive-auditor',key FROM grants;

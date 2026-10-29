-- Replace ambiguous management grants without removing existing capabilities.
ALTER TABLE roles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
ALTER TABLE users
ADD COLUMN role_assignment_version INTEGER NOT NULL DEFAULT 1 CHECK (role_assignment_version > 0);
WITH
  mappings(old_key, new_key) AS (
    VALUES
      ('users.read', 'admin.users.read'),
      ('users.create', 'admin.users.create'),
      ('users.update', 'admin.users.profile.update'),
      ('users.update', 'admin.users.status.update'),
      ('users.update', 'admin.users.credentials.reset'),
      ('users.email.update', 'admin.users.email.update'),
      ('users.delete', 'admin.users.delete'),
      ('users.roles.read', 'admin.users.roles.read'),
      ('users.roles.manage', 'admin.users.roles.assign'),
      ('users.roles.manage', 'admin.users.roles.remove'),
      ('roles.read', 'admin.roles.read'),
      ('roles.manage', 'admin.roles.create'),
      ('roles.manage', 'admin.roles.update'),
      ('roles.manage', 'admin.roles.delete'),
      ('mail.providers.manage', 'admin.mail.providers.manage'),
      ('mail.domains.manage', 'admin.mail.domains.manage'),
      ('mail.mailboxes.manage', 'admin.mail.mailboxes.manage')
  )
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT grants.role_id, mappings.new_key
FROM role_permissions grants
JOIN mappings ON grants.permission_key = mappings.old_key;
DELETE FROM role_permissions
WHERE
  permission_key IN
    (
      'users.read',
      'users.create',
      'users.update',
      'users.email.update',
      'users.delete',
      'users.roles.read',
      'users.roles.manage',
      'roles.read',
      'roles.manage',
      'mail.providers.manage',
      'mail.domains.manage',
      'mail.mailboxes.manage'
    );
-- Complete each migrated role's explicit prerequisite chain.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT DISTINCT role_id, 'admin.users.roles.read'
FROM role_permissions
WHERE permission_key IN ('admin.users.roles.assign', 'admin.users.roles.remove');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT DISTINCT role_id, 'admin.roles.read'
FROM role_permissions
WHERE permission_key LIKE 'admin.roles.%' OR permission_key LIKE 'admin.users.roles.%';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT DISTINCT role_id, 'admin.users.read'
FROM role_permissions
WHERE permission_key LIKE 'admin.users.%';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'admin.mail.providers.read'
FROM role_permissions
WHERE permission_key = 'admin.mail.providers.manage';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'admin.mail.domains.read'
FROM role_permissions
WHERE permission_key = 'admin.mail.domains.manage';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'admin.mail.mailboxes.read'
FROM role_permissions
WHERE permission_key = 'admin.mail.mailboxes.manage';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT DISTINCT role_id, 'console.access' FROM role_permissions WHERE permission_key LIKE 'admin.%';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'admin.roles.defaults.manage'),
  ('system-administrator', 'mail.access'),
  ('system-administrator', 'calendar.access'),
  ('system-administrator', 'drive.access');
UPDATE roles
SET
  version = version + 1,
  updated_at = unixepoch();
-- Mail was available to signed-in users before service access became explicit.
-- Preserve that access for existing accounts; future accounts use this default role.
INSERT INTO roles (id, key, label, description, is_default)
SELECT
  'system-mail-user',
  CASE
    WHEN EXISTS (SELECT 1 FROM roles WHERE key = 'mail-user') THEN
      'officeflare-mail-user-' || lower(hex(randomblob(4)))
    ELSE 'mail-user'
  END,
  'Mail user',
  'Use owned and shared mailboxes. Does not grant mail administration.',
  1;
INSERT INTO role_permissions (role_id, permission_key) VALUES ('system-mail-user', 'mail.access');
INSERT INTO user_roles (user_id, role_id)
SELECT id, 'system-mail-user' FROM users WHERE deleted_at IS NULL;
-- Assignment versions change for every writer, including cascaded role deletion.
CREATE TRIGGER user_roles_assignment_insert
AFTER INSERT ON user_roles
BEGIN
  UPDATE users SET role_assignment_version = role_assignment_version + 1 WHERE id = NEW.user_id;
END;
CREATE TRIGGER user_roles_assignment_delete
AFTER DELETE ON user_roles
BEGIN
  UPDATE users SET role_assignment_version = role_assignment_version + 1 WHERE id = OLD.user_id;
END;

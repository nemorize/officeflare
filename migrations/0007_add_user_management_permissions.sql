-- Grant existing and future administrator accounts the user-management actions.
INSERT INTO role_permissions (role_id, permission_key)
VALUES
  ('system-administrator', 'users.read'),
  ('system-administrator', 'users.create'),
  ('system-administrator', 'users.update'),
  ('system-administrator', 'users.delete');

UPDATE roles
SET
  description = 'Manages user accounts, roles and user role assignments.',
  version = version + 1,
  updated_at = unixepoch()
WHERE id = 'system-administrator';

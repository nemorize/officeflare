-- Email changes require an explicit grant; existing custom roles do not gain it.
INSERT INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'users.email.update');

UPDATE roles
SET
  version = version + 1,
  updated_at = unixepoch()
WHERE id = 'system-administrator';

-- Personal contacts roles are editable. Existing role assignments stay unchanged.
WITH
  definitions(id, key, label, description, is_default) AS (
    VALUES
      (
        'system-contacts-user',
        'contacts-user',
        'Contacts user',
        'Manage your personal address book, folders and custom fields.',
        1
      ),
      (
        'system-contacts-reader',
        'contacts-reader',
        'Contacts read-only user',
        'Read and search your personal address book.',
        0
      )
  )
INSERT INTO roles (id, key, label, description, is_default)
SELECT
  id,
  CASE
    WHEN EXISTS (SELECT 1 FROM roles WHERE roles.key = definitions.key) THEN
      'officeflare-' || definitions.key || '-' || lower(hex(randomblob(4)))
    ELSE definitions.key
  END,
  label,
  description,
  is_default
FROM definitions;

WITH
  capabilities(key) AS (
    VALUES
      ('contacts.access'),
      ('contacts.entries.create'),
      ('contacts.entries.update'),
      ('contacts.entries.delete'),
      ('contacts.folders.manage'),
      ('contacts.fields.manage')
  )
INSERT INTO role_permissions (role_id, permission_key)
SELECT 'system-contacts-user', key FROM capabilities
UNION ALL
SELECT 'system-administrator', key FROM capabilities;
INSERT INTO role_permissions (role_id, permission_key)
VALUES ('system-contacts-reader', 'contacts.access');

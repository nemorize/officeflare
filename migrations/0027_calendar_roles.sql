-- Optional, editable Calendar roles for existing and new installations.
-- Existing assignments and new-user defaults remain unchanged.
WITH
  definitions(id, key, label, description) AS (
    VALUES
      (
        'system-calendar-user',
        'calendar-user',
        'Calendar user',
        'Create calendars and events, invite attendees and share accessible calendars subject to workspace policies.'
      ),
      (
        'system-calendar-reader',
        'calendar-reader',
        'Calendar read-only user',
        'View owned and explicitly shared calendars without creating, changing or sharing events.'
      ),
      (
        'system-calendar-manager',
        'calendar-manager',
        'Calendar manager',
        'Manage workspace Calendar sharing policies and invitation sender settings. Does not grant access to personal calendars.'
      )
  )
INSERT INTO roles (id, key, label, description)
SELECT
  definitions.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM roles WHERE roles.key = definitions.key) THEN
      'officeflare-' || definitions.key || '-' || lower(hex(randomblob(4)))
    ELSE definitions.key
  END,
  label,
  description
FROM definitions;

WITH
  capabilities(key) AS (
    VALUES
      ('calendar.access'),
      ('calendar.calendars.create'),
      ('calendar.events.create'),
      ('calendar.events.update'),
      ('calendar.events.delete'),
      ('calendar.sharing.internal'),
      ('calendar.sharing.external'),
      ('calendar.events.invite'),
      ('calendar.groups.manage')
  )
INSERT INTO role_permissions (role_id, permission_key)
SELECT 'system-calendar-user', key FROM capabilities;
INSERT INTO role_permissions (role_id, permission_key)
VALUES
  ('system-calendar-reader', 'calendar.access'),
  ('system-calendar-manager', 'console.access'),
  ('system-calendar-manager', 'admin.calendar.settings.read'),
  ('system-calendar-manager', 'admin.calendar.settings.manage');

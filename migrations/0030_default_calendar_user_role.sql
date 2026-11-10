-- Select Calendar user alongside Mail user when creating new accounts.
UPDATE roles
SET
  is_default = 1,
  version = version + 1,
  updated_at = unixepoch()
WHERE id = 'system-calendar-user' AND is_default = 0;

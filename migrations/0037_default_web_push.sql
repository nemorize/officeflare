-- Seed the policy before the first administrator is created. Existing
-- installations and explicit administrator choices retain their current value.
UPDATE push_settings
SET web_push_enabled = 1
WHERE
  id = 1
  AND version = 1
  AND updated_by IS NULL
  AND NOT EXISTS (SELECT 1 FROM installation_state)
  AND NOT EXISTS (SELECT 1 FROM users);

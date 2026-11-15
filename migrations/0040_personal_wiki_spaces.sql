-- Preserve existing personal spaces and provision one for every remaining account.
INSERT INTO wiki_spaces (id, name, kind, owner_user_id)
SELECT lower(hex(randomblob(16))), 'Personal space', 'personal', u.id
FROM users u
WHERE u.deleted_at IS NULL
ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING;

UPDATE wiki_spaces
SET
  archived_at = NULL,
  version = version + 1
WHERE
  kind = 'personal'
  AND archived_at IS NOT NULL
  AND owner_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL);

CREATE TRIGGER wiki_personal_space_created
AFTER INSERT ON users
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO wiki_spaces (id, name, kind, owner_user_id)
  VALUES (lower(hex(randomblob(16))), 'Personal space', 'personal', NEW.id)
  ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING;
END;

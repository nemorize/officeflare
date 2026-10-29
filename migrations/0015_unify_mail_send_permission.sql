-- Preserve either historical sending grant as one From-address send permission.
ALTER TABLE mail_mailbox_members RENAME COLUMN can_send_as TO can_send;
UPDATE mail_mailbox_members SET can_send = max(can_send, can_send_on_behalf);
ALTER TABLE mail_mailbox_members DROP COLUMN can_send_on_behalf;

CREATE TABLE mail_api_key_scopes_unified (
  key_id TEXT NOT NULL REFERENCES mail_api_keys (id)
    ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes (id)
    ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('read', 'write', 'send')),
  PRIMARY KEY (key_id, mailbox_id, action)
)
STRICT;
INSERT OR IGNORE INTO mail_api_key_scopes_unified (key_id, mailbox_id, action)
SELECT
  key_id,
  mailbox_id,
  CASE
    WHEN action IN ('send_as', 'send_on_behalf') THEN 'send'
    ELSE action
  END
FROM mail_api_key_scopes;
DROP TABLE mail_api_key_scopes;
ALTER TABLE mail_api_key_scopes_unified RENAME TO mail_api_key_scopes;

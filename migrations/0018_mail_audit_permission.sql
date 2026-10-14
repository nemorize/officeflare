-- Audit history requires an explicit role grant in addition to mailbox management.
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
VALUES('system-administrator','admin.mail.audit.read');
UPDATE roles SET version=version+1,updated_at=unixepoch()
WHERE id='system-administrator';

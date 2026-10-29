ALTER TABLE mail_domains
ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
CREATE UNIQUE INDEX mail_domains_default_unique ON mail_domains (is_default) WHERE is_default = 1;
UPDATE mail_domains
SET is_default = 1
WHERE id = (SELECT id FROM mail_domains ORDER BY created_at, name, id LIMIT 1);

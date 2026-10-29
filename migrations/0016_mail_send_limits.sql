ALTER TABLE mail_domains
ADD COLUMN max_send_bytes INTEGER CHECK (max_send_bytes IS NULL OR max_send_bytes > 0);

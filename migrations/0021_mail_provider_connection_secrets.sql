ALTER TABLE mail_provider_connections
ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json));
ALTER TABLE mail_provider_connections ADD COLUMN secret_ciphertext TEXT;
ALTER TABLE mail_provider_connections ADD COLUMN secret_nonce TEXT;

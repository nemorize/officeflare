ALTER TABLE mail_domains
ADD COLUMN provider_settings_json TEXT NOT NULL DEFAULT '{"inbound":null,"outbound":null}' CHECK (
  json_valid(provider_settings_json)
);
ALTER TABLE mail_domains ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Copy configuration and encrypted credentials into each domain before removing references.
-- Keep transport IDs so queued submissions and provider delivery receipts remain valid.
UPDATE mail_domains
SET
  provider_settings_json = json_object(
    'inbound',
    json(
      (
        SELECT json_object(
          'id',
          p.id,
          'provider',
          p.provider,
          'config',
          json(p.config_json),
          'secret_ciphertext',
          p.secret_ciphertext,
          'secret_nonce',
          p.secret_nonce
        )
        FROM mail_provider_connections p
        WHERE p.id = inbound_connection_id
      )
    ),
    'outbound',
    json(
      (
        SELECT json_object(
          'id',
          p.id,
          'provider',
          p.provider,
          'config',
          json(p.config_json),
          'secret_ciphertext',
          p.secret_ciphertext,
          'secret_nonce',
          p.secret_nonce
        )
        FROM mail_provider_connections p
        WHERE p.id = outbound_connection_id
      )
    )
  ),
  inbound_enabled = inbound_enabled
  AND coalesce((SELECT enabled FROM mail_provider_connections WHERE id = inbound_connection_id), 0),
  version = coalesce(
    (SELECT version FROM mail_provider_connections WHERE id = outbound_connection_id),
    1
  ),
  outbound_enabled = outbound_enabled
  AND coalesce(
    (SELECT enabled FROM mail_provider_connections WHERE id = outbound_connection_id),
    0
  );

ALTER TABLE mail_domains DROP COLUMN inbound_connection_id;
ALTER TABLE mail_domains DROP COLUMN outbound_connection_id;
DROP TABLE mail_provider_connections;

-- Provider names deliberately remain extensible; supported adapters are validated by the application.
CREATE TABLE mail_provider_connections (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
INSERT INTO mail_provider_connections (id, provider, name) VALUES ('cloudflare-bindings', 'cloudflare', 'Cloudflare bindings');
CREATE TABLE mail_domains (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  inbound_connection_id TEXT REFERENCES mail_provider_connections(id),
  outbound_connection_id TEXT REFERENCES mail_provider_connections(id),
  inbound_enabled INTEGER NOT NULL DEFAULT 0 CHECK (inbound_enabled IN (0, 1)),
  outbound_enabled INTEGER NOT NULL DEFAULT 0 CHECK (outbound_enabled IN (0, 1)),
  plus_addressing INTEGER NOT NULL DEFAULT 1 CHECK (plus_addressing IN (0, 1)),
  catch_all_mailbox_id TEXT REFERENCES mail_mailboxes(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE mail_routing_rules (
  id TEXT PRIMARY KEY NOT NULL, domain_id TEXT NOT NULL REFERENCES mail_domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  action TEXT NOT NULL CHECK (action IN ('store','forward','reject')), forward_to TEXT, reject_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (action <> 'forward' OR forward_to IS NOT NULL)
) STRICT;
CREATE INDEX mail_routing_rules_domain_index ON mail_routing_rules(domain_id,enabled,priority);
CREATE TABLE mail_mailboxes (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'shared')),
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'active', 'disabled', 'deleted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX mail_mailboxes_owner_index ON mail_mailboxes(owner_user_id, status);
CREATE TABLE mail_mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_read INTEGER NOT NULL DEFAULT 0 CHECK (can_read IN (0, 1)),
  can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1)),
  can_send_as INTEGER NOT NULL DEFAULT 0 CHECK (can_send_as IN (0, 1)),
  can_send_on_behalf INTEGER NOT NULL DEFAULT 0 CHECK (can_send_on_behalf IN (0, 1)),
  can_manage INTEGER NOT NULL DEFAULT 0 CHECK (can_manage IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (mailbox_id, user_id)
) STRICT;
CREATE INDEX mail_members_user_index ON mail_mailbox_members(user_id, mailbox_id);
CREATE TABLE mail_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL REFERENCES mail_domains(id),
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id),
  local_part TEXT NOT NULL COLLATE NOCASE CHECK (length(local_part) BETWEEN 1 AND 64),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  receive_enabled INTEGER NOT NULL DEFAULT 1 CHECK (receive_enabled IN (0, 1)),
  send_enabled INTEGER NOT NULL DEFAULT 1 CHECK (send_enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (domain_id, local_part)
) STRICT;
CREATE INDEX mail_addresses_mailbox_index ON mail_addresses(mailbox_id);
CREATE UNIQUE INDEX mail_addresses_primary_unique ON mail_addresses(mailbox_id) WHERE is_primary = 1;
CREATE TABLE mail_api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE mail_api_key_scopes (
  key_id TEXT NOT NULL REFERENCES mail_api_keys(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('read', 'write', 'send_as', 'send_on_behalf')),
  PRIMARY KEY (key_id, mailbox_id, action)
) STRICT;
CREATE TABLE mail_webhooks (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_nonce TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX mail_webhooks_mailbox_index ON mail_webhooks(mailbox_id);
CREATE TABLE mail_control_operations (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (actor_id, operation, id)
) STRICT;
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('system-administrator', 'mail.providers.manage'),
  ('system-administrator', 'mail.domains.manage'),
  ('system-administrator', 'mail.mailboxes.manage');

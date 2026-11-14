-- External MCP clients use their own resource-bound tokens, never Officeflare login tokens.
CREATE TABLE mcp_oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE TABLE mcp_oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients (id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  used_by TEXT,
  user_id TEXT REFERENCES users (id),
  session_id TEXT,
  grant_id TEXT REFERENCES mcp_oauth_grants (id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied', 'consumed')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX mcp_oauth_requests_expiry ON mcp_oauth_requests (expires_at);
CREATE TABLE mcp_oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
)
STRICT;
CREATE INDEX mcp_oauth_grants_user ON mcp_oauth_grants (user_id, revoked_at);
CREATE TABLE mcp_oauth_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants (id),
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  parent_id TEXT REFERENCES mcp_oauth_tokens (id),
  used_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
)
STRICT;
CREATE INDEX mcp_oauth_tokens_grant ON mcp_oauth_tokens (grant_id, kind);
CREATE TABLE mcp_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
)
STRICT;
CREATE INDEX mcp_api_keys_user ON mcp_api_keys (user_id, revoked_at);
CREATE TABLE mcp_tool_operations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
  reservation_id TEXT REFERENCES ai_quota_reservations (id),
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL CHECK (json_valid(args_json)),
  intent_hash TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN
      ('pending', 'approved', 'executing', 'succeeded', 'failed', 'denied', 'unknown', 'expired')
  ),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  decision_session_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (credential_id, operation_key)
)
STRICT;
CREATE INDEX mcp_tool_operations_owner ON mcp_tool_operations (owner_user_id, status, created_at);
CREATE TRIGGER mcp_grant_revoke_session
AFTER UPDATE OF revoked_at ON mcp_oauth_grants
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE user_sessions
  SET revoked_at = NEW.revoked_at
  WHERE id = NEW.session_id AND revoked_at IS NULL;
END;
CREATE TRIGGER mcp_key_revoke_session
AFTER UPDATE OF revoked_at ON mcp_api_keys
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE user_sessions
  SET revoked_at = NEW.revoked_at
  WHERE id = NEW.session_id AND revoked_at IS NULL;
END;
CREATE TRIGGER mcp_client_disable
AFTER UPDATE OF status ON mcp_oauth_clients
WHEN NEW.status = 'disabled'
BEGIN
  UPDATE mcp_oauth_grants
  SET revoked_at = unixepoch()
  WHERE client_id = NEW.id AND revoked_at IS NULL;
END;

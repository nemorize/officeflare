-- Shared AI platform, metering, agent runs and MCP connections.
-- Existing prerequisite: users(id). Session IDs are historical locators; session GC remains independent.
-- Runtime authorization, policy resolution and atomic quota accounting are
-- enforced by the service layer. CHECK constraints do not replace them.

CREATE TABLE ai_quota_plans (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;

CREATE TABLE ai_subjects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('workspace', 'user', 'service')),
  user_id TEXT UNIQUE REFERENCES users (id),
  service_key TEXT UNIQUE,
  plan_id TEXT REFERENCES ai_quota_plans (id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (kind = 'user' AND user_id IS NOT NULL AND service_key IS NULL)
    OR (kind = 'service' AND user_id IS NULL AND service_key IS NOT NULL)
    OR (kind = 'workspace' AND user_id IS NULL AND service_key IS NULL)
  )
)
STRICT;
CREATE UNIQUE INDEX ai_subjects_one_workspace ON ai_subjects (kind) WHERE kind = 'workspace';

CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  workspace_subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  default_user_plan_id TEXT NOT NULL REFERENCES ai_quota_plans (id),
  quota_time_zone TEXT NOT NULL DEFAULT 'UTC',
  payload_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (
    payload_retention_days BETWEEN 1 AND 3650
  ),
  policy_epoch INTEGER NOT NULL DEFAULT 1 CHECK (policy_epoch > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT REFERENCES users (id)
)
STRICT;

CREATE TABLE ai_quota_rules (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES ai_quota_plans (id),
  metric TEXT NOT NULL CHECK (
    metric IN
      (
        'chat_runs',
        'invocations',
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'cost_micro_usd',
        'tool_calls',
        'concurrent_invocations',
        'concurrent_runs'
      )
  ),
  window_kind TEXT NOT NULL CHECK (
    window_kind IN ('minute', 'day', 'month', 'lifetime', 'concurrent')
  ),
  scope_key TEXT NOT NULL DEFAULT '*' CHECK (
    scope_key = '*'
    OR scope_key GLOB 'consumer:?*'
    OR scope_key GLOB 'profile:?*'
  ),
  limit_value INTEGER CHECK (limit_value BETWEEN 0 AND 9007199254740991),
  UNIQUE (plan_id, metric, window_kind, scope_key),
  CHECK (
    (metric IN ('concurrent_invocations', 'concurrent_runs') AND window_kind = 'concurrent')
    OR (metric NOT IN ('concurrent_invocations', 'concurrent_runs') AND window_kind <> 'concurrent')
  )
)
STRICT;

CREATE TABLE ai_quota_overrides (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  metric TEXT NOT NULL CHECK (
    metric IN
      (
        'chat_runs',
        'invocations',
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'cost_micro_usd',
        'tool_calls',
        'concurrent_invocations',
        'concurrent_runs'
      )
  ),
  window_kind TEXT NOT NULL CHECK (
    window_kind IN ('minute', 'day', 'month', 'lifetime', 'concurrent')
  ),
  scope_key TEXT NOT NULL DEFAULT '*' CHECK (
    scope_key = '*'
    OR scope_key GLOB 'consumer:?*'
    OR scope_key GLOB 'profile:?*'
  ),
  limit_value INTEGER CHECK (limit_value BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT REFERENCES users (id),
  UNIQUE (subject_id, metric, window_kind, scope_key),
  CHECK (
    (metric IN ('concurrent_invocations', 'concurrent_runs') AND window_kind = 'concurrent')
    OR (metric NOT IN ('concurrent_invocations', 'concurrent_runs') AND window_kind <> 'concurrent')
  )
)
STRICT;

CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
)
STRICT;

CREATE TABLE ai_gateways (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  secret_envelope_json TEXT CHECK (
    secret_envelope_json IS NULL
    OR (json_valid(secret_envelope_json) AND json_type(secret_envelope_json) = 'object')
  ),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
)
STRICT;

CREATE TABLE ai_provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  name TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('api_key', 'oauth', 'binding', 'gateway_managed')),
  owner_user_id TEXT REFERENCES users (id),
  share_scope TEXT NOT NULL DEFAULT 'owner' CHECK (share_scope IN ('owner', 'workspace')),
  sharing_authorization TEXT NOT NULL DEFAULT 'owner_only' CHECK (
    sharing_authorization IN ('owner_only', 'pending_verification', 'provider_permitted')
  ),
  authorization_ref TEXT,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (
    status IN ('active', 'disabled', 'reauth_required', 'revoked')
  ),
  secret_envelope_json TEXT CHECK (
    secret_envelope_json IS NULL
    OR (json_valid(secret_envelope_json) AND json_type(secret_envelope_json) = 'object')
  ),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  credential_expires_at INTEGER,
  oauth_issuer TEXT,
  oauth_subject TEXT,
  oauth_workspace_id TEXT,
  oauth_client_id TEXT,
  oauth_host_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json)
    AND json_type(metadata_json) = 'object'
  ),
  quota_group_key TEXT,
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit BETWEEN 1 AND 10000),
  cooldown_until INTEGER,
  last_selected_at INTEGER,
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (provider_id, id),
  CHECK (share_scope <> 'owner' OR owner_user_id IS NOT NULL),
  CHECK (
    share_scope <> 'workspace'
    OR (sharing_authorization = 'provider_permitted' AND authorization_ref IS NOT NULL)
  ),
  CHECK (
    auth_kind <> 'oauth'
    OR status <> 'active'
    OR (oauth_issuer IS NOT NULL AND oauth_subject IS NOT NULL AND oauth_client_id IS NOT NULL)
  ),
  CHECK (
    status <> 'active'
    OR auth_kind IN ('binding', 'gateway_managed')
    OR secret_envelope_json IS NOT NULL
  )
)
STRICT;
CREATE INDEX ai_provider_accounts_select
ON ai_provider_accounts (provider_id, status, cooldown_until);
CREATE INDEX ai_provider_accounts_owner ON ai_provider_accounts (owner_user_id, status);
CREATE INDEX ai_provider_accounts_quota_group
ON ai_provider_accounts (provider_id, quota_group_key, status);

CREATE TABLE ai_oauth_flows (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('provider_account', 'mcp_connection')),
  provider_id TEXT REFERENCES ai_providers (id),
  account_id TEXT,
  mcp_server_id TEXT REFERENCES ai_mcp_servers (id),
  mcp_connection_id TEXT,
  user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  secret_envelope_json TEXT NOT NULL CHECK (
    json_valid(secret_envelope_json)
    AND json_type(secret_envelope_json) = 'object'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'exchanging', 'completed', 'failed', 'expired', 'unknown')
  ),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (provider_id, account_id) REFERENCES ai_provider_accounts (provider_id, id),
  FOREIGN KEY (mcp_server_id, mcp_connection_id) REFERENCES ai_mcp_connections (server_id, id),
  FOREIGN KEY (mcp_connection_id, user_id) REFERENCES ai_mcp_connections (id, owner_user_id),
  CHECK (
    (
      target_kind = 'provider_account'
      AND provider_id IS NOT NULL
      AND mcp_server_id IS NULL
      AND mcp_connection_id IS NULL
    )
    OR (
      target_kind = 'mcp_connection'
      AND mcp_server_id IS NOT NULL
      AND provider_id IS NULL
      AND account_id IS NULL
    )
  )
)
STRICT;
CREATE INDEX ai_oauth_flows_expiry ON ai_oauth_flows (status, expires_at);

CREATE TABLE ai_account_pools (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  name TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'priority' CHECK (
    strategy IN ('priority', 'weighted', 'least_recently_used')
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  UNIQUE (provider_id, id)
)
STRICT;

CREATE TABLE ai_pool_members (
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (pool_id, account_id),
  FOREIGN KEY (provider_id, pool_id) REFERENCES ai_account_pools (provider_id, id),
  FOREIGN KEY (provider_id, account_id) REFERENCES ai_provider_accounts (provider_id, id)
)
STRICT;
CREATE INDEX ai_pool_members_account ON ai_pool_members (account_id, pool_id);

CREATE TABLE ai_models (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(capabilities_json)
    AND json_type(capabilities_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
)
STRICT;

CREATE TABLE ai_model_deployments (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES ai_models (id),
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  provider_model_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (
    protocol IN
      (
        'openai_responses',
        'openai_chat',
        'anthropic_messages',
        'google_generate_content',
        'cloudflare_run'
      )
  ),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api', 'chatgpt_plan', 'platform')),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(capabilities_json)
    AND json_type(capabilities_json) = 'object'
  ),
  pricing_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(pricing_json)
    AND json_type(pricing_json) = 'object'
  ),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  verified_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  UNIQUE (provider_id, id),
  UNIQUE (provider_id, provider_model_id, protocol, auth_mode)
)
STRICT;
CREATE INDEX ai_model_deployments_model ON ai_model_deployments (model_id, enabled);

CREATE TABLE ai_profiles (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(required_capabilities_json)
    AND json_type(required_capabilities_json) = 'object'
  ),
  generation_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(generation_json)
    AND json_type(generation_json) = 'object'
  ),
  data_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(data_policy_json)
    AND json_type(data_policy_json) = 'object'
  ),
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(limits_json)
    AND json_type(limits_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
)
STRICT;

CREATE TABLE ai_consumers (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'service', 'both')),
  billing_policy TEXT NOT NULL CHECK (billing_policy IN ('actor', 'resource_owner', 'service')),
  budget_subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  tools_allowed INTEGER NOT NULL DEFAULT 0 CHECK (tools_allowed IN (0, 1)),
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(limits_json)
    AND json_type(limits_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;

CREATE TABLE ai_consumer_profiles (
  consumer_key TEXT NOT NULL REFERENCES ai_consumers (key),
  profile_id TEXT NOT NULL REFERENCES ai_profiles (id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  PRIMARY KEY (consumer_key, profile_id),
  CHECK (is_default = 0 OR enabled = 1)
)
STRICT;
CREATE UNIQUE INDEX ai_consumer_profiles_default ON ai_consumer_profiles (consumer_key)
WHERE is_default = 1;

CREATE TABLE ai_profile_routes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES ai_profiles (id),
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  deployment_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  gateway_id TEXT REFERENCES ai_gateways (id),
  priority INTEGER NOT NULL CHECK (priority >= 0),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (profile_id, priority),
  FOREIGN KEY (provider_id, deployment_id) REFERENCES ai_model_deployments (provider_id, id),
  FOREIGN KEY (provider_id, pool_id) REFERENCES ai_account_pools (provider_id, id)
)
STRICT;

CREATE TABLE ai_payloads (
  id TEXT PRIMARY KEY,
  owner_subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  owner_user_id TEXT REFERENCES users (id),
  purpose TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('inline', 'r2', 'deleted')),
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  r2_key TEXT UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  deleted_at INTEGER,
  CHECK (
    (storage_kind = 'inline' AND content_json IS NOT NULL AND r2_key IS NULL AND deleted_at IS NULL)
    OR (storage_kind = 'r2' AND content_json IS NULL AND r2_key IS NOT NULL AND deleted_at IS NULL)
    OR (
      storage_kind = 'deleted'
      AND content_json IS NULL
      AND r2_key IS NULL
      AND deleted_at IS NOT NULL
    )
  ),
  CHECK (storage_kind <> 'inline' OR length(CAST(content_json AS BLOB)) <= 65536)
)
STRICT;
CREATE INDEX ai_payloads_expiry ON ai_payloads (expires_at, id) WHERE deleted_at IS NULL;
CREATE INDEX ai_payloads_owner ON ai_payloads (owner_user_id, created_at, id);

CREATE TABLE ai_invocations (
  id TEXT PRIMARY KEY,
  consumer_key TEXT NOT NULL REFERENCES ai_consumers (key),
  initiator_key TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id),
  session_id TEXT,
  actor_auth_version INTEGER,
  billing_subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  profile_id TEXT NOT NULL REFERENCES ai_profiles (id),
  source_ref_json TEXT NOT NULL CHECK (
    json_valid(source_ref_json)
    AND json_type(source_ref_json) = 'object'
  ),
  trace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  input_payload_id TEXT REFERENCES ai_payloads (id),
  output_payload_id TEXT REFERENCES ai_payloads (id),
  policy_snapshot_json TEXT NOT NULL CHECK (
    json_valid(policy_snapshot_json)
    AND json_type(policy_snapshot_json) = 'object'
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN
      ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown')
  ),
  execution_token TEXT,
  deadline_at INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (consumer_key, initiator_key, idempotency_key),
  FOREIGN KEY (consumer_key, profile_id) REFERENCES ai_consumer_profiles (consumer_key, profile_id)
)
STRICT;
CREATE INDEX ai_invocations_subject_time
ON ai_invocations (billing_subject_id, created_at DESC, id);
CREATE INDEX ai_invocations_consumer_time ON ai_invocations (consumer_key, created_at DESC, id);
CREATE INDEX ai_invocations_recovery ON ai_invocations (status, deadline_at, id);

CREATE TABLE ai_inference_attempts (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES ai_invocations (id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  route_id TEXT NOT NULL REFERENCES ai_profile_routes (id),
  provider_id TEXT NOT NULL REFERENCES ai_providers (id),
  deployment_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  gateway_id TEXT REFERENCES ai_gateways (id),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  route_snapshot_json TEXT NOT NULL CHECK (
    json_valid(route_snapshot_json)
    AND json_type(route_snapshot_json) = 'object'
  ),
  pricing_snapshot_json TEXT NOT NULL CHECK (
    json_valid(pricing_snapshot_json)
    AND json_type(pricing_snapshot_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'in_flight', 'succeeded', 'failed', 'cancelled', 'unknown')
  ),
  execution_token TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  provider_request_id TEXT,
  resolved_provider TEXT,
  error_code TEXT,
  usage_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
    usage_state IN ('unknown', 'estimated', 'provider')
  ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER,
  finished_at INTEGER,
  UNIQUE (invocation_id, ordinal),
  UNIQUE (invocation_id, id),
  FOREIGN KEY (provider_id, deployment_id) REFERENCES ai_model_deployments (provider_id, id),
  FOREIGN KEY (provider_id, pool_id) REFERENCES ai_account_pools (provider_id, id),
  FOREIGN KEY (provider_id, account_id) REFERENCES ai_provider_accounts (provider_id, id)
)
STRICT;
CREATE INDEX ai_attempts_account_occupancy
ON ai_inference_attempts (account_id, status, lease_expires_at);
CREATE INDEX ai_attempts_unknown ON ai_inference_attempts (status, created_at, id)
WHERE status = 'unknown';

CREATE TABLE ai_usage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES ai_inference_attempts (id),
  event_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('measurement', 'adjustment')),
  usage_source TEXT NOT NULL CHECK (usage_source IN ('estimated', 'provider', 'reconciliation')),
  cost_source TEXT NOT NULL CHECK (
    cost_source IN ('unknown', 'provider', 'catalog', 'internal_rate')
  ),
  input_tokens_delta INTEGER NOT NULL DEFAULT 0,
  output_tokens_delta INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens_delta INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens_delta INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens_delta INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd_delta INTEGER,
  receipt_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(receipt_json)
    AND json_type(receipt_json) = 'object'
  ),
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    event_kind <> 'measurement'
    OR (
      input_tokens_delta >= 0
      AND output_tokens_delta >= 0
      AND cached_input_tokens_delta >= 0
      AND cache_write_tokens_delta >= 0
      AND reasoning_tokens_delta >= 0
      AND (cost_micro_usd_delta IS NULL OR cost_micro_usd_delta >= 0)
    )
  ),
  CHECK (cost_source <> 'unknown' OR cost_micro_usd_delta IS NULL),
  CHECK (event_kind <> 'adjustment' OR reason IS NOT NULL)
)
STRICT;
CREATE UNIQUE INDEX ai_usage_events_measurement ON ai_usage_events (attempt_id)
WHERE event_kind = 'measurement';
CREATE INDEX ai_usage_events_attempt ON ai_usage_events (attempt_id, seq);
CREATE INDEX ai_usage_events_time ON ai_usage_events (created_at, seq);
CREATE TRIGGER ai_usage_events_no_update
BEFORE UPDATE ON ai_usage_events
BEGIN
  SELECT RAISE(ABORT, 'AI usage events are append-only');
END;
CREATE TRIGGER ai_usage_events_no_delete
BEFORE DELETE ON ai_usage_events
BEGIN
  SELECT RAISE(ABORT, 'AI usage events are append-only');
END;

CREATE TABLE ai_quota_buckets (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES ai_subjects (id),
  metric TEXT NOT NULL CHECK (
    metric IN
      (
        'chat_runs',
        'invocations',
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'cost_micro_usd',
        'tool_calls',
        'concurrent_invocations',
        'concurrent_runs'
      )
  ),
  window_kind TEXT NOT NULL CHECK (
    window_kind IN ('minute', 'day', 'month', 'lifetime', 'concurrent')
  ),
  scope_key TEXT NOT NULL CHECK (
    scope_key = '*'
    OR scope_key GLOB 'consumer:?*'
    OR scope_key GLOB 'profile:?*'
  ),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  used_amount INTEGER NOT NULL DEFAULT 0 CHECK (used_amount BETWEEN 0 AND 9007199254740991),
  reserved_amount INTEGER NOT NULL DEFAULT 0 CHECK (reserved_amount BETWEEN 0 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (subject_id, metric, window_kind, scope_key, window_start),
  CHECK (window_end > window_start),
  CHECK (used_amount <= 9007199254740991 - reserved_amount),
  CHECK (
    (
      metric IN ('concurrent_invocations', 'concurrent_runs')
      AND window_kind = 'concurrent'
      AND used_amount = 0
    )
    OR (metric NOT IN ('concurrent_invocations', 'concurrent_runs') AND window_kind <> 'concurrent')
  )
)
STRICT;

CREATE TABLE ai_quota_reservations (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('run', 'invocation', 'attempt', 'tool')),
  operation_id TEXT NOT NULL,
  invocation_id TEXT REFERENCES ai_invocations (id),
  attempt_id TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'held', 'settled', 'released', 'uncertain')),
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  mutation_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (invocation_id, attempt_id) REFERENCES ai_inference_attempts (invocation_id, id),
  CHECK (attempt_id IS NULL OR invocation_id IS NOT NULL)
)
STRICT;
CREATE INDEX ai_quota_reservations_recovery ON ai_quota_reservations (status, expires_at, id);
CREATE INDEX ai_quota_reservations_invocation ON ai_quota_reservations (invocation_id, status);
CREATE INDEX ai_quota_reservations_operation
ON ai_quota_reservations (operation_kind, operation_id);

CREATE TABLE ai_quota_reservation_items (
  reservation_id TEXT NOT NULL REFERENCES ai_quota_reservations (id),
  bucket_id TEXT NOT NULL REFERENCES ai_quota_buckets (id),
  reserved_amount INTEGER NOT NULL CHECK (reserved_amount BETWEEN 0 AND 9007199254740991),
  settled_amount INTEGER CHECK (settled_amount BETWEEN 0 AND 9007199254740991),
  limit_snapshot INTEGER CHECK (limit_snapshot BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (reservation_id, bucket_id)
)
STRICT;
CREATE INDEX ai_quota_reservation_items_bucket
ON ai_quota_reservation_items (bucket_id, reservation_id);

CREATE TABLE ai_quota_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  bucket_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('reserve', 'settle', 'release', 'adjust')),
  used_delta INTEGER NOT NULL,
  reserved_delta INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (reservation_id, bucket_id, event_key),
  FOREIGN KEY (reservation_id, bucket_id) REFERENCES ai_quota_reservation_items (
    reservation_id,
    bucket_id
  )
)
STRICT;
CREATE INDEX ai_quota_ledger_bucket ON ai_quota_ledger (bucket_id, seq);
CREATE TRIGGER ai_quota_ledger_no_update
BEFORE UPDATE ON ai_quota_ledger
BEGIN
  SELECT RAISE(ABORT, 'AI quota ledger is append-only');
END;
CREATE TRIGGER ai_quota_ledger_no_delete
BEFORE DELETE ON ai_quota_ledger
BEGIN
  SELECT RAISE(ABORT, 'AI quota ledger is append-only');
END;

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'completed', 'dead')
  ),
  available_at INTEGER NOT NULL,
  publish_after INTEGER NOT NULL,
  lease_token TEXT,
  fencing_version INTEGER NOT NULL DEFAULT 0 CHECK (fencing_version >= 0),
  lease_expires_at INTEGER,
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (status <> 'leased' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
)
STRICT;
CREATE INDEX ai_jobs_dispatch ON ai_jobs (status, publish_after, available_at, id);
CREATE INDEX ai_jobs_leases ON ai_jobs (status, lease_expires_at, id);

CREATE TABLE ai_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  actor_key TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  trace_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(details_json)
    AND json_type(details_json) = 'object'
  ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
STRICT;
CREATE INDEX ai_audit_events_time ON ai_audit_events (created_at DESC, seq DESC);
CREATE INDEX ai_audit_events_target ON ai_audit_events (target_type, target_id, seq);
CREATE TRIGGER ai_audit_events_no_update
BEFORE UPDATE ON ai_audit_events
BEGIN
  SELECT RAISE(ABORT, 'AI audit events are append-only');
END;
CREATE TRIGGER ai_audit_events_no_delete
BEFORE DELETE ON ai_audit_events
BEGIN
  SELECT RAISE(ABORT, 'AI audit events are append-only');
END;

CREATE TABLE ai_mcp_servers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('builtin', 'streamable_http')),
  builtin_key TEXT,
  endpoint_url TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (transport = 'builtin' AND builtin_key IS NOT NULL AND endpoint_url IS NULL)
    OR (transport = 'streamable_http' AND builtin_key IS NULL AND endpoint_url IS NOT NULL)
  )
)
STRICT;

CREATE TABLE ai_mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES ai_mcp_servers (id),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL CHECK (
    json_valid(input_schema_json)
    AND json_type(input_schema_json) = 'object'
  ),
  output_schema_json TEXT CHECK (
    output_schema_json IS NULL
    OR (json_valid(output_schema_json) AND json_type(output_schema_json) = 'object')
  ),
  schema_hash TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK (
    execution_class IN ('read', 'write', 'destructive', 'external')
  ),
  approval_policy TEXT NOT NULL DEFAULT 'always' CHECK (approval_policy IN ('none', 'always')),
  replay_policy TEXT NOT NULL CHECK (
    replay_policy IN ('read_only', 'idempotent', 'reconcile', 'never')
  ),
  limits_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(limits_json)
    AND json_type(limits_json) = 'object'
  ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (server_id, name, revision),
  UNIQUE (server_id, id)
)
STRICT;

CREATE TABLE ai_mcp_connections (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES ai_mcp_servers (id),
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json)
    AND json_type(config_json) = 'object'
  ),
  secret_envelope_json TEXT CHECK (
    secret_envelope_json IS NULL
    OR (json_valid(secret_envelope_json) AND json_type(secret_envelope_json) = 'object')
  ),
  granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(granted_scopes_json)
    AND json_type(granted_scopes_json) = 'array'
  ),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  credential_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (
    status IN ('connected', 'disabled', 'reauth_required', 'error')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (id, owner_user_id),
  UNIQUE (server_id, id)
)
STRICT;
CREATE INDEX ai_mcp_connections_owner ON ai_mcp_connections (owner_user_id, status, id);

CREATE TABLE ai_rooms (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES ai_profiles (id),
  instructions_payload_id TEXT REFERENCES ai_payloads (id),
  next_message_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_message_seq > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE (id, owner_user_id)
)
STRICT;
CREATE INDEX ai_rooms_owner ON ai_rooms (owner_user_id, updated_at DESC, id)
WHERE deleted_at IS NULL;

CREATE TABLE ai_room_mcp_bindings (
  room_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(allowed_tools_json)
    AND json_type(allowed_tools_json) = 'array'
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (room_id, connection_id),
  FOREIGN KEY (room_id, owner_user_id) REFERENCES ai_rooms (id, owner_user_id),
  FOREIGN KEY (connection_id, owner_user_id) REFERENCES ai_mcp_connections (id, owner_user_id)
)
STRICT;

-- Circular message/run references are intentional. Insert the user message
-- with run_id NULL, then create the run. Assistant messages reference that run.
CREATE TABLE ai_room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES ai_rooms (id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  author_user_id TEXT REFERENCES users (id),
  client_message_id TEXT,
  run_id TEXT,
  payload_id TEXT REFERENCES ai_payloads (id),
  status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (room_id, id),
  UNIQUE (room_id, seq),
  UNIQUE (room_id, author_user_id, client_message_id),
  FOREIGN KEY (room_id, author_user_id) REFERENCES ai_rooms (id, owner_user_id),
  FOREIGN KEY (room_id, run_id) REFERENCES ai_runs (room_id, id),
  CHECK (role <> 'user' OR (author_user_id IS NOT NULL AND client_message_id IS NOT NULL))
)
STRICT;

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  actor_auth_version INTEGER NOT NULL CHECK (actor_auth_version > 0),
  trigger_message_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES ai_profiles (id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN
      (
        'queued',
        'running',
        'waiting_approval',
        'reconciling',
        'cancel_requested',
        'succeeded',
        'failed',
        'cancelled'
      )
  ),
  config_snapshot_json TEXT NOT NULL CHECK (
    json_valid(config_snapshot_json)
    AND json_type(config_snapshot_json) = 'object'
  ),
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(checkpoint_json)
    AND json_type(checkpoint_json) = 'object'
  ),
  execution_token TEXT,
  next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
  deadline_at INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  UNIQUE (room_id, id),
  UNIQUE (id, room_id, actor_user_id),
  UNIQUE (actor_user_id, idempotency_key),
  FOREIGN KEY (room_id, actor_user_id) REFERENCES ai_rooms (id, owner_user_id),
  FOREIGN KEY (room_id, trigger_message_id) REFERENCES ai_room_messages (room_id, id)
)
STRICT;
CREATE UNIQUE INDEX ai_runs_one_active_room ON ai_runs (room_id)
WHERE status IN ('queued', 'running', 'waiting_approval', 'reconciling', 'cancel_requested');
CREATE INDEX ai_runs_recovery ON ai_runs (status, deadline_at, id);

CREATE TABLE ai_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs (id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('inference', 'tools', 'compaction')),
  invocation_id TEXT UNIQUE REFERENCES ai_invocations (id),
  status TEXT NOT NULL CHECK (
    status IN
      ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'unknown')
  ),
  execution_token TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, id),
  CHECK (kind NOT IN ('inference', 'compaction') OR invocation_id IS NOT NULL)
)
STRICT;

CREATE TABLE ai_tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  args_payload_id TEXT NOT NULL REFERENCES ai_payloads (id),
  args_hash TEXT NOT NULL,
  intent_snapshot_json TEXT NOT NULL CHECK (
    json_valid(intent_snapshot_json)
    AND json_type(intent_snapshot_json) = 'object'
  ),
  result_payload_id TEXT REFERENCES ai_payloads (id),
  status TEXT NOT NULL CHECK (
    status IN
      (
        'planned',
        'waiting_approval',
        'approved',
        'executing',
        'succeeded',
        'failed',
        'unknown',
        'denied',
        'cancelled'
      )
  ),
  execution_token TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  UNIQUE (id, actor_user_id),
  UNIQUE (step_id, provider_call_id),
  FOREIGN KEY (run_id, step_id) REFERENCES ai_run_steps (run_id, id),
  FOREIGN KEY (run_id, room_id, actor_user_id) REFERENCES ai_runs (id, room_id, actor_user_id),
  FOREIGN KEY (room_id, connection_id) REFERENCES ai_room_mcp_bindings (room_id, connection_id),
  FOREIGN KEY (connection_id, actor_user_id) REFERENCES ai_mcp_connections (id, owner_user_id),
  FOREIGN KEY (server_id, connection_id) REFERENCES ai_mcp_connections (server_id, id),
  FOREIGN KEY (server_id, tool_id) REFERENCES ai_mcp_tools (server_id, id)
)
STRICT;
CREATE INDEX ai_tool_calls_run ON ai_tool_calls (run_id, created_at, id);
CREATE INDEX ai_tool_calls_reconcile ON ai_tool_calls (status, created_at, id)
WHERE status = 'unknown';

CREATE TABLE ai_tool_approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL UNIQUE,
  required_user_id TEXT NOT NULL REFERENCES users (id),
  intent_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied', 'expired', 'revoked')
  ),
  expires_at INTEGER NOT NULL,
  decision_user_id TEXT REFERENCES users (id),
  decision_session_id TEXT,
  decided_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (tool_call_id, required_user_id) REFERENCES ai_tool_calls (id, actor_user_id),
  CHECK (
    status NOT IN ('approved', 'denied')
    OR (decision_user_id IS NOT NULL AND decision_session_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (decision_user_id IS NULL OR decision_user_id = required_user_id),
  CHECK (consumed_at IS NULL OR status = 'approved')
)
STRICT;
CREATE INDEX ai_tool_approvals_pending ON ai_tool_approvals (required_user_id, status, expires_at);

CREATE TABLE ai_run_events (
  run_id TEXT NOT NULL REFERENCES ai_runs (id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
  ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (run_id, seq)
)
STRICT;

ALTER TABLE ai_invocations
ADD COLUMN admission_reservation_id TEXT REFERENCES ai_quota_reservations (id);
ALTER TABLE ai_invocations ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE ai_inference_attempts
ADD COLUMN reservation_id TEXT REFERENCES ai_quota_reservations (id);
ALTER TABLE ai_inference_attempts ADD COLUMN output_payload_id TEXT REFERENCES ai_payloads (id);
ALTER TABLE ai_runs ADD COLUMN admission_reservation_id TEXT REFERENCES ai_quota_reservations (id);
ALTER TABLE ai_runs ADD COLUMN slot_reservation_id TEXT REFERENCES ai_quota_reservations (id);
ALTER TABLE ai_runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE ai_tool_calls ADD COLUMN reservation_id TEXT REFERENCES ai_quota_reservations (id);
CREATE INDEX ai_invocations_lease ON ai_invocations (status, lease_expires_at);
INSERT INTO ai_quota_plans (id, key, name)
VALUES
  ('system-ai-user', 'ai-user', 'AI user'),
  ('system-ai-workspace', 'ai-workspace', 'Workspace AI budget'),
  ('system-ai-service', 'ai-service', 'AI service budget');
INSERT INTO ai_subjects (id, key, kind, plan_id)
VALUES
  ('system-ai-workspace', 'workspace', 'workspace', 'system-ai-workspace');
INSERT INTO ai_subjects (id, key, kind, service_key, plan_id)
VALUES
  ('system-ai-chat', 'service:hub.chat', 'service', 'hub.chat', 'system-ai-service');
INSERT INTO ai_subjects (id, key, kind, service_key, plan_id)
VALUES ('system-ai-mcp', 'service:mcp.tools', 'service', 'mcp.tools', 'system-ai-service');
INSERT INTO ai_consumers
  (key, name, principal_kind, billing_policy, budget_subject_id, tools_allowed, enabled)
VALUES ('mcp.tools', 'MCP tools', 'user', 'actor', 'system-ai-mcp', 1, 1);
INSERT INTO ai_settings (id, workspace_subject_id, default_user_plan_id)
VALUES
  (1, 'system-ai-workspace', 'system-ai-user');
INSERT INTO ai_quota_rules (id, plan_id, metric, window_kind, limit_value)
VALUES
  ('system-ai-user-month-cost', 'system-ai-user', 'cost_micro_usd', 'month', 10000000),
  ('system-ai-user-day-calls', 'system-ai-user', 'invocations', 'day', 100),
  ('system-ai-user-concurrent', 'system-ai-user', 'concurrent_invocations', 'concurrent', 2),
  ('system-ai-user-runs', 'system-ai-user', 'concurrent_runs', 'concurrent', 1),
  ('system-ai-workspace-month', 'system-ai-workspace', 'cost_micro_usd', 'month', 100000000),
  (
    'system-ai-workspace-concurrent',
    'system-ai-workspace',
    'concurrent_invocations',
    'concurrent',
    10
  );
INSERT INTO ai_consumers
  (
    key,
    name,
    principal_kind,
    billing_policy,
    budget_subject_id,
    tools_allowed,
    enabled,
    limits_json
  )
VALUES
  (
    'hub.chat',
    'AI hub',
    'user',
    'actor',
    'system-ai-chat',
    1,
    1,
    '{"schema_version":1,"max_input_tokens":16384,"max_output_tokens":2048,"max_attempts":3,"timeout_seconds":120,"max_steps":12,"max_tool_calls":24,"run_timeout_seconds":1800}'
  );
INSERT INTO ai_mcp_servers (id, key, name, transport, builtin_key, enabled)
VALUES
  ('system-mcp-mail', 'mail', 'Mail', 'builtin', 'mail', 1),
  ('system-mcp-contacts', 'contacts', 'Contacts', 'builtin', 'contacts', 1),
  ('system-mcp-drive', 'drive', 'Drive', 'builtin', 'drive', 1),
  ('system-mcp-calendar', 'calendar', 'Calendar', 'builtin', 'calendar', 1);
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'ai.access');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'ai.runs.create');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'ai.connections.manage');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.settings.read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.settings.manage');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.providers.read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.providers.manage');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.quotas.read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.quotas.manage');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.usage.read');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
VALUES ('system-administrator', 'admin.ai.audit.read');
INSERT INTO roles (id, key, label, description)
SELECT
  'system-ai-user',
  CASE
    WHEN EXISTS (SELECT 1 FROM roles WHERE key = 'ai-user') THEN
      'officeflare-ai-user-' || lower(hex(randomblob(4)))
    ELSE 'ai-user'
  END,
  'AI user',
  'Use the AI hub with personal tools and workspace usage limits.';
INSERT INTO role_permissions (role_id, permission_key) VALUES ('system-ai-user', 'ai.access');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('system-ai-user', 'ai.runs.create');
INSERT INTO role_permissions (role_id, permission_key)
VALUES ('system-ai-user', 'ai.connections.manage');
CREATE TRIGGER ai_quota_plans_epoch_insert
AFTER INSERT ON ai_quota_plans
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_plans_epoch_update
AFTER UPDATE OF version ON ai_quota_plans
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_plans_epoch_delete
AFTER DELETE ON ai_quota_plans
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_rules_epoch_insert
AFTER INSERT ON ai_quota_rules
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_rules_epoch_update
AFTER UPDATE ON ai_quota_rules
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_rules_epoch_delete
AFTER DELETE ON ai_quota_rules
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_overrides_epoch_insert
AFTER INSERT ON ai_quota_overrides
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_overrides_epoch_update
AFTER UPDATE ON ai_quota_overrides
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_quota_overrides_epoch_delete
AFTER DELETE ON ai_quota_overrides
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_subjects_epoch_insert
AFTER INSERT ON ai_subjects
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_subjects_epoch_update
AFTER UPDATE OF version ON ai_subjects
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_subjects_epoch_delete
AFTER DELETE ON ai_subjects
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_providers_epoch_insert
AFTER INSERT ON ai_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_providers_epoch_update
AFTER UPDATE OF version ON ai_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_providers_epoch_delete
AFTER DELETE ON ai_providers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_gateways_epoch_insert
AFTER INSERT ON ai_gateways
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_gateways_epoch_update
AFTER UPDATE OF version ON ai_gateways
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_gateways_epoch_delete
AFTER DELETE ON ai_gateways
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_provider_accounts_epoch_insert
AFTER INSERT ON ai_provider_accounts
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_provider_accounts_epoch_update
AFTER UPDATE OF version ON ai_provider_accounts
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_provider_accounts_epoch_delete
AFTER DELETE ON ai_provider_accounts
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_account_pools_epoch_insert
AFTER INSERT ON ai_account_pools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_account_pools_epoch_update
AFTER UPDATE OF version ON ai_account_pools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_account_pools_epoch_delete
AFTER DELETE ON ai_account_pools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_pool_members_epoch_insert
AFTER INSERT ON ai_pool_members
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_pool_members_epoch_update
AFTER UPDATE ON ai_pool_members
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_pool_members_epoch_delete
AFTER DELETE ON ai_pool_members
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_models_epoch_insert
AFTER INSERT ON ai_models
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_models_epoch_update
AFTER UPDATE OF version ON ai_models
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_models_epoch_delete
AFTER DELETE ON ai_models
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_model_deployments_epoch_insert
AFTER INSERT ON ai_model_deployments
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_model_deployments_epoch_update
AFTER UPDATE OF version ON ai_model_deployments
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_model_deployments_epoch_delete
AFTER DELETE ON ai_model_deployments
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profiles_epoch_insert
AFTER INSERT ON ai_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profiles_epoch_update
AFTER UPDATE OF version ON ai_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profiles_epoch_delete
AFTER DELETE ON ai_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumers_epoch_insert
AFTER INSERT ON ai_consumers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumers_epoch_update
AFTER UPDATE OF version ON ai_consumers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumers_epoch_delete
AFTER DELETE ON ai_consumers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumer_profiles_epoch_insert
AFTER INSERT ON ai_consumer_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumer_profiles_epoch_update
AFTER UPDATE ON ai_consumer_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_consumer_profiles_epoch_delete
AFTER DELETE ON ai_consumer_profiles
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profile_routes_epoch_insert
AFTER INSERT ON ai_profile_routes
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profile_routes_epoch_update
AFTER UPDATE OF version ON ai_profile_routes
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_profile_routes_epoch_delete
AFTER DELETE ON ai_profile_routes
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_servers_epoch_insert
AFTER INSERT ON ai_mcp_servers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_servers_epoch_update
AFTER UPDATE OF version ON ai_mcp_servers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_servers_epoch_delete
AFTER DELETE ON ai_mcp_servers
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_tools_epoch_insert
AFTER INSERT ON ai_mcp_tools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_tools_epoch_update
AFTER UPDATE ON ai_mcp_tools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_tools_epoch_delete
AFTER DELETE ON ai_mcp_tools
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_connections_epoch_insert
AFTER INSERT ON ai_mcp_connections
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_connections_epoch_update
AFTER UPDATE OF version ON ai_mcp_connections
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_mcp_connections_epoch_delete
AFTER DELETE ON ai_mcp_connections
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_room_mcp_bindings_epoch_insert
AFTER INSERT ON ai_room_mcp_bindings
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_room_mcp_bindings_epoch_update
AFTER UPDATE OF version ON ai_room_mcp_bindings
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;
CREATE TRIGGER ai_room_mcp_bindings_epoch_delete
AFTER DELETE ON ai_room_mcp_bindings
BEGIN
  UPDATE ai_settings SET policy_epoch = policy_epoch + 1 WHERE id = 1;
END;

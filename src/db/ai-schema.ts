import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Migrations 0038 and 0039 own STRICT, CHECK, foreign keys, indexes and triggers.
// Keep this typed query model in sync with those authoritative SQL definitions.

export const aiAccountPools = sqliteTable("ai_account_pools", {
  id: text().primaryKey().notNull(),
  provider_id: text().notNull(),
  name: text().notNull(),
  strategy: text()
    .notNull()
    .default(sql`'priority'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiAuditEvents = sqliteTable("ai_audit_events", {
  seq: integer().primaryKey(),
  event_key: text().notNull(),
  actor_key: text().notNull(),
  actor_user_id: text(),
  action: text().notNull(),
  target_type: text().notNull(),
  target_id: text(),
  trace_id: text(),
  details_json: text()
    .notNull()
    .default(sql`'{}'`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiConsumerProfiles = sqliteTable(
  "ai_consumer_profiles",
  {
    consumer_key: text().notNull(),
    profile_id: text().notNull(),
    enabled: integer()
      .notNull()
      .default(sql`1`),
    is_default: integer()
      .notNull()
      .default(sql`0`),
  },
  (table) => [primaryKey({ columns: [table.consumer_key, table.profile_id] })],
);

export const aiConsumers = sqliteTable("ai_consumers", {
  key: text().primaryKey().notNull(),
  name: text().notNull(),
  principal_kind: text().notNull(),
  billing_policy: text().notNull(),
  budget_subject_id: text().notNull(),
  tools_allowed: integer()
    .notNull()
    .default(sql`0`),
  limits_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiGateways = sqliteTable("ai_gateways", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  adapter_key: text().notNull(),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  secret_envelope_json: text(),
  credential_version: integer()
    .notNull()
    .default(sql`1`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiInferenceAttempts = sqliteTable("ai_inference_attempts", {
  id: text().primaryKey().notNull(),
  invocation_id: text().notNull(),
  ordinal: integer().notNull(),
  route_id: text().notNull(),
  provider_id: text().notNull(),
  deployment_id: text().notNull(),
  pool_id: text().notNull(),
  account_id: text().notNull(),
  gateway_id: text(),
  credential_version: integer().notNull(),
  route_snapshot_json: text().notNull(),
  pricing_snapshot_json: text().notNull(),
  status: text().notNull(),
  execution_token: text().notNull(),
  lease_expires_at: integer().notNull(),
  provider_request_id: text(),
  resolved_provider: text(),
  error_code: text(),
  usage_state: text()
    .notNull()
    .default(sql`'unknown'`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  sent_at: integer(),
  finished_at: integer(),
  reservation_id: text(),
  output_payload_id: text(),
});

export const aiInvocations = sqliteTable("ai_invocations", {
  id: text().primaryKey().notNull(),
  consumer_key: text().notNull(),
  initiator_key: text().notNull(),
  actor_user_id: text(),
  session_id: text(),
  actor_auth_version: integer(),
  billing_subject_id: text().notNull(),
  profile_id: text().notNull(),
  source_ref_json: text().notNull(),
  trace_id: text().notNull(),
  idempotency_key: text().notNull(),
  request_hash: text().notNull(),
  input_payload_id: text(),
  output_payload_id: text(),
  policy_snapshot_json: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'queued'`),
  execution_token: text(),
  deadline_at: integer().notNull(),
  error_code: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  started_at: integer(),
  finished_at: integer(),
  admission_reservation_id: text(),
  lease_expires_at: integer(),
});

export const aiJobs = sqliteTable("ai_jobs", {
  id: text().primaryKey().notNull(),
  kind: text().notNull(),
  entity_id: text().notNull(),
  generation: integer()
    .notNull()
    .default(sql`1`),
  dedupe_key: text().notNull(),
  payload_json: text()
    .notNull()
    .default(sql`'{}'`),
  status: text()
    .notNull()
    .default(sql`'pending'`),
  available_at: integer().notNull(),
  publish_after: integer().notNull(),
  lease_token: text(),
  fencing_version: integer()
    .notNull()
    .default(sql`0`),
  lease_expires_at: integer(),
  delivery_count: integer()
    .notNull()
    .default(sql`0`),
  last_error_code: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiMcpConnections = sqliteTable("ai_mcp_connections", {
  id: text().primaryKey().notNull(),
  server_id: text().notNull(),
  owner_user_id: text().notNull(),
  name: text().notNull(),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  secret_envelope_json: text(),
  granted_scopes_json: text()
    .notNull()
    .default(sql`'[]'`),
  credential_version: integer()
    .notNull()
    .default(sql`1`),
  credential_expires_at: integer(),
  status: text()
    .notNull()
    .default(sql`'disabled'`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiMcpServers = sqliteTable("ai_mcp_servers", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  transport: text().notNull(),
  builtin_key: text(),
  endpoint_url: text(),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiMcpTools = sqliteTable("ai_mcp_tools", {
  id: text().primaryKey().notNull(),
  server_id: text().notNull(),
  name: text().notNull(),
  revision: integer().notNull(),
  description: text().notNull(),
  input_schema_json: text().notNull(),
  output_schema_json: text(),
  schema_hash: text().notNull(),
  execution_class: text().notNull(),
  approval_policy: text()
    .notNull()
    .default(sql`'always'`),
  replay_policy: text().notNull(),
  limits_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiModelDeployments = sqliteTable("ai_model_deployments", {
  id: text().primaryKey().notNull(),
  model_id: text().notNull(),
  provider_id: text().notNull(),
  provider_model_id: text().notNull(),
  protocol: text().notNull(),
  auth_mode: text().notNull(),
  capabilities_json: text()
    .notNull()
    .default(sql`'{}'`),
  pricing_json: text()
    .notNull()
    .default(sql`'{}'`),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  verified_at: integer(),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiModels = sqliteTable("ai_models", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  vendor: text().notNull(),
  capabilities_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiOauthFlows = sqliteTable("ai_oauth_flows", {
  id: text().primaryKey().notNull(),
  target_kind: text().notNull(),
  provider_id: text(),
  account_id: text(),
  mcp_server_id: text(),
  mcp_connection_id: text(),
  user_id: text().notNull(),
  session_id: text().notNull(),
  state_hash: text().notNull(),
  issuer: text().notNull(),
  redirect_uri: text().notNull(),
  secret_envelope_json: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'pending'`),
  expires_at: integer().notNull(),
  consumed_at: integer(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiPayloads = sqliteTable("ai_payloads", {
  id: text().primaryKey().notNull(),
  owner_subject_id: text().notNull(),
  owner_user_id: text(),
  purpose: text().notNull(),
  storage_kind: text().notNull(),
  content_json: text(),
  r2_key: text(),
  content_type: text().notNull(),
  size_bytes: integer().notNull(),
  sha256: text().notNull(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  expires_at: integer(),
  deleted_at: integer(),
});

export const aiPoolMembers = sqliteTable(
  "ai_pool_members",
  {
    pool_id: text().notNull(),
    account_id: text().notNull(),
    provider_id: text().notNull(),
    priority: integer()
      .notNull()
      .default(sql`0`),
    weight: integer()
      .notNull()
      .default(sql`1`),
    enabled: integer()
      .notNull()
      .default(sql`1`),
  },
  (table) => [primaryKey({ columns: [table.pool_id, table.account_id] })],
);

export const aiProfileRoutes = sqliteTable("ai_profile_routes", {
  id: text().primaryKey().notNull(),
  profile_id: text().notNull(),
  provider_id: text().notNull(),
  deployment_id: text().notNull(),
  pool_id: text().notNull(),
  gateway_id: text(),
  priority: integer().notNull(),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
});

export const aiProfiles = sqliteTable("ai_profiles", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  required_capabilities_json: text()
    .notNull()
    .default(sql`'{}'`),
  generation_json: text()
    .notNull()
    .default(sql`'{}'`),
  data_policy_json: text()
    .notNull()
    .default(sql`'{}'`),
  limits_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiProviderAccounts = sqliteTable("ai_provider_accounts", {
  id: text().primaryKey().notNull(),
  provider_id: text().notNull(),
  name: text().notNull(),
  auth_kind: text().notNull(),
  owner_user_id: text(),
  share_scope: text()
    .notNull()
    .default(sql`'owner'`),
  sharing_authorization: text()
    .notNull()
    .default(sql`'owner_only'`),
  authorization_ref: text(),
  status: text()
    .notNull()
    .default(sql`'disabled'`),
  secret_envelope_json: text(),
  credential_version: integer()
    .notNull()
    .default(sql`1`),
  credential_expires_at: integer(),
  oauth_issuer: text(),
  oauth_subject: text(),
  oauth_workspace_id: text(),
  oauth_client_id: text(),
  oauth_host_id: text(),
  metadata_json: text()
    .notNull()
    .default(sql`'{}'`),
  quota_group_key: text(),
  concurrency_limit: integer()
    .notNull()
    .default(sql`1`),
  cooldown_until: integer(),
  last_selected_at: integer(),
  last_error_code: text(),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiProviders = sqliteTable("ai_providers", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  adapter_key: text().notNull(),
  base_url: text().notNull(),
  config_json: text()
    .notNull()
    .default(sql`'{}'`),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  archived_at: integer(),
});

export const aiQuotaBuckets = sqliteTable("ai_quota_buckets", {
  id: text().primaryKey().notNull(),
  subject_id: text().notNull(),
  metric: text().notNull(),
  window_kind: text().notNull(),
  scope_key: text().notNull(),
  window_start: integer().notNull(),
  window_end: integer().notNull(),
  used_amount: integer()
    .notNull()
    .default(sql`0`),
  reserved_amount: integer()
    .notNull()
    .default(sql`0`),
  version: integer()
    .notNull()
    .default(sql`1`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiQuotaLedger = sqliteTable("ai_quota_ledger", {
  seq: integer().primaryKey(),
  reservation_id: text().notNull(),
  bucket_id: text().notNull(),
  event_key: text().notNull(),
  event_kind: text().notNull(),
  used_delta: integer().notNull(),
  reserved_delta: integer().notNull(),
  reason: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiQuotaOverrides = sqliteTable("ai_quota_overrides", {
  id: text().primaryKey().notNull(),
  subject_id: text().notNull(),
  metric: text().notNull(),
  window_kind: text().notNull(),
  scope_key: text()
    .notNull()
    .default(sql`'*'`),
  limit_value: integer(),
  version: integer()
    .notNull()
    .default(sql`1`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_by: text(),
});

export const aiQuotaPlans = sqliteTable("ai_quota_plans", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  enabled: integer()
    .notNull()
    .default(sql`1`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiQuotaReservationItems = sqliteTable(
  "ai_quota_reservation_items",
  {
    reservation_id: text().notNull(),
    bucket_id: text().notNull(),
    reserved_amount: integer().notNull(),
    settled_amount: integer(),
    limit_snapshot: integer(),
  },
  (table) => [primaryKey({ columns: [table.reservation_id, table.bucket_id] })],
);

export const aiQuotaReservations = sqliteTable("ai_quota_reservations", {
  id: text().primaryKey().notNull(),
  operation_key: text().notNull(),
  operation_kind: text().notNull(),
  operation_id: text().notNull(),
  invocation_id: text(),
  attempt_id: text(),
  request_hash: text().notNull(),
  status: text().notNull(),
  policy_epoch: integer().notNull(),
  mutation_token: text().notNull(),
  expires_at: integer().notNull(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiQuotaRules = sqliteTable("ai_quota_rules", {
  id: text().primaryKey().notNull(),
  plan_id: text().notNull(),
  metric: text().notNull(),
  window_kind: text().notNull(),
  scope_key: text()
    .notNull()
    .default(sql`'*'`),
  limit_value: integer(),
});

export const aiRoomMcpBindings = sqliteTable(
  "ai_room_mcp_bindings",
  {
    room_id: text().notNull(),
    connection_id: text().notNull(),
    owner_user_id: text().notNull(),
    allowed_tools_json: text()
      .notNull()
      .default(sql`'[]'`),
    enabled: integer()
      .notNull()
      .default(sql`1`),
    version: integer()
      .notNull()
      .default(sql`1`),
  },
  (table) => [primaryKey({ columns: [table.room_id, table.connection_id] })],
);

export const aiRoomMessages = sqliteTable("ai_room_messages", {
  id: text().primaryKey().notNull(),
  room_id: text().notNull(),
  seq: integer().notNull(),
  role: text().notNull(),
  author_user_id: text(),
  client_message_id: text(),
  run_id: text(),
  payload_id: text(),
  status: text().notNull(),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiRooms = sqliteTable("ai_rooms", {
  id: text().primaryKey().notNull(),
  owner_user_id: text().notNull(),
  title: text().notNull(),
  profile_id: text().notNull(),
  instructions_payload_id: text(),
  next_message_seq: integer()
    .notNull()
    .default(sql`1`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  deleted_at: integer(),
});

export const aiRunEvents = sqliteTable(
  "ai_run_events",
  {
    run_id: text().notNull(),
    seq: integer().notNull(),
    kind: text().notNull(),
    payload_json: text()
      .notNull()
      .default(sql`'{}'`),
    created_at: integer()
      .notNull()
      .default(sql`unixepoch()`),
  },
  (table) => [primaryKey({ columns: [table.run_id, table.seq] })],
);

export const aiRunSteps = sqliteTable("ai_run_steps", {
  id: text().primaryKey().notNull(),
  run_id: text().notNull(),
  ordinal: integer().notNull(),
  kind: text().notNull(),
  invocation_id: text(),
  status: text().notNull(),
  execution_token: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  finished_at: integer(),
});

export const aiRuns = sqliteTable("ai_runs", {
  id: text().primaryKey().notNull(),
  room_id: text().notNull(),
  actor_user_id: text().notNull(),
  session_id: text().notNull(),
  actor_auth_version: integer().notNull(),
  trigger_message_id: text().notNull(),
  profile_id: text().notNull(),
  idempotency_key: text().notNull(),
  request_hash: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'queued'`),
  config_snapshot_json: text().notNull(),
  checkpoint_json: text()
    .notNull()
    .default(sql`'{}'`),
  execution_token: text(),
  next_event_seq: integer()
    .notNull()
    .default(sql`1`),
  deadline_at: integer().notNull(),
  error_code: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  finished_at: integer(),
  admission_reservation_id: text(),
  slot_reservation_id: text(),
  lease_expires_at: integer(),
});

export const aiSettings = sqliteTable("ai_settings", {
  id: integer().primaryKey(),
  enabled: integer()
    .notNull()
    .default(sql`0`),
  workspace_subject_id: text().notNull(),
  default_user_plan_id: text().notNull(),
  quota_time_zone: text()
    .notNull()
    .default(sql`'UTC'`),
  payload_retention_days: integer()
    .notNull()
    .default(sql`30`),
  policy_epoch: integer()
    .notNull()
    .default(sql`1`),
  version: integer()
    .notNull()
    .default(sql`1`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_by: text(),
});

export const aiSubjects = sqliteTable("ai_subjects", {
  id: text().primaryKey().notNull(),
  key: text().notNull(),
  kind: text().notNull(),
  user_id: text(),
  service_key: text(),
  plan_id: text(),
  status: text()
    .notNull()
    .default(sql`'active'`),
  version: integer()
    .notNull()
    .default(sql`1`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  updated_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiToolApprovals = sqliteTable("ai_tool_approvals", {
  id: text().primaryKey().notNull(),
  tool_call_id: text().notNull(),
  required_user_id: text().notNull(),
  intent_hash: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'pending'`),
  expires_at: integer().notNull(),
  decision_user_id: text(),
  decision_session_id: text(),
  decided_at: integer(),
  consumed_at: integer(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const aiToolCalls = sqliteTable("ai_tool_calls", {
  id: text().primaryKey().notNull(),
  run_id: text().notNull(),
  step_id: text().notNull(),
  room_id: text().notNull(),
  actor_user_id: text().notNull(),
  server_id: text().notNull(),
  connection_id: text().notNull(),
  tool_id: text().notNull(),
  provider_call_id: text().notNull(),
  operation_key: text().notNull(),
  args_payload_id: text().notNull(),
  args_hash: text().notNull(),
  intent_snapshot_json: text().notNull(),
  result_payload_id: text(),
  status: text().notNull(),
  execution_token: text(),
  error_code: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  finished_at: integer(),
  reservation_id: text(),
});

export const aiUsageEvents = sqliteTable("ai_usage_events", {
  seq: integer().primaryKey(),
  attempt_id: text().notNull(),
  event_key: text().notNull(),
  event_kind: text().notNull(),
  usage_source: text().notNull(),
  cost_source: text().notNull(),
  input_tokens_delta: integer()
    .notNull()
    .default(sql`0`),
  output_tokens_delta: integer()
    .notNull()
    .default(sql`0`),
  cached_input_tokens_delta: integer()
    .notNull()
    .default(sql`0`),
  cache_write_tokens_delta: integer()
    .notNull()
    .default(sql`0`),
  reasoning_tokens_delta: integer()
    .notNull()
    .default(sql`0`),
  cost_micro_usd_delta: integer(),
  receipt_json: text()
    .notNull()
    .default(sql`'{}'`),
  reason: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const mcpApiKeys = sqliteTable("mcp_api_keys", {
  id: text().primaryKey().notNull(),
  user_id: text().notNull(),
  session_id: text().notNull(),
  name: text().notNull(),
  token_hash: text().notNull(),
  auth_version: integer().notNull(),
  scopes_json: text().notNull(),
  constraints_json: text()
    .notNull()
    .default(sql`'{}'`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  expires_at: integer().notNull(),
  revoked_at: integer(),
});

export const mcpOauthClients = sqliteTable("mcp_oauth_clients", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  redirect_uris_json: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'active'`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const mcpOauthGrants = sqliteTable("mcp_oauth_grants", {
  id: text().primaryKey().notNull(),
  client_id: text().notNull(),
  user_id: text().notNull(),
  session_id: text().notNull(),
  auth_version: integer().notNull(),
  resource: text().notNull(),
  scopes_json: text().notNull(),
  constraints_json: text()
    .notNull()
    .default(sql`'{}'`),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  expires_at: integer().notNull(),
  revoked_at: integer(),
});

export const mcpOauthRequests = sqliteTable("mcp_oauth_requests", {
  id: text().primaryKey().notNull(),
  client_id: text().notNull(),
  redirect_uri: text().notNull(),
  resource: text().notNull(),
  scopes_json: text().notNull(),
  state: text(),
  code_challenge: text().notNull(),
  code_hash: text(),
  used_by: text(),
  user_id: text(),
  session_id: text(),
  grant_id: text(),
  status: text()
    .notNull()
    .default(sql`'pending'`),
  expires_at: integer().notNull(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
});

export const mcpOauthTokens = sqliteTable("mcp_oauth_tokens", {
  id: text().primaryKey().notNull(),
  grant_id: text().notNull(),
  token_hash: text().notNull(),
  kind: text().notNull(),
  parent_id: text(),
  used_by: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  expires_at: integer().notNull(),
  revoked_at: integer(),
});

export const mcpToolOperations = sqliteTable("mcp_tool_operations", {
  id: text().primaryKey().notNull(),
  owner_user_id: text().notNull(),
  session_id: text().notNull(),
  credential_id: text().notNull(),
  authorization_json: text().notNull(),
  reservation_id: text(),
  tool_name: text().notNull(),
  args_json: text().notNull(),
  intent_hash: text().notNull(),
  operation_key: text().notNull(),
  status: text()
    .notNull()
    .default(sql`'pending'`),
  result_json: text(),
  decision_session_id: text(),
  created_at: integer()
    .notNull()
    .default(sql`unixepoch()`),
  expires_at: integer().notNull(),
  finished_at: integer(),
});

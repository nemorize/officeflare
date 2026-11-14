import type { AuthEnv, Identity } from "../auth/types";

export type Bind = string | number | null;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = Record<string, unknown>;
export type AIEnv = AuthEnv;
export type AIPrincipal =
  | { kind: "user"; userId: string; sessionId: string; authVersion: number }
  | { kind: "service"; serviceKey: string };
export const userPrincipal = ({ user, session }: Identity): AIPrincipal => ({
  kind: "user",
  userId: user.id,
  sessionId: session.id,
  authVersion: user.auth_version,
});
export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: AIToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  provider_state?: unknown;
}
export interface AITool {
  name: string;
  description: string;
  inputSchema: ObjectValue;
}
export interface AIToolCall {
  id: string;
  name: string;
  arguments: ObjectValue;
}
export interface AILimits {
  max_input_tokens: number;
  max_output_tokens: number;
  max_attempts: number;
  timeout_seconds: number;
  max_cost_micro_usd: number | null;
}
export interface AIRequest {
  consumer: string;
  principal: AIPrincipal;
  profileKey: string;
  idempotencyKey: string;
  sourceRef: { type: string; id: string };
  messages: AIMessage[];
  tools?: AITool[];
  outputSchema?: ObjectValue;
  limits?: Partial<AILimits>;
}
export interface AIUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  source: "provider" | "estimated" | "unknown";
}
export interface AIResult {
  invocation_id: string;
  text: string;
  tool_calls: AIToolCall[];
  finish_reason: string;
  usage: AIUsage;
  provider_state?: unknown;
}
export interface AIEvent {
  type: "output.delta" | "completed" | "failed";
  invocation_id: string;
  data: unknown;
}
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface AIRuntime {
  fetcher?: Fetcher;
  onDelta?: (text: string) => Promise<void>;
  signal?: AbortSignal;
}
export interface Profile {
  id: string;
  key: string;
  enabled: number;
  version: number;
  generation_json: string;
  required_capabilities_json: string;
  limits_json: string;
  data_policy_json: string;
}
export interface Provider {
  id: string;
  adapter_key: string;
  base_url: string;
  config_json: string;
  version: number;
}
export interface Account {
  id: string;
  provider_id: string;
  auth_kind: string;
  owner_user_id: string | null;
  share_scope: string;
  sharing_authorization: string;
  status: string;
  secret_envelope_json: string | null;
  credential_version: number;
  credential_expires_at: number | null;
  oauth_issuer: string | null;
  oauth_subject: string | null;
  oauth_workspace_id: string | null;
  oauth_client_id: string | null;
  oauth_host_id: string | null;
  metadata_json: string;
  concurrency_limit: number;
  cooldown_until: number | null;
  quota_group_key: string | null;
  version: number;
}
export interface Route {
  id: string;
  profile_id: string;
  provider_id: string;
  deployment_id: string;
  pool_id: string;
  gateway_id: string | null;
  config_json: string;
  priority: number;
  version: number;
}
export interface Deployment {
  id: string;
  model_id: string;
  provider_id: string;
  provider_model_id: string;
  protocol: string;
  auth_mode: string;
  capabilities_json: string;
  pricing_json: string;
  config_json: string;
  version: number;
}
export interface Invocation {
  id: string;
  consumer_key: string;
  initiator_key: string;
  actor_user_id: string | null;
  session_id: string | null;
  actor_auth_version: number | null;
  billing_subject_id: string;
  profile_id: string;
  input_payload_id: string | null;
  output_payload_id: string | null;
  request_hash: string;
  policy_snapshot_json: string;
  status: string;
  execution_token: string | null;
  deadline_at: number;
  created_at: number;
  error_code: string | null;
  admission_reservation_id: string | null;
  lease_expires_at: number | null;
}
export type Metric =
  | "chat_runs"
  | "invocations"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "cost_micro_usd"
  | "tool_calls"
  | "concurrent_invocations"
  | "concurrent_runs";
export type Amounts = Partial<Record<Metric, number>>;
export interface QuotaContext {
  subjectIds: string[];
  consumer: string;
  profileId: string;
  epoch: number;
}
export interface Guard {
  sql: string;
  args: Bind[];
}

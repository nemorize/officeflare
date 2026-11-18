export const aiAdapters = [
  "openai",
  "openrouter",
  "anthropic",
  "google",
  "cloudflare",
  "openai_compatible",
] as const;
export const aiProtocols = [
  "openai_responses",
  "openai_chat",
  "anthropic_messages",
  "google_generate_content",
  "cloudflare_run",
] as const;
export type AIAdapter = (typeof aiAdapters)[number];
export type AIProtocol = (typeof aiProtocols)[number];
export type AIConfigurationObject = Record<string, unknown>;

export interface AIConfiguredAccount {
  id?: string;
  version?: number;
  name: string;
  auth_kind: "api_key" | "oauth";
  share_scope: "workspace" | "owner";
  owner_user_id?: string | null;
  authorization_ref?: string | null;
  status: string;
  concurrency_limit: number;
  quota_group_key?: string | null;
  has_secret?: boolean;
  cooldown_until?: number | null;
  credentials?: { api_key?: string; client_secret?: string };
}
export interface AIConfiguredGateway {
  account_id: string;
  gateway_id: string;
  provider_slug: string;
  has_secret?: boolean;
  api_key?: string;
}
export interface AIProviderConfiguration {
  id?: string;
  version?: number;
  key: string;
  name: string;
  adapter_key: AIAdapter;
  base_url: string;
  enabled: boolean;
  oauth: AIConfigurationObject | null;
  accounts: AIConfiguredAccount[];
  gateway: AIConfiguredGateway | null;
}
export interface AIModelProvider {
  id?: string;
  provider_id: string;
  provider_model_id: string;
  protocol: AIProtocol;
  auth_mode: "api" | "chatgpt_plan" | "platform";
  enabled: boolean;
  capabilities: AIConfigurationObject;
  pricing: AIConfigurationObject;
  config?: AIConfigurationObject;
  cooldown_until?: number | null;
}
export interface AIModelConfiguration {
  id?: string;
  version?: number;
  key: string;
  name: string;
  vendor: string;
  enabled: boolean;
  providers: AIModelProvider[];
}
export interface AIProviderModel {
  id: string;
  name: string;
  context_tokens?: number;
  max_output_tokens?: number;
  pricing?: { input: number; output: number };
}

export const defaultAIProtocol = (adapter: AIAdapter): AIProtocol =>
  adapter === "anthropic"
    ? "anthropic_messages"
    : adapter === "google"
      ? "google_generate_content"
      : adapter === "cloudflare"
        ? "cloudflare_run"
        : adapter === "openai"
          ? "openai_responses"
          : "openai_chat";

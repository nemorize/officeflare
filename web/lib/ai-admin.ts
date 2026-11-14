import { t, type StaticMessageKey } from "../../shared/i18n/index.ts";
import { jsonObject, type AIRecord } from "./ai";
export interface AIAdminField {
  path: string;
  label: StaticMessageKey;
  kind?: "text" | "number" | "password" | "url" | "boolean" | "select" | "ref";
  options?: string[];
  ref?: string;
  required?: boolean;
  initial?: string | number | boolean;
  min?: number;
  step?: string;
  advanced?: boolean;
}
export interface AIAdminSpec {
  key: string;
  titleKey: StaticMessageKey;
  permission: "providers" | "settings" | "quotas";
  fields: AIAdminField[];
}
const field = (
  path: string,
  label: StaticMessageKey,
  extras: Partial<AIAdminField> = {},
): AIAdminField => ({ path, label, ...extras });
const enabled = field("enabled", "common.enabled", { kind: "boolean", initial: true });
const named = [
  field("key", "aiui.key", { required: true }),
  field("name", "common.name", { required: true }),
];
const provider = field("provider_id", "aiui.provider", {
  kind: "ref",
  ref: "providers",
  required: true,
});
const oauth = [
  field("oauth_enabled", "aiui.enableOAuth", { kind: "boolean" }),
  ...[
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "revocation_endpoint",
    "client_id",
    "scope",
    "resource",
    "hosted_authorization_ref",
  ].map((key) =>
    field("config_json.oauth." + key, `aiui.oauth.${key}` as StaticMessageKey, {
      kind: [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
        "revocation_endpoint",
        "resource",
      ].includes(key)
        ? "url"
        : "text",
      advanced: true,
    }),
  ),
];
export const aiAdminSpecs: AIAdminSpec[] = [
  {
    key: "providers",
    titleKey: "aiui.providers",
    permission: "providers",
    fields: [
      ...named,
      field("adapter_key", "aiui.adapter", {
        kind: "select",
        options: ["openai", "openrouter", "anthropic", "google", "cloudflare", "openai_compatible"],
        initial: "openai",
      }),
      field("base_url", "aiui.baseURL", {
        kind: "url",
        required: true,
        initial: "https://api.openai.com/v1",
      }),
      enabled,
      ...oauth,
    ],
  },
  {
    key: "accounts",
    titleKey: "aiui.accounts",
    permission: "providers",
    fields: [
      provider,
      field("name", "common.name", { required: true }),
      field("auth_kind", "aiui.authKind", {
        kind: "select",
        options: ["api_key", "oauth"],
        initial: "api_key",
      }),
      field("secret.api_key", "aiui.apiKey", { kind: "password" }),
      field("secret.client_secret", "aiui.clientSecret", { kind: "password", advanced: true }),
      field("share_scope", "aiui.sharing", {
        kind: "select",
        options: ["owner", "workspace"],
        initial: "owner",
      }),
      field("sharing_authorization", "aiui.sharingAuthorization", {
        kind: "select",
        options: ["owner_only", "provider_permitted"],
        initial: "owner_only",
      }),
      field("authorization_ref", "aiui.authorizationRef"),
      field("owner_user_id", "aiui.ownerID", { advanced: true }),
      field("status", "common.status", {
        kind: "select",
        options: ["active", "disabled"],
        initial: "active",
      }),
      field("concurrency_limit", "aiui.concurrency", { kind: "number", initial: 1, min: 1 }),
      field("quota_group_key", "aiui.quotaGroup", { advanced: true }),
    ],
  },
  {
    key: "gateways",
    titleKey: "aiui.gateways",
    permission: "providers",
    fields: [
      ...named,
      field("config_json.account_id", "aiui.cloudflareAccount", { required: true }),
      field("config_json.gateway_id", "aiui.gatewayID", { required: true }),
      field("config_json.provider_slug", "aiui.providerSlug", {
        required: true,
        initial: "openai",
      }),
      field("secret.api_key", "aiui.gatewayKey", { kind: "password" }),
      enabled,
    ],
  },
  {
    key: "pools",
    titleKey: "aiui.pools",
    permission: "providers",
    fields: [
      provider,
      field("name", "common.name", { required: true }),
      field("strategy", "aiui.strategy", {
        kind: "select",
        options: ["priority", "weighted", "least_recently_used"],
        initial: "priority",
      }),
      enabled,
    ],
  },
  {
    key: "models",
    titleKey: "aiui.models",
    permission: "providers",
    fields: [...named, field("vendor", "aiui.vendor", { required: true }), enabled],
  },
  {
    key: "deployments",
    titleKey: "aiui.deployments",
    permission: "providers",
    fields: [
      provider,
      field("model_id", "aiui.model", { kind: "ref", ref: "models", required: true }),
      field("provider_model_id", "aiui.modelID", { required: true }),
      field("protocol", "aiui.protocol", {
        kind: "select",
        options: [
          "openai_responses",
          "openai_chat",
          "anthropic_messages",
          "google_generate_content",
          "cloudflare_run",
        ],
        initial: "openai_responses",
      }),
      field("auth_mode", "aiui.authMode", {
        kind: "select",
        options: ["api", "chatgpt_plan", "platform"],
        initial: "api",
      }),
      field("capabilities_json.context_tokens", "aiui.contextTokens", {
        kind: "number",
        required: true,
        min: 1,
      }),
      field("capabilities_json.max_output_tokens", "aiui.maxOutput", {
        kind: "number",
        required: true,
        min: 1,
      }),
      field("capabilities_json.input_overhead_tokens", "aiui.inputOverhead", {
        kind: "number",
        initial: 1024,
        min: 0,
        advanced: true,
      }),
      field("capabilities_json.tool_calls", "aiui.supportsTools", {
        kind: "boolean",
        initial: true,
      }),
      field("capabilities_json.json_schema", "aiui.supportsJSON", {
        kind: "boolean",
        initial: true,
      }),
      field("capabilities_json.bounded_usage", "aiui.verifiedBounds", {
        kind: "boolean",
        initial: false,
      }),
      field("pricing_json.source", "aiui.pricingSource", {
        kind: "select",
        options: ["catalog", "internal_rate", "unknown"],
        initial: "catalog",
      }),
      ...["input", "output", "cache_read", "cache_write"].map((key) =>
        field("pricing_json." + key, `aiui.price.${key}` as StaticMessageKey, {
          kind: "number",
          min: 0,
          step: "0.000001",
        }),
      ),
      enabled,
    ],
  },
  {
    key: "profiles",
    titleKey: "aiui.profiles",
    permission: "settings",
    fields: [
      ...named,
      field("limits_json.max_input_tokens", "aiui.maxInput", {
        kind: "number",
        initial: 32768,
        min: 1,
      }),
      field("limits_json.max_output_tokens", "aiui.maxOutput", {
        kind: "number",
        initial: 4096,
        min: 1,
      }),
      field("limits_json.max_attempts", "aiui.maxAttempts", { kind: "number", initial: 3, min: 1 }),
      field("limits_json.timeout_seconds", "aiui.timeout", {
        kind: "number",
        initial: 120,
        min: 1,
      }),
      field("generation_json.temperature", "aiui.temperature", {
        kind: "number",
        min: 0,
        step: "0.1",
        advanced: true,
      }),
      field("data_policy_json.require_no_logging", "aiui.noLogging", {
        kind: "boolean",
        advanced: true,
      }),
      field("data_policy_json.region", "aiui.region", { advanced: true }),
      enabled,
    ],
  },
  {
    key: "routes",
    titleKey: "aiui.routes",
    permission: "settings",
    fields: [
      field("profile_id", "aiui.profile", { kind: "ref", ref: "profiles", required: true }),
      provider,
      field("deployment_id", "aiui.deployment", {
        kind: "ref",
        ref: "deployments",
        required: true,
      }),
      field("pool_id", "aiui.pool", { kind: "ref", ref: "pools", required: true }),
      field("gateway_id", "aiui.gateway", { kind: "ref", ref: "gateways" }),
      field("priority", "aiui.priority", { kind: "number", min: 0, initial: 0 }),
      enabled,
    ],
  },
  {
    key: "consumers",
    titleKey: "aiui.consumers",
    permission: "settings",
    fields: [
      field("name", "common.name", { required: true }),
      field("tools_allowed", "aiui.allowTools", { kind: "boolean", initial: true }),
      field("limits_json.max_steps", "aiui.maxSteps", { kind: "number", min: 1, initial: 12 }),
      field("limits_json.max_tool_calls", "aiui.maxToolCalls", {
        kind: "number",
        min: 1,
        initial: 24,
      }),
      enabled,
    ],
  },
  {
    key: "mcp-servers",
    titleKey: "aiui.mcpServers",
    permission: "settings",
    fields: [
      ...named,
      field("transport", "aiui.transport", {
        kind: "select",
        options: ["builtin", "streamable_http"],
        initial: "streamable_http",
      }),
      field("endpoint_url", "aiui.endpointURL", { kind: "url" }),
      field("builtin_key", "aiui.builtinKey", {
        kind: "select",
        options: ["", "mail", "contacts", "drive", "calendar"],
        initial: "",
      }),
      enabled,
      ...oauth,
    ],
  },
  { key: "quota-plans", titleKey: "aiui.plans", permission: "quotas", fields: [...named, enabled] },
];
export const aiConsolePages = [
  { page: "settings", titleKey: "aiui.settings", permission: "admin.ai.settings.read" },
  ...aiAdminSpecs.map((spec) => ({
    page: spec.key,
    titleKey: spec.titleKey,
    permission: `admin.ai.${spec.permission}.read`,
  })),
  { page: "quotas", titleKey: "aiui.userLimits", permission: "admin.ai.quotas.read" },
  { page: "usage", titleKey: "aiui.usage", permission: "admin.ai.usage.read" },
  { page: "activity", titleKey: "aiui.audit", permission: "admin.ai.audit.read" },
  { page: "reconciliation", titleKey: "aiui.reconciliation", permission: "admin.ai.usage.read" },
] satisfies { page: string; titleKey: StaticMessageKey; permission: string }[];
export const recordLabel = (record: AIRecord) =>
  String(record.name ?? record.provider_model_id ?? record.key ?? record.id);
export function readAIField(record: AIRecord | null, field: AIAdminField): string | boolean {
  if (field.kind === "password") return "";
  if (field.path === "oauth_enabled") return !!jsonObject(record?.config_json).oauth;
  const parts = field.path.split(".");
  let value: unknown = record;
  for (const part of parts) {
    if (typeof value === "string") value = jsonObject(value);
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  }
  if (field.kind === "boolean") return value === undefined ? Boolean(field.initial) : !!value;
  if (field.path.startsWith("pricing_json.") && field.path !== "pricing_json.source")
    return value == null ? "" : String(Number(value) / 1_000_000);
  return String(value ?? field.initial ?? "");
}
export function aiResourcePayload(
  spec: AIAdminSpec,
  values: Record<string, string | boolean>,
  record: AIRecord | null,
) {
  const body: Record<string, unknown> = record ? { version: record.version } : {};
  for (const field of spec.fields) {
    if (field.path === "oauth_enabled" || (record && field.path === "key")) continue;
    if (field.path.startsWith("config_json.oauth.") && !values.oauth_enabled) continue;
    const raw = values[field.path];
    if (field.kind === "password" && !raw) continue;
    const parts = field.path.split(".");
    let value: unknown = raw;
    if (field.kind === "number" && raw !== "") {
      value = Number(raw);
      if (!Number.isFinite(value) || Number(value) < (field.min ?? 0))
        throw new Error(t("ai.invalid"));
      if (field.path.startsWith("pricing_json.")) value = Math.round(Number(value) * 1_000_000);
    }
    if (raw === "" && field.required) throw new Error(t("ai.invalid"));
    if (parts.length === 1) {
      if (raw !== "") body[field.path] = value;
      else if (
        record &&
        [
          "gateway_id",
          "owner_user_id",
          "quota_group_key",
          "authorization_ref",
          "endpoint_url",
          "builtin_key",
        ].includes(field.path)
      )
        body[field.path] = null;
      continue;
    }
    const root = parts.shift()!;
    if (!body[root]) body[root] = root === "secret" ? {} : { ...jsonObject(record?.[root]) };
    let target = body[root] as Record<string, unknown>;
    while (parts.length > 1) {
      const next = parts.shift()!;
      target[next] = { ...jsonObject(target[next]) };
      target = target[next] as Record<string, unknown>;
    }
    if (raw === "") delete target[parts[0]!];
    else target[parts[0]!] = value;
  }
  if (spec.key === "gateways") body.adapter_key = "cloudflare";
  if (
    ["providers", "mcp-servers"].includes(spec.key) &&
    !values.oauth_enabled &&
    record &&
    jsonObject(record.config_json).oauth
  ) {
    body.config_json = { ...jsonObject(body.config_json ?? record.config_json) };
    delete (body.config_json as Record<string, unknown>).oauth;
  }
  if (spec.key === "deployments") {
    const caps = body.capabilities_json as Record<string, unknown>;
    caps.schema_version = 1;
    caps.streaming = true;
    caps.input_token_bound = "utf8_bytes";
    caps.enforces_output_limit = true;
    const pricing = body.pricing_json as Record<string, unknown>;
    pricing.schema_version = 1;
    pricing.currency = "USD";
    pricing.unit = "micro_usd_per_million_tokens";
    if (body.enabled && !caps.bounded_usage) throw new Error(t("aiui.verifyBoundsHint"));
  }
  if (spec.key === "accounts") {
    if (
      body.share_scope === "workspace" &&
      (body.sharing_authorization !== "provider_permitted" || !body.authorization_ref)
    )
      throw new Error(t("aiui.sharingHint"));
    if (!record && body.auth_kind === "oauth") body.status = "disabled";
    if (!record && body.auth_kind === "api_key" && !body.secret) throw new Error(t("ai.invalid"));
  }
  return body;
}

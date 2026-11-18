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
    key: "profiles",
    titleKey: "aiui.profiles",
    permission: "settings",
    fields: [
      ...named,
      field("model_id", "aiui.model", { kind: "ref", ref: "models" }),
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
        options: ["", "mail", "contacts", "drive", "calendar", "wiki"],
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
  { page: "providers", titleKey: "aiui.providers", permission: "admin.ai.providers.read" },
  { page: "models", titleKey: "aiui.models", permission: "admin.ai.providers.read" },
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
      else if (record && ["endpoint_url", "builtin_key", "model_id"].includes(field.path))
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
  if (
    spec.key === "mcp-servers" &&
    !values.oauth_enabled &&
    record &&
    jsonObject(record.config_json).oauth
  ) {
    body.config_json = { ...jsonObject(body.config_json ?? record.config_json) };
    delete (body.config_json as Record<string, unknown>).oauth;
  }
  return body;
}

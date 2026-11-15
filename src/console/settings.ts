import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";
import {
  serviceDefaults,
  type ServiceSettings,
  type SettingsService,
  type SettingValue,
} from "../../shared/console-settings";
import type { AuthEnv } from "../auth/types";

export async function serviceSettings(
  env: Pick<AuthEnv, "DB">,
  service: SettingsService,
): Promise<ServiceSettings> {
  const row = await env.DB.withSession("first-primary")
    .prepare("SELECT values_json,version,updated_at FROM console_settings WHERE service=?")
    .bind(service)
    .first<{ values_json: string; version: number; updated_at: number | null }>();
  if (!row) throw new HTTPException(503, { message: t("consoleAdmin.configurationUnavailable") });
  return {
    values: { ...serviceDefaults[service], ...JSON.parse(row.values_json) },
    version: row.version,
    updated_at: row.updated_at,
  };
}
export function settingEnabled(service: "contacts" | "wiki", key: string) {
  // All identifiers are selected by application code, never by request input.
  return {
    sql: "EXISTS(SELECT 1 FROM console_settings WHERE service=? AND json_extract(values_json,?)=1)",
    args: [service, `$.${key}`],
  };
}
export function policyDenied(): never {
  throw new HTTPException(403, { message: t("consoleAdmin.policyDenied") });
}
export async function contactCreationPolicy(
  env: Pick<AuthEnv, "DB">,
  userId: string,
  operation: string,
) {
  const config: Record<string, { flag: string; limit: string; table: string }> = {
    "contacts.create": { flag: "entries_enabled", limit: "max_contacts", table: "contacts" },
    "folders.create": { flag: "folders_enabled", limit: "max_folders", table: "contact_folders" },
    "fields.create": {
      flag: "fields_enabled",
      limit: "max_fields",
      table: "contact_field_definitions",
    },
  };
  const spec = config[operation];
  if (!spec) return { sql: "1", args: [] as (string | number)[] };
  const settings = await serviceSettings(env, "contacts");
  if (!settings.values[spec.flag]) policyDenied();
  const count = `(SELECT COUNT(*) FROM ${spec.table} x JOIN contact_books b ON b.id=x.book_id WHERE b.owner_user_id=?)`;
  const guard = {
    sql: `EXISTS(SELECT 1 FROM console_settings WHERE service='contacts' AND json_extract(values_json,?)=1 AND (json_extract(values_json,?)=0 OR ${count}<json_extract(values_json,?)))`,
    args: [`$.${spec.flag}`, `$.${spec.limit}`, userId, `$.${spec.limit}`],
  };
  const allowed = await env.DB.withSession("first-primary")
    .prepare(`SELECT 1 WHERE ${guard.sql}`)
    .bind(...guard.args)
    .first();
  if (!allowed) throw new HTTPException(409, { message: t("consoleAdmin.limitReached") });
  return guard;
}
export function validSettingsService(value: string): value is SettingsService {
  return Object.hasOwn(serviceDefaults, value);
}
export function validateSetting(
  service: SettingsService,
  key: string,
  value: unknown,
): SettingValue {
  const initial = (serviceDefaults[service] as Record<string, SettingValue>)[key];
  const invalid = (): never => {
    throw new HTTPException(400, { message: t("consoleAdmin.invalidSetting") });
  };
  if (initial === undefined || typeof value !== typeof initial) return invalid();
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : invalid();
  if (typeof value !== "string" || value.length > 500) return invalid();
  const text = value.trim();
  if (key === "workspace_name" && (!text || text.length > 100)) return invalid();
  if (key === "support_url" && text) {
    try {
      const url = new URL(text);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        return invalid();
    } catch {
      return invalid();
    }
  }
  if (key === "default_language" && !["system", "en", "ko", "ja"].includes(text)) return invalid();
  try {
    if (key === "default_time_zone") {
      if (/^[+-]/.test(text)) return invalid();
      return new Intl.DateTimeFormat("en", { timeZone: text }).resolvedOptions().timeZone;
    }
    if (key === "default_regional_format") return Intl.getCanonicalLocales(text)[0] ?? invalid();
  } catch {
    return invalid();
  }
  return text;
}

import { HTTPException } from "hono/http-exception";
import { Temporal } from "@js-temporal/polyfill";
import { t } from "../../shared/i18n/index.ts";
import { uuid } from "../auth/types";
import type { ContactContext, DetailKind, DetailRow, FieldDefinition } from "./types";

export function fail(
  status: 400 | 403 | 404 | 409 | 412 | 428,
  code: string,
  message: string,
): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: message, code }, { status }),
  });
}
export function invalid(field: string): never {
  fail(400, "INVALID_INPUT", t("contacts.invalid", { field }));
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body");
  return value as Record<string, unknown>;
}
export function fields(data: Record<string, unknown>, allowed: readonly string[]) {
  for (const field of Object.keys(data)) if (!allowed.includes(field)) invalid(field);
}
export async function body(c: ContactContext, allowed: readonly string[]) {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    invalid("JSON");
  }
  const result = object(data);
  fields(result, allowed);
  return result;
}
export function text(value: unknown, field: string, max = 255, empty = false): string {
  if (typeof value !== "string" || value.length > max || /\u0000/.test(value)) invalid(field);
  const result = value.trim().normalize("NFC");
  if (!empty && !result) invalid(field);
  return result;
}
export function identifier(value: unknown, field = "id"): string {
  const result = text(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid(field);
  return result;
}
export function integer(value: unknown, field: string, min = 0, max = 2147483647) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(field);
  return value;
}
export const nameKey = (value: string) => value.normalize("NFC").toLowerCase();
export function email(value: unknown): string {
  const result = text(value, "email_address", 254),
    key = result.toLowerCase();
  if (
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(key) ||
    key.split("@")[0]!.length > 64 ||
    key.startsWith(".") ||
    key.includes("..")
  )
    invalid("email_address");
  return result;
}
export function date(value: unknown, field = "birthday"): string {
  const result = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) invalid(field);
  try {
    Temporal.PlainDate.from(result, { overflow: "reject" });
  } catch {
    invalid(field);
  }
  return result;
}
export function url(value: unknown): string {
  const result = text(value, "url", 2048);
  try {
    const parsed = new URL(result);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
      invalid("url");
  } catch {
    invalid("url");
  }
  return result;
}
export function version(c: ContactContext, data?: Record<string, unknown>) {
  const header = c.req.header("If-Match"),
    raw = data?.version ?? c.req.query("version");
  const match = header?.match(/^"v([1-9][0-9]*)"$/);
  if (header && !match) invalid("If-Match");
  const fromBody =
    raw === undefined
      ? undefined
      : integer(typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw, "version", 1);
  const fromHeader = match ? integer(Number(match[1]), "If-Match", 1) : undefined;
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader)
    invalid("version");
  if (fromBody === undefined && fromHeader === undefined)
    fail(428, "VERSION_REQUIRED", t("contacts.versionRequired"));
  return fromBody ?? fromHeader!;
}
export function limit(value: unknown, fallback = 50, max = 100) {
  return value === undefined
    ? fallback
    : integer(
        typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
        "limit",
        1,
        max,
      );
}
export function array(value: unknown, field: string, max = 50): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}
const detailFields = {
  emails: ["email_address"],
  phones: ["phone_number", "extension"],
  addresses: [
    "country_code",
    "region",
    "city",
    "postal_code",
    "street_address",
    "extended_address",
    "formatted_address",
  ],
  links: ["url"],
} as const;
export function details(
  value: unknown,
  kind: DetailKind,
  contactId: string,
  previous: DetailRow[] = [],
): DetailRow[] {
  const ids = new Set<string>(),
    emailKeys = new Set<string>();
  const result = array(value, kind).map((entry, index) => {
    const data = object(entry);
    fields(data, ["id", "label", "is_primary", "sort_order", ...detailFields[kind]]);
    const id = data.id === undefined ? uuid() : identifier(data.id);
    if (data.id !== undefined && !previous.some((row) => row.id === id)) invalid("id");
    if (ids.has(id)) invalid("id");
    ids.add(id);
    if (data.is_primary !== undefined && typeof data.is_primary !== "boolean")
      invalid("is_primary");
    const row: DetailRow = {
      id,
      contact_id: contactId,
      label: data.label === undefined ? "" : text(data.label, "label", 100, true),
      is_primary: data.is_primary ? 1 : 0,
      sort_order: data.sort_order === undefined ? index : integer(data.sort_order, "sort_order"),
    };
    if (kind === "emails") {
      row.email_address = email(data.email_address);
      row.email_key = nameKey(row.email_address);
      if (emailKeys.has(row.email_key)) invalid("emails");
      emailKeys.add(row.email_key);
    } else if (kind === "phones") {
      row.phone_number = text(data.phone_number, "phone_number", 100);
      if (!/^\+?[0-9\s().-]+$/.test(row.phone_number) || !/[0-9]/.test(row.phone_number))
        invalid("phone_number");
      row.phone_key = row.phone_number.replace(/[\s().-]/g, "");
      row.extension =
        data.extension === undefined ? "" : text(data.extension, "extension", 20, true);
    } else if (kind === "links") row.url = url(data.url);
    else {
      for (const key of detailFields.addresses)
        row[key] = data[key] === undefined ? "" : text(data[key], key, 1024, true);
      row.country_code = String(row.country_code).toUpperCase();
      if (row.country_code && !/^[A-Z]{2}$/.test(row.country_code)) invalid("country_code");
      if (!detailFields.addresses.some((key) => row[key])) invalid("addresses");
    }
    return row;
  });
  if (result.filter((row) => row.is_primary).length > 1) invalid("is_primary");
  if (result.length && !result.some((row) => row.is_primary)) result[0]!.is_primary = 1;
  return result.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}
export const valueTypes = [
  "text",
  "number",
  "boolean",
  "date",
  "url",
  "select",
  "multiselect",
] as const;
export function fieldValue(value: unknown, definition: FieldDefinition) {
  const options = JSON.parse(definition.options_json) as string[];
  switch (definition.value_type) {
    case "text":
      return text(value, definition.key, 10000, true);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) invalid(definition.key);
      return value;
    case "boolean":
      if (typeof value !== "boolean") invalid(definition.key);
      return value;
    case "date":
      return date(value, definition.key);
    case "url":
      return url(value);
    case "select":
      if (typeof value !== "string" || !options.includes(value)) invalid(definition.key);
      return value;
    case "multiselect": {
      const result = array(value, definition.key, 100).map((entry) => text(entry, definition.key));
      if (
        new Set(result).size !== result.length ||
        result.some((entry) => !options.includes(entry))
      )
        invalid(definition.key);
      return result;
    }
  }
}

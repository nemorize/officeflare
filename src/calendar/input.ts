import { t } from "../../shared/i18n/index.ts";
import { HTTPException } from "hono/http-exception";
import type { CalendarContext } from "./types";
export function fail(
  status: 400 | 403 | 404 | 409 | 410 | 412 | 422 | 428 | 429,
  code: string,
  message: string,
): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: message, code }, { status }),
  });
}
export function object(value: unknown, name = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return value as Record<string, unknown>;
}
export function fields(data: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(data).find((key) => !allowed.includes(key));
  if (extra) fail(400, "INVALID_INPUT", t("calendarInput.unknownField", { extra: extra }));
}
export async function body(c: CalendarContext, allowed: readonly string[]) {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    fail(400, "INVALID_INPUT", t("calendarInput.invalidJsonBody"));
  }
  const data = object(value);
  fields(data, allowed);
  return data;
}
export function text(value: unknown, name: string, max: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /\u0000/.test(value)
  )
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return value;
}
export const identifier = (value: unknown, name = "id") => {
  const result = text(value, name, 255);
  if (!/^[A-Za-z0-9_-]+$/.test(result))
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return result;
};
export function integer(
  value: unknown,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return value;
}
export function choice<T extends string>(value: unknown, name: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return value as T;
}
export function flag(value: unknown, name: string) {
  if (typeof value !== "boolean")
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return +value;
}
export function color(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
    fail(400, "INVALID_INPUT", t("calendarInput.invalidColor"));
  return value.toLowerCase();
}
export function jsonObject(value: unknown, name: string, max = 8192) {
  const result = object(value, name);
  if (JSON.stringify(result).length > max)
    fail(400, "INVALID_INPUT", t("calendarInput.isTooLarge", { name: name }));
  return result;
}
export function expectedVersion(c: CalendarContext, data?: Record<string, unknown>) {
  const raw = data && Object.hasOwn(data, "version") ? data.version : c.req.query("version"),
    header = c.req.header("If-Match");
  const fromBody =
    raw === undefined
      ? undefined
      : integer(typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw, "version", 1);
  const match = header?.match(/^"v([1-9][0-9]*)"$/);
  if (header && !match) fail(400, "INVALID_INPUT", t("calendarInput.invalidIfMatch"));
  const fromHeader = match ? integer(Number(match[1]), t("calendarInput.ifMatch"), 1) : undefined;
  if (fromBody !== undefined && fromHeader !== undefined && fromBody !== fromHeader)
    fail(400, "INVALID_INPUT", t("calendarInput.versionAndIfMatchDisagree"));
  const version = fromBody ?? fromHeader;
  if (version === undefined)
    fail(428, "VERSION_REQUIRED", t("calendarInput.aVersionOrIfMatchIsRequired"));
  return version;
}
export function pageLimit(c: CalendarContext, query?: URLSearchParams) {
  return integer(
    Number((query ? query.get("limit") : c.req.query("limit")) ?? 100),
    "limit",
    1,
    500,
  );
}
export function queryFlag(
  c: CalendarContext,
  name: string,
  fallback = false,
  query?: URLSearchParams,
) {
  const value = query ? (query.get(name) ?? undefined) : c.req.query(name);
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false")
    fail(400, "INVALID_INPUT", t("calendarInput.invalid", { name: name }));
  return value === "true";
}

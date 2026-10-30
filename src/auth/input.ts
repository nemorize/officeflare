import { t } from "../../shared/i18n/index.ts";
import { HTTPException } from "hono/http-exception";
import type { AuthContext } from "./types";

export function invalid(message = t("authInput.invalidRequest")): never {
  throw new HTTPException(400, { message });
}
export function unauthorized(): never {
  throw new HTTPException(401, {
    message: t("authInput.invalidCredentialsOrToken"),
    res: new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
  });
}
export function conflict(message: string): never {
  throw new HTTPException(409, { message });
}
export async function body(c: AuthContext, allowed: readonly string[]) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
    throw new HTTPException(415, { message: t("authInput.expectedApplicationJson") });
  }
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    invalid(t("authInput.invalidJson"));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !allowed.includes(key))) invalid(t("authInput.unknownField"));
  return data;
}
export function string(value: unknown, key: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    invalid(t("authInput.invalid", { key: key }));
  return value;
}
export function password(value: unknown, fresh = false): string {
  const result = string(value, fresh ? "new_password" : "password", 256);
  const length = [...result].length;
  if (fresh && (length < 15 || length > 128))
    invalid(t("authInput.passwordMustContain15To128Characters"));
  if (new TextEncoder().encode(result).length > 512) invalid(t("authInput.passwordIsTooLong"));
  return result;
}
export function bearer(c: AuthContext): string {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(header);
  if (!match || match[1]!.length > 4096) unauthorized();
  return match[1]!;
}

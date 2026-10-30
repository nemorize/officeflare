import { t } from "../../shared/i18n/index.ts";
import type { CalendarEnv } from "./types";
import { fail } from "./input";
import { now } from "../auth/types";
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
const encoder = new TextEncoder();
const key = (env: CalendarEnv) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(`officeflare:calendar:cursor:${env.AUTH_SIGNING_KEYS}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export async function cursor(
  env: CalendarEnv,
  user: string,
  scope: string,
  position: string | number,
) {
  const payload = encode(encoder.encode(JSON.stringify([user, scope, position, now() + 86400])));
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload))))}`;
}
export async function readCursor(
  env: CalendarEnv,
  user: string,
  scope: string,
  token: string,
): Promise<string | number> {
  try {
    if (token.length > 8192) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !(await crypto.subtle.verify(
        "HMAC",
        await key(env),
        decode(signature),
        encoder.encode(payload),
      ))
    )
      throw new Error();
    const value = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== user ||
      value[1] !== scope ||
      typeof value[3] !== "number" ||
      value[3] <= now() ||
      !(
        typeof value[2] === "string" ||
        (typeof value[2] === "number" && Number.isSafeInteger(value[2]) && value[2] >= 0)
      )
    )
      throw new Error();
    return value[2] as string | number;
  } catch {
    fail(400, "INVALID_CURSOR", t("calendarCursor.invalidCalendarCursor"));
  }
}

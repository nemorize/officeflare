import { t } from "../../shared/i18n/index.ts";
import { invalid } from "../auth/input";
import type { AuthEnv } from "../auth/types";

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
async function key(env: AuthEnv) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`officeflare:notifications:cursor:${env.AUTH_SIGNING_KEYS}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function cursor(env: AuthEnv, userId: string, scope: string, value: number) {
  const payload = base64(encoder.encode(JSON.stringify([userId, scope, value])));
  return `${payload}.${base64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload))))}`;
}
export async function readCursor(env: AuthEnv, userId: string, scope: string, value: string) {
  try {
    if (value.length > 1024) throw new Error();
    const [payload, signature, extra] = value.split(".");
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
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      !Array.isArray(data) ||
      data.length !== 3 ||
      data[0] !== userId ||
      data[1] !== scope ||
      !Number.isSafeInteger(data[2]) ||
      data[2] < 0
    )
      throw new Error();
    return data[2] as number;
  } catch {
    invalid(t("notificationsCursor.invalidOrExpiredCursor"));
  }
}

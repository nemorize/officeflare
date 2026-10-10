import type { DriveEnv } from "./types";
import { invalid } from "../auth/input";
const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decode = (data: string) => Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
const encoder = new TextEncoder();
const key = (env: DriveEnv) => crypto.subtle.importKey("raw", encoder.encode(`officeflare:drive:cursor:${env.AUTH_SIGNING_KEYS}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
export async function cursor(env: DriveEnv, user: string, scope: string, position: [number, string]) {
  const payload = encode(encoder.encode(JSON.stringify([user, scope, position])));
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload))))}`;
}
export async function readCursor(env: DriveEnv, user: string, scope: string, token: string): Promise<[number, string]> {
  try {
    if (token.length > 2048) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !await crypto.subtle.verify("HMAC", await key(env), decode(signature), encoder.encode(payload))) throw new Error();
    const value = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== user || value[1] !== scope || !Array.isArray(value[2]) || value[2].length !== 2
      || !Number.isSafeInteger(value[2][0]) || value[2][0] < 0 || typeof value[2][1] !== "string" || value[2][1].length > 128) throw new Error();
    return [value[2][0], value[2][1]];
  } catch { invalid("Invalid Drive cursor"); }
}

import { t } from "../../shared/i18n/index.ts";
import { epoch, fail, type MailActor } from "./types";

export interface MailImageGrant {
  actor: MailActor;
  bodyKey: string;
  sessionId: string | null;
  part: "body" | "quoted";
  expires: number;
}
const keys = new Map<string, Promise<CryptoKey>>();
function signingKey(env: Env) {
  const secret = env.AUTH_SIGNING_KEYS;
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("officeflare:mail-images:v1\n" + secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
    if (keys.size > 4) keys.delete(keys.keys().next().value!);
  }
  return key;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
export async function signMailImageGrant(
  env: Env,
  scope: string,
  grant: Omit<MailImageGrant, "expires">,
) {
  // Stable within five-minute windows so revisiting a message reuses image URLs.
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({ ...grant, expires: (Math.floor(epoch() / 300) + 3) * 300 }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    new TextEncoder().encode(scope + "\n" + payload),
  );
  return payload + "." + encode(new Uint8Array(signature));
}
export async function verifyMailImageGrant(
  env: Env,
  scope: string,
  token: string,
): Promise<MailImageGrant> {
  try {
    if (token.length > 2048 || !/^[\w-]+\.[\w-]{43}$/.test(token)) throw new Error();
    const [payload, signature] = token.split(".");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(env),
        decode(signature!) as Uint8Array<ArrayBuffer>,
        new TextEncoder().encode(scope + "\n" + payload),
      ))
    )
      throw new Error();
    const grant = JSON.parse(new TextDecoder().decode(decode(payload!))) as MailImageGrant;
    if (
      !Number.isSafeInteger(grant.expires) ||
      grant.expires <= epoch() ||
      grant.expires > epoch() + 900 ||
      !grant.bodyKey ||
      !grant.actor?.user_id ||
      !Number.isSafeInteger(grant.actor.auth_version) ||
      !(grant.sessionId || grant.actor.api_key_id) ||
      !["body", "quoted"].includes(grant.part)
    )
      throw new Error();
    return grant;
  } catch {
    fail(401, t("mailControl.invalidMailApiKey"));
  }
}

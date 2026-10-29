import { Buffer } from "node:buffer";
import type { CalendarEnv } from "./types";
interface Envelope {
  calendar_secret: 1;
  version: number;
  nonce: string;
  ciphertext: string;
}
async function encryptionKey(env: CalendarEnv, version?: number) {
  const ring = JSON.parse(env.MFA_ENCRYPTION_KEYS) as {
    active_version: number;
    keys: Record<string, string>;
  };
  const selected = version ?? ring.active_version,
    value = ring.keys[selected];
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error("Invalid calendar encryption key");
  return {
    version: selected,
    key: await crypto.subtle.importKey("raw", Buffer.from(value, "base64url"), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
  };
}
const aad = (purpose: string) => new TextEncoder().encode(`officeflare:calendar:${purpose}`);
export async function seal(env: CalendarEnv, purpose: string, value: unknown): Promise<Envelope> {
  const { key, version } = await encryptionKey(env),
    nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(purpose) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    calendar_secret: 1,
    version,
    nonce: Buffer.from(nonce).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}
export async function unseal<T>(env: CalendarEnv, purpose: string, value: Envelope): Promise<T> {
  const { key } = await encryptionKey(env, value.version);
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(value.nonce, "base64url"),
      additionalData: aad(purpose),
    },
    key,
    Buffer.from(value.ciphertext, "base64url"),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
export async function receipt<T>(env: CalendarEnv, purpose: string, json: string): Promise<T> {
  const value = JSON.parse(json);
  return value?.calendar_secret === 1 ? unseal<T>(env, purpose, value) : (value as T);
}

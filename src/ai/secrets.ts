import { Buffer } from "node:buffer";
import { fail } from "./errors";
import type { AIEnv } from "./types";
interface Envelope {
  version: number;
  nonce: string;
  ciphertext: string;
}
async function encryptionKey(env: AIEnv, version?: number) {
  let ring: { active_version: number; keys: Record<string, string> };
  try {
    ring = JSON.parse(env.AI_ENCRYPTION_KEYS ?? "");
  } catch {
    fail(503, "AI_ENCRYPTION_REQUIRED");
  }
  const selected = version ?? ring.active_version;
  const raw = ring.keys?.[selected];
  if (!Number.isSafeInteger(selected) || selected < 1 || !raw || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    fail(503, "AI_ENCRYPTION_REQUIRED");
  return {
    version: selected,
    key: await crypto.subtle.importKey("raw", Buffer.from(raw, "base64url"), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
  };
}
const aad = (env: AIEnv, purpose: string) =>
  new TextEncoder().encode(JSON.stringify(["officeflare:ai", env.AUTH_ISSUER, purpose]));
export async function seal(env: AIEnv, purpose: string, value: unknown): Promise<string> {
  const { key, version } = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(env, purpose) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    version,
    nonce: Buffer.from(nonce).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  });
}
export async function unseal<T>(env: AIEnv, purpose: string, json: string): Promise<T> {
  try {
    const envelope = JSON.parse(json) as Envelope;
    const { key } = await encryptionKey(env, envelope.version);
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(envelope.nonce, "base64url"),
        additionalData: aad(env, purpose),
      },
      key,
      Buffer.from(envelope.ciphertext, "base64url"),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    fail(503, "AI_ENCRYPTION_REQUIRED");
  }
}

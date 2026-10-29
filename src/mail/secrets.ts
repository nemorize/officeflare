import { fail } from "./types";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function key(env: Env) {
  if (!env.MAIL_ENCRYPTION_KEY) fail(503, "MAIL_ENCRYPTION_KEY must be configured for webhooks");
  let bytes: Uint8Array;
  try {
    bytes = decode(env.MAIL_ENCRYPTION_KEY);
  } catch {
    fail(503, "Invalid mail encryption key");
  }
  if (bytes.length !== 32) fail(503, "Invalid mail encryption key");
  return crypto.subtle.importKey("raw", bytes as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(env: Env, secret: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await key(env),
    new TextEncoder().encode(secret),
  );
  return {
    ciphertext: encode(new Uint8Array(encrypted)),
    nonce: encode(nonce),
  };
}
export async function unseal(env: Env, ciphertext: string, nonce: string) {
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(nonce) as Uint8Array<ArrayBuffer> },
      await key(env),
      decode(ciphertext) as Uint8Array<ArrayBuffer>,
    ),
  );
}

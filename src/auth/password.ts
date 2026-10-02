import { scrypt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// Shared by the Worker and deployment bootstrap so stored hashes use the same format.
// OWASP's 16 MiB scrypt profile; bound memory and CPU on both hash and verify.
const COST = { N: 16384, r: 8, p: 5, maxmem: 24 * 1024 * 1024 };
const derive = (password: string, salt: Uint8Array) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 32, COST, (error, value) => error ? reject(error) : resolve(value));
});
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `scrypt$16384$8$5$${Buffer.from(salt).toString("base64url")}$${(await derive(password, salt)).toString("base64url")}`;
}
export async function verifyPassword(password: string, encoded: string | null) {
  const parts = encoded?.split("$");
  const valid = parts?.length === 6 && parts.slice(0, 4).join("$") === "scrypt$16384$8$5" &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[4]!) && /^[A-Za-z0-9_-]{43}$/.test(parts[5]!);
  // The missing-account path performs the same expensive derivation.
  const salt = valid ? Buffer.from(parts![4]!, "base64url") : Buffer.alloc(16);
  const expected = valid ? Buffer.from(parts![5]!, "base64url") : Buffer.alloc(32);
  const actual = await derive(password, salt);
  const equal = expected.length === actual.length && timingSafeEqual(actual, expected);
  return !!valid && equal;
}

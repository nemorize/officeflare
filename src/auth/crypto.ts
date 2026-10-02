import { timingSafeEqual, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { importJWK, SignJWT, jwtVerify, type JWK } from "jose";
import { ACCESS_TTL, now, type AuthEnv, type Session } from "./types";
import { unauthorized } from "./input";
export { hashPassword, verifyPassword } from "./password";

export const random = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
export const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
interface SigningRing { active_kid: string; keys: JWK[] }
function signingRing(env: AuthEnv): SigningRing {
  const ring = JSON.parse(env.AUTH_SIGNING_KEYS) as SigningRing;
  if (!ring.active_kid || !Array.isArray(ring.keys) || ring.keys.length === 0 ||
      new Set(ring.keys.map((k) => k.kid)).size !== ring.keys.length ||
      ring.keys.some((k) => !k.kid || k.kty !== "EC" || k.crv !== "P-256")) throw new Error("Invalid signing key ring");
  return ring;
}
export async function signAccess(env: AuthEnv, session: Session) {
  const ring = signingRing(env);
  const jwk = ring.keys.find((key) => key.kid === ring.active_kid);
  if (!jwk?.d) throw new Error("Active JWT private key is missing");
  const key = await importJWK({ ...jwk, alg: "ES256", key_ops: undefined }, "ES256");
  const timestamp = now();
  return new SignJWT({ sid: session.id, ver: session.auth_version })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: ring.active_kid })
    .setIssuer(env.AUTH_ISSUER).setAudience(env.AUTH_AUDIENCE).setSubject(session.user_id)
    .setJti(crypto.randomUUID()).setIssuedAt(timestamp)
    .setExpirationTime(Math.min(timestamp + ACCESS_TTL, session.expires_at)).sign(key);
}
export async function verifyAccess(env: AuthEnv, token: string) {
  const ring = signingRing(env);
  try {
    const { payload } = await jwtVerify(token, async (header) => {
      const jwk = ring.keys.find((key) => key.kid === header.kid);
      if (!jwk) throw new Error("Unknown key");
      const { d: _private, ...publicKey } = jwk;
      return importJWK({ ...publicKey, alg: "ES256", key_ops: undefined }, "ES256");
    }, { algorithms: ["ES256"], typ: "at+jwt", issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE, requiredClaims: ["sub", "sid", "ver", "iat", "exp", "jti"] });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string" ||
        !Number.isSafeInteger(payload.ver) || typeof payload.iat !== "number" || payload.iat > now() + 5) unauthorized();
    return { userId: payload.sub, sessionId: payload.sid, version: payload.ver as number };
  } catch { unauthorized(); }
}
interface EncryptionRing { active_version: number; keys: Record<string, string> }
async function encryptionKey(env: AuthEnv, version?: number) {
  const ring = JSON.parse(env.MFA_ENCRYPTION_KEYS) as EncryptionRing;
  const selected = version ?? ring.active_version;
  const value = ring.keys?.[selected];
  if (!Number.isSafeInteger(selected) || selected < 1 || !value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid MFA encryption key ring");
  return { version: selected, key: await crypto.subtle.importKey("raw", Buffer.from(value, "base64url"), "AES-GCM", false, ["encrypt", "decrypt"]) };
}
// Associated data prevents moving a ciphertext to another user or method.
const aad = (userId: string, methodId: string) => new TextEncoder().encode(JSON.stringify(["totp", userId, methodId]));
export async function encryptTotp(env: AuthEnv, userId: string, methodId: string, secret: Uint8Array) {
  const { key, version } = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(userId, methodId) }, key, secret);
  return { version, nonce, ciphertext };
}
export async function decryptTotp(env: AuthEnv, userId: string, methodId: string, version: number, nonce: Uint8Array, ciphertext: Uint8Array) {
  const { key } = await encryptionKey(env, version);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: aad(userId, methodId) }, key, new Uint8Array(ciphertext)));
}
export function base32(bytes: Uint8Array) {
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(value << (5 - bits)) & 31];
  return output;
}
export function totpStep(secret: Uint8Array, code: string, algorithm: string, digits: number, period: number, timestamp = now()) {
  if (!new RegExp(`^[0-9]{${digits}}$`).test(code)) return null;
  const current = Math.floor(timestamp / period);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0) continue;
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
    const hash = createHmac(algorithm.toLowerCase(), secret).update(counter).digest();
    const offset = hash[hash.length - 1]! & 15;
    const expected = String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

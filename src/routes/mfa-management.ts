import { Hono } from "hono";
import { base32, digest, encryptTotp } from "../auth/crypto";
import { body, conflict, string, unauthorized } from "../auth/input";
import { loadTotp, matchTotp } from "../auth/mfa";
import { claim, getGrant, hasMfa, invalidateCredentials, prepareSession, requireAccess, throttle, won } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";
import { Buffer } from "node:buffer";

const mfa = new Hono<AppEnv>();
mfa.get("/methods", requireAccess, async (c) => {
  const timestamp = now();
  const result = await c.get("db").prepare(`SELECT id, type, name, created_at, verified_at, last_used_at, setup_expires_at
    FROM user_mfa_methods WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`)
    .bind(c.get("identity").user.id).all<{ verified_at: number | null; setup_expires_at: number | null }>();
  return c.json({ methods: result.results.map((method) => ({ ...method,
    status: method.verified_at !== null ? "active" : (method.setup_expires_at ?? 0) > timestamp ? "pending" : "expired" })) });
});

mfa.post("/totp", async (c) => {
  const data = await body(c, ["name"]), grant = await getGrant(c);
  const name = data.name === undefined ? null : string(data.name, "name", 100).trim();
  if (name === "") conflict("Method name cannot be empty");
  await throttle(c, "mfa-setup", grant.user_id);
  const id = uuid(), operation = uuid(), timestamp = now();
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const encrypted = await encryptTotp(c.env, grant.user_id, id, secret);
  const user = await c.get("db").prepare("SELECT email_address FROM users WHERE id = ?").bind(grant.user_id).first<{ email_address: string }>();
  if (!user) unauthorized();
  const results = await c.get("db").batch([
    claim(c, grant, operation),
    c.get("db").prepare(`INSERT INTO user_mfa_methods(id, user_id, type, name, created_at, setup_expires_at)
      SELECT ?, ?, 'totp', ?, ?, ? WHERE ${won}
      AND (SELECT COUNT(*) FROM user_mfa_methods WHERE user_id = ? AND revoked_at IS NULL
        AND (verified_at IS NOT NULL OR setup_expires_at > ?)) < 5`)
      .bind(id, grant.user_id, name, timestamp, timestamp + 600, operation, grant.user_id, timestamp),
    c.get("db").prepare(`INSERT INTO user_mfa_totp(method_id, secret_ciphertext, secret_nonce, key_version)
      SELECT id, ?, ?, ? FROM user_mfa_methods WHERE id = ?`)
      .bind(encrypted.ciphertext, Array.from(encrypted.nonce), encrypted.version, id),
  ]);
  if (results[0]!.meta.changes !== 1) unauthorized();
  if (results[1]!.meta.changes !== 1) conflict("At most five active or pending methods are allowed");
  const uri = `otpauth://totp/${encodeURIComponent(`Officeflare:${user.email_address}`)}?${new URLSearchParams({
    secret: base32(secret), issuer: "Officeflare", algorithm: "SHA1", digits: "6", period: "30",
  })}`;
  return c.json({ method_id: id, provisioning_uri: uri, setup_expires_at: timestamp + 600 }, 201);
});

mfa.post("/totp/:id/verify", async (c) => {
  const data = await body(c, ["code"]), grant = await getGrant(c), timestamp = now();
  await throttle(c, "mfa-setup", grant.user_id);
  const attempt = await c.get("db").prepare(`UPDATE user_auth_challenges SET attempts = attempts + 1
    WHERE id = ? AND used_at IS NULL AND attempts < 5 AND expires_at > ? RETURNING id`).bind(grant.id, timestamp).first();
  if (!attempt) unauthorized();
  const method = await loadTotp(c, grant.user_id, c.req.param("id"));
  if (!method || method.verified_at !== null || (method.setup_expires_at ?? 0) <= timestamp) unauthorized();
  const step = await matchTotp(c, method, string(data.code, "code", 8));
  if (step === null) unauthorized();
  const operation = uuid(), version = grant.auth_version + 1;
  const pair = await prepareSession(c, { ...grant, mfa_authenticated_at: timestamp }, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await c.get("db").batch([
    claim(c, grant, operation),
    c.get("db").prepare(`UPDATE user_mfa_totp SET last_accepted_step = ? WHERE method_id = ?
      AND (last_accepted_step IS NULL OR last_accepted_step < ?) AND ${won}
      AND EXISTS (SELECT 1 FROM user_mfa_methods WHERE id = ? AND user_id = ? AND verified_at IS NULL
        AND revoked_at IS NULL AND setup_expires_at > ?)`)
      .bind(step, method.id, step, operation, method.id, grant.user_id, timestamp),
    c.get("db").prepare("UPDATE user_mfa_methods SET verified_at = ?, last_used_at = ? WHERE id = ? AND changes() = 1")
      .bind(timestamp, timestamp, method.id),
    c.get("db").prepare(`UPDATE users SET auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND auth_version = ? AND changes() = 1`).bind(timestamp, grant.user_id, grant.auth_version),
    ...invalidations, ...pair.statements(operation),
  ]);
  if (results[3]!.meta.changes !== 1 || results[4 + invalidations.length]!.meta.changes !== 1) unauthorized();
  return c.json({ ...pair.response, method_id: method.id });
});

mfa.delete("/methods/:id", async (c) => {
  const grant = await getGrant(c), timestamp = now(), operation = uuid(), version = grant.auth_version + 1;
  await throttle(c, "mfa-change", grant.user_id);
  const pair = await prepareSession(c, grant, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await c.get("db").batch([
    claim(c, grant, operation),
    c.get("db").prepare(`UPDATE user_mfa_methods SET revoked_at = ? WHERE id = ? AND user_id = ?
      AND revoked_at IS NULL AND ${won}`).bind(timestamp, c.req.param("id"), grant.user_id, operation),
    c.get("db").prepare("UPDATE users SET auth_version = auth_version + 1, updated_at = ? WHERE id = ? AND auth_version = ? AND changes() = 1")
      .bind(timestamp, grant.user_id, grant.auth_version),
    c.get("db").prepare(`UPDATE user_mfa_recovery_codes SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND ${won} AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ?)
      AND NOT EXISTS (SELECT 1 FROM user_mfa_methods WHERE user_id = ? AND verified_at IS NOT NULL AND revoked_at IS NULL)`)
      .bind(timestamp, grant.user_id, operation, grant.user_id, version, grant.user_id),
    ...invalidations, ...pair.statements(operation),
  ]);
  if (results[2]!.meta.changes !== 1 || results[4 + invalidations.length]!.meta.changes !== 1) unauthorized();
  return c.json(pair.response);
});

mfa.get("/recovery-codes", requireAccess, async (c) => {
  const result = await c.get("db").prepare(`SELECT COUNT(*) AS remaining FROM user_mfa_recovery_codes
    WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`).bind(c.get("identity").user.id).first<{ remaining: number }>();
  return c.json({ remaining: result!.remaining });
});
mfa.post("/recovery-codes", async (c) => {
  const grant = await getGrant(c);
  await throttle(c, "mfa-change", grant.user_id);
  if (!await hasMfa(c, grant.user_id)) conflict("Enable MFA before generating recovery codes");
  const timestamp = now(), operation = uuid(), version = grant.auth_version + 1;
  const codes = Array.from({ length: 10 }, () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"));
  const hashes = await Promise.all(codes.map(digest));
  const pair = await prepareSession(c, grant, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const results = await c.get("db").batch([
    claim(c, grant, operation),
    c.get("db").prepare(`UPDATE users SET auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND auth_version = ? AND ${won}`).bind(timestamp, grant.user_id, grant.auth_version, operation),
    c.get("db").prepare(`UPDATE user_mfa_recovery_codes SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND ${won}`).bind(timestamp, grant.user_id, operation),
    ...hashes.map((hash) => c.get("db").prepare(`INSERT INTO user_mfa_recovery_codes(id, user_id, code_hash, created_at)
      SELECT ?, ?, ?, ? WHERE ${won}`).bind(uuid(), grant.user_id, hash, timestamp, operation)),
    ...invalidations, ...pair.statements(operation),
  ]);
  if (results[1]!.meta.changes !== 1 || results[3 + hashes.length + invalidations.length]!.meta.changes !== 1) unauthorized();
  return c.json({ ...pair.response, recovery_codes: codes.map((code) => code.match(/.{8}/g)!.join("-")) }, 201);
});
export default mfa;

import { Hono } from "hono";
import { bearer, body, password, string, unauthorized } from "../auth/input";
import { digest, random, signAccess, verifyPassword } from "../auth/crypto";
import { countAttempt, verifyFactor } from "../auth/mfa";
import { activeMfaSql, completeLogin, eligibleUserSql, getChallenge, hasMfa, makeChallenge, requireAccess, throttle } from "../auth/store";
import { ACCESS_TTL, now, uuid, type AppEnv, type Session, type User } from "../auth/types";

const auth = new Hono<AppEnv>();
auth.post("/login", async (c) => {
  const data = await body(c, ["email_address", "password"]);
  const email = string(data.email_address, "email_address", 254).trim().toLowerCase();
  const supplied = password(data.password);
  await throttle(c, "login", email);
  const user = await c.get("db").prepare("SELECT * FROM users WHERE email_address = ? COLLATE NOCASE AND deleted_at IS NULL")
    .bind(email).first<User>();
  const correct = await verifyPassword(supplied, user?.password_hash ?? null);
  if (!correct || !user || user.disabled_at !== null) unauthorized();
  const mfa = await hasMfa(c, user.id);
  const { token, challenge } = await makeChallenge(c, user, mfa ? "login_mfa" : "login");
  if (mfa) return c.json({ next: "mfa", token_type: "Bearer", challenge_token: token, expires_at: challenge.expires_at, methods: await methods(c, user.id) });
  return completeLogin(c, challenge, token);
});

async function methods(c: Parameters<typeof hasMfa>[0], userId: string) {
  const rows = await c.get("db").prepare("SELECT id, type, name FROM user_mfa_methods WHERE user_id = ? AND verified_at IS NOT NULL AND revoked_at IS NULL")
    .bind(userId).all();
  return rows.results;
}
for (const recovery of [false, true]) {
  auth.post(recovery ? "/mfa/recovery" : "/mfa/verify", async (c) => {
    const data = await body(c, recovery ? ["recovery_code"] : ["method_id", "code"]);
    const challenge = await getChallenge(c, ["login_mfa", "reauth_mfa"]);
    await throttle(c, "mfa", challenge.user_id);
    await countAttempt(c, challenge);
    const verified = await verifyFactor(c, challenge, recovery
      ? { recoveryCode: string(data.recovery_code, "recovery_code", 64) }
      : { methodId: string(data.method_id, "method_id", 128), code: string(data.code, "code", 8) });
    if (verified.purpose === "reauth") return c.json({ token_type: "Bearer", reauthentication_token: bearer(c), expires_at: verified.expires_at });
    return completeLogin(c, verified, bearer(c));
  });
}

auth.post("/reauthenticate", requireAccess, async (c) => {
  const data = await body(c, ["password"]), { user, session } = c.get("identity");
  await throttle(c, "reauth", user.id);
  if (!await verifyPassword(password(data.password), user.password_hash)) unauthorized();
  const mfa = await hasMfa(c, user.id);
  const { token, challenge } = await makeChallenge(c, user, mfa ? "reauth_mfa" : "reauth", session);
  if (mfa) return c.json({ next: "mfa", token_type: "Bearer", challenge_token: token, expires_at: challenge.expires_at, methods: await methods(c, user.id) });
  return c.json({ token_type: "Bearer", reauthentication_token: token, expires_at: challenge.expires_at });
});

auth.post("/refresh", async (c) => {
  await throttle(c, "refresh");
  const token = bearer(c);
  if (!/^ofr_[A-Za-z0-9_-]{43}$/.test(token)) unauthorized();
  const hash = await digest(token), timestamp = now();
  const session = await c.get("db").prepare(`SELECT s.* FROM user_refresh_tokens t JOIN user_sessions s ON s.id = t.session_id
    WHERE t.token_hash = ?`).bind(hash).first<Session>();
  if (!session) unauthorized();
  const refresh = `ofr_${random()}`, operation = uuid();
  const access = await signAccess(c.env, session);
  const results = await c.get("db").batch([
    // Strict replay detection: concurrent refreshes must be serialized by the client.
    c.get("db").prepare(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND EXISTS (SELECT 1 FROM user_refresh_tokens WHERE token_hash = ? AND used_at IS NOT NULL)`)
      .bind(timestamp, session.id, hash),
    c.get("db").prepare(`UPDATE user_refresh_tokens SET used_at = ?, used_by = ? WHERE token_hash = ?
      AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = session_id AND s.revoked_at IS NULL AND s.expires_at > ?
        AND s.auth_version = u.auth_version AND u.password_reset_required = 0 AND ${eligibleUserSql}
        AND (NOT ${activeMfaSql} OR s.mfa_authenticated_at IS NOT NULL))`)
      .bind(timestamp, operation, hash, timestamp, timestamp),
    c.get("db").prepare(`INSERT INTO user_refresh_tokens(id, session_id, token_hash, parent_id, created_at, expires_at)
      SELECT ?, session_id, ?, id, ?, expires_at FROM user_refresh_tokens WHERE used_by = ?`)
      .bind(uuid(), await digest(refresh), timestamp, operation),
    c.get("db").prepare(`UPDATE user_sessions SET last_used_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM user_refresh_tokens WHERE used_by = ?)`)
      .bind(timestamp, session.id, operation),
  ]);
  if (results[1]!.meta.changes !== 1) unauthorized();
  return c.json({ token_type: "Bearer", access_token: access, expires_in: Math.min(ACCESS_TTL, session.expires_at - timestamp),
    refresh_token: refresh, refresh_expires_at: session.expires_at, session_id: session.id });
});

auth.post("/logout", requireAccess, async (c) => {
  const { session } = c.get("identity");
  await c.get("db").prepare("UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(now(), session.id).run();
  return c.body(null, 204);
});

export default auth;

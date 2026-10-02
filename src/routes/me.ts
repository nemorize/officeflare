import { Hono } from "hono";
import { body, password, unauthorized } from "../auth/input";
import { hashPassword } from "../auth/crypto";
import { accessClaim, accessWon, claim, getGrant, invalidateCredentials, prepareSession, publicUser, requireAccess, throttle, won } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";
import profile from "./profile";
import mfaManagement from "./mfa-management";

const me = new Hono<AppEnv>();
me.get("/", requireAccess, (c) => c.json({ user: publicUser(c.get("identity").user) }));

// A password-reset or one-use reauthentication grant is the Bearer token here.
me.put("/password", async (c) => {
  const data = await body(c, ["new_password"]), nextPassword = password(data.new_password, true);
  const grant = await getGrant(c, true);
  await throttle(c, "password", grant.user_id);
  const timestamp = now(), version = grant.auth_version + 1, operation = uuid();
  const hash = await hashPassword(nextPassword);
  const pair = await prepareSession(c, { ...grant, password_authenticated_at: timestamp }, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const result = await c.get("db").batch([
    claim(c, grant, operation),
    c.get("db").prepare(`UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?,
      password_reset_required = 0, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ? AND ${won}`)
      .bind(hash, timestamp, timestamp, grant.user_id, grant.auth_version, operation),
    ...invalidations, ...pair.statements(operation),
    ...(grant.purpose === "password_reset" ? [c.get("db").prepare(`UPDATE users SET last_login_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM user_sessions WHERE id = ?)`).bind(timestamp, grant.user_id, pair.session.id)] : []),
  ]);
  if (result[1]!.meta.changes !== 1 || result[2 + invalidations.length]!.meta.changes !== 1) unauthorized();
  return c.json(pair.response);
});

me.get("/sessions", requireAccess, async (c) => {
  const { user, session } = c.get("identity");
  const rows = await c.get("db").prepare(`SELECT id, created_at, password_authenticated_at, mfa_authenticated_at,
    last_used_at, expires_at, user_agent FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL
    AND expires_at > ? AND auth_version = ? ORDER BY created_at DESC LIMIT 100`)
    .bind(user.id, now(), user.auth_version).all();
  return c.json({ sessions: rows.results.map((row) => ({ ...row, current: row.id === session.id })) });
});
me.delete("/sessions/:id", requireAccess, async (c) => {
  const { user, session } = c.get("identity"), operation = uuid();
  const result = await c.get("db").batch([
    accessClaim(c, operation),
    c.get("db").prepare(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND user_id = ? AND ${accessWon}`).bind(now(), c.req.param("id"), user.id, session.id, operation),
  ]);
  if (result[0]!.meta.changes !== 1) unauthorized();
  return c.body(null, 204);
});
me.delete("/sessions", requireAccess, async (c) => {
  const { user, session } = c.get("identity"), timestamp = now(), operation = uuid();
  const result = await c.get("db").batch([
    accessClaim(c, operation),
    c.get("db").prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${accessWon}`).bind(user.id, session.id, operation),
    c.get("db").prepare(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND ${accessWon}`).bind(timestamp, user.id, session.id, operation),
    c.get("db").prepare(`UPDATE user_auth_challenges SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND ${accessWon}`).bind(timestamp, user.id, session.id, operation),
  ]);
  if (result[0]!.meta.changes !== 1) unauthorized();
  return c.body(null, 204);
});
me.route("/", profile);
me.route("/mfa", mfaManagement);
export default me;

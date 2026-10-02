import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { bearer, unauthorized } from "./input";
import { digest, random, signAccess, verifyAccess } from "./crypto";
import { ACCESS_TTL, CHALLENGE_TTL, SESSION_TTL, now, uuid, type AppEnv, type AuthContext, type Challenge, type Session, type User } from "./types";

export const activeMfaSql = "EXISTS (SELECT 1 FROM user_mfa_methods m WHERE m.user_id = u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)";
export const eligibleUserSql = "u.disabled_at IS NULL AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL";
const validChallengeSql = `q.used_at IS NULL AND q.expires_at > ? AND q.attempts <= 5
  AND q.auth_version = u.auth_version AND ${eligibleUserSql}
  AND (q.session_id IS NULL OR (u.password_reset_required = 0 AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = q.session_id
    AND s.user_id = u.id AND s.auth_version = u.auth_version AND s.revoked_at IS NULL AND s.expires_at > ?)))`;

export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c);
  if (token.startsWith("ofc_") || token.startsWith("ofr_")) unauthorized();
  const claims = await verifyAccess(c.env, token);
  const timestamp = now();
  const row = await c.get("db").prepare(`SELECT u.*, s.id AS session_id,
    s.created_at AS session_created_at, s.password_authenticated_at, s.mfa_authenticated_at,
    s.last_used_at AS session_last_used_at, s.expires_at AS session_expires_at, s.user_agent
    FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.id = ?
    AND s.auth_version = ? AND u.auth_version = s.auth_version AND s.revoked_at IS NULL
    AND s.expires_at > ? AND u.password_reset_required = 0 AND ${eligibleUserSql}
    AND (NOT ${activeMfaSql} OR s.mfa_authenticated_at IS NOT NULL)`)
    .bind(claims.sessionId, claims.userId, claims.version, timestamp).first<User & {
      session_id: string; session_created_at: number; password_authenticated_at: number;
      mfa_authenticated_at: number | null; session_last_used_at: number; session_expires_at: number; user_agent: string | null;
    }>();
  if (!row) unauthorized();
  const session: Session = { id: row.session_id, user_id: row.id, auth_version: row.auth_version,
    created_at: row.session_created_at, password_authenticated_at: row.password_authenticated_at,
    mfa_authenticated_at: row.mfa_authenticated_at, last_used_at: row.session_last_used_at,
    expires_at: row.session_expires_at, revoked_at: null, user_agent: row.user_agent };
  c.set("identity", { user: row, session });
  if (row.session_last_used_at <= timestamp - 60) {
    await c.get("db").prepare("UPDATE user_sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND auth_version = ?")
      .bind(timestamp, session.id, session.auth_version).run();
  }
  await next();
});

export async function throttle(c: AuthContext, category: string, subject?: string) {
  const timestamp = now(), window = 900;
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const buckets = [{ key: `${category}:ip:${ip}`, limit: 60 }];
  if (subject) buckets.push({ key: `${category}:subject:${subject}`, limit: 10 });
  const statements = await Promise.all(buckets.map(async (bucket) => c.get("db").prepare(`
    INSERT INTO auth_rate_limits(bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`)
    .bind(await digest(`${bucket.key}:${Math.floor(timestamp / window)}`), (Math.floor(timestamp / window) + 1) * window)));
  const result = await c.get("db").batch<{ attempts: number }>(statements);
  if (result.some((row, index) => row.results[0]!.attempts > buckets[index]!.limit)) {
    c.header("Retry-After", String(window - timestamp % window));
    throw new HTTPException(429, { message: "Too many attempts" });
  }
  // Bounded cleanup; refresh/challenge history remains until its security deadline.
  await c.get("db").prepare("DELETE FROM auth_rate_limits WHERE bucket IN (SELECT bucket FROM auth_rate_limits WHERE expires_at <= ? LIMIT 100)").bind(timestamp).run();
  if (crypto.getRandomValues(new Uint8Array(1))[0]! % 32 === 0) {
    await c.get("db").batch([
      c.get("db").prepare("DELETE FROM user_auth_challenges WHERE id IN (SELECT id FROM user_auth_challenges WHERE expires_at <= ? LIMIT 100)").bind(timestamp),
      c.get("db").prepare("DELETE FROM user_sessions WHERE id IN (SELECT id FROM user_sessions WHERE expires_at <= ? LIMIT 50)").bind(timestamp),
    ]);
  }
}

export async function hasMfa(c: AuthContext, userId: string) {
  return !!await c.get("db").prepare("SELECT id FROM user_mfa_methods WHERE user_id = ? AND verified_at IS NOT NULL AND revoked_at IS NULL LIMIT 1").bind(userId).first();
}

export async function makeChallenge(c: AuthContext, user: User, purpose: Challenge["purpose"], session: Session | null = null) {
  const timestamp = now(), token = `ofc_${random()}`, id = uuid();
  const result = await c.get("db").prepare(`INSERT INTO user_auth_challenges
    (id, user_id, session_id, token_hash, purpose, auth_version, password_authenticated_at, created_at, expires_at)
    SELECT ?, u.id, ?, ?, ?, u.auth_version, ?, ?, ? FROM users u
    WHERE u.id = ? AND u.auth_version = ? AND ${eligibleUserSql}
    AND (? IS NULL OR (u.password_reset_required = 0 AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = ? AND s.user_id = u.id
      AND s.auth_version = u.auth_version AND s.revoked_at IS NULL AND s.expires_at > ?)))`)
    .bind(id, session?.id ?? null, await digest(token), purpose, timestamp, timestamp, timestamp + CHALLENGE_TTL,
      user.id, user.auth_version, session?.id ?? null, session?.id ?? null, timestamp).run();
  if (result.meta.changes !== 1) unauthorized();
  const challenge: Challenge = { id, user_id: user.id, session_id: session?.id ?? null, purpose,
    auth_version: user.auth_version, password_authenticated_at: timestamp, mfa_authenticated_at: null,
    expires_at: timestamp + CHALLENGE_TTL, attempts: 0, used_at: null, used_by: null };
  return { token, challenge };
}

export async function getChallenge(c: AuthContext, purposes: Challenge["purpose"][]) {
  const token = bearer(c);
  if (!/^ofc_[A-Za-z0-9_-]{43}$/.test(token)) unauthorized();
  const timestamp = now();
  const challenge = await c.get("db").prepare(`SELECT q.* FROM user_auth_challenges q
    JOIN users u ON u.id = q.user_id WHERE q.token_hash = ? AND ${validChallengeSql}`)
    .bind(await digest(token), timestamp, timestamp).first<Challenge>();
  if (!challenge || !purposes.includes(challenge.purpose)) unauthorized();
  return challenge;
}

export async function getGrant(c: AuthContext, allowReset = false) {
  const challenge = await getChallenge(c, allowReset ? ["reauth", "password_reset"] : ["reauth"]);
  if (challenge.mfa_authenticated_at === null && await hasMfa(c, challenge.user_id)) unauthorized();
  return challenge;
}

export function claim(c: AuthContext, challenge: Challenge, operation: string) {
  const timestamp = now();
  return c.get("db").prepare(`UPDATE user_auth_challenges AS q SET used_at = ?, used_by = ?
    WHERE q.id = ? AND q.purpose = ? AND EXISTS (SELECT 1 FROM users u WHERE u.id = q.user_id
      AND ${validChallengeSql} AND (NOT ${activeMfaSql} OR q.mfa_authenticated_at IS NOT NULL))`)
    .bind(timestamp, operation, challenge.id, challenge.purpose, timestamp, timestamp);
}
export const won = "EXISTS (SELECT 1 FROM user_auth_challenges WHERE used_by = ?)";
export async function prepareSession(c: AuthContext, challenge: Challenge, version = challenge.auth_version) {
  const timestamp = now(), refresh = `ofr_${random()}`;
  const session: Session = { id: uuid(), user_id: challenge.user_id, auth_version: version,
    created_at: timestamp, last_used_at: timestamp, password_authenticated_at: challenge.password_authenticated_at,
    mfa_authenticated_at: challenge.mfa_authenticated_at, expires_at: timestamp + SESSION_TTL,
    revoked_at: null, user_agent: c.req.header("user-agent")?.slice(0, 512) ?? null };
  const access = await signAccess(c.env, session);
  const refreshHash = await digest(refresh);
  const statements = (operation: string) => [
    c.get("db").prepare(`INSERT INTO user_sessions
      (id, user_id, auth_version, created_at, password_authenticated_at, mfa_authenticated_at, last_used_at, expires_at, user_agent)
      SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ? FROM users u WHERE u.id = ? AND u.auth_version = ?
      AND u.password_reset_required = 0 AND ${eligibleUserSql} AND ${won}
      AND (NOT ${activeMfaSql} OR ? IS NOT NULL)`)
      .bind(session.id, version, timestamp, session.password_authenticated_at, session.mfa_authenticated_at,
        timestamp, session.expires_at, session.user_agent, session.user_id, version, operation, session.mfa_authenticated_at),
    c.get("db").prepare(`INSERT INTO user_refresh_tokens(id, session_id, token_hash, created_at, expires_at)
      SELECT ?, id, ?, ?, expires_at FROM user_sessions WHERE id = ?`).bind(uuid(), refreshHash, timestamp, session.id),
  ];
  return { session, statements, response: { token_type: "Bearer", access_token: access, expires_in: ACCESS_TTL,
    refresh_token: refresh, refresh_expires_at: session.expires_at, session_id: session.id } };
}

export async function completeLogin(c: AuthContext, challenge: Challenge, token: string) {
  const user = await c.get("db").prepare(`SELECT u.* FROM users u WHERE id = ? AND auth_version = ? AND ${eligibleUserSql}`)
    .bind(challenge.user_id, challenge.auth_version).first<User>();
  if (!user) unauthorized();
  if (challenge.mfa_authenticated_at === null && await hasMfa(c, user.id)) unauthorized();
  if (user.password_reset_required) {
    const result = await c.get("db").prepare(`UPDATE user_auth_challenges SET purpose = 'password_reset'
      WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`)
      .bind(challenge.id, challenge.purpose, now()).run();
    if (result.meta.changes !== 1) unauthorized();
    return c.json({ next: "password_reset", token_type: "Bearer", challenge_token: token, expires_at: challenge.expires_at });
  }
  const pair = await prepareSession(c, challenge), operation = uuid(), timestamp = now();
  const results = await c.get("db").batch([
    claim(c, challenge, operation), ...pair.statements(operation),
    c.get("db").prepare("UPDATE users SET last_login_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM user_sessions WHERE id = ?)")
      .bind(timestamp, user.id, pair.session.id),
  ]);
  if (results[1]!.meta.changes !== 1) unauthorized();
  return c.json(pair.response);
}

// Call only inside the same batch after claim(); the unique operation id gates every write.
export function invalidateCredentials(c: AuthContext, userId: string, operation: string, version: number) {
  const timestamp = now();
  const changed = `${won} AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ?)`;
  return [
    c.get("db").prepare(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND ${changed}`).bind(timestamp, userId, operation, userId, version),
    c.get("db").prepare(`UPDATE user_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id = ?) AND ${changed}`).bind(timestamp, userId, operation, userId, version),
    c.get("db").prepare(`UPDATE user_auth_challenges SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND ${changed}`).bind(timestamp, userId, operation, userId, version),
    c.get("db").prepare(`UPDATE user_mfa_methods SET revoked_at = ? WHERE user_id = ?
      AND verified_at IS NULL AND revoked_at IS NULL AND ${changed}`).bind(timestamp, userId, operation, userId, version),
  ];
}

export function accessClaim(c: AuthContext, operation: string, extra = "1", params: (string | number | null)[] = []) {
  const { session, user } = c.get("identity"), timestamp = now();
  return c.get("db").prepare(`UPDATE user_sessions AS s SET last_operation_id = ?, last_used_at = ?
    WHERE s.id = ? AND s.auth_version = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.auth_version = s.auth_version
      AND u.password_reset_required = 0 AND ${eligibleUserSql}
      AND (NOT ${activeMfaSql} OR s.mfa_authenticated_at IS NOT NULL)) AND (${extra})`)
    .bind(operation, timestamp, session.id, user.auth_version, timestamp, ...params);
}
export const accessWon = "EXISTS (SELECT 1 FROM user_sessions WHERE id = ? AND last_operation_id = ?)";

export function publicUser(user: User) {
  return { id: user.id, email_address: user.email_address, display_name: user.display_name,
    profile_image_key: user.profile_image_key, created_at: user.created_at, updated_at: user.updated_at,
    password_changed_at: user.password_changed_at, last_login_at: user.last_login_at,
    password_reset_required: !!user.password_reset_required };
}

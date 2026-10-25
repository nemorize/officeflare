import { and, eq, exists, gt, inArray, isNotNull, isNull, lte, not, or, type SQL } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { bearer, unauthorized } from "./input";
import { digest, random, signAccess, verifyAccess } from "./crypto";
import { activeMfa, challengeWon, eligibleUser, sessionAccountValid, validChallenge } from "../db/auth-conditions";
import { coalesce, increment } from "../db/expressions";
import { insertWhen } from "../db/conditional-insert";
import { authRateLimits, users, userAuthChallenges, userMfaMethods, userRefreshTokens, userSessions } from "../db/schema";
import { ACCESS_TTL, CHALLENGE_TTL, SESSION_TTL, now, uuid, type AppEnv, type AuthContext, type Challenge, type Session, type User } from "./types";
import { prepareNotification } from "../notifications/service";
import { measured } from "../observability/performance";
import { recoverNotifications } from "../notifications/jobs";

export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c);
  if (token.startsWith("ofc_") || token.startsWith("ofr_")) unauthorized();
  const claims = await measured(c, "jwt", () => verifyAccess(c.env, token)), db = c.get("db"), timestamp = now();
  const row = await measured(c, "auth", async () => db.select({ user: users, session: userSessions }).from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.user_id)).where(and(
      eq(userSessions.id, claims.sessionId), eq(users.id, claims.userId), eq(userSessions.auth_version, claims.version),
      eq(users.auth_version, userSessions.auth_version), isNull(userSessions.revoked_at), gt(userSessions.expires_at, timestamp),
      eq(users.password_reset_required, 0), eligibleUser(),
      or(not(activeMfa(db, users.id)), isNotNull(userSessions.mfa_authenticated_at)),
    )).get());
  if (!row) unauthorized();
  c.set("identity", row);
  if (row.session.last_used_at <= timestamp - 60) {
    c.executionCtx.waitUntil(db.update(userSessions).set({ last_used_at: timestamp }).where(and(
      eq(userSessions.id, row.session.id), isNull(userSessions.revoked_at), eq(userSessions.auth_version, row.session.auth_version), lte(userSessions.last_used_at, timestamp - 60),
    )).execute().catch(() => { console.warn("Session activity update failed"); }));
  }
  await next();
});

export async function throttle(c: AuthContext, category: string, subject?: string) {
  const db = c.get("db"), timestamp = now(), window = 900;
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const buckets = [{ key: `${category}:ip:${ip}`, limit: 60 }];
  if (subject) buckets.push({ key: `${category}:subject:${subject}`, limit: 10 });
  const hashes = await Promise.all(buckets.map((bucket) => digest(`${bucket.key}:${Math.floor(timestamp / window)}`)));
  const statements = buckets.map((bucket, index) => db.insert(authRateLimits).values({
    bucket: hashes[index]!, attempts: 1,
    expires_at: (Math.floor(timestamp / window) + 1) * window,
  }).onConflictDoUpdate({ target: authRateLimits.bucket, set: { attempts: increment(authRateLimits.attempts) } })
    .returning({ attempts: authRateLimits.attempts }));
  const result = await db.batch([statements[0]!, ...statements.slice(1)]);
  if (result.some((rows, index) => rows[0]!.attempts > buckets[index]!.limit)) {
    c.header("Retry-After", String(window - timestamp % window));
    throw new HTTPException(429, { message: "Too many attempts" });
  }
  // Bounded cleanup; retain rotation history until its session expires.
  await db.delete(authRateLimits).where(inArray(authRateLimits.bucket,
    db.select({ bucket: authRateLimits.bucket }).from(authRateLimits).where(lte(authRateLimits.expires_at, timestamp)).limit(100)));
  if (crypto.getRandomValues(new Uint8Array(1))[0]! % 32 === 0) {
    await db.batch([
      db.delete(userAuthChallenges).where(inArray(userAuthChallenges.id,
        db.select({ id: userAuthChallenges.id }).from(userAuthChallenges).where(lte(userAuthChallenges.expires_at, timestamp)).limit(100))),
      db.delete(userSessions).where(inArray(userSessions.id,
        db.select({ id: userSessions.id }).from(userSessions).where(lte(userSessions.expires_at, timestamp)).limit(50))),
    ]);
  }
}

export async function hasMfa(c: AuthContext, userId: string) {
  return !!await c.get("db").select({ id: userMfaMethods.id }).from(userMfaMethods).where(and(
    eq(userMfaMethods.user_id, userId), isNotNull(userMfaMethods.verified_at), isNull(userMfaMethods.revoked_at),
  )).limit(1).get();
}

export async function makeChallenge(c: AuthContext, user: User, purpose: Challenge["purpose"], session: Session | null = null) {
  const db = c.get("db"), timestamp = now(), token = `ofc_${random()}`;
  const challenge: Challenge = {
    id: uuid(), user_id: user.id, session_id: session?.id ?? null, token_hash: await digest(token), purpose,
    auth_version: user.auth_version, password_authenticated_at: timestamp, mfa_authenticated_at: null,
    created_at: timestamp, expires_at: timestamp + CHALLENGE_TTL, attempts: 0, used_at: null, used_by: null,
  };
  const result = await insertWhen(db, userAuthChallenges, challenge, exists(
    db.select({ id: users.id }).from(users).where(and(
      eq(users.id, user.id), eq(users.auth_version, user.auth_version), eligibleUser(),
      session ? and(eq(users.password_reset_required, 0), exists(
        db.select({ id: userSessions.id }).from(userSessions).where(and(
          eq(userSessions.id, session.id), eq(userSessions.user_id, users.id),
          eq(userSessions.auth_version, users.auth_version), isNull(userSessions.revoked_at), gt(userSessions.expires_at, timestamp),
        )),
      )) : undefined,
    )),
  ));
  if (result.meta.changes !== 1) unauthorized();
  return { token, challenge };
}

export async function getChallenge(c: AuthContext, purposes: Challenge["purpose"][]) {
  const token = bearer(c);
  if (!/^ofc_[A-Za-z0-9_-]{43}$/.test(token)) unauthorized();
  const db = c.get("db");
  const row = await db.select({ challenge: userAuthChallenges }).from(userAuthChallenges)
    .innerJoin(users, eq(users.id, userAuthChallenges.user_id)).where(and(
      eq(userAuthChallenges.token_hash, await digest(token)), validChallenge(db, now()),
      inArray(userAuthChallenges.purpose, purposes),
    )).get();
  if (!row) unauthorized();
  return row.challenge;
}

export async function getGrant(c: AuthContext, allowReset = false) {
  const challenge = await getChallenge(c, allowReset ? ["reauth", "password_reset"] : ["reauth"]);
  if (challenge.mfa_authenticated_at === null && await hasMfa(c, challenge.user_id)) unauthorized();
  return challenge;
}

export function claim(c: AuthContext, challenge: Challenge, operation: string) {
  const db = c.get("db"), timestamp = now();
  return db.update(userAuthChallenges).set({ used_at: timestamp, used_by: operation }).where(and(
    eq(userAuthChallenges.id, challenge.id), eq(userAuthChallenges.purpose, challenge.purpose),
    exists(db.select({ id: users.id }).from(users).where(and(
      eq(users.id, userAuthChallenges.user_id), validChallenge(db, timestamp),
      or(not(activeMfa(db, users.id)), isNotNull(userAuthChallenges.mfa_authenticated_at)),
    ))),
  ));
}

export async function prepareSession(c: AuthContext, challenge: Challenge, version = challenge.auth_version) {
  const db = c.get("db"), timestamp = now(), refresh = `ofr_${random()}`;
  const session: Session = {
    id: uuid(), user_id: challenge.user_id, auth_version: version, created_at: timestamp, last_used_at: timestamp,
    last_operation_id: null, password_authenticated_at: challenge.password_authenticated_at,
    mfa_authenticated_at: challenge.mfa_authenticated_at, expires_at: timestamp + SESSION_TTL,
    revoked_at: null, user_agent: c.req.header("user-agent")?.slice(0, 512) ?? null,
  };
  const access = await signAccess(c.env, session), refreshHash = await digest(refresh);
  const statements = (operation: string) => [
    insertWhen(db, userSessions, session, and(challengeWon(db, operation), exists(
      db.select({ id: users.id }).from(users).where(and(
        eq(users.id, session.user_id), eq(users.auth_version, version), eq(users.password_reset_required, 0), eligibleUser(),
        session.mfa_authenticated_at === null ? not(activeMfa(db, users.id)) : undefined,
      )),
    ))!),
    insertWhen(db, userRefreshTokens, {
      id: uuid(), session_id: session.id, token_hash: refreshHash, created_at: timestamp, expires_at: session.expires_at,
    }, exists(db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.id, session.id)))),
  ] as const;
  return { session, statements, response: { token_type: "Bearer", access_token: access, expires_in: ACCESS_TTL,
    refresh_token: refresh, refresh_expires_at: session.expires_at, session_id: session.id } };
}

export async function completeLogin(c: AuthContext, challenge: Challenge, token: string) {
  const db = c.get("db");
  const user = await db.select().from(users).where(and(
    eq(users.id, challenge.user_id), eq(users.auth_version, challenge.auth_version), eligibleUser(),
  )).get();
  if (!user) unauthorized();
  if (challenge.mfa_authenticated_at === null && await hasMfa(c, user.id)) unauthorized();
  if (user.password_reset_required) {
    const result = await db.update(userAuthChallenges).set({ purpose: "password_reset" }).where(and(
      eq(userAuthChallenges.id, challenge.id), eq(userAuthChallenges.purpose, challenge.purpose),
      isNull(userAuthChallenges.used_at), gt(userAuthChallenges.expires_at, now()),
    ));
    if (result.meta.changes !== 1) unauthorized();
    return c.json({ next: "password_reset", token_type: "Bearer", challenge_token: token, expires_at: challenge.expires_at });
  }
  const pair = await prepareSession(c, challenge), operation = uuid();
  const sessionCreated = exists(db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.id, pair.session.id)));
  const results = await db.batch([
    claim(c, challenge, operation), ...pair.statements(operation),
    db.update(users).set({ last_login_at: now() }).where(and(eq(users.id, user.id),
      exists(db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.id, pair.session.id))))),
    ...prepareNotification(db, { source_key: `security.sign_in:${pair.session.id}`, type: "security.sign_in",
      title: "New sign-in to your account", body: "A new session signed in. Review your active sessions if you do not recognize this activity.",
      target_path: "/profile/sessions", recipient_ids: [user.id] }, sessionCreated),
  ]);
  if (results[1].meta.changes !== 1) unauthorized();
  if (c.env.NOTIFICATION_QUEUE) c.executionCtx.waitUntil(recoverNotifications(c.env).catch((error) => console.error("Notification recovery failed", error)));
  return c.json(pair.response);
}

// Call only inside the same batch after claim(); the unique operation id gates every write.
export function invalidateCredentials(c: AuthContext, userId: string, operation: string, version: number) {
  const db = c.get("db"), timestamp = now();
  const changed = and(challengeWon(db, operation), exists(
    db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.auth_version, version))),
  ));
  return [
    db.update(userSessions).set({ revoked_at: coalesce(userSessions.revoked_at, timestamp) }).where(and(eq(userSessions.user_id, userId), changed)),
    db.update(userRefreshTokens).set({ revoked_at: coalesce(userRefreshTokens.revoked_at, timestamp) }).where(and(
      inArray(userRefreshTokens.session_id, db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.user_id, userId))), changed,
    )),
    db.update(userAuthChallenges).set({ used_at: coalesce(userAuthChallenges.used_at, timestamp) }).where(and(eq(userAuthChallenges.user_id, userId), changed)),
    db.update(userMfaMethods).set({ revoked_at: timestamp }).where(and(
      eq(userMfaMethods.user_id, userId), isNull(userMfaMethods.verified_at), isNull(userMfaMethods.revoked_at), changed,
    )),
  ] as const;
}

export function accessClaim(c: AuthContext, operation: string, extra?: SQL) {
  const db = c.get("db"), { session, user } = c.get("identity"), timestamp = now();
  return db.update(userSessions).set({ last_operation_id: operation, last_used_at: timestamp }).where(and(
    eq(userSessions.id, session.id), eq(userSessions.auth_version, user.auth_version), isNull(userSessions.revoked_at),
    gt(userSessions.expires_at, timestamp), sessionAccountValid(db), extra,
  ));
}

export function publicUser(user: User) {
  return { id: user.id, email_address: user.email_address, display_name: user.display_name,
    profile_image_key: user.profile_image_key, created_at: user.created_at, updated_at: user.updated_at,
    password_changed_at: user.password_changed_at, last_login_at: user.last_login_at,
    password_reset_required: !!user.password_reset_required };
}

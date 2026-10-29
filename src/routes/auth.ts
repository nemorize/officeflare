import { and, eq, exists, gt, isNotNull, isNull, not, sql } from "drizzle-orm";
import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { bearer, body, password, string, unauthorized } from "../auth/input";
import { digest, random, signAccess, verifyPassword } from "../auth/crypto";
import { countAttempt, verifyFactor } from "../auth/mfa";
import {
  completeLogin,
  getChallenge,
  hasMfa,
  makeChallenge,
  requireAccess,
  throttle,
} from "../auth/store";
import { sessionAccountValid } from "../db/auth-conditions";
import { coalesce } from "../db/expressions";
import { insertWhen } from "../db/conditional-insert";
import { users, userMfaMethods, userRefreshTokens, userSessions } from "../db/schema";
import { ACCESS_TTL, now, uuid, type AppEnv, type AuthContext } from "../auth/types";

const auth = new Hono<AppEnv>();
auth.post("/login", async (c) => {
  const data = await body(c, ["email_address", "password"]);
  const email = string(data.email_address, "email_address", 254).trim().toLowerCase();
  const supplied = password(data.password);
  await throttle(c, "login", email);
  // The existing email column uses COLLATE NOCASE, including this equality lookup.
  const user = await c
    .get("db")
    .select()
    .from(users)
    .where(and(eq(users.email_address, email), isNull(users.deleted_at)))
    .get();
  const correct = await verifyPassword(supplied, user?.password_hash ?? null);
  if (!correct || !user || user.disabled_at !== null) unauthorized();
  const mfa = await hasMfa(c, user.id);
  const { token, challenge } = await makeChallenge(c, user, mfa ? "login_mfa" : "login");
  if (mfa)
    return c.json({
      next: "mfa",
      token_type: "Bearer",
      challenge_token: token,
      expires_at: challenge.expires_at,
      methods: await methods(c, user.id),
    });
  return completeLogin(c, challenge, token);
});

async function methods(c: AuthContext, userId: string) {
  return c
    .get("db")
    .select({ id: userMfaMethods.id, type: userMfaMethods.type, name: userMfaMethods.name })
    .from(userMfaMethods)
    .where(
      and(
        eq(userMfaMethods.user_id, userId),
        isNotNull(userMfaMethods.verified_at),
        isNull(userMfaMethods.revoked_at),
      ),
    );
}
for (const recovery of [false, true]) {
  auth.post(recovery ? "/mfa/recovery" : "/mfa/verify", async (c) => {
    const data = await body(c, recovery ? ["recovery_code"] : ["method_id", "code"]);
    const challenge = await getChallenge(c, ["login_mfa", "reauth_mfa"]);
    await throttle(c, "mfa", challenge.user_id);
    await countAttempt(c, challenge);
    const verified = await verifyFactor(
      c,
      challenge,
      recovery
        ? { recoveryCode: string(data.recovery_code, "recovery_code", 64) }
        : {
            methodId: string(data.method_id, "method_id", 128),
            code: string(data.code, "code", 8),
          },
    );
    if (verified.purpose === "reauth")
      return c.json({
        token_type: "Bearer",
        reauthentication_token: bearer(c),
        expires_at: verified.expires_at,
      });
    return completeLogin(c, verified, bearer(c));
  });
}

auth.post("/reauthenticate", requireAccess, async (c) => {
  const data = await body(c, ["password"]),
    { user, session } = c.get("identity");
  await throttle(c, "reauth", user.id);
  if (!(await verifyPassword(password(data.password), user.password_hash))) unauthorized();
  const mfa = await hasMfa(c, user.id);
  const { token, challenge } = await makeChallenge(c, user, mfa ? "reauth_mfa" : "reauth", session);
  if (mfa)
    return c.json({
      next: "mfa",
      token_type: "Bearer",
      challenge_token: token,
      expires_at: challenge.expires_at,
      methods: await methods(c, user.id),
    });
  return c.json({
    token_type: "Bearer",
    reauthentication_token: token,
    expires_at: challenge.expires_at,
  });
});

auth.post("/refresh", async (c) => {
  await throttle(c, "refresh");
  // A durable request id lets browser clients retry a lost rotation response.
  // Clients without it keep the existing strict one-use refresh behavior.
  const data = c.req.header("content-type") ? await body(c, ["request_id"]) : undefined;
  const requestId =
    data?.request_id !== undefined ? string(data.request_id, "request_id", 64) : undefined;
  if (requestId && !/^[a-f0-9]{64}$/.test(requestId)) {
    return c.json({ error: "Invalid request_id" }, 400);
  }
  const token = bearer(c);
  if (!/^ofr_[A-Za-z0-9_-]{43}$/.test(token)) unauthorized();
  const db = c.get("db"),
    hash = await digest(token),
    timestamp = now();
  const row = await db
    .select({ session: userSessions, token: userRefreshTokens })
    .from(userRefreshTokens)
    .innerJoin(userSessions, eq(userSessions.id, userRefreshTokens.session_id))
    .where(eq(userRefreshTokens.token_hash, hash))
    .get();
  if (!row) unauthorized();
  const { session } = row;
  const operation = requestId ? await digest(`refresh-operation:${hash}:${requestId}`) : uuid();
  const refresh = requestId
    ? `ofr_${Buffer.from(await digest(`refresh-token:${token}:${requestId}`), "hex").toString("base64url")}`
    : `ofr_${random()}`;
  const refreshHash = await digest(refresh);
  const access = await signAccess(c.env, session);
  const rotated = exists(
    db
      .select({ id: userRefreshTokens.id })
      .from(userRefreshTokens)
      .where(eq(userRefreshTokens.used_by, operation)),
  );
  const noSuccessor = not(
    exists(
      db
        .select({ id: userRefreshTokens.id })
        .from(userRefreshTokens)
        .where(eq(userRefreshTokens.token_hash, refreshHash)),
    ),
  );
  const results = await db.batch([
    // Only an identical durable request may repeat a completed rotation.
    db
      .update(userSessions)
      .set({ revoked_at: coalesce(userSessions.revoked_at, timestamp) })
      .where(
        and(
          eq(userSessions.id, session.id),
          exists(
            db
              .select({ id: userRefreshTokens.id })
              .from(userRefreshTokens)
              .where(
                and(
                  eq(userRefreshTokens.token_hash, hash),
                  isNotNull(userRefreshTokens.used_at),
                  requestId ? sql`${userRefreshTokens.used_by} IS NOT ${operation}` : undefined,
                ),
              ),
          ),
        ),
      ),
    db
      .update(userRefreshTokens)
      .set({ used_at: timestamp, used_by: operation })
      .where(
        and(
          eq(userRefreshTokens.token_hash, hash),
          isNull(userRefreshTokens.used_at),
          isNull(userRefreshTokens.revoked_at),
          gt(userRefreshTokens.expires_at, timestamp),
          exists(
            db
              .select({ id: userSessions.id })
              .from(userSessions)
              .where(
                and(
                  eq(userSessions.id, userRefreshTokens.session_id),
                  isNull(userSessions.revoked_at),
                  gt(userSessions.expires_at, timestamp),
                  sessionAccountValid(db),
                ),
              ),
          ),
        ),
      ),
    insertWhen(
      db,
      userRefreshTokens,
      {
        id: uuid(),
        session_id: session.id,
        token_hash: refreshHash,
        parent_id: row.token.id,
        created_at: timestamp,
        expires_at: row.token.expires_at,
      },
      and(rotated, noSuccessor)!,
    ),
    db
      .update(userSessions)
      .set({ last_used_at: timestamp })
      .where(and(eq(userSessions.id, session.id), rotated)),
  ]);
  if (results[1].meta.changes !== 1) {
    const retry =
      requestId &&
      (await db
        .select({ id: userRefreshTokens.id })
        .from(userRefreshTokens)
        .innerJoin(userSessions, eq(userSessions.id, userRefreshTokens.session_id))
        .where(
          and(
            eq(userRefreshTokens.token_hash, refreshHash),
            eq(userRefreshTokens.parent_id, row.token.id),
            isNull(userRefreshTokens.used_at),
            isNull(userRefreshTokens.revoked_at),
            gt(userRefreshTokens.expires_at, now()),
            isNull(userSessions.revoked_at),
            gt(userSessions.expires_at, now()),
            sessionAccountValid(db),
          ),
        )
        .get());
    if (!retry) unauthorized();
  }
  return c.json({
    token_type: "Bearer",
    access_token: access,
    expires_in: Math.min(ACCESS_TTL, session.expires_at - timestamp),
    refresh_token: refresh,
    refresh_expires_at: session.expires_at,
    session_id: session.id,
  });
});

auth.post("/logout", requireAccess, async (c) => {
  const { session } = c.get("identity");
  await c
    .get("db")
    .update(userSessions)
    .set({ revoked_at: coalesce(userSessions.revoked_at, now()) })
    .where(eq(userSessions.id, session.id));
  return c.body(null, 204);
});
export default auth;

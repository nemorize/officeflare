import { t } from "../../shared/i18n/index.ts";
import { isLanguagePreference } from "../../shared/i18n/locale.ts";
import { and, desc, eq, exists, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { body, conflict, invalid, password, unauthorized } from "../auth/input";
import { hashPassword } from "../auth/crypto";
import {
  accessClaim,
  claim,
  getGrant,
  invalidateCredentials,
  prepareSession,
  publicUser,
  requireAccess,
  throttle,
} from "../auth/store";
import { accessWon, challengeWon } from "../db/auth-conditions";
import { coalesce, increment } from "../db/expressions";
import { users, userAuthChallenges, userSessions } from "../db/schema";
import { now, uuid, type AppEnv } from "../auth/types";
import profile from "./profile";
import profileImages from "./profile-images";
import mfaManagement from "./mfa-management";
import { permissionsFor } from "../authorization/access";

const me = new Hono<AppEnv>();
me.get("/", requireAccess, (c) => c.json({ user: publicUser(c.get("identity").user) }));
me.get("/permissions", requireAccess, async (c) =>
  c.json({ permissions: await permissionsFor(c.get("db"), c.get("identity").user.id) }),
);

me.put("/language", requireAccess, async (c) => {
  const data = await body(c, ["language"]);
  if (!isLanguagePreference(data.language)) invalid(t("language.invalid"));
  const { user, session } = c.get("identity");
  const db = c.get("db"),
    operation = uuid();
  const result = await db.batch([
    accessClaim(c, operation),
    db
      .update(users)
      .set({ language: data.language, updated_at: now() })
      .where(and(eq(users.id, user.id), accessWon(db, session.id, operation)))
      .returning(),
  ]);
  const updated = result[1][0];
  if (!updated) conflict(t("routesProfile.accountOrProfilePolicyChangedReloadAndRetry"));
  return c.json({ user: publicUser(updated) });
});

// A password-reset or one-use reauthentication grant is the Bearer token here.
me.put("/password", async (c) => {
  const data = await body(c, ["new_password"]),
    nextPassword = password(data.new_password, true);
  const grant = await getGrant(c, true);
  await throttle(c, "password", grant.user_id);
  const db = c.get("db"),
    timestamp = now(),
    version = grant.auth_version + 1,
    operation = uuid();
  const hash = await hashPassword(nextPassword);
  const pair = await prepareSession(c, { ...grant, password_authenticated_at: timestamp }, version);
  const invalidations = invalidateCredentials(c, grant.user_id, operation, version);
  const result = await db.batch([
    claim(c, grant, operation),
    db
      .update(users)
      .set({
        password_hash: hash,
        password_changed_at: timestamp,
        updated_at: timestamp,
        password_reset_required: 0,
        auth_version: increment(users.auth_version),
      })
      .where(
        and(
          eq(users.id, grant.user_id),
          eq(users.auth_version, grant.auth_version),
          challengeWon(db, operation),
        ),
      ),
    ...invalidations,
    ...pair.statements(operation),
    ...(grant.purpose === "password_reset"
      ? [
          db
            .update(users)
            .set({ last_login_at: timestamp })
            .where(
              and(
                eq(users.id, grant.user_id),
                exists(
                  db
                    .select({ id: userSessions.id })
                    .from(userSessions)
                    .where(eq(userSessions.id, pair.session.id)),
                ),
              ),
            ),
        ]
      : []),
  ]);
  if (result[1].meta.changes !== 1 || result[2 + invalidations.length]!.meta.changes !== 1)
    unauthorized();
  return c.json(pair.response);
});

me.get("/sessions", requireAccess, async (c) => {
  const { user, session } = c.get("identity");
  const rows = await c
    .get("db")
    .select({
      id: userSessions.id,
      created_at: userSessions.created_at,
      password_authenticated_at: userSessions.password_authenticated_at,
      mfa_authenticated_at: userSessions.mfa_authenticated_at,
      last_used_at: userSessions.last_used_at,
      expires_at: userSessions.expires_at,
      user_agent: userSessions.user_agent,
    })
    .from(userSessions)
    .where(
      and(
        eq(userSessions.user_id, user.id),
        isNull(userSessions.revoked_at),
        gt(userSessions.expires_at, now()),
        eq(userSessions.auth_version, user.auth_version),
      ),
    )
    .orderBy(desc(userSessions.created_at))
    .limit(100);
  return c.json({ sessions: rows.map((row) => ({ ...row, current: row.id === session.id })) });
});
me.delete("/sessions/:id", requireAccess, async (c) => {
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const result = await db.batch([
    accessClaim(c, operation),
    db
      .update(userSessions)
      .set({ revoked_at: coalesce(userSessions.revoked_at, now()) })
      .where(
        and(
          eq(userSessions.id, c.req.param("id")),
          eq(userSessions.user_id, user.id),
          accessWon(db, session.id, operation),
        ),
      ),
  ]);
  if (result[0].meta.changes !== 1) unauthorized();
  return c.body(null, 204);
});
me.delete("/sessions", requireAccess, async (c) => {
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    timestamp = now(),
    operation = uuid();
  const won = accessWon(db, session.id, operation);
  const result = await db.batch([
    accessClaim(c, operation),
    db
      .update(users)
      .set({ auth_version: increment(users.auth_version) })
      .where(and(eq(users.id, user.id), won)),
    db
      .update(userSessions)
      .set({ revoked_at: coalesce(userSessions.revoked_at, timestamp) })
      .where(and(eq(userSessions.user_id, user.id), won)),
    db
      .update(userAuthChallenges)
      .set({ used_at: coalesce(userAuthChallenges.used_at, timestamp) })
      .where(and(eq(userAuthChallenges.user_id, user.id), won)),
  ]);
  if (result[0].meta.changes !== 1) unauthorized();
  return c.body(null, 204);
});
me.route("/", profile);
me.route("/", profileImages);
me.route("/mfa", mfaManagement);
export default me;

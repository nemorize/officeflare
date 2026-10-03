import { and, eq, exists, gt, inArray, isNull, ne, notExists, type AnyColumn } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashPassword } from "../auth/password";
import { body, conflict, invalid, password, string } from "../auth/input";
import { accessClaim, publicUser, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv, type AuthContext, type User } from "../auth/types";
import { administratorRemains, can, forbidden, manageableUser, permissionCondition, requirePermission } from "../authorization/access";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { coalesce, increment } from "../db/expressions";
import { users, userAuthChallenges, userMfaMethods, userMfaRecoveryCodes, userRefreshTokens, userSessions } from "../db/schema";

const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", requireAccess);
const account = (user: User) => ({ ...publicUser(user), disabled_at: user.disabled_at, deleted_at: user.deleted_at });
function missing(): never { throw new HTTPException(404, { message: "User not found" }); }
function emailAddress(value: unknown) {
  const email = string(value, "email_address", 254).trim().toLowerCase();
  const parts = email.split("@"), local = parts[0]!, domain = parts[1];
  if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") || !domain || domain.split(".").length < 2 ||
      domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid("Invalid email_address");
  return email;
}
function nullableText(value: unknown, key: string, max: number) {
  if (value === null) return null;
  return string(value, key, max).trim() || invalid(`Invalid ${key}`);
}
function boolean(value: unknown, key: string) {
  if (typeof value !== "boolean") invalid(`Invalid ${key}`);
  return value;
}
async function findUser(c: AuthContext, id: string) {
  const row = await c.get("db").select().from(users).where(and(eq(users.id, id), isNull(users.deleted_at))).get();
  return row ?? missing();
}
function availableEmail(c: AuthContext, email: string, exceptId?: string) {
  return notExists(c.get("db").select({ id: users.id }).from(users).where(and(
    eq(users.email_address, email), isNull(users.deleted_at), exceptId ? ne(users.id, exceptId) : undefined,
  )));
}
async function requireAvailableEmail(c: AuthContext, email: string, exceptId?: string) {
  if (!await c.get("db").select({ ok: users.id }).from(users).where(and(
    eq(users.id, c.get("identity").user.id), availableEmail(c, email, exceptId),
  )).get()) conflict("Email address is already assigned");
}
async function requireManageable(c: AuthContext, id: string) {
  const db = c.get("db"), actor = c.get("identity").user.id;
  if (!await db.select({ id: users.id }).from(users).where(and(eq(users.id, actor), manageableUser(db, actor, id))).get()) {
    forbidden("Cannot manage a user with permissions you do not hold");
  }
}
// Catch changes between loading the account and committing its security-sensitive mutation.
function unchanged(c: AuthContext, user: User) {
  const same = (column: AnyColumn, value: string | number | null) => value === null ? isNull(column) : eq(column, value);
  return exists(c.get("db").select({ id: users.id }).from(users).where(and(
    eq(users.id, user.id), isNull(users.deleted_at), eq(users.auth_version, user.auth_version),
    eq(users.email_address, user.email_address), same(users.display_name, user.display_name),
    same(users.profile_image_key, user.profile_image_key), same(users.disabled_at, user.disabled_at),
    eq(users.password_reset_required, user.password_reset_required),
  )));
}
function revokeCredentials(c: AuthContext, userId: string, operation: string, timestamp: number, deleted = false) {
  const db = c.get("db"), won = accessWon(db, c.get("identity").session.id, operation);
  return [
    db.update(userSessions).set({ revoked_at: coalesce(userSessions.revoked_at, timestamp) }).where(and(eq(userSessions.user_id, userId), won)),
    db.update(userRefreshTokens).set({ revoked_at: coalesce(userRefreshTokens.revoked_at, timestamp) }).where(and(
      inArray(userRefreshTokens.session_id, db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.user_id, userId))), won,
    )),
    db.update(userAuthChallenges).set({ used_at: coalesce(userAuthChallenges.used_at, timestamp) }).where(and(eq(userAuthChallenges.user_id, userId), won)),
    db.update(userMfaMethods).set({ revoked_at: coalesce(userMfaMethods.revoked_at, timestamp) }).where(and(
      eq(userMfaMethods.user_id, userId), deleted ? undefined : isNull(userMfaMethods.verified_at), won,
    )),
    ...(deleted ? [db.update(userMfaRecoveryCodes).set({ revoked_at: coalesce(userMfaRecoveryCodes.revoked_at, timestamp) })
      .where(and(eq(userMfaRecoveryCodes.user_id, userId), won))] : []),
  ] as const;
}

userRoutes.get("/", requirePermission("users.read"), async (c) => {
  const cursor = c.req.query("cursor"), suppliedLimit = c.req.query("limit") ?? "50";
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) invalid("Invalid cursor");
  if (!/^[1-9][0-9]{0,2}$/.test(suppliedLimit) || Number(suppliedLimit) > 100) invalid("Invalid limit");
  const limit = Number(suppliedLimit);
  const rows = await c.get("db").select().from(users).where(and(isNull(users.deleted_at), cursor ? gt(users.id, cursor) : undefined))
    .orderBy(users.id).limit(limit + 1);
  const page = rows.slice(0, limit);
  return c.json({ users: page.map(account), next_cursor: rows.length > limit ? page.at(-1)!.id : null });
});
userRoutes.get("/:id", requirePermission("users.read"), async (c) => c.json({ user: account(await findUser(c, c.req.param("id"))) }));

userRoutes.post("/", requirePermission("users.create"), async (c) => {
  const data = await body(c, ["email_address", "password", "display_name", "profile_image_key", "disabled", "password_reset_required"]);
  const email = emailAddress(data.email_address), suppliedPassword = password(data.password, true), timestamp = now();
  const values = {
    id: uuid(), email_address: email,
    display_name: "display_name" in data ? nullableText(data.display_name, "display_name", 200) : null,
    profile_image_key: "profile_image_key" in data ? nullableText(data.profile_image_key, "profile_image_key", 1024) : null,
    disabled_at: "disabled" in data && boolean(data.disabled, "disabled") ? timestamp : null,
    password_reset_required: "password_reset_required" in data ? Number(boolean(data.password_reset_required, "password_reset_required")) : 1,
    created_at: timestamp, updated_at: timestamp, password_changed_at: timestamp,
    password_hash: await hashPassword(suppliedPassword),
  };
  await requireAvailableEmail(c, email);
  const db = c.get("db"), operation = uuid(), { session, user } = c.get("identity");
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "users.create"), availableEmail(c, email))),
    insertWhen(db, users, values, accessWon(db, session.id, operation)).returning(),
  ]);
  if (result[0].meta.changes !== 1 || !result[1][0]) conflict("Account, permissions or email assignment changed; retry");
  c.header("Location", `/api/users/${values.id}`);
  return c.json({ user: account(result[1][0]) }, 201);
});

userRoutes.patch("/:id", requirePermission("users.update"), async (c) => {
  const data = await body(c, ["email_address", "display_name", "profile_image_key", "password", "disabled", "password_reset_required"]);
  if (Object.keys(data).length === 0) invalid("No changes supplied");
  const editsEmail = "email_address" in data;
  if (editsEmail && !await can(c, "users.email.update")) forbidden("Changing email addresses requires users.email.update");
  const target = await findUser(c, c.req.param("id"));
  await requireManageable(c, target.id);
  const timestamp = now(), changes: Partial<typeof users.$inferInsert> = { updated_at: timestamp };
  if ("email_address" in data) { changes.email_address = emailAddress(data.email_address); await requireAvailableEmail(c, changes.email_address, target.id); }
  if ("display_name" in data) changes.display_name = nullableText(data.display_name, "display_name", 200);
  if ("profile_image_key" in data) changes.profile_image_key = nullableText(data.profile_image_key, "profile_image_key", 1024);
  if ("disabled" in data) changes.disabled_at = boolean(data.disabled, "disabled") ? target.disabled_at ?? timestamp : null;
  if ("password_reset_required" in data) changes.password_reset_required = Number(boolean(data.password_reset_required, "password_reset_required"));
  if ("password" in data) {
    changes.password_hash = await hashPassword(password(data.password, true));
    changes.password_changed_at = timestamp;
    changes.password_reset_required ??= 1;
  }
  const securityChanged = "password" in data || changes.email_address !== undefined && changes.email_address !== target.email_address ||
    changes.disabled_at !== undefined && changes.disabled_at !== target.disabled_at ||
    changes.password_reset_required !== undefined && changes.password_reset_required !== target.password_reset_required;
  const db = c.get("db"), { user, session } = c.get("identity"), operation = uuid();
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "users.update"), unchanged(c, target), manageableUser(db, user.id, target.id),
      editsEmail ? permissionCondition(db, user.id, "users.email.update") : undefined,
      changes.email_address ? availableEmail(c, changes.email_address, target.id) : undefined,
      changes.disabled_at !== undefined && changes.disabled_at !== null ? administratorRemains(db, target.id) : undefined,
    )),
    db.update(users).set({ ...changes, ...(securityChanged ? { auth_version: increment(users.auth_version) } : {}) })
      .where(and(eq(users.id, target.id), accessWon(db, session.id, operation))).returning(),
    ...(securityChanged ? revokeCredentials(c, target.id, operation, timestamp) : []),
  ]);
  if (result[0].meta.changes !== 1 || !result[1][0]) conflict("Account, permissions or administrator availability changed; reload and retry");
  return c.json({ user: account(result[1][0]) });
});

userRoutes.delete("/:id", requirePermission("users.delete"), async (c) => {
  const target = await findUser(c, c.req.param("id"));
  await requireManageable(c, target.id);
  const db = c.get("db"), { user, session } = c.get("identity"), operation = uuid(), timestamp = now();
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "users.delete"), unchanged(c, target),
      manageableUser(db, user.id, target.id), administratorRemains(db, target.id))),
    db.update(users).set({ deleted_at: timestamp, updated_at: timestamp, auth_version: increment(users.auth_version) })
      .where(and(eq(users.id, target.id), accessWon(db, session.id, operation))),
    ...revokeCredentials(c, target.id, operation, timestamp, true),
  ]);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) conflict("Account, permissions or administrator availability changed; reload and retry");
  return c.body(null, 204);
});

export default userRoutes;

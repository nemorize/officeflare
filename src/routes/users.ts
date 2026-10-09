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
import { profileImageResponse } from "../profile/image-response";
import { defaultRoles, defaultsSnapshot, permissionsOf, requireOwnedRoles, roleIds, roleSnapshot, rolesOwned } from "../authorization/roles";
import type { Permission } from "../authorization/permissions";
import { roles, userRoles, mailMailboxes } from "../db/schema";
import { hasMailRole, mailRoleCondition, mailOptions, personalMail, personalMailDirectory, personalMailPlan, personalMailStatements, tryFinishMailbox } from "../mail/provisioning";

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

userRoutes.get("/", requirePermission("admin.users.read"), async (c) => {
  const cursor = c.req.query("cursor"), suppliedLimit = c.req.query("limit") ?? "50";
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) invalid("Invalid cursor");
  if (!/^[1-9][0-9]{0,2}$/.test(suppliedLimit) || Number(suppliedLimit) > 100) invalid("Invalid limit");
  const limit = Number(suppliedLimit);
  const rows = await c.get("db").select().from(users).where(and(isNull(users.deleted_at), cursor ? gt(users.id, cursor) : undefined))
    .orderBy(users.id).limit(limit + 1);
  const page = rows.slice(0, limit);
  const mail = await personalMailDirectory(c.env, page.map((entry) => entry.id));
  const entries = page.map((entry) => ({ ...account(entry), mail: mail.get(entry.id) }));
  return c.json({ users: entries, next_cursor: rows.length > limit ? page.at(-1)!.id : null });
});
userRoutes.get("/default-roles", requirePermission("admin.users.create"), async (c) => c.json({
  roles: await Promise.all((await defaultRoles(c)).map(async (role) => ({ ...role, is_default: true,
    is_system: !!role.is_system, permissions: await permissionsOf(c, role.id) }))),
}));
userRoutes.get("/mail-options", requirePermission("admin.users.read"), async (c) => c.json(await mailOptions(c)));
async function personalMailRole(c: AuthContext) {
  const candidates = await c.get("db").select().from(roles).where(eq(roles.id, "system-mail-user"));
  return candidates[0] && (await permissionsOf(c, candidates[0].id)).includes("mail.access") ? candidates[0] : null;
}
userRoutes.get("/:id/mailbox", requirePermission("admin.users.read"), async (c) => {
  const user = await findUser(c, c.req.param("id")), enabled = await hasMailRole(c, user.id);
  const setup = await personalMail(c.env, user.id);
  if (setup.mailbox?.status === "provisioning") await tryFinishMailbox(c.env, setup.mailbox.id);
  const role = !enabled && await can(c, "admin.users.roles.assign") ? await personalMailRole(c) : null;
  const ownsRole = role && await c.get("db").select({ id: users.id }).from(users).where(and(eq(users.id, c.get("identity").user.id), rolesOwned(c, [role.id]))).get();
  return c.json({ ...await personalMail(c.env, user.id), mail_enabled: enabled, enable_role: ownsRole ? { id: role!.id, label: role!.label } : null });
});
userRoutes.post("/:id/mailbox", requirePermission("admin.users.read"), requirePermission("admin.mail.mailboxes.manage"), async (c) => {
  const target = await findUser(c, c.req.param("id"));
  const data = await body(c, ["domain_id", "local_part", "enable_mail"]), enabled = await hasMailRole(c, target.id);
  if (data.enable_mail !== undefined) boolean(data.enable_mail, "enable_mail");
  const role = !enabled && data.enable_mail === true ? await personalMailRole(c) : null;
  if (!enabled && !role) invalid("Enable Mail for this user before setting up their address");
  if (role) {
    if (!await can(c, "admin.users.roles.assign")) forbidden("Enabling Mail requires admin.users.roles.assign");
    await requireOwnedRoles(c, [role.id]);
    if ((await dbRolesCount(c, target.id)) >= 50) invalid("This user already has 50 roles");
  }
  const { enable_mail: _enable, ...addressInput } = data, plan = await personalMailPlan(c, target, addressInput);
  if (plan.address && !await can(c, "admin.mail.domains.manage")) forbidden("Setting a mail address requires admin.mail.domains.manage");
  const db = c.get("db"), { user, session } = c.get("identity"), operation = uuid();
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "admin.users.read"), permissionCondition(db, user.id, "admin.mail.mailboxes.manage"),
      plan.address ? permissionCondition(db, user.id, "admin.mail.domains.manage") : undefined,
      role ? and(permissionCondition(db, user.id, "admin.users.roles.assign"), roleSnapshot([role]), rolesOwned(c, [role.id]),
        exists(db.select({ id: users.id }).from(users).where(and(eq(users.id, target.id), eq(users.role_assignment_version, target.role_assignment_version))))) : mailRoleCondition(c, target.id),
      exists(db.select({ id: users.id }).from(users).where(and(eq(users.id, target.id), isNull(users.deleted_at)))), plan.guard)),
    ...(role ? [insertWhen(db, userRoles, { user_id: target.id, role_id: role.id, assigned_by: user.id, assigned_at: now() }, accessWon(db, session.id, operation)).onConflictDoNothing(),
      db.update(users).set({ role_assignment_version: increment(users.role_assignment_version), updated_at: now() }).where(and(eq(users.id, target.id), accessWon(db, session.id, operation)))] : []),
    ...personalMailStatements(c, plan, accessWon(db, session.id, operation)),
  ]);
  if (!result[0].meta.changes) conflict("The account, address or permissions changed. Retry the setup.");
  await tryFinishMailbox(c.env, plan.box.id);
  return c.json(await personalMail(c.env, target.id));
});
async function dbRolesCount(c: AuthContext, id: string) {
  return (await c.get("db").select({ id: userRoles.role_id }).from(userRoles).where(eq(userRoles.user_id, id))).length;
}
userRoutes.get("/:id", requirePermission("admin.users.read"), async (c) => c.json({ user: account(await findUser(c, c.req.param("id"))) }));
userRoutes.get("/:id/profile-image", requirePermission("admin.users.read"), async (c) => profileImageResponse(c, await findUser(c, c.req.param("id"))));

userRoutes.post("/", requirePermission("admin.users.create"), async (c) => {
  const data = await body(c, ["email_address", "password", "display_name", "profile_image_key", "disabled", "password_reset_required", "role_ids", "mail_address"]);
  const db = c.get("db"), defaults = await defaultRoles(c), defaultIds = defaults.map((role) => role.id);
  const ids = "role_ids" in data ? roleIds(data.role_ids) : defaultIds;
  const selected = ids.length ? await db.select().from(roles).where(inArray(roles.id, ids)) : [];
  if (selected.length !== ids.length) invalid("Unknown role");
  const added = ids.filter((id) => !defaultIds.includes(id)), removed = defaultIds.filter((id) => !ids.includes(id));
  if (added.length && !await can(c, "admin.users.roles.assign")) forbidden("Changing default roles requires admin.users.roles.assign");
  if (removed.length && !await can(c, "admin.users.roles.remove")) forbidden("Changing default roles requires admin.users.roles.remove");
  await requireOwnedRoles(c, [...added, ...removed]);
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
  const hasMail = (await Promise.all(selected.map((role) => permissionsOf(c, role.id)))).some((permissions) => permissions.includes("mail.access"));
  if ("mail_address" in data && !hasMail) invalid("Mail address requires a role with Mail access");
  const mailPlan = hasMail ? await personalMailPlan(c, values, data.mail_address) : null;
  await requireAvailableEmail(c, email);
  const operation = uuid(), { session, user } = c.get("identity");
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "admin.users.create"), availableEmail(c, email),
      defaultsSnapshot(defaults), roleSnapshot(selected), rolesOwned(c, [...added, ...removed]),
      added.length ? permissionCondition(db, user.id, "admin.users.roles.assign") : undefined,
      removed.length ? permissionCondition(db, user.id, "admin.users.roles.remove") : undefined, mailPlan?.guard)),
    insertWhen(db, users, values, accessWon(db, session.id, operation)).returning(),
    ...ids.map((role_id) => insertWhen(db, userRoles, { user_id: values.id, role_id, assigned_by: user.id, assigned_at: timestamp }, accessWon(db, session.id, operation))),
    ...(mailPlan ? personalMailStatements(c, mailPlan, accessWon(db, session.id, operation)) : []),
  ]);
  if (result[0].meta.changes !== 1 || !result[1][0]) conflict("Account, permissions or email assignment changed; retry");
  c.header("Location", `/api/users/${values.id}`);
  if (mailPlan) await tryFinishMailbox(c.env, mailPlan.box.id);
  return c.json({ user: account(result[1][0]), mail: mailPlan ? await personalMail(c.env, values.id) : null }, 201);
});

userRoutes.patch("/:id", requirePermission("admin.users.read"), async (c) => {
  const data = await body(c, ["email_address", "display_name", "profile_image_key", "password", "disabled", "password_reset_required"]);
  if (Object.keys(data).length === 0) invalid("No changes supplied");
  const required = new Set<Permission>();
  for (const key of Object.keys(data)) required.add({
    display_name: "admin.users.profile.update", profile_image_key: "admin.users.profile.update",
    email_address: "admin.users.email.update", disabled: "admin.users.status.update",
    password: "admin.users.credentials.reset", password_reset_required: "admin.users.credentials.reset",
  }[key] as Permission);
  for (const permission of required) if (!await can(c, permission)) forbidden(`This change requires ${permission}`);
  const target = await findUser(c, c.req.param("id"));
  await requireManageable(c, target.id);
  const timestamp = now(), changes: Partial<typeof users.$inferInsert> = { updated_at: timestamp };
  if ("email_address" in data) { changes.email_address = emailAddress(data.email_address); await requireAvailableEmail(c, changes.email_address, target.id); }
  if ("display_name" in data) changes.display_name = nullableText(data.display_name, "display_name", 200);
  if ("profile_image_key" in data) changes.profile_image_key = nullableText(data.profile_image_key, "profile_image_key", 1024);
  if ("disabled" in data) {
    const disabled = boolean(data.disabled, "disabled");
    if (disabled && target.id === c.get("identity").user.id) forbidden("You cannot disable your own account.");
    changes.disabled_at = disabled ? target.disabled_at ?? timestamp : null;
  }
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
    accessClaim(c, operation, and(...[...required].map((permission) => permissionCondition(db, user.id, permission)), unchanged(c, target), manageableUser(db, user.id, target.id),
      changes.email_address ? availableEmail(c, changes.email_address, target.id) : undefined,
      changes.disabled_at !== undefined && changes.disabled_at !== null ? administratorRemains(db, target.id) : undefined,
    )),
    db.update(users).set({ ...changes, ...(securityChanged ? { auth_version: increment(users.auth_version) } : {}) })
      .where(and(eq(users.id, target.id), accessWon(db, session.id, operation))).returning(),
    ...("display_name" in data || "email_address" in data ? [db.update(mailMailboxes).set({
      name: (("display_name" in data ? changes.display_name : target.display_name) || changes.email_address || target.email_address).slice(0, 100), updated_at: timestamp,
    }).where(and(eq(mailMailboxes.owner_user_id, target.id), eq(mailMailboxes.kind, "personal"), ne(mailMailboxes.status, "deleted"),
      eq(mailMailboxes.name, (target.display_name || target.email_address).slice(0, 100)), accessWon(db, session.id, operation)))] : []),
    ...(securityChanged ? revokeCredentials(c, target.id, operation, timestamp) : []),
  ]);
  if (result[0].meta.changes !== 1 || !result[1][0]) conflict("Account, permissions or administrator availability changed; reload and retry");
  return c.json({ user: account(result[1][0]) });
});

userRoutes.delete("/:id", requirePermission("admin.users.delete"), async (c) => {
  const target = await findUser(c, c.req.param("id"));
  await requireManageable(c, target.id);
  const db = c.get("db"), { user, session } = c.get("identity"), operation = uuid(), timestamp = now();
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, "admin.users.delete"), unchanged(c, target),
      manageableUser(db, user.id, target.id), administratorRemains(db, target.id))),
    db.update(users).set({ deleted_at: timestamp, updated_at: timestamp, auth_version: increment(users.auth_version) })
      .where(and(eq(users.id, target.id), accessWon(db, session.id, operation))),
    db.update(mailMailboxes).set({ status: "disabled", updated_at: timestamp })
      .where(and(eq(mailMailboxes.owner_user_id, target.id), eq(mailMailboxes.kind, "personal"), ne(mailMailboxes.status, "deleted"), accessWon(db, session.id, operation))),
    ...revokeCredentials(c, target.id, operation, timestamp, true),
  ]);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) conflict("Account, permissions or administrator availability changed; reload and retry");
  return c.body(null, 204);
});

export default userRoutes;

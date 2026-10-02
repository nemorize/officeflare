import { and, eq, exists, gt, inArray, isNotNull, isNull, ne, not, notExists, or, sql, type SQL } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import type { BatchItem } from "drizzle-orm/batch";
import { HTTPException } from "hono/http-exception";
import { body, conflict, invalid, string } from "../auth/input";
import { accessClaim, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv, type AuthContext } from "../auth/types";
import { forbidden, permissionCondition, requirePermission } from "../authorization/access";
import { ADMINISTRATOR_ROLE_ID, isPermission, permissionCatalog, type Permission } from "../authorization/permissions";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { increment, jsonExtract } from "../db/expressions";
import { roles, rolePermissions, userRoles, users } from "../db/schema";

type Role = typeof roles.$inferSelect;
// Virtual JSON rows keep an assignment snapshot within D1's bound-parameter limit.
const assignmentSnapshot = sqliteTable("assignment_role_snapshot", { value: text() });
const publicRole = (role: Role) => ({ ...role, is_system: !!role.is_system });
function missing(): never { throw new HTTPException(404, { message: "Not found" }); }
function permissionList(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length > Object.keys(permissionCatalog).length ||
      value.some((item) => !isPermission(item)) || new Set(value).size !== value.length) invalid("Invalid permissions");
  return value as Permission[];
}
function label(value: unknown) { return string(value, "label", 100).trim() || invalid("Invalid label"); }
function description(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 1000) invalid("Invalid description");
  return value;
}
async function roleWithPermissions(c: AuthContext, id: string) {
  const db = c.get("db"), role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  const permissions = await db.select({ key: rolePermissions.permission_key }).from(rolePermissions)
    .where(eq(rolePermissions.role_id, id)).orderBy(rolePermissions.permission_key);
  return { ...publicRole(role), permissions: permissions.map((row) => row.key) };
}
async function requireGrantable(c: AuthContext, permissions: Permission[]) {
  const db = c.get("db"), userId = c.get("identity").user.id;
  const rows = await db.select({ key: rolePermissions.permission_key }).from(rolePermissions)
    .where(and(inArray(rolePermissions.permission_key, permissions), permissionCondition(db, userId, rolePermissions.permission_key)));
  const owned = new Set(rows.map((row) => row.key));
  if (permissions.some((permission) => !owned.has(permission))) forbidden("Cannot grant permissions you do not hold");
}
function grantable(c: AuthContext, permissions: Permission[]) {
  return and(...permissions.map((permission) => permissionCondition(c.get("db"), c.get("identity").user.id, permission)));
}
async function commit(c: AuthContext, permission: Permission, extra: SQL | undefined,
  writes: (won: SQL) => readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) {
  const db = c.get("db"), { user, session } = c.get("identity"), operation = uuid();
  const statements = writes(accessWon(db, session.id, operation));
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, permission), extra)), ...statements,
  ]);
  if (result[0]!.meta.changes !== 1) conflict("Account, permissions or role changed; reload and retry");
}

const roleRoutes = new Hono<AppEnv>();
roleRoutes.use("*", requireAccess);
roleRoutes.get("/", requirePermission("roles.read"), async (c) => {
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && (cursor.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(cursor))) invalid("Invalid cursor");
  const db = c.get("db"), rows = await db.select().from(roles)
    .where(cursor ? gt(roles.key, cursor) : undefined).orderBy(roles.key).limit(51);
  const page = rows.slice(0, 50), ids = page.map((role) => role.id);
  const grants = ids.length ? await db.select().from(rolePermissions)
    .where(inArray(rolePermissions.role_id, ids)).orderBy(rolePermissions.permission_key) : [];
  return c.json({ roles: page.map((role) => ({ ...publicRole(role),
    permissions: grants.filter((grant) => grant.role_id === role.id).map((grant) => grant.permission_key),
  })), next_cursor: rows.length > 50 ? page.at(-1)!.key : null });
});
roleRoutes.get("/:id", requirePermission("roles.read"), async (c) => c.json({ role: await roleWithPermissions(c, c.req.param("id")) }));
roleRoutes.post("/", requirePermission("roles.manage"), async (c) => {
  const data = await body(c, ["key", "label", "description", "permissions"]);
  const key = string(data.key, "key", 64);
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) invalid("Invalid key");
  const values = { id: uuid(), key, label: label(data.label), description: description(data.description), created_at: now(), updated_at: now() };
  const permissions = permissionList(data.permissions);
  await requireGrantable(c, permissions);
  const db = c.get("db");
  if (await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).get()) conflict("Role key already exists");
  await commit(c, "roles.manage", and(grantable(c, permissions), notExists(db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)))),
    (won) => [insertWhen(db, roles, values, won), ...permissions.map((permission_key) => insertWhen(db, rolePermissions, { role_id: values.id, permission_key }, won))]);
  return c.json({ role: await roleWithPermissions(c, values.id) }, 201);
});
roleRoutes.put("/:id", requirePermission("roles.manage"), async (c) => {
  const data = await body(c, ["label", "description", "permissions", "version"]);
  const id = c.req.param("id"), db = c.get("db");
  const role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  if (role.is_system) forbidden("System roles cannot be modified");
  if (!Number.isSafeInteger(data.version) || (data.version as number) < 1) invalid("Invalid version");
  if (data.version !== role.version) conflict("Role changed; reload and retry");
  const next = { label: label(data.label), description: description(data.description), updated_at: now(), version: increment(roles.version) };
  const permissions = permissionList(data.permissions);
  await requireGrantable(c, permissions);
  await commit(c, "roles.manage", and(grantable(c, permissions), exists(db.select({ id: roles.id }).from(roles)
    .where(and(eq(roles.id, id), eq(roles.is_system, 0), eq(roles.version, role.version))))), (won) => [
    db.update(roles).set(next).where(and(eq(roles.id, id), won)),
    db.delete(rolePermissions).where(and(eq(rolePermissions.role_id, id), won)),
    ...permissions.map((permission_key) => insertWhen(db, rolePermissions, { role_id: id, permission_key }, won)),
  ]);
  return c.json({ role: await roleWithPermissions(c, id) });
});
roleRoutes.delete("/:id", requirePermission("roles.manage"), async (c) => {
  const id = c.req.param("id"), db = c.get("db"), role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  if (role.is_system) forbidden("System roles cannot be deleted");
  await commit(c, "roles.manage", exists(db.select({ id: roles.id }).from(roles)
    .where(and(eq(roles.id, id), eq(roles.is_system, 0), eq(roles.version, role.version)))),
    (won) => [db.delete(roles).where(and(eq(roles.id, id), won))]);
  return c.body(null, 204);
});

const userRoleRoutes = new Hono<AppEnv>();
userRoleRoutes.use("/:id/roles", requireAccess);
async function userExists(c: AuthContext, id: string) {
  if (!await c.get("db").select({ id: users.id }).from(users).where(and(eq(users.id, id), isNull(users.deleted_at))).get()) missing();
}
userRoleRoutes.get("/:id/roles", requirePermission("users.roles.read"), async (c) => {
  const id = c.req.param("id"); await userExists(c, id);
  const rows = await c.get("db").select({ role: roles, assigned_by: userRoles.assigned_by, assigned_at: userRoles.assigned_at })
    .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.role_id)).where(eq(userRoles.user_id, id)).orderBy(roles.key);
  return c.json({ roles: rows.map((row) => ({ ...publicRole(row.role), assigned_by: row.assigned_by, assigned_at: row.assigned_at })) });
});
userRoleRoutes.put("/:id/roles", requirePermission("users.roles.manage"), async (c) => {
  const data = await body(c, ["role_ids"]), id = c.req.param("id"), db = c.get("db"), actorId = c.get("identity").user.id;
  if (!Array.isArray(data.role_ids) || data.role_ids.length > 50 || data.role_ids.some((item) => typeof item !== "string" || !item.length || item.length > 100) ||
      new Set(data.role_ids).size !== data.role_ids.length) invalid("Invalid role_ids");
  const ids = data.role_ids as string[]; await userExists(c, id);
  const selected = ids.length ? await db.select().from(roles).where(inArray(roles.id, ids)) : [];
  if (selected.length !== ids.length) invalid("Unknown role");
  const snapshot = JSON.stringify(selected.map((role) => ({ id: role.id, version: role.version })));
  const snapshotSource = sql`json_each(${snapshot}) AS ${sql.identifier("assignment_role_snapshot")}`;
  const snapshotIds = db.select({ id: jsonExtract(assignmentSnapshot.value, "$.id") }).from(snapshotSource);
  const mismatches = db.select({ id: roles.id }).from(snapshotSource).leftJoin(roles, eq(roles.id, jsonExtract(assignmentSnapshot.value, "$.id")))
    .where(or(isNull(roles.id), ne(roles.version, jsonExtract(assignmentSnapshot.value, "$.version"))));
  const unowned = () => notExists(db.select({ key: rolePermissions.permission_key }).from(rolePermissions).where(and(
    inArray(rolePermissions.role_id, snapshotIds), not(permissionCondition(db, actorId, rolePermissions.permission_key)),
  )));
  if (ids.length && !await db.select({ id: users.id }).from(users).where(and(eq(users.id, actorId), unowned())).get()) {
    forbidden("Cannot grant permissions you do not hold");
  }
  // Preserve an eligible administrator even when concurrent requests remove assignments.
  const administratorRemains = ids.includes(ADMINISTRATOR_ROLE_ID) ? undefined : or(
    notExists(db.select({ id: userRoles.user_id }).from(userRoles).where(and(eq(userRoles.user_id, id), eq(userRoles.role_id, ADMINISTRATOR_ROLE_ID)))),
    exists(db.select({ id: users.id }).from(userRoles).innerJoin(users, eq(users.id, userRoles.user_id)).where(and(
      eq(userRoles.role_id, ADMINISTRATOR_ROLE_ID), ne(users.id, id), isNull(users.disabled_at), isNull(users.deleted_at), isNotNull(users.password_hash),
    ))),
  );
  await commit(c, "users.roles.manage", and(
    exists(db.select({ id: users.id }).from(users).where(and(eq(users.id, id), isNull(users.deleted_at)))),
    administratorRemains, ids.length ? unowned() : undefined,
    notExists(mismatches),
  ), (won) => [
    db.delete(userRoles).where(and(eq(userRoles.user_id, id), ids.length ? not(inArray(userRoles.role_id, ids)) : undefined, won)),
    db.insert(userRoles).select(db.select({ user_id: sql<string>`${id}`.as("user_id"), role_id: sql<string>`${jsonExtract(assignmentSnapshot.value, "$.id")}`.as("role_id"),
      assigned_by: sql<string>`${actorId}`.as("assigned_by"), assigned_at: sql<number>`${now()}`.as("assigned_at"),
    }).from(snapshotSource).where(won)).onConflictDoNothing(),
  ]);
  return c.body(null, 204);
});

export { roleRoutes, userRoleRoutes };

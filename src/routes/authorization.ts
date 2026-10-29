import { and, count, eq, exists, gt, inArray, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { BatchItem } from "drizzle-orm/batch";
import { HTTPException } from "hono/http-exception";
import { body, conflict, invalid, string } from "../auth/input";
import { accessClaim, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv, type AuthContext } from "../auth/types";
import {
  administratorRemains,
  can,
  forbidden,
  permissionCondition,
  requirePermission,
} from "../authorization/access";
import {
  ADMINISTRATOR_ROLE_ID,
  defaultEligible,
  type Permission,
} from "../authorization/permissions";
import {
  permissionList,
  permissionsOf,
  requireOwnedRoles,
  roleIds,
  roleSnapshot,
  rolesOwned,
} from "../authorization/roles";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { increment } from "../db/expressions";
import { roles, rolePermissions, userRoles, users } from "../db/schema";

type Role = typeof roles.$inferSelect;
const publicRole = (role: Role) => ({
  ...role,
  is_system: !!role.is_system,
  is_default: !!role.is_default,
});
function missing(): never {
  throw new HTTPException(404, { message: "Not found" });
}
function label(value: unknown) {
  return string(value, "label", 100).trim() || invalid("Invalid label");
}
function description(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 1000) invalid("Invalid description");
  return value;
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("Invalid version");
  return value as number;
}
async function roleWithPermissions(c: AuthContext, id: string) {
  const db = c.get("db"),
    role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  const members = await db
    .select({ count: count() })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.user_id))
    .where(and(eq(userRoles.role_id, id), isNull(users.deleted_at)))
    .get();
  return {
    ...publicRole(role),
    permissions: await permissionsOf(c, id),
    assigned_user_count: members?.count ?? 0,
  };
}
function grantable(c: AuthContext, permissions: readonly string[]) {
  const actor = c.get("identity").user.id;
  // Use a single JSON parameter instead of expanding every permission's prerequisites.
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(permissions)}) proposed_permission
    WHERE NOT ${permissionCondition(c.get("db"), actor, sql`proposed_permission.value`)})`;
}
async function requireGrantable(c: AuthContext, permissions: readonly string[]) {
  if (
    !(await c
      .get("db")
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, c.get("identity").user.id), grantable(c, permissions)))
      .get())
  ) {
    forbidden("Cannot grant permissions you do not hold");
  }
}
async function commit(
  c: AuthContext,
  permission: Permission,
  extra: SQL | undefined,
  writes: (won: SQL) => readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
) {
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const result = await db.batch([
    accessClaim(c, operation, and(permissionCondition(db, user.id, permission), extra)),
    ...writes(accessWon(db, session.id, operation)),
  ]);
  if (result[0]!.meta.changes !== 1)
    conflict("Account, permissions or role changed; reload and retry");
}

const roleRoutes = new Hono<AppEnv>();
roleRoutes.use("*", requireAccess);
roleRoutes.get("/", requirePermission("admin.roles.read"), async (c) => {
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && (cursor.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(cursor)))
    invalid("Invalid cursor");
  const db = c.get("db"),
    rows = await db
      .select()
      .from(roles)
      .where(cursor ? gt(roles.key, cursor) : undefined)
      .orderBy(roles.key)
      .limit(51);
  const page = rows.slice(0, 50),
    ids = page.map((role) => role.id);
  const grants = ids.length
    ? await db
        .select()
        .from(rolePermissions)
        .where(inArray(rolePermissions.role_id, ids))
        .orderBy(rolePermissions.permission_key)
    : [];
  const members = ids.length
    ? await db
        .select({ role_id: userRoles.role_id, count: count() })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.user_id))
        .where(and(inArray(userRoles.role_id, ids), isNull(users.deleted_at)))
        .groupBy(userRoles.role_id)
    : [];
  return c.json({
    roles: page.map((role) => ({
      ...publicRole(role),
      permissions: grants
        .filter((grant) => grant.role_id === role.id)
        .map((grant) => grant.permission_key),
      assigned_user_count: members.find((member) => member.role_id === role.id)?.count ?? 0,
    })),
    next_cursor: rows.length > 50 ? page.at(-1)!.key : null,
  });
});
roleRoutes.get("/:id", requirePermission("admin.roles.read"), async (c) =>
  c.json({ role: await roleWithPermissions(c, c.req.param("id")) }),
);
roleRoutes.post("/", requirePermission("admin.roles.create"), async (c) => {
  const data = await body(c, ["key", "label", "description", "permissions"]);
  const key = string(data.key, "key", 64);
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) invalid("Invalid key");
  const values = {
    id: uuid(),
    key,
    label: label(data.label),
    description: description(data.description),
    created_at: now(),
    updated_at: now(),
  };
  const permissions = permissionList(data.permissions);
  await requireGrantable(c, permissions);
  const db = c.get("db");
  if (await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).get())
    conflict("Role key already exists");
  await commit(
    c,
    "admin.roles.create",
    and(
      grantable(c, permissions),
      notExists(db.select({ id: roles.id }).from(roles).where(eq(roles.key, key))),
    ),
    (won) => [
      insertWhen(db, roles, values, won),
      ...permissions.map((permission_key) =>
        insertWhen(db, rolePermissions, { role_id: values.id, permission_key }, won),
      ),
    ],
  );
  return c.json({ role: await roleWithPermissions(c, values.id) }, 201);
});
roleRoutes.put("/:id", requirePermission("admin.roles.update"), async (c) => {
  const data = await body(c, ["label", "description", "permissions", "version"]);
  const id = c.req.param("id"),
    db = c.get("db"),
    role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  if (role.is_system) forbidden("System roles cannot be modified");
  if (version(data.version) !== role.version) conflict("Role changed; reload and retry");
  const next = {
    label: label(data.label),
    description: description(data.description),
    updated_at: now(),
    version: increment(roles.version),
  };
  const permissions = permissionList(data.permissions);
  if (role.is_default && !defaultEligible(permissions))
    invalid("Default roles can only grant Mail, Calendar or Drive access");
  if (role.is_default && !(await can(c, "admin.roles.defaults.manage")))
    forbidden("Editing a default role requires admin.roles.defaults.manage");
  await requireOwnedRoles(c, [id]);
  await requireGrantable(c, permissions);
  await commit(
    c,
    "admin.roles.update",
    and(
      grantable(c, permissions),
      rolesOwned(c, [id]),
      roleSnapshot([role]),
      role.is_default
        ? permissionCondition(db, c.get("identity").user.id, "admin.roles.defaults.manage")
        : undefined,
    ),
    (won) => [
      db
        .update(roles)
        .set(next)
        .where(and(eq(roles.id, id), won)),
      db.delete(rolePermissions).where(and(eq(rolePermissions.role_id, id), won)),
      ...permissions.map((permission_key) =>
        insertWhen(db, rolePermissions, { role_id: id, permission_key }, won),
      ),
    ],
  );
  return c.json({ role: await roleWithPermissions(c, id) });
});
roleRoutes.patch("/:id/default", requirePermission("admin.roles.defaults.manage"), async (c) => {
  const data = await body(c, ["is_default", "version"]),
    id = c.req.param("id"),
    db = c.get("db");
  if (typeof data.is_default !== "boolean") invalid("Invalid is_default");
  const role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  if (role.is_system) forbidden("System roles cannot be default roles");
  if (version(data.version) !== role.version) conflict("Role changed; reload and retry");
  if (data.is_default && !defaultEligible(await permissionsOf(c, id)))
    invalid("Default roles can only grant Mail, Calendar or Drive access");
  await requireOwnedRoles(c, [id]);
  const limit = data.is_default
    ? sql`(SELECT count(*) FROM roles WHERE is_default=1 AND id<>${id})<50`
    : undefined;
  await commit(
    c,
    "admin.roles.defaults.manage",
    and(rolesOwned(c, [id]), roleSnapshot([role]), limit),
    (won) => [
      db
        .update(roles)
        .set({
          is_default: Number(data.is_default),
          version: increment(roles.version),
          updated_at: now(),
        })
        .where(and(eq(roles.id, id), won)),
    ],
  );
  return c.json({ role: await roleWithPermissions(c, id) });
});
roleRoutes.delete("/:id", requirePermission("admin.roles.delete"), async (c) => {
  const id = c.req.param("id"),
    db = c.get("db"),
    role = await db.select().from(roles).where(eq(roles.id, id)).get();
  if (!role) missing();
  if (role.is_system) forbidden("System roles cannot be deleted");
  await requireOwnedRoles(c, [id]);
  if (role.is_default && !(await can(c, "admin.roles.defaults.manage")))
    forbidden("Deleting a default role requires admin.roles.defaults.manage");
  await commit(
    c,
    "admin.roles.delete",
    and(
      rolesOwned(c, [id]),
      roleSnapshot([role]),
      role.is_default
        ? permissionCondition(db, c.get("identity").user.id, "admin.roles.defaults.manage")
        : undefined,
    ),
    (won) => [db.delete(roles).where(and(eq(roles.id, id), won))],
  );
  return c.body(null, 204);
});

const userRoleRoutes = new Hono<AppEnv>();
userRoleRoutes.use("/:id/roles", requireAccess);
async function userExists(c: AuthContext, id: string) {
  return (
    (await c
      .get("db")
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deleted_at)))
      .get()) ?? missing()
  );
}
userRoleRoutes.get("/:id/roles", requirePermission("admin.users.roles.read"), async (c) => {
  const id = c.req.param("id"),
    db = c.get("db");
  // The assignment list and its version must come from the same database snapshot.
  const [accounts, rows] = await db.batch([
    db
      .select({ version: users.role_assignment_version })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deleted_at))),
    db
      .select({
        role: roles,
        assigned_by: userRoles.assigned_by,
        assigned_at: userRoles.assigned_at,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.role_id))
      .where(eq(userRoles.user_id, id))
      .orderBy(roles.key),
  ]);
  if (!accounts[0]) missing();
  return c.json({
    version: accounts[0].version,
    roles: await Promise.all(
      rows.map(async (row) => ({
        ...publicRole(row.role),
        permissions: await permissionsOf(c, row.role.id),
        assigned_by: row.assigned_by,
        assigned_at: row.assigned_at,
      })),
    ),
  });
});
userRoleRoutes.put("/:id/roles", requirePermission("admin.users.roles.read"), async (c) => {
  const data = await body(c, ["role_ids", "version"]),
    id = c.req.param("id"),
    db = c.get("db"),
    actorId = c.get("identity").user.id;
  const ids = roleIds(data.role_ids),
    expected = version(data.version),
    user = await userExists(c, id);
  if (expected !== user.role_assignment_version)
    conflict("Assigned roles changed; reload and retry");
  const selected = ids.length ? await db.select().from(roles).where(inArray(roles.id, ids)) : [];
  if (selected.length !== ids.length) invalid("Unknown role");
  const current = await db
    .select({ role: roles })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(eq(userRoles.user_id, id));
  const oldIds = current.map((row) => row.role.id),
    added = ids.filter((key) => !oldIds.includes(key)),
    removed = oldIds.filter((key) => !ids.includes(key));
  if (added.length && !(await can(c, "admin.users.roles.assign")))
    forbidden("Adding roles requires admin.users.roles.assign");
  if (removed.length && !(await can(c, "admin.users.roles.remove")))
    forbidden("Removing roles requires admin.users.roles.remove");
  if (!added.length && !removed.length) return c.body(null, 204);
  await requireOwnedRoles(c, [...added, ...removed]);
  const allRows = [
    ...new Map(
      [...selected, ...current.map((row) => row.role)].map((row) => [row.id, row]),
    ).values(),
  ];
  await commit(
    c,
    "admin.users.roles.read",
    and(
      exists(
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, id),
              isNull(users.deleted_at),
              eq(users.role_assignment_version, expected),
            ),
          ),
      ),
      added.length ? permissionCondition(db, actorId, "admin.users.roles.assign") : undefined,
      removed.length ? permissionCondition(db, actorId, "admin.users.roles.remove") : undefined,
      ids.includes(ADMINISTRATOR_ROLE_ID) ? undefined : administratorRemains(db, id),
      rolesOwned(c, [...added, ...removed]),
      roleSnapshot(allRows),
    ),
    (won) => [
      db
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.user_id, id),
            sql`${userRoles.role_id} NOT IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
            won,
          ),
        ),
      db
        .insert(userRoles)
        .select(
          db
            .select({
              user_id: sql<string>`${id}`.as("user_id"),
              role_id: sql<string>`value`.as("role_id"),
              assigned_by: sql<string>`${actorId}`.as("assigned_by"),
              assigned_at: sql<number>`${now()}`.as("assigned_at"),
            })
            .from(sql`json_each(${JSON.stringify(ids)})`)
            .where(won),
        )
        .onConflictDoNothing(),
    ],
  );
  return c.body(null, 204);
});

export { roleRoutes, userRoleRoutes };

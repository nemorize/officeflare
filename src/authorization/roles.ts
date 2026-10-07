import { and, eq, inArray, isNull, not, notExists, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "../auth/types";
import { invalid } from "../auth/input";
import { roles, rolePermissions, userRoles, users } from "../db/schema";
import { forbidden, permissionCondition } from "./access";
import { defaultEligible, isPermission, missingPrerequisites, permissionCatalog, type Permission } from "./permissions";

export type RoleRecord = typeof roles.$inferSelect;
export function permissionList(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length > Object.keys(permissionCatalog).length ||
    value.some((key) => !isPermission(key)) || new Set(value).size !== value.length) invalid("Invalid permissions");
  const missing = missingPrerequisites(value);
  if (missing.length) invalid(`Missing required permissions: ${missing.join(", ")}`);
  return value as Permission[];
}
export function roleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((id) => typeof id !== "string" || !id.length || id.length > 100) ||
    new Set(value).size !== value.length) invalid("Invalid role_ids");
  return value as string[];
}
export async function permissionsOf(c: AuthContext, id: string) {
  return (await c.get("db").select({ key: rolePermissions.permission_key }).from(rolePermissions)
    .where(eq(rolePermissions.role_id, id)).orderBy(rolePermissions.permission_key)).map((row) => row.key);
}
export function rolesOwned(c: AuthContext, ids: readonly string[]): SQL | undefined {
  if (!ids.length) return undefined;
  const db = c.get("db"), actorId = c.get("identity").user.id;
  return notExists(db.select({ key: rolePermissions.permission_key }).from(rolePermissions).where(and(
    sql`${rolePermissions.role_id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`, not(permissionCondition(db, actorId, rolePermissions.permission_key)),
  )));
}
export async function requireOwnedRoles(c: AuthContext, ids: readonly string[]) {
  if (!ids.length) return;
  if (!await c.get("db").select({ id: users.id }).from(users)
    .where(and(eq(users.id, c.get("identity").user.id), rolesOwned(c, ids))).get()) {
    forbidden("Cannot manage roles with permissions you do not hold");
  }
}
// JSON snapshots keep batches below D1's 100-parameter limit, even with 50 roles.
export function roleSnapshot(rows: readonly RoleRecord[]): SQL {
  const snapshot = JSON.stringify(rows.map(({ id, version, is_default }) => ({ id, version, is_default })));
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${snapshot}) snapshot LEFT JOIN roles current
    ON current.id=json_extract(snapshot.value, '$.id') WHERE current.id IS NULL
    OR current.version<>json_extract(snapshot.value, '$.version') OR current.is_default<>json_extract(snapshot.value, '$.is_default'))`;
}
export function defaultsSnapshot(rows: readonly RoleRecord[]): SQL {
  const ids = JSON.stringify(rows.map((role) => role.id));
  return and(roleSnapshot(rows), sql`NOT EXISTS (SELECT 1 FROM roles WHERE is_default=1
    AND id NOT IN (SELECT value FROM json_each(${ids})))`)!;
}
export async function defaultRoles(c: AuthContext) {
  const db = c.get("db"), rows = await db.select().from(roles).where(eq(roles.is_default, 1)).orderBy(roles.key);
  if (rows.length > 50) invalid("Too many default roles");
  for (const role of rows) if (!defaultEligible(await permissionsOf(c, role.id))) invalid("A default role contains administrative permissions");
  return rows;
}
export async function assignedRoles(c: AuthContext, id: string) {
  return c.get("db").select({ role: roles }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.role_id))
    .innerJoin(users, eq(users.id, userRoles.user_id)).where(and(eq(users.id, id), isNull(users.deleted_at)));
}

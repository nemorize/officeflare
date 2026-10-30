import { t } from "../../shared/i18n/index.ts";
import { measured } from "../observability/performance";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  ne,
  not,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, AuthContext } from "../auth/types";
import type { Database } from "../db";
import { rolePermissions, userRoles, users } from "../db/schema";
import {
  ADMINISTRATOR_ROLE_ID,
  effectivePermissions,
  isPermission,
  permissionCatalog,
  permissionClosure,
  type Permission,
  type ResourceRef,
} from "./permissions";

const prerequisitePolicy = JSON.stringify(
  Object.fromEntries(Object.keys(permissionCatalog).map((key) => [key, permissionClosure([key])])),
);

// Also usable inside a conditional write, so revocation cannot race an API mutation.
export function permissionCondition(db: Database, userId: string, permission: string | SQLWrapper) {
  if (typeof permission === "string") {
    if (!isPermission(permission)) return sql`0`;
    return and(
      ...permissionClosure([permission]).map((key) => directPermissionCondition(db, userId, key)),
    )!;
  }
  return sql`EXISTS (SELECT 1 FROM json_each(${prerequisitePolicy}) authorization_policy
    WHERE authorization_policy.key=${permission} AND NOT EXISTS
    (SELECT 1 FROM json_each(authorization_policy.value) authorization_requirement
    WHERE NOT ${directPermissionCondition(db, userId, sql`authorization_requirement.value`)}))`;
}
function directPermissionCondition(db: Database, userId: string, permission: string | SQLWrapper) {
  const assignments = alias(userRoles, "authorization_assignments");
  const grants = alias(rolePermissions, "authorization_permissions");
  const account = alias(users, "authorization_user");
  return exists(
    db
      .select({ user_id: assignments.user_id })
      .from(assignments)
      .innerJoin(grants, eq(grants.role_id, assignments.role_id))
      .innerJoin(account, eq(account.id, assignments.user_id))
      .where(
        and(
          eq(assignments.user_id, userId),
          eq(grants.permission_key, permission),
          isNull(account.deleted_at),
          isNull(account.disabled_at),
          isNotNull(account.password_hash),
          eq(account.password_reset_required, 0),
        ),
      ),
  );
}

export async function permissionsFor(db: Database, userId: string): Promise<Permission[]> {
  const rows = await db
    .selectDistinct({ permission: rolePermissions.permission_key })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.role_id, userRoles.role_id))
    .innerJoin(users, eq(users.id, userRoles.user_id))
    .where(
      and(
        eq(userRoles.user_id, userId),
        isNull(users.deleted_at),
        isNull(users.disabled_at),
        isNotNull(users.password_hash),
        eq(users.password_reset_required, 0),
      ),
    )
    .orderBy(rolePermissions.permission_key);
  return effectivePermissions(rows.map((row) => row.permission));
}

// Editing credentials or disabling an account must not let a delegated manager take
// over or remove an account with privileges that the manager does not hold.
export function manageableUser(db: Database, actorId: string, userId: string) {
  return notExists(
    db
      .select({ key: rolePermissions.permission_key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.role_id, userRoles.role_id))
      .where(
        and(
          eq(userRoles.user_id, userId),
          not(permissionCondition(db, actorId, rolePermissions.permission_key)),
        ),
      ),
  );
}

// Recheck inside the mutation batch; concurrent removals must leave an administrator.
export function administratorRemains(db: Database, userId: string) {
  return or(
    notExists(
      db
        .select({ id: userRoles.user_id })
        .from(userRoles)
        .where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, ADMINISTRATOR_ROLE_ID))),
    ),
    exists(
      db
        .select({ id: users.id })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.user_id))
        .where(
          and(
            eq(userRoles.role_id, ADMINISTRATOR_ROLE_ID),
            ne(users.id, userId),
            isNull(users.disabled_at),
            isNull(users.deleted_at),
            isNotNull(users.password_hash),
          ),
        ),
    ),
  );
}

export function requestPermissions(c: AuthContext): Promise<Permission[]> {
  let pending = c.get("permissions");
  if (!pending) {
    pending = measured(c, "authorization", () =>
      permissionsFor(c.get("db"), c.get("identity").user.id),
    );
    c.set("permissions", pending);
  }
  return pending;
}

export async function can(
  c: AuthContext,
  permission: Permission,
  resource?: ResourceRef,
): Promise<boolean> {
  // Current actions are global. A resource requires its own policy; global grants never imply it.
  if (!isPermission(permission) || resource !== undefined) return false;
  return (await requestPermissions(c)).includes(permission);
}

export function forbidden(message = t("authorizationAccess.permissionDenied")): never {
  throw new HTTPException(403, { message });
}
export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!(await can(c, permission))) forbidden();
    await next();
  });

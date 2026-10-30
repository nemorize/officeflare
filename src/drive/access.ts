import { t } from "../../shared/i18n/index.ts";
import { now } from "../auth/types";
import type { Bind, Condition, DriveContext, DriveEnv, DriveItem } from "./types";
import { fail } from "./input";
import { permissionClosure, type Permission } from "../authorization/permissions";

export const session = (env: DriveEnv) => env.DB.withSession("first-primary");
export const statement = (env: DriveEnv, query: string, ...args: Bind[]) =>
  session(env)
    .prepare(query)
    .bind(...args);
export const first = <T>(env: DriveEnv, query: string, ...args: Bind[]) =>
  statement(env, query, ...args).first<T>();
export async function rows<T>(env: DriveEnv, query: string, ...args: Bind[]) {
  return (await statement(env, query, ...args).all<T>()).results;
}
export const condition = (sql: string, ...args: Bind[]): Condition => ({ sql, args });
export const combine = (...checks: Condition[]): Condition => ({
  sql: checks.map((check) => `(${check.sql})`).join(" AND ") || "1",
  args: checks.flatMap((check) => check.args),
});
export const activeUser = (alias: string) =>
  `${alias}.disabled_at IS NULL AND ${alias}.deleted_at IS NULL AND ${alias}.password_hash IS NOT NULL AND ${alias}.password_reset_required=0`;
export const driveEnabled = (alias: string) =>
  `EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=${alias}.id AND rp.permission_key='drive.access') AND NOT EXISTS(SELECT 1 FROM drive_accounts da WHERE da.user_id=${alias}.id AND da.status='suspended')`;
export function permission(user: string, key: Permission): Condition {
  return condition(
    `NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=required.value))`,
    JSON.stringify(permissionClosure([key])),
    user,
  );
}
export const writableOwner = (owner: string) =>
  condition(
    `NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND status<>'active') AND NOT EXISTS(SELECT 1 FROM drive_admin_jobs WHERE (source_user_id=? OR target_user_id=?) AND status IN ('queued','running','failed'))`,
    owner,
    owner,
    owner,
  );
export const availableItem = (ref: string) =>
  `NOT EXISTS(SELECT 1 FROM drive_admin_job_items ji JOIN drive_admin_jobs j ON j.id=ji.job_id WHERE ji.item_id=${ref} AND j.status IN ('queued','running','failed'))`;
export const ancestors = (
  ref: string,
) => `WITH RECURSIVE ancestors(id,parent_id,owner_user_id,trashed_at,purged_at) AS (
  SELECT id,parent_id,owner_user_id,trashed_at,purged_at FROM drive_items WHERE id=${ref}
  UNION ALL SELECT p.id,p.parent_id,p.owner_user_id,p.trashed_at,p.purged_at FROM drive_items p JOIN ancestors a ON p.id=a.parent_id
)`;
export const descendants = (ref: string) => `WITH RECURSIVE descendants(id) AS (
  SELECT id FROM drive_items WHERE id=${ref} UNION ALL SELECT d.id FROM drive_items d JOIN descendants p ON d.parent_id=p.id
) SELECT id FROM descendants`;
export const cleanPath = (ref: string, trash = false) =>
  `NOT EXISTS(${ancestors(ref)} SELECT 1 FROM ancestors WHERE purged_at IS NOT NULL${trash ? "" : " OR trashed_at IS NOT NULL"})`;
export function access(
  userId: string,
  action: "read" | "comment" | "edit" | "owner" = "read",
  ref = "d.id",
  trash = false,
): Condition {
  const roles =
    action === "read"
      ? "'viewer','commenter','editor'"
      : action === "comment"
        ? "'commenter','editor'"
        : "'editor'";
  return condition(
    `EXISTS(SELECT 1 FROM drive_items resource JOIN users owner ON owner.id=resource.owner_user_id
    WHERE resource.id=${ref} AND ${activeUser("owner")} AND ${driveEnabled("owner")} AND ${cleanPath(ref, trash)} AND ${availableItem(ref)}
    ${action === "edit" || action === "comment" ? "AND NOT EXISTS(SELECT 1 FROM drive_accounts da WHERE da.user_id=owner.id AND da.status<>'active') AND NOT EXISTS(SELECT 1 FROM drive_admin_jobs j WHERE (j.source_user_id=owner.id OR j.target_user_id=owner.id) AND j.status IN ('queued','running','failed'))" : ""}
    AND (resource.owner_user_id=?${
      action === "owner" || trash
        ? ""
        : ` OR EXISTS(SELECT 1 FROM drive_permissions grant_access
      WHERE (SELECT internal_sharing_enabled FROM drive_settings WHERE id=1)=1 AND grant_access.user_id=? AND grant_access.role IN (${roles}) AND (grant_access.expires_at IS NULL OR grant_access.expires_at>unixepoch())
      AND grant_access.item_id IN (${ancestors(ref)} SELECT id FROM ancestors))`
    }))`,
    userId,
    ...(action === "owner" || trash ? [] : [userId]),
  );
}
export function sessionIdentity(c: DriveContext) {
  const { user, session: actorSession } = c.get("identity");
  return condition(
    `EXISTS(SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND s.auth_version=?
    AND s.auth_version=u.auth_version AND s.revoked_at IS NULL AND s.expires_at>? AND ${activeUser("u")}
    AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)))`,
    actorSession.id,
    user.id,
    user.auth_version,
    now(),
  );
}
export function actionCondition(c: DriveContext): Condition {
  const user = c.get("identity").user.id,
    actions = c.get("driveAction") ?? [];
  return combine(
    ...actions.map((key) => permission(user, key)),
    ...(actions.some((key) => key !== "drive.files.download") ? [writableOwner(user)] : []),
    ...(actions.includes("drive.sharing.internal")
      ? [condition("(SELECT internal_sharing_enabled FROM drive_settings WHERE id=1)=1")]
      : []),
    ...(actions.includes("drive.sharing.public")
      ? [condition("(SELECT public_sharing_enabled FROM drive_settings WHERE id=1)=1")]
      : []),
  );
}
export function identity(c: DriveContext) {
  const user = c.get("identity").user.id;
  return combine(
    sessionIdentity(c),
    permission(user, "drive.access"),
    actionCondition(c),
    condition(
      "NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND status='suspended')",
      user,
    ),
  );
}
export async function requireItem(
  c: DriveContext,
  id: string,
  action: "read" | "comment" | "edit" | "owner" = "read",
  trash = false,
) {
  const check = access(c.get("identity").user.id, action, "d.id", trash);
  const item = await first<DriveItem>(
    c.env,
    `SELECT d.* FROM drive_items d WHERE d.id=? AND ${check.sql}`,
    id,
    ...check.args,
  );
  if (!item) fail(404, t("driveAccess.driveItemNotFound"));
  return item;
}
export function itemCondition(
  c: DriveContext,
  id: string,
  version: number | undefined,
  action: "read" | "comment" | "edit" | "owner",
  trash = false,
) {
  const check = access(c.get("identity").user.id, action, "d.id", trash);
  return condition(
    `EXISTS(SELECT 1 FROM drive_items d WHERE d.id=?${version === undefined ? "" : " AND d.version=?"} AND ${check.sql})`,
    id,
    ...(version === undefined ? [] : [version]),
    ...check.args,
  );
}
export async function audience(c: DriveContext, id: string): Promise<string[]> {
  const result = await rows<{ id: string }>(
    c.env,
    `SELECT DISTINCT u.id FROM users u WHERE ${activeUser("u")} AND ${driveEnabled("u")}
    AND (u.id=(SELECT owner_user_id FROM drive_items WHERE id=?) OR EXISTS(SELECT 1 FROM drive_permissions p WHERE p.user_id=u.id
      AND (p.expires_at IS NULL OR p.expires_at>unixepoch()) AND p.item_id IN (${ancestors("?")} SELECT id FROM ancestors)))`,
    id,
    id,
  );
  return result.map((row) => row.id);
}
// One JSON parameter keeps large folder operations below D1's parameter limit.
// Check both membership and versions so a concurrent child insertion cannot be lost.
export function treeSnapshot(
  c: DriveContext,
  root: string,
  nodes: DriveItem[],
  includeTrash = false,
) {
  const read = access(
    c.get("identity").user.id,
    includeTrash ? "owner" : "read",
    "d.id",
    includeTrash,
  );
  return condition(
    `NOT EXISTS(
    WITH snapshot AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.version') version FROM json_each(?)),
    current AS (SELECT d.id,d.version FROM drive_items d WHERE d.id IN (${descendants("?")}) AND ${cleanPath("d.id", includeTrash)})
    SELECT 1 FROM snapshot s LEFT JOIN current d ON d.id=s.id WHERE d.id IS NULL OR d.version<>s.version
    UNION ALL SELECT 1 FROM current d LEFT JOIN snapshot s ON s.id=d.id WHERE s.id IS NULL OR NOT (${read.sql})
  )`,
    JSON.stringify(nodes.map(({ id, version }) => ({ id, version }))),
    root,
    ...read.args,
  );
}

import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";
import { wikiRoles, type WikiPage, type WikiSpace } from "../../shared/wiki";
import { now, uuid, type AuthContext } from "../auth/types";
import { invalid } from "../auth/input";
import { permissionClosure, type Permission } from "../authorization/permissions";
import type { CollaborationActor } from "../collaboration/types";
export type Bind = string | number | null;
export type Condition = { sql: string; args: Bind[] };
export const check = (sql: string, ...args: Bind[]): Condition => ({ sql, args });
export const stmt = (env: Pick<Env, "DB">, sql: string, ...args: Bind[]) =>
  env.DB.withSession("first-primary")
    .prepare(sql)
    .bind(...args);
export const row = <T>(env: Pick<Env, "DB">, sql: string, ...args: Bind[]) =>
  stmt(env, sql, ...args).first<T>();
export const rows = async <T>(env: Pick<Env, "DB">, sql: string, ...args: Bind[]) =>
  (await stmt(env, sql, ...args).all<T>()).results;
export function fail(
  status: 400 | 403 | 404 | 409 | 412 | 413 | 503,
  key:
    | "wiki.notFound"
    | "wiki.denied"
    | "wiki.changed"
    | "wiki.invalid"
    | "wiki.tooLarge" = "wiki.invalid",
): never {
  throw new HTTPException(status, { message: t(key) });
}
export function text(value: unknown, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(t("wiki.invalid"));
  return value.trim();
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    invalid(t("wiki.invalid"));
  return value;
}
export function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(t("wiki.invalid"));
  return Number(value);
}
export function role(value: unknown) {
  if (!wikiRoles.includes(value as (typeof wikiRoles)[number])) invalid(t("wiki.invalid"));
  return value as (typeof wikiRoles)[number];
}
export const roleRank = (ref: string) =>
  `CASE ${ref} WHEN 'viewer' THEN 1 WHEN 'commenter' THEN 2 WHEN 'editor' THEN 3 WHEN 'manager' THEN 4 ELSE 0 END`;
export const spaceRank = (ref = "s") =>
  `CASE WHEN ${ref}.owner_user_id=actor.user_id THEN 5 ELSE COALESCE((SELECT ${roleRank("m.role")} FROM wiki_space_members m WHERE m.space_id=${ref}.id AND m.user_id=actor.user_id),0) END`;
// actor is one bound user ID, shared by every correlated ACL expression.
export const actorCte = "WITH actor(user_id) AS (VALUES (?))";
export function pageRank(ref = "p") {
  return `(WITH RECURSIVE path(id,parent_id,permission_mode,depth) AS (
    SELECT ${ref}.id,${ref}.parent_id,${ref}.permission_mode,0
    UNION ALL SELECT a.id,a.parent_id,a.permission_mode,path.depth+1 FROM wiki_pages a JOIN path ON a.id=path.parent_id WHERE path.depth<32
  ) SELECT CASE WHEN ${spaceRank("s")}>=4 THEN ${spaceRank("s")} ELSE MAX(
    CASE WHEN EXISTS(SELECT 1 FROM path WHERE permission_mode='restricted') THEN 0 ELSE ${spaceRank("s")} END,
    COALESCE((SELECT MAX(${roleRank("g.role")}) FROM wiki_page_grants g JOIN path ON path.id=g.page_id
      WHERE g.user_id=actor.user_id AND path.depth<=COALESCE((SELECT MIN(depth) FROM path WHERE permission_mode='restricted'),32)),0)
  ) END)`;
}
export function cleanPath(ref = "p") {
  return `NOT EXISTS(WITH RECURSIVE path(id,parent_id,trashed_at,purged_at,depth) AS (
    SELECT ${ref}.id,${ref}.parent_id,${ref}.trashed_at,${ref}.purged_at,0 UNION ALL
    SELECT a.id,a.parent_id,a.trashed_at,a.purged_at,path.depth+1 FROM wiki_pages a JOIN path ON a.id=path.parent_id WHERE path.depth<32
  ) SELECT 1 FROM path WHERE trashed_at IS NOT NULL OR purged_at IS NOT NULL)`;
}
export const pageFilter = (min = 1, trash = false) =>
  `${spaceRank()}>=1 AND s.archived_at IS NULL AND p.purged_at IS NULL AND ${pageRank()}>=${min}${trash ? "" : ` AND ${cleanPath()}`}`;
export function pageCondition(user: string, page: string, min = 1, trash = false) {
  return check(
    `EXISTS(${actorCte} SELECT 1 FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id CROSS JOIN actor WHERE p.id=? AND ${pageFilter(min, trash)})`,
    user,
    page,
  );
}
export function spaceCondition(user: string, space: string, min = 1) {
  return check(
    `EXISTS(${actorCte} SELECT 1 FROM wiki_spaces s CROSS JOIN actor WHERE s.id=? AND s.archived_at IS NULL AND ${spaceRank()}>=${min})`,
    user,
    space,
  );
}
export function permissionCondition(user: string, action: Permission) {
  return check(
    `NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=required.value))`,
    JSON.stringify(permissionClosure([action])),
    user,
  );
}
export function actorCondition(actor: CollaborationActor) {
  return check(
    `EXISTS(SELECT 1 FROM user_sessions us JOIN users u ON u.id=us.user_id WHERE us.id=? AND u.id=? AND us.auth_version=? AND us.auth_version=u.auth_version AND us.revoked_at IS NULL AND us.expires_at>unixepoch() AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL AND u.password_reset_required=0 AND (us.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)))`,
    actor.session_id,
    actor.user_id,
    actor.auth_version,
  );
}
export const actorOf = (c: AuthContext): CollaborationActor => ({
  user_id: c.get("identity").user.id,
  session_id: c.get("identity").session.id,
  auth_version: c.get("identity").user.auth_version,
});
export async function getSpace(c: AuthContext, space: string, min = 1) {
  const value = await row<WikiSpace>(
    c.env,
    `${actorCte} SELECT s.*,${spaceRank()} AS role FROM wiki_spaces s CROSS JOIN actor WHERE s.id=? AND s.archived_at IS NULL AND ${spaceRank()}>=1`,
    actorOf(c).user_id,
    id(space),
  );
  if (!value) fail(404, "wiki.notFound");
  if (value.role < min) fail(403, "wiki.denied");
  return value;
}
export async function getPage(c: AuthContext, page: string, min = 1, trash = false) {
  const value = await row<WikiPage>(
    c.env,
    `${actorCte} SELECT p.id,p.space_id,p.parent_id,p.resource_id,p.title,p.icon,p.sort_order,p.permission_mode,p.version,p.projected_epoch,p.projected_seq,p.created_by,p.created_at,p.updated_at,p.trashed_at,p.purged_at,${pageRank()} AS role FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id CROSS JOIN actor WHERE p.id=? AND ${pageFilter(1, trash)}`,
    actorOf(c).user_id,
    id(page),
  );
  if (!value) fail(404, "wiki.notFound");
  if (value.role < min) fail(403, "wiki.denied");
  return value;
}
export async function mutate(
  c: AuthContext,
  action: Permission,
  checks: Condition[],
  build: (proof: string, operation: string) => D1PreparedStatement[],
  audit?: { space: string; page?: string; action: string },
) {
  const actor = actorOf(c),
    operation = uuid(),
    all = [actorCondition(actor), permissionCondition(actor.user_id, action), ...checks];
  const proof = `EXISTS(SELECT 1 FROM wiki_operations WHERE id='${operation}')`;
  const result = await c.env.DB.withSession("first-primary").batch([
    stmt(
      c.env,
      `INSERT INTO wiki_operations(id,actor_user_id) SELECT ?,? WHERE ${all.map((v) => `(${v.sql})`).join(" AND ")}`,
      operation,
      actor.user_id,
      ...all.flatMap((v) => v.args),
    ),
    ...build(proof, operation),
    ...(audit
      ? [
          stmt(
            c.env,
            `INSERT INTO wiki_activity(id,space_id,page_id,actor_user_id,action) SELECT ?,?,?,?,? WHERE ${proof}`,
            operation,
            audit.space,
            audit.page ?? null,
            actor.user_id,
            audit.action,
          ),
        ]
      : []),
  ]);
  if (result[0]!.meta.changes !== 1) fail(412, "wiki.changed");
  return result;
}
export const pageVersion = (page: WikiPage) =>
  check("EXISTS(SELECT 1 FROM wiki_pages WHERE id=? AND version=?)", page.id, page.version);
export const spaceVersion = (space: WikiSpace) =>
  check(
    "EXISTS(SELECT 1 FROM wiki_spaces WHERE id=? AND version=? AND acl_version=? AND tree_version=?)",
    space.id,
    space.version,
    space.acl_version,
    space.tree_version,
  );
export const subtree =
  "WITH RECURSIVE children(id) AS (SELECT id FROM wiki_pages WHERE id=? UNION ALL SELECT p.id FROM wiki_pages p JOIN children ON p.parent_id=children.id) SELECT id FROM children";

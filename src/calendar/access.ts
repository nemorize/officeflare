import { now } from "../auth/types";
import {
  permissionClosure,
  type Permission,
} from "../authorization/permissions";
import type {
  Bind,
  Calendar,
  CalendarContext,
  CalendarEnv,
  Condition,
  Event,
  Role,
} from "./types";
import { fail } from "./input";
export const statement = (env: CalendarEnv, sql: string, ...args: Bind[]) =>
  env.DB.withSession("first-primary")
    .prepare(sql)
    .bind(...args);
export const first = <T>(env: CalendarEnv, sql: string, ...args: Bind[]) =>
  statement(env, sql, ...args).first<T>();
export const rows = async <T>(env: CalendarEnv, sql: string, ...args: Bind[]) =>
  (await statement(env, sql, ...args).all<T>()).results;
export const condition = (sql: string, ...args: Bind[]): Condition => ({
  sql,
  args,
});
export const combine = (...values: Condition[]): Condition => ({
  sql: values.map((value) => `(${value.sql})`).join(" AND ") || "1",
  args: values.flatMap((value) => value.args),
});
export const active = (alias: string) =>
  `${alias}.disabled_at IS NULL AND ${alias}.deleted_at IS NULL AND ${alias}.password_hash IS NOT NULL AND ${alias}.password_reset_required=0`;
export function permission(user: string, key: Permission) {
  return condition(
    `NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE NOT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key=required.value))`,
    JSON.stringify(permissionClosure([key])),
    user,
  );
}
export function identity(
  c: CalendarContext,
  action: Permission | null = "calendar.access",
) {
  const { user, session } = c.get("identity");
  return combine(
    condition(
      `EXISTS(SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND s.auth_version=? AND s.auth_version=u.auth_version
    AND s.revoked_at IS NULL AND s.expires_at>? AND ${active("u")} AND (s.mfa_authenticated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_mfa_methods m WHERE m.user_id=u.id AND m.verified_at IS NOT NULL AND m.revoked_at IS NULL)))`,
      session.id,
      user.id,
      user.auth_version,
      now(),
    ),
    ...(action ? [permission(user.id, action)] : []),
  );
}
export const rank: Record<Role, number> = {
  free_busy: 1,
  reader: 2,
  writer_without_private: 3,
  writer: 4,
  manager: 5,
  data_owner: 6,
};
const roleRank = (user: string, alias: string): Condition =>
  condition(
    `CASE WHEN ${alias}.data_owner_user_id=? THEN 6 ELSE COALESCE((SELECT MAX(CASE a.role WHEN 'free_busy' THEN 1 WHEN 'reader' THEN 2 WHEN 'writer_without_private' THEN 3 WHEN 'writer' THEN 4 WHEN 'manager' THEN 5 ELSE 0 END)
  FROM calendar_acl a JOIN calendar_workspace_settings settings ON settings.id='workspace' AND settings.internal_sharing_enabled=1
  WHERE a.calendar_id=${alias}.id AND (a.expires_at IS NULL OR a.expires_at>unixepoch()) AND (
  (a.scope_type='user' AND a.scope_key=?) OR
  (a.scope_type='group' AND EXISTS(SELECT 1 FROM calendar_groups g JOIN calendar_group_members gm ON gm.group_id=g.id WHERE g.id=a.scope_key AND g.deleted_at IS NULL AND gm.user_id=?)) OR
  (a.scope_type IN('organization','public') AND a.scope_key='workspace') OR
  (a.scope_type='domain' AND EXISTS(SELECT 1 FROM users domain_user JOIN mail_domains d ON d.name=a.scope_key AND (d.inbound_enabled=1 OR d.outbound_enabled=1) WHERE domain_user.id=? AND lower(substr(domain_user.email_address,instr(domain_user.email_address,'@')+1))=lower(a.scope_key)))
  )),0) END`,
    user,
    user,
    user,
    user,
  );
export function calendarAccess(
  user: string,
  alias = "cal",
  min = 1,
  trash = false,
) {
  const role = roleRank(user, alias);
  return condition(
    `${alias}.status='active' ${trash ? "" : `AND ${alias}.trashed_at IS NULL`} AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=${alias}.data_owner_user_id AND ${active("owner")}) AND (${role.sql})>=?`,
    ...role.args,
    min,
  );
}
export async function calendars(
  c: CalendarContext,
  includeTrash = false,
): Promise<Calendar[]> {
  const user = c.get("identity").user.id,
    access = calendarAccess(user, "cal", 1, includeTrash),
    role = roleRank(user, "cal");
  const values = await rows<Calendar & { access_rank: number }>(
    c.env,
    `SELECT cal.*,(${role.sql}) access_rank,EXISTS(SELECT 1 FROM calendar_primary_calendars p WHERE p.calendar_id=cal.id AND p.user_id=?) is_primary FROM calendars cal WHERE ${access.sql} ORDER BY cal.created_at,cal.id`,
    ...role.args,
    user,
    ...access.args,
  );
  return values.map(({ access_rank, ...value }) => ({
    ...value,
    effective_role: (Object.keys(rank) as Role[]).find(
      (key) => rank[key] === access_rank,
    )!,
  }));
}
export async function resolveCalendar(c: CalendarContext, id: string) {
  if (id !== "primary") return id;
  const value = await first<{ calendar_id: string }>(
    c.env,
    "SELECT calendar_id FROM calendar_primary_calendars WHERE user_id=?",
    c.get("identity").user.id,
  );
  if (!value)
    fail(
      404,
      "CALENDAR_NOT_FOUND",
      "Initialize Calendar with /bootstrap first",
    );
  return value.calendar_id;
}
export async function requireCalendar(
  c: CalendarContext,
  id: string,
  min = 1,
  trash = false,
) {
  const resolved = await resolveCalendar(c, id),
    value = (await calendars(c, trash)).find(
      (cal) => cal.id === resolved && rank[cal.effective_role] >= min,
    );
  if (!value) fail(404, "CALENDAR_NOT_FOUND", "Calendar not found");
  return value;
}
export function calendarCondition(
  c: CalendarContext,
  cal: Calendar,
  min = 1,
  trash = false,
) {
  const access = calendarAccess(c.get("identity").user.id, "cal", min, trash);
  return condition(
    `EXISTS(SELECT 1 FROM calendars cal WHERE cal.id=? AND cal.version=? AND ${access.sql})`,
    cal.id,
    cal.version,
    ...access.args,
  );
}
export function privateEvent(event: Event, cal: Calendar) {
  return (
    event.visibility === "private" ||
    (event.visibility === "default" && cal.default_visibility === "private")
  );
}
export function canSeeDetails(event: Event, cal: Calendar) {
  return (
    rank[cal.effective_role] >= 2 &&
    (!privateEvent(event, cal) || rank[cal.effective_role] >= 4)
  );
}
export async function requireEvent(
  c: CalendarContext,
  cal: Calendar,
  id: string,
  edit = false,
  trash = false,
) {
  const value = await first<Event>(
    c.env,
    `SELECT * FROM calendar_events WHERE id=? AND organizer_calendar_id=? ${trash ? "" : "AND trashed_at IS NULL"}`,
    id,
    cal.id,
  );
  if (
    !value ||
    (edit &&
      (rank[cal.effective_role] < 3 ||
        (privateEvent(value, cal) && rank[cal.effective_role] < 4) ||
        value.authority !== "native"))
  )
    fail(404, "EVENT_NOT_FOUND", "Event not found");
  return value;
}
export function eventCondition(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  version: number,
  min = 3,
  trash = false,
) {
  return combine(
    calendarCondition(c, cal, min, trash),
    condition(
      `EXISTS(SELECT 1 FROM calendar_events e WHERE e.id=? AND e.organizer_calendar_id=? AND e.version=? ${trash ? "" : "AND e.trashed_at IS NULL"})`,
      event.id,
      cal.id,
      version,
    ),
  );
}

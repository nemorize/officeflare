import { sql } from "drizzle-orm";
import { uuid } from "../auth/types";
import type { Permission } from "../authorization/permissions";
import { prepareNotification } from "../notifications/service";
import { recoverNotifications } from "../notifications/jobs";
import { combine, condition, first, permission, sessionIdentity, statement } from "./access";
import { treeChanges } from "./mutations";
import { fail, text } from "./input";
import type { Condition, DriveContext } from "./types";

export const reason = (value: unknown) => text(value, "reason", 1000).trim() || fail(400, "Enter a reason for this administrative action");
export const noTransfer = (owner: string) => condition("NOT EXISTS(SELECT 1 FROM drive_admin_jobs WHERE (source_user_id=? OR target_user_id=?) AND status IN ('queued','running','failed'))", owner, owner);
export const adminClaim = (c: DriveContext, key: Permission) => combine(sessionIdentity(c), permission(c.get("identity").user.id, key));
export async function adminMutate(c: DriveContext, key: Permission, checks: Condition[], build: (proof: string, operation: string) => D1PreparedStatement[], audit: { action: string; type: string; id?: string | null; details: Record<string, unknown> }) {
  const operation = uuid(), proof = `EXISTS(SELECT 1 FROM drive_admin_activity WHERE operation_id='${operation}')`, claim = combine(adminClaim(c, key), ...checks);
  const result = await c.env.DB.withSession("first-primary").batch([
    statement(c.env, `INSERT INTO drive_admin_activity(operation_id,actor_user_id,action,target_type,target_id,details_json) SELECT ?,?,?,?,?,? WHERE ${claim.sql}`, operation, c.get("identity").user.id, audit.action, audit.type, audit.id ?? null, JSON.stringify(audit.details), ...claim.args),
    ...build(proof, operation),
  ]);
  if (result[0]!.meta.changes !== 1) {
    const access = adminClaim(c, key);
    if (!await first(c.env, `SELECT 1 WHERE ${access.sql}`, ...access.args)) fail(403, "Administrative permission was revoked");
    fail(412, "Drive configuration or item changed. Reload and try again.");
  }
  if (c.env.NOTIFICATION_QUEUE) c.executionCtx.waitUntil(recoverNotifications(c.env).catch(error => console.error("Drive admin notification recovery failed", error)));
  return result;
}
export function itemEvent(c: DriveContext, item: { id: string; kind: string }, proof: string, operation: string, action: string, details: Record<string, unknown>, recipients: string[] = [], kind = "permissions") {
  return [
    statement(c.env, `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,actor_user_id,action,details_json) SELECT ?,id,owner_user_id,?,?,? FROM drive_items WHERE id=? AND ${proof}`, operation, c.get("identity").user.id, action, JSON.stringify(details), item.id),
    treeChanges(c.env, item.id, kind, recipients, proof),
  ];
}
export function notificationStatements(c: DriveContext, operation: string, proof: string, recipients: string[], title: string, body: string) {
  const targets = [...new Set(recipients)].filter(id => id !== c.get("identity").user.id);
  if (!targets.length) return [];
  return prepareNotification(c.get("db"), { source_key: `drive-admin:${operation}`, type: "drive.shared", title, body, target_path: null, recipient_ids: targets }, sql.raw(proof)).map(query => {
    const compiled = query.toSQL(); return c.env.DB.prepare(compiled.sql).bind(...compiled.params);
  });
}

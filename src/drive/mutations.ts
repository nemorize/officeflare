import { t } from "../../shared/i18n/index.ts";
import { sql } from "drizzle-orm";
import { unauthorized } from "../auth/input";
import { uuid } from "../auth/types";
import { prepareNotification } from "../notifications/service";
import { recoverNotifications } from "../notifications/jobs";
import type { NotificationType } from "../notifications/catalog";
import {
  actionCondition,
  activeUser,
  ancestors,
  cleanPath,
  combine,
  descendants,
  driveEnabled,
  first,
  identity,
  permission,
  sessionIdentity,
  statement,
  writableOwner,
} from "./access";
import type { Condition, DriveContext, DriveEnv } from "./types";
import { fail } from "./input";

export interface Audit {
  item_id: string;
  action: string;
  details?: Record<string, unknown>;
  recipients?: string[];
  kind?: "updated" | "removed" | "permissions";
  tree_changes?: boolean | "after";
  notification?: { type: NotificationType; title: string; body: string; recipients: string[] };
}
export function treeChanges(
  env: DriveEnv,
  root: string,
  kind: string,
  recipients: string[],
  proof: string,
) {
  return statement(
    env,
    `INSERT INTO drive_changes(user_id,item_id,kind)
    SELECT u.id,d.id,? FROM drive_items d JOIN users u WHERE d.id IN (${descendants("?")}) AND d.purged_at IS NULL
    AND ${activeUser("u")} AND ${driveEnabled("u")} AND ${proof}
    AND (u.id=d.owner_user_id OR ${cleanPath("d.id")})
    AND (u.id=d.owner_user_id OR u.id IN (SELECT value FROM json_each(?)) OR EXISTS(
      SELECT 1 FROM drive_permissions p WHERE p.user_id=u.id AND (p.expires_at IS NULL OR p.expires_at>unixepoch())
      AND p.item_id IN (${ancestors("d.id")} SELECT id FROM ancestors)))`,
    kind,
    root,
    JSON.stringify([...new Set(recipients)]),
  );
}
// The authorization claim, metadata, audit, change feed and notification outbox are
// committed by one D1 batch. Every later statement depends on that claim.
export async function mutate(
  c: DriveContext,
  checks: Condition[],
  build: (proof: string, operation: string) => D1PreparedStatement[],
  audit?: Audit,
) {
  const operation = uuid(),
    proof = `EXISTS(SELECT 1 FROM drive_operations WHERE id='${operation}')`;
  const owner =
    audit && (c.get("driveAction") ?? []).some((key) => key !== "drive.files.download")
      ? await first<{ owner_user_id: string }>(
          c.env,
          "SELECT owner_user_id FROM drive_items WHERE id=?",
          audit.item_id,
        )
      : null;
  const claim = combine(
    identity(c),
    ...(owner ? [writableOwner(owner.owner_user_id)] : []),
    ...checks,
  );
  const statements = [
    statement(
      c.env,
      `INSERT INTO drive_operations(id,actor_user_id) SELECT ?,? WHERE ${claim.sql}`,
      operation,
      c.get("identity").user.id,
      ...claim.args,
    ),
    ...(audit?.tree_changes === true
      ? [treeChanges(c.env, audit.item_id, audit.kind ?? "updated", audit.recipients ?? [], proof)]
      : []),
    ...build(proof, operation),
    ...(audit?.tree_changes === "after"
      ? [treeChanges(c.env, audit.item_id, audit.kind ?? "updated", audit.recipients ?? [], proof)]
      : []),
  ];
  if (audit) {
    statements.push(
      statement(
        c.env,
        `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,actor_user_id,action,details_json)
      SELECT ?,id,owner_user_id,?,?,? FROM drive_items WHERE id=? AND ${proof}`,
        operation,
        c.get("identity").user.id,
        audit.action,
        JSON.stringify(audit.details ?? {}),
        audit.item_id,
      ),
    );
    const recipients = [...new Set(audit.recipients ?? [c.get("identity").user.id])];
    statements.push(
      statement(
        c.env,
        `INSERT INTO drive_changes(user_id,item_id,kind) SELECT value,?,? FROM json_each(?) WHERE ${proof}`,
        audit.item_id,
        audit.kind ?? "updated",
        JSON.stringify(recipients),
      ),
    );
    const notification = audit.notification;
    if (notification) {
      const recipients = [...new Set(notification.recipients)].filter(
        (id) => id !== c.get("identity").user.id,
      );
      for (let index = 0; index < recipients.length; index += 50) {
        for (const query of prepareNotification(
          c.get("db"),
          {
            source_key: `drive:${operation}:${index}`,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            target_path: null,
            recipient_ids: recipients.slice(index, index + 50),
          },
          sql.raw(proof),
        )) {
          const compiled = query.toSQL();
          statements.push(c.env.DB.prepare(compiled.sql).bind(...compiled.params));
        }
      }
    }
  }
  const result = await c.env.DB.withSession("first-primary").batch(statements);
  if (result[0]!.meta.changes !== 1) {
    const actor = combine(
      sessionIdentity(c),
      permission(c.get("identity").user.id, "drive.access"),
    );
    if (!(await first(c.env, `SELECT 1 WHERE ${actor.sql}`, ...actor.args))) unauthorized();
    const action = actionCondition(c);
    if (!(await first(c.env, `SELECT 1 WHERE ${action.sql}`, ...action.args)))
      fail(403, t("driveMutations.driveActionIsRestrictedByYourRoleAccountStatus"));
    fail(412, t("driveMutations.driveItemOrPermissionsChangedReloadAndTryAgain"));
  }
  if (audit?.notification && c.env.NOTIFICATION_QUEUE)
    c.executionCtx.waitUntil(
      recoverNotifications(c.env).catch((error) =>
        console.error("Drive notification recovery failed", error),
      ),
    );
  return result;
}

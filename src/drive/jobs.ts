import { now, uuid } from "../auth/types";
import { first, rows, session, statement } from "./access";
import { purgeStatements } from "./lifecycle";
import { treeChanges } from "./mutations";
import type { DriveEnv } from "./types";
import { settings } from "./policy";
import { recoverAdminTransfers } from "./transfers";

// Recovery is bounded and repeatable. D1 owns the upload lifecycle; R2 remains private.
export async function recoverDrive(env: DriveEnv) {
  if (!env.DRIVE_BUCKET) return;
  await recoverAdminTransfers(env);
  const policy = await settings(env);
  const timestamp = now();
  const expired = await rows<{ id: string }>(
    env,
    `SELECT id FROM drive_uploads WHERE status NOT IN ('completed','cancelled')
    AND expires_at<=? AND lease_until<=? ORDER BY expires_at LIMIT 100`,
    timestamp,
    timestamp,
  );
  for (const { id } of expired)
    await session(env).batch([
      statement(
        env,
        `INSERT INTO drive_garbage(blob_key,not_before) SELECT blob_key,? FROM drive_uploads WHERE id=? AND expires_at<=?
      AND lease_until<=? AND status NOT IN ('completed','cancelled') ON CONFLICT(blob_key) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)`,
        timestamp,
        id,
        timestamp,
        timestamp,
      ),
      statement(
        env,
        `UPDATE drive_uploads SET status='cancelled' WHERE id=? AND expires_at<=? AND lease_until<=? AND status NOT IN ('completed','cancelled')`,
        id,
        timestamp,
        timestamp,
      ),
    ]);
  const trash = await rows<{ id: string }>(
    env,
    "SELECT id FROM drive_items WHERE trashed_at<=? AND purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM drive_admin_jobs WHERE (source_user_id=drive_items.owner_user_id OR target_user_id=drive_items.owner_user_id) AND status IN ('queued','running','failed')) ORDER BY trashed_at LIMIT 20",
    timestamp - policy.trash_retention_days * 86400,
  );
  for (const { id } of trash) {
    const operation = uuid(),
      proof = `EXISTS(SELECT 1 FROM drive_activity WHERE operation_id='${operation}')`;
    await session(env).batch([
      statement(
        env,
        `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,action,details_json)
        SELECT ?,id,owner_user_id,'trash_expired','{}' FROM drive_items WHERE id=? AND trashed_at<=? AND purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM drive_admin_jobs WHERE (source_user_id=drive_items.owner_user_id OR target_user_id=drive_items.owner_user_id) AND status IN ('queued','running','failed'))`,
        operation,
        id,
        timestamp - policy.trash_retention_days * 86400,
      ),
      treeChanges(env, id, "removed", [], proof),
      ...purgeStatements(env, id, proof),
    ]);
  }
  const grants = await rows<{ item_id: string; user_id: string; expires_at: number }>(
    env,
    "SELECT item_id,user_id,expires_at FROM drive_permissions WHERE expires_at<=? LIMIT 100",
    timestamp,
  );
  for (const grant of grants) {
    const operation = uuid(),
      proof = `EXISTS(SELECT 1 FROM drive_activity WHERE operation_id='${operation}')`;
    await session(env).batch([
      statement(
        env,
        `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,action,details_json) SELECT ?,id,owner_user_id,'permission_expired',? FROM drive_items
        WHERE id=? AND EXISTS(SELECT 1 FROM drive_permissions WHERE item_id=? AND user_id=? AND expires_at=?)`,
        operation,
        JSON.stringify({ user_id: grant.user_id }),
        grant.item_id,
        grant.item_id,
        grant.user_id,
        grant.expires_at,
      ),
      treeChanges(env, grant.item_id, "permissions", [grant.user_id], proof),
      statement(
        env,
        `DELETE FROM drive_permissions WHERE item_id=? AND user_id=? AND ${proof}`,
        grant.item_id,
        grant.user_id,
      ),
      statement(
        env,
        `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`,
        timestamp,
        grant.item_id,
      ),
    ]);
  }
  const garbage = await rows<{ blob_key: string }>(
    env,
    "SELECT blob_key FROM drive_garbage WHERE not_before<=? AND lease_until<=? LIMIT 100",
    timestamp,
    timestamp,
  );
  for (const { blob_key: key } of garbage) {
    const claimed = await statement(
      env,
      "UPDATE drive_garbage SET lease_until=? WHERE blob_key=? AND not_before<=? AND lease_until<=?",
      timestamp + 300,
      key,
      timestamp,
      timestamp,
    ).run();
    if (!claimed.meta.changes) continue;
    try {
      const pending = await first(
        env,
        "SELECT 1 FROM drive_uploads WHERE blob_key=? AND (status NOT IN ('cancelled','completed') OR lease_until>?)",
        key,
        timestamp,
      );
      if (pending) continue;
      const cancelled = await first<{ id: string; multipart_id: string | null }>(
        env,
        "SELECT id,multipart_id FROM drive_uploads WHERE blob_key=? AND status='cancelled'",
        key,
      );
      if (cancelled?.multipart_id) {
        await env.DRIVE_BUCKET.resumeMultipartUpload(key, cancelled.multipart_id).abort();
        await statement(
          env,
          "UPDATE drive_uploads SET multipart_id=NULL WHERE id=? AND status='cancelled'",
          cancelled.id,
        ).run();
      }
      if (!(await first(env, "SELECT 1 FROM drive_versions WHERE blob_key=?", key)))
        await env.DRIVE_BUCKET.delete(key);
      await statement(
        env,
        "DELETE FROM drive_garbage WHERE blob_key=? AND lease_until=?",
        key,
        timestamp + 300,
      ).run();
    } catch (error) {
      console.error("Drive storage cleanup failed", error);
    } finally {
      await statement(
        env,
        "UPDATE drive_garbage SET lease_until=0 WHERE blob_key=? AND lease_until=?",
        key,
        timestamp + 300,
      ).run();
    }
  }
  await statement(
    env,
    "DELETE FROM drive_operations WHERE created_at<?",
    timestamp - 7 * 86400,
  ).run();
}

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { body } from "../auth/input";
import { now, uuid, type AppEnv } from "../auth/types";
import { requirePermission } from "../authorization/access";
import { createDatabase } from "../db";
import { prepareNotification } from "../notifications/service";
import { recoverNotifications } from "../notifications/jobs";
import { activeUser, ancestors, condition, descendants, driveEnabled, first, permission, rows, statement } from "./access";
import { adminMutate, noTransfer, reason } from "./admin-store";
import { cursor, readCursor } from "./cursor";
import { fail, identifier, integer } from "./input";
import { limit } from "./items";
import type { DriveEnv, DriveItem } from "./types";

export interface TransferJob {
  id: string; source_user_id: string; target_user_id: string; root_item_id: string | null; root_trashed_at: number | null; actor_user_id: string;
  reason: string; status: "queued" | "running" | "failed" | "completed" | "cancelled";
  total_items: number; processed_items: number; reserved_bytes: number; error: string | null;
  version: number; created_at: number; updated_at: number;
}
export const transferRoutes = new Hono<AppEnv>();
transferRoutes.get("/", requirePermission("admin.drive.accounts.read"), async c => {
  const account = c.req.query("account") ? identifier(c.req.query("account")) : "", scope = JSON.stringify(["admin.transfers", account]);
  const after = c.req.query("cursor") ? await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!) : [Number.MAX_SAFE_INTEGER, "~"] as [number, string];
  const result = await rows<TransferJob>(c.env, `SELECT j.*,s.email_address source_email,t.email_address target_email FROM drive_admin_jobs j JOIN users s ON s.id=j.source_user_id JOIN users t ON t.id=j.target_user_id WHERE (j.created_at<? OR (j.created_at=? AND j.id<?))${account ? " AND (j.source_user_id=? OR j.target_user_id=?)" : ""} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`, after[0], after[0], after[1], ...(account ? [account, account] : []), limit(c) + 1);
  const entries = result.slice(0, limit(c));
  return c.json({ items: entries, next_cursor: result.length > entries.length ? await cursor(c.env, c.get("identity").user.id, scope, [entries.at(-1)!.created_at, entries.at(-1)!.id]) : null });
});
transferRoutes.post("/", requirePermission("admin.drive.ownership.transfer"), async c => {
  const data = await body(c, ["source_user_id", "target_user_id", "item_id", "version", "reason"]), target = identifier(data.target_user_id, "target_user_id");
  const root = data.item_id == null ? null : await first<DriveItem>(c.env, "SELECT * FROM drive_items WHERE id=? AND purged_at IS NULL", identifier(data.item_id, "item_id"));
  if (data.item_id != null && !root) fail(404, "Drive item not found");
  const source = root?.owner_user_id ?? identifier(data.source_user_id, "source_user_id");
  if (source === target) fail(400, "Choose a different destination account");
  if (!await first(c.env, "SELECT id FROM users WHERE id=?", source)) fail(404, "Source account not found");
  const eligible = condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")}) AND NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND status<>'active')`, target, target);
  if (!await first(c.env, `SELECT 1 WHERE ${eligible.sql}`, ...eligible.args)) fail(400, "Destination must have active, writable Drive access");
  const originalAccount = await first<{ version: number }>(c.env, "SELECT version FROM drive_accounts WHERE user_id=?", source);
  if (integer(data.version, "version", 0) !== (root?.version ?? originalAccount?.version ?? 0)) fail(412, "Source changed. Reload and try again.");
  const selection = `d.owner_user_id=? AND d.purged_at IS NULL${root ? ` AND d.id IN (${descendants("?")})` : ""}`, args = root ? [source, root.id] : [source];
  const totals = (await first<{ count: number; size: number }>(c.env, `SELECT COUNT(*) count,COALESCE(SUM((SELECT COALESCE(SUM(size),0) FROM drive_versions WHERE item_id=d.id)),0) size FROM drive_items d WHERE ${selection}`, ...args))!;
  if (!totals.count) fail(400, "No items available for transfer");
  if (await first(c.env, "SELECT 1 FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled') LIMIT 1", source)) fail(409, "Finish or cancel the source account's unfinished uploads before transferring ownership");
  integer(totals.size, "transfer_size");
  const destination = (await first<{ quota_bytes: number; used_bytes: number; reserved_bytes: number }>(c.env, "SELECT COALESCE(a.quota_bytes,s.default_quota_bytes) quota_bytes,COALESCE(a.used_bytes,0) used_bytes,COALESCE(a.reserved_bytes,0) reserved_bytes FROM users u CROSS JOIN drive_settings s LEFT JOIN drive_accounts a ON a.user_id=u.id WHERE u.id=? AND s.id=1", target))!;
  if (destination.used_bytes + destination.reserved_bytes + totals.size > destination.quota_bytes) fail(413, "Destination storage is insufficient");
  const job = uuid();
  const trash = root ? await first<{ trashed_at: number | null }>(c.env, `${ancestors("?")} SELECT MIN(trashed_at) trashed_at FROM ancestors`, root.id) : null;
  await adminMutate(c, "admin.drive.ownership.transfer", [eligible, noTransfer(source), noTransfer(target),
    condition("EXISTS(SELECT 1 FROM users u CROSS JOIN drive_settings s LEFT JOIN drive_accounts a ON a.user_id=u.id WHERE u.id=? AND s.id=1 AND COALESCE(a.used_bytes,0)+COALESCE(a.reserved_bytes,0)+?<=COALESCE(a.quota_bytes,s.default_quota_bytes))", target, totals.size),
    root ? condition("EXISTS(SELECT 1 FROM drive_items WHERE id=? AND version=? AND owner_user_id=? AND purged_at IS NULL)", root.id, root.version, source) : originalAccount ? condition("EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND version=?)", source, originalAccount.version) : condition("NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=?)", source),
    condition(`?=(SELECT COUNT(*) FROM drive_items d WHERE ${selection}) AND ?=(SELECT COALESCE(SUM((SELECT COALESCE(SUM(size),0) FROM drive_versions WHERE item_id=d.id)),0) FROM drive_items d WHERE ${selection})`, totals.count, ...args, totals.size, ...args),
    condition("NOT EXISTS(SELECT 1 FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled'))", source),
  ], (proof, operation) => [
    statement(c.env, `INSERT OR IGNORE INTO drive_accounts(user_id,quota_bytes,updated_at) SELECT value,default_quota_bytes,unixepoch() FROM drive_settings s CROSS JOIN json_each(?) WHERE s.id=1 AND ${proof}`, JSON.stringify([source, target])),
    statement(c.env, `INSERT INTO drive_admin_jobs(id,source_user_id,target_user_id,root_item_id,root_trashed_at,actor_user_id,reason,status,total_items,reserved_bytes) SELECT ?,?,?,?,?,?,?,'queued',?,? WHERE ${proof}`, job, source, target, root?.id ?? null, trash?.trashed_at ?? null, c.get("identity").user.id, reason(data.reason), totals.count, totals.size),
    statement(c.env, `INSERT INTO drive_admin_job_items(job_id,item_id,parent_id,item_version,size) SELECT ?,d.id,d.parent_id,d.version,(SELECT COALESCE(SUM(size),0) FROM drive_versions WHERE item_id=d.id) FROM drive_items d WHERE ${selection} AND ${proof}`, job, ...args),
    statement(c.env, `UPDATE drive_accounts SET reserved_bytes=reserved_bytes+? WHERE user_id=? AND ${proof}`, totals.size, target),
    statement(c.env, `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,actor_user_id,link_id,action,details_json) SELECT ?||':link:'||l.id,l.item_id,d.owner_user_id,?,l.id,'admin_link_revoked',json_object('job_id',?,'link_id',l.id) FROM drive_links l JOIN drive_items d ON d.id=l.item_id WHERE l.item_id IN (SELECT item_id FROM drive_admin_job_items WHERE job_id=?) AND l.revoked_at IS NULL AND ${proof}`, operation, c.get("identity").user.id, job, job),
    statement(c.env, `UPDATE drive_links SET revoked_at=? WHERE item_id IN (SELECT item_id FROM drive_admin_job_items WHERE job_id=?) AND revoked_at IS NULL AND ${proof}`, now(), job),
  ], { action: "transfer_started", type: "transfer", id: job, details: { source_user_id: source, target_user_id: target, root_item_id: root?.id ?? null, total_items: totals.count, size: totals.size, reason: reason(data.reason) } });
  c.executionCtx.waitUntil(recoverAdminTransfers(c.env, job));
  return c.json({ job: await first<TransferJob>(c.env, "SELECT * FROM drive_admin_jobs WHERE id=?", job) }, 202);
});
for (const action of ["retry", "cancel"] as const) transferRoutes.post(`/:jobId/${action}`, requirePermission("admin.drive.ownership.transfer"), async c => {
  const data = await body(c, ["version", "reason"]), id = identifier(c.req.param("jobId")), job = await first<TransferJob>(c.env, "SELECT * FROM drive_admin_jobs WHERE id=?", id);
  if (!job) fail(404, "Transfer not found");
  if (["completed", "cancelled"].includes(job.status)) fail(409, "Transfer already finished");
  if (action === "cancel" && job.processed_items > 0) fail(409, "A partially completed transfer must be resumed to preserve folder ownership");
  await adminMutate(c, "admin.drive.ownership.transfer", [condition("EXISTS(SELECT 1 FROM drive_admin_jobs WHERE id=? AND version=? AND status IN ('queued','running','failed'))", id, integer(data.version, "version", 1)), ...(action === "cancel" ? [condition("EXISTS(SELECT 1 FROM drive_admin_jobs WHERE id=? AND processed_items=0)", id)] : [])], proof => [
    statement(c.env, `UPDATE drive_admin_jobs SET status=?,error=NULL,actor_user_id=?,version=version+1,updated_at=?${action === "cancel" ? ",reserved_bytes=0" : ""} WHERE id=? AND ${proof}`, action === "cancel" ? "cancelled" : "queued", c.get("identity").user.id, now(), id),
    ...(action === "cancel" ? [statement(c.env, `UPDATE drive_accounts SET reserved_bytes=reserved_bytes-? WHERE user_id=? AND ${proof}`, job.reserved_bytes, job.target_user_id)] : []),
  ], { action: `transfer_${action === "cancel" ? "cancelled" : "resumed"}`, type: "transfer", id, details: { reason: reason(data.reason), processed_items: job.processed_items } });
  if (action === "retry") c.executionCtx.waitUntil(recoverAdminTransfers(c.env, id));
  return c.json({ job: await first<TransferJob>(c.env, "SELECT * FROM drive_admin_jobs WHERE id=?", id) });
});

async function stop(env: DriveEnv, job: TransferJob, error: string) {
  const operation = uuid(), proof = `EXISTS(SELECT 1 FROM drive_admin_activity WHERE operation_id='${operation}')`;
  await env.DB.withSession("first-primary").batch([
    statement(env, "INSERT INTO drive_admin_activity(operation_id,actor_user_id,action,target_type,target_id,details_json) SELECT ?,actor_user_id,'transfer_failed','transfer',id,? FROM drive_admin_jobs WHERE id=? AND version=? AND status IN ('queued','running')", operation, JSON.stringify({ error, processed_items: job.processed_items }), job.id, job.version),
    statement(env, `UPDATE drive_admin_jobs SET status='failed',error=?,version=version+1,updated_at=? WHERE id=? AND ${proof}`, error, now(), job.id),
  ]);
}
async function runChunk(env: DriveEnv, job: TransferJob): Promise<boolean> {
  const rights = permission(job.actor_user_id, "admin.drive.ownership.transfer");
  const authorized = condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")}) AND ${rights.sql}`, job.actor_user_id, ...rights.args);
  const target = condition(`EXISTS(SELECT 1 FROM users u JOIN drive_accounts a ON a.user_id=u.id WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")} AND a.status='active' AND a.used_bytes+a.reserved_bytes<=a.quota_bytes)`, job.target_user_id);
  if (!await first(env, `SELECT 1 WHERE ${authorized.sql}`, ...authorized.args)) { await stop(env, job, "Transfer administrator no longer has the required permission"); return false; }
  if (!await first(env, `SELECT 1 WHERE ${target.sql}`, ...target.args)) { await stop(env, job, "Destination is unavailable or its storage limit is insufficient"); return false; }
  const entries = await rows<{ item_id: string; parent_id: string | null; item_version: number; size: number }>(env, `SELECT ji.item_id,ji.parent_id,ji.item_version,ji.size FROM drive_admin_job_items ji WHERE ji.job_id=? AND ji.processed=0 AND NOT EXISTS(SELECT 1 FROM drive_admin_job_items parent WHERE parent.job_id=ji.job_id AND parent.item_id=ji.parent_id AND parent.processed=0) ORDER BY ji.item_id LIMIT 16`, job.id);
  if (!entries.length) { await stop(env, job, "Folder hierarchy no longer matches the transfer snapshot"); return false; }
  const size = entries.reduce((sum, entry) => sum + entry.size, 0), completed = job.processed_items + entries.length === job.total_items;
  const matches = condition(`NOT EXISTS(WITH snapshot AS (SELECT json_extract(value,'$.item_id') id,json_extract(value,'$.item_version') version FROM json_each(?)) SELECT 1 FROM snapshot s LEFT JOIN drive_items d ON d.id=s.id WHERE d.id IS NULL OR d.owner_user_id<>? OR d.version<>s.version OR d.purged_at IS NOT NULL)`, JSON.stringify(entries), job.source_user_id);
  if (!await first(env, `SELECT 1 WHERE ${matches.sql}`, ...matches.args)) { await stop(env, job, "A source item changed; resolve the ownership conflict before retrying"); return false; }
  const operation = uuid(), proof = `EXISTS(SELECT 1 FROM drive_admin_activity WHERE operation_id='${operation}')`;
  const statements = [
    statement(env, `INSERT INTO drive_admin_activity(operation_id,actor_user_id,action,target_type,target_id,details_json) SELECT ?,actor_user_id,?,'transfer',id,? FROM drive_admin_jobs WHERE id=? AND version=? AND status IN ('queued','running') AND ${authorized.sql} AND ${target.sql} AND ${matches.sql} AND EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND used_bytes>=?)`, operation, completed ? "transfer_completed" : "transfer_progress", JSON.stringify({ source_user_id: job.source_user_id, target_user_id: job.target_user_id, processed_items: job.processed_items + entries.length, total_items: job.total_items, reason: job.reason }), job.id, job.version, ...authorized.args, ...target.args, ...matches.args, job.source_user_id, size),
    ...entries.flatMap(entry => [
      statement(env, `UPDATE drive_items SET owner_user_id=?,parent_id=CASE WHEN parent_id IN (SELECT item_id FROM drive_admin_job_items WHERE job_id=?) THEN parent_id ELSE NULL END,trashed_at=CASE WHEN id=? THEN COALESCE(trashed_at,?) ELSE trashed_at END,version=version+1,updated_at=? WHERE id=? AND ${proof}`, job.target_user_id, job.id, job.root_item_id, job.root_trashed_at, now(), entry.item_id),
      statement(env, `UPDATE drive_admin_job_items SET processed=1 WHERE job_id=? AND item_id=? AND ${proof}`, job.id, entry.item_id),
      statement(env, `DELETE FROM drive_permissions WHERE item_id=? AND user_id=? AND ${proof}`, entry.item_id, job.target_user_id),
      statement(env, `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,actor_user_id,action,details_json) SELECT ?,id,owner_user_id,?,'admin_ownership_transferred',? FROM drive_items WHERE id=? AND ${proof}`, `${operation}:${entry.item_id}`, job.actor_user_id, JSON.stringify({ job_id: job.id, from_user_id: job.source_user_id, to_user_id: job.target_user_id }), entry.item_id),
      statement(env, `INSERT INTO drive_changes(user_id,item_id,kind) SELECT value,?,'permissions' FROM json_each(?) WHERE ${proof}`, entry.item_id, JSON.stringify([job.source_user_id, job.target_user_id])),
    ]),
    statement(env, `UPDATE drive_accounts SET used_bytes=used_bytes-? WHERE user_id=? AND ${proof}`, size, job.source_user_id),
    statement(env, `UPDATE drive_accounts SET used_bytes=used_bytes+?,reserved_bytes=reserved_bytes-? WHERE user_id=? AND ${proof}`, size, size, job.target_user_id),
    statement(env, `UPDATE drive_admin_jobs SET status=?,processed_items=processed_items+?,reserved_bytes=reserved_bytes-?,version=version+1,error=NULL,updated_at=? WHERE id=? AND ${proof}`, completed ? "completed" : "running", entries.length, size, now(), job.id),
  ];
  if (completed) statements.push(statement(env, `INSERT INTO drive_changes(user_id,item_id,kind) SELECT u.id,d.id,'permissions' FROM drive_items d JOIN users u WHERE d.id IN (SELECT item_id FROM drive_admin_job_items WHERE job_id=?) AND ${activeUser("u")} AND ${driveEnabled("u")} AND ${proof} AND (u.id=d.owner_user_id OR EXISTS(SELECT 1 FROM drive_permissions p WHERE p.user_id=u.id AND (p.expires_at IS NULL OR p.expires_at>unixepoch()) AND p.item_id IN (${ancestors("d.id")} SELECT id FROM ancestors)))`, job.id));
  if (completed) for (const query of prepareNotification(createDatabase(env.DB), { source_key: `drive-transfer:${job.id}`, type: "drive.shared", title: "Drive ownership transfer completed", body: `${job.total_items} Drive items were transferred to the destination account. Public links were revoked.`, target_path: null, recipient_ids: [...new Set([job.source_user_id, job.target_user_id])] }, sql.raw(proof))) {
    const compiled = query.toSQL(); statements.push(env.DB.prepare(compiled.sql).bind(...compiled.params));
  }
  const result = await env.DB.withSession("first-primary").batch(statements);
  if (result[0]!.meta.changes !== 1) {
    const current = await first<TransferJob>(env, "SELECT * FROM drive_admin_jobs WHERE id=?", job.id);
    if (current?.version === job.version) await stop(env, job, "Authorization, storage or the source snapshot changed during transfer");
    return false;
  }
  return !completed;
}
export async function recoverAdminTransfers(env: DriveEnv, id?: string) {
  const jobs = await rows<TransferJob>(env, `SELECT * FROM drive_admin_jobs WHERE status IN ('queued','running')${id ? " AND id=?" : ""} ORDER BY created_at LIMIT 2`, ...(id ? [id] : []));
  for (let job of jobs) {
    try {
      for (let chunk = 0; chunk < 32; chunk++) {
        if (!await runChunk(env, job)) break;
        job = (await first<TransferJob>(env, "SELECT * FROM drive_admin_jobs WHERE id=?", job.id))!;
        if (!["queued", "running"].includes(job.status)) break;
      }
    } catch (error) {
      console.error("Drive administrative transfer failed", error);
      const current = await first<TransferJob>(env, "SELECT * FROM drive_admin_jobs WHERE id=?", job.id);
      if (current && ["queued", "running"].includes(current.status)) await stop(env, current, "Transfer could not continue. Review the source hierarchy and retry.");
    }
  }
  if (env.NOTIFICATION_QUEUE) await recoverNotifications(env);
}

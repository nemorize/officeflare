import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/types";
import type { Permission } from "../authorization/permissions";
import { requestPermissions } from "../authorization/access";
import { actionCondition, condition, first, writableOwner } from "./access";
import { fail } from "./input";
import type { DriveContext, DriveEnv } from "./types";

export interface DriveSettings {
  id: number; default_quota_bytes: number; max_file_bytes: number;
  internal_sharing_enabled: number; public_sharing_enabled: number;
  public_link_password_required: number; public_link_max_days: number;
  trash_retention_days: number; version: number; updated_at: number; updated_by: string | null;
}
export async function settings(env: DriveEnv) {
  const value = await first<DriveSettings>(env, "SELECT * FROM drive_settings WHERE id=1");
  if (!value) fail(503, "Drive settings are unavailable");
  return value;
}
export function requestSettings(c: DriveContext) {
  let pending = c.get("drivePolicy");
  if (!pending) { pending = settings(c.env); c.set("drivePolicy", pending); }
  return pending;
}
export function requestWritable(c: DriveContext) {
  let pending = c.get("driveWritable");
  if (!pending) { const check = writableOwner(c.get("identity").user.id); pending = first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args).then(Boolean); c.set("driveWritable", pending); }
  return pending;
}
export const uploadPolicy = (size: number) => condition("EXISTS(SELECT 1 FROM drive_settings WHERE id=1 AND max_file_bytes>=?)", size);
export function linkPolicy(passwordProtected: boolean, expires: number | null, created = Math.floor(Date.now() / 1000)) {
  return condition(`EXISTS(SELECT 1 FROM drive_settings WHERE id=1 AND public_sharing_enabled=1 AND (public_link_password_required=0 OR ?=1) AND (public_link_max_days=0 OR (? IS NOT NULL AND ?>unixepoch() AND ?<=?+public_link_max_days*86400)))`, +passwordProtected, expires, expires, expires, created);
}
export const publicLinkPolicy = (alias: string) => `EXISTS(SELECT 1 FROM drive_settings policy WHERE policy.id=1 AND policy.public_sharing_enabled=1 AND (policy.public_link_password_required=0 OR ${alias}.password_hash IS NOT NULL) AND (policy.public_link_max_days=0 OR (${alias}.expires_at IS NOT NULL AND ${alias}.expires_at<=${alias}.created_at+policy.public_link_max_days*86400)))`;
export async function driveAbilities(c: DriveContext) {
  const [grants, policy, writable] = await Promise.all([requestPermissions(c), requestSettings(c), requestWritable(c)]);
  return (item: { effective_role?: string | null }, ownerWritable: boolean) => {
    const owner = item.effective_role === "owner", edit = owner || item.effective_role === "editor", comment = edit || item.effective_role === "commenter";
    const has = (key: string) => grants.includes(key as Permission), writeToOwner = writable && ownerWritable;
    return { create: writeToOwner && edit && has("drive.files.create"), update: writeToOwner && edit && has("drive.files.update"), delete: writeToOwner && owner && has("drive.files.delete"), download: has("drive.files.download"), copy: writable && has("drive.files.create") && has("drive.files.download"), comment: writeToOwner && comment && has("drive.comments.create"), internal_share: writeToOwner && owner && has("drive.sharing.internal") && !!policy.internal_sharing_enabled, public_share: writeToOwner && owner && has("drive.sharing.public") && !!policy.public_sharing_enabled };
  };
}
async function actionBody(c: DriveContext) {
  try { return await c.req.json<Record<string, unknown>>(); } catch { fail(400, "Invalid JSON request body"); }
}
// Establish action permissions once, then repeat the same check inside D1 writes and after R2 reads.
export const requireDriveAction = createMiddleware<AppEnv>(async (c, next) => {
  const path = c.req.path.slice("/api/drive".length), method = c.req.method;
  const actions: Permission[] = [];
  if ((method === "GET" || method === "HEAD") && /\/content$/.test(path)) actions.push("drive.files.download");
  if (method !== "GET" && method !== "HEAD") {
    if (path === "/folders") actions.push("drive.files.create");
    else if (path.startsWith("/uploads")) {
      if (method !== "DELETE") {
        const existing = path === "/uploads" || path === "/uploads/" ? (await actionBody(c))?.item_id != null
          : !!(await first<{ base_version: number }>(c.env, "SELECT base_version FROM drive_uploads WHERE id=?", path.split("/")[2] ?? ""))?.base_version;
        actions.push(existing ? "drive.files.update" : "drive.files.create");
      }
    } else if (/\/links(?:\/[^/]+)?$/.test(path)) {
      const data = await actionBody(c);
      if (!data || Array.isArray(data) || typeof data !== "object") fail(400, "Invalid request body");
      if (!(method === "PATCH" && data.revoked === true && Object.keys(data).every(key => ["version", "revoked"].includes(key)))) actions.push("drive.sharing.public");
    } else if (/\/permissions\/[^/]+$/.test(path)) { if (method !== "DELETE") actions.push("drive.sharing.internal"); }
    else if (/\/access-requests\/[^/]+$/.test(path) || /\/transfer$/.test(path)) actions.push("drive.sharing.internal");
    else if (/\/comments(?:\/[^/]+)?$/.test(path)) actions.push("drive.comments.create");
    else if (/\/copy$/.test(path)) actions.push("drive.files.create", "drive.files.download");
    else if (/\/versions\/[^/]+/.test(path)) actions.push("drive.files.update");
    else if (/^\/items\/[^/]+$/.test(path)) {
      if (method === "DELETE") actions.push("drive.files.delete");
      else {
        const data = await actionBody(c);
        if (!data || Array.isArray(data) || typeof data !== "object") fail(400, "Invalid request body");
        if (data.trashed === true) actions.push("drive.files.delete");
        if (data.trashed !== true || Object.keys(data).some(key => !["version", "trashed"].includes(key))) actions.push("drive.files.update");
      }
    }
  }
  c.set("driveAction", actions);
  const action = actionCondition(c);
  const check = { sql: `(${action.sql}) AND NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND status='suspended')`, args: [...action.args, c.get("identity").user.id] };
  if (!await first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args)) fail(403, "Drive action is restricted by your role, account status or workspace policy");
  await next();
});

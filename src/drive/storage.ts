import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import { body, unauthorized } from "../auth/input";
import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { audience, combine, condition, first, identity, itemCondition, requireItem, rows, statement, writableOwner } from "./access";
import { checksum, fail, identifier, integer, mime, name } from "./input";
import { mutate } from "./mutations";
import { MAX_FILE_BYTES, PART_BYTES, type Condition, type DriveContext, type DriveUpload } from "./types";
import { settings, uploadPolicy } from "./policy";

export async function account(c: DriveContext, owner = c.get("identity").user.id) {
  const check = identity(c);
  await statement(c.env, `INSERT OR IGNORE INTO drive_accounts(user_id,quota_bytes,updated_at) SELECT ?,default_quota_bytes,unixepoch() FROM drive_settings WHERE id=1 AND ${check.sql}`, owner, ...check.args).run();
  const result = await first<{ user_id: string; quota_bytes: number; used_bytes: number; reserved_bytes: number; status: string; version: number; quota_override_bytes: number | null }>(c.env, "SELECT user_id,quota_bytes,used_bytes,reserved_bytes,status,version,quota_override_bytes FROM drive_accounts WHERE user_id=?", owner);
  if (!result) unauthorized();
  return result;
}
export async function destination(c: DriveContext, parent: unknown) {
  if (parent === undefined || parent === null || parent === "root") return { parent_id: null, owner_user_id: c.get("identity").user.id,
    check: condition("1") };
  const folder = await requireItem(c, identifier(parent, "parent_id"), "edit");
  if (folder.kind !== "folder") fail(400, "The destination must be a folder");
  return { parent_id: folder.id, owner_user_id: folder.owner_user_id,
    check: condition(`EXISTS(SELECT 1 FROM drive_items d WHERE d.id=? AND d.kind='folder' AND d.owner_user_id=?)`, folder.id, folder.owner_user_id),
    access: itemCondition(c, folder.id, undefined, "edit") };
}
export const quotaCondition = (owner: string, size: number) => combine(writableOwner(owner), condition("EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND used_bytes+reserved_bytes+?<=quota_bytes)", owner, size));
export async function ensureCapacity(c: DriveContext, owner: string, size: number) {
  const quota = (await account(c, owner))!;
  if (quota.used_bytes + quota.reserved_bytes + size > quota.quota_bytes) fail(413, "Drive storage quota exceeded");
}
const uploadView = (upload: DriveUpload) => ({ id: upload.id, item_id: upload.item_id, parent_id: upload.parent_id, name: upload.name,
  size: upload.size, content_type: upload.content_type, mode: upload.mode, status: upload.status, expires_at: upload.expires_at,
  part_bytes: PART_BYTES, part_count: upload.mode === "single" ? 1 : Math.ceil(upload.size / PART_BYTES) });
async function requireUpload(c: DriveContext) {
  const upload = await first<DriveUpload>(c.env, "SELECT * FROM drive_uploads WHERE id=? AND created_by=?", identifier(c.req.param("uploadId")), c.get("identity").user.id);
  if (!upload) fail(404, "Upload not found");
  if (upload.status === "cancelled" || upload.expires_at <= now() && upload.status !== "completed") fail(410, "Upload expired or cancelled");
  await uploadTarget(c, upload);
  return upload;
}
async function uploadTarget(c: DriveContext, upload: DriveUpload) {
  if (upload.base_version > 0) await requireItem(c, upload.item_id, "edit");
  else if (upload.parent_id) await requireItem(c, upload.parent_id, "edit");
  else if (upload.owner_user_id !== c.get("identity").user.id) fail(404, "Upload not found");
}
function uploadChecks(c: DriveContext, upload: DriveUpload, states: string[], final = false, lease?: string): Condition[] {
  const checks = [uploadPolicy(upload.size), writableOwner(upload.owner_user_id), condition(`EXISTS(SELECT 1 FROM drive_uploads WHERE id=? AND created_by=? AND owner_user_id=? AND expires_at>?
    AND status IN (${states.map(() => "?").join(",")})${lease ? " AND lease_token=?" : ""})`,
    upload.id, c.get("identity").user.id, upload.owner_user_id, now(), ...states, ...(lease ? [lease] : []))];
  if (upload.base_version > 0) checks.push(itemCondition(c, upload.item_id, final ? upload.base_version : undefined, "edit"),
    condition("EXISTS(SELECT 1 FROM drive_items WHERE id=? AND owner_user_id=?)", upload.item_id, upload.owner_user_id));
  else if (upload.parent_id) checks.push(itemCondition(c, upload.parent_id, undefined, "edit"),
    condition("EXISTS(SELECT 1 FROM drive_items WHERE id=? AND kind='folder' AND owner_user_id=?)", upload.parent_id, upload.owner_user_id));
  else checks.push(condition("?=?", upload.owner_user_id, c.get("identity").user.id));
  if (final) checks.push(quotaCondition(upload.owner_user_id, 0));
  return checks;
}
async function payload(c: DriveContext, expected: number) {
  const declared = c.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== expected)) fail(400, "Upload size mismatch");
  const content = await c.req.arrayBuffer();
  if (content.byteLength !== expected || content.byteLength > PART_BYTES) fail(400, "Upload size mismatch");
  return content;
}
const sha256 = async (content: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))].map(value => value.toString(16).padStart(2, "0")).join("");
const leaseExpired = (upload: DriveUpload) => upload.lease_until <= now();

export const uploads = new Hono<AppEnv>();
uploads.post("/", async c => {
  const data = await body(c, ["item_id", "version", "parent_id", "name", "size", "content_type", "mode", "sha256"]);
  const size = integer(data.size, "size", 0, MAX_FILE_BYTES), contentType = mime(data.content_type), hash = checksum(data.sha256);
  if (size > (await settings(c.env)).max_file_bytes) fail(413, "File exceeds the workspace file size limit");
  const mode = data.mode ?? (size <= PART_BYTES ? "single" : "multipart");
  if (mode !== "single" && mode !== "multipart") fail(400, "Invalid upload mode");
  if (mode === "single" && size > PART_BYTES || mode === "multipart" && size === 0) fail(400, "Invalid upload size for this mode");
  if (mode === "multipart" && hash) fail(400, "Full-file SHA-256 is supported for single uploads; multipart parts accept X-Content-SHA256");
  const id = uuid(), itemId = data.item_id === undefined ? uuid() : identifier(data.item_id, "item_id");
  const existing = data.item_id === undefined ? null : await requireItem(c, itemId, "edit");
  if (existing?.kind === "folder") fail(400, "Folders have no file content");
  if (existing && (data.name !== undefined || data.parent_id !== undefined) || !existing && data.version !== undefined) fail(400, "Content uploads cannot move or rename items");
  const target = existing ? { parent_id: existing.parent_id, owner_user_id: existing.owner_user_id, check: itemCondition(c, itemId, integer(data.version, "version", 1), "edit") } : await destination(c, data.parent_id);
  const uploadName = existing?.name ?? name(data.name), base = existing ? integer(data.version, "version", 1) : 0;
  await ensureCapacity(c, target.owner_user_id, size);
  const key = `drive/objects/${target.owner_user_id}/${id}`, expires = now() + 86400;
  await mutate(c, [uploadPolicy(size), target.check, ...("access" in target && target.access ? [target.access] : []), quotaCondition(target.owner_user_id, size)], proof => [
    statement(c.env, `INSERT INTO drive_uploads(id,owner_user_id,created_by,item_id,parent_id,name,base_version,size,content_type,sha256,mode,blob_key,status,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'allocating',? WHERE ${proof}`, id, target.owner_user_id, c.get("identity").user.id, itemId, target.parent_id, uploadName, base, size, contentType, hash, mode, key, expires),
  ]);
  let multipart: R2MultipartUpload | null = null;
  try {
    multipart = mode === "multipart" ? await c.env.DRIVE_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType }, customMetadata: { upload_id: id } }) : null;
    await mutate(c, [uploadPolicy(size), writableOwner(target.owner_user_id), condition("EXISTS(SELECT 1 FROM drive_uploads WHERE id=? AND status='allocating')", id), target.check,
      ...("access" in target && target.access ? [target.access] : [])], proof => [statement(c.env,
        `UPDATE drive_uploads SET status='open',multipart_id=? WHERE id=? AND ${proof}`, multipart?.uploadId ?? null, id)]);
  } catch (error) {
    if (multipart) {
      await statement(c.env, "UPDATE drive_uploads SET multipart_id=? WHERE id=? AND status='allocating'", multipart.uploadId, id).run();
      await multipart.abort().catch(abortError => console.error("Drive multipart abort failed", abortError));
    }
    await statement(c.env, "UPDATE drive_uploads SET status='cancelled' WHERE id=? AND status='allocating'", id).run();
    await statement(c.env, "INSERT OR IGNORE INTO drive_garbage(blob_key) VALUES(?)", key).run();
    throw error;
  }
  return c.json({ upload: uploadView((await first<DriveUpload>(c.env, "SELECT * FROM drive_uploads WHERE id=?", id))!) }, 201);
});
uploads.get("/:uploadId", async c => {
  const upload = await requireUpload(c);
  const parts = await rows<{ part_number: number; size: number; etag: string }>(c.env, "SELECT part_number,size,etag FROM drive_upload_parts WHERE upload_id=? ORDER BY part_number", upload.id);
  return c.json({ upload: uploadView(upload), parts });
});
uploads.put("/:uploadId/content", async c => {
  const upload = await requireUpload(c);
  if (upload.mode !== "single") fail(400, "Use multipart parts for this upload");
  const content = await payload(c, upload.size), hash = await sha256(content);
  if (upload.sha256 && upload.sha256 !== hash) fail(400, "SHA-256 mismatch");
  if (upload.status === "ready") return c.json({ upload: uploadView(upload) });
  if (upload.status === "writing" && leaseExpired(upload)) await statement(c.env, "UPDATE drive_uploads SET status='open' WHERE id=? AND lease_until<=? AND status='writing'", upload.id, now()).run();
  const lease = uuid();
  await mutate(c, uploadChecks(c, upload, ["open"]), proof => [statement(c.env,
    `UPDATE drive_uploads SET status='writing',lease_token=?,lease_until=? WHERE id=? AND ${proof}`, lease, now() + 300, upload.id)]);
  try {
    let object = await c.env.DRIVE_BUCKET.put(upload.blob_key, content, { onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: upload.content_type }, customMetadata: { upload_id: upload.id, sha256: hash } });
    if (!object) object = await c.env.DRIVE_BUCKET.head(upload.blob_key);
    if (!object || object.size !== upload.size || object.customMetadata?.sha256 !== hash) fail(409, "Upload content changed; create a new upload");
    await mutate(c, uploadChecks(c, upload, ["writing"], false, lease), proof => [statement(c.env,
      `UPDATE drive_uploads SET status='ready',sha256=?,lease_until=0,lease_token=NULL WHERE id=? AND ${proof}`, hash, upload.id)]);
  } catch (error) {
    await statement(c.env, "UPDATE drive_uploads SET status='open',lease_until=0,lease_token=NULL WHERE id=? AND status='writing' AND lease_token=?", upload.id, lease).run();
    throw error;
  }
  return c.json({ upload: uploadView({ ...upload, status: "ready", sha256: hash }) });
});
uploads.put("/:uploadId/parts/:part", async c => {
  const upload = await requireUpload(c);
  if (upload.mode !== "multipart" || !upload.multipart_id) fail(400, "Not a multipart upload");
  const part = integer(Number(c.req.param("part")), "part_number", 1, Math.ceil(upload.size / PART_BYTES));
  const size = Math.min(PART_BYTES, upload.size - (part - 1) * PART_BYTES), content = await payload(c, size);
  const expected = checksum(c.req.header("x-content-sha256"));
  if (expected && await sha256(content) !== expected) fail(400, "Part SHA-256 mismatch");
  if (upload.status === "writing" && leaseExpired(upload)) await statement(c.env, "UPDATE drive_uploads SET status='open' WHERE id=? AND lease_until<=? AND status='writing'", upload.id, now()).run();
  const lease = uuid();
  await mutate(c, uploadChecks(c, upload, ["open"]), proof => [statement(c.env,
    `UPDATE drive_uploads SET status='writing',lease_token=?,lease_until=? WHERE id=? AND ${proof}`, lease, now() + 300, upload.id)]);
  try {
    const result = await c.env.DRIVE_BUCKET.resumeMultipartUpload(upload.blob_key, upload.multipart_id).uploadPart(part, content);
    await mutate(c, uploadChecks(c, upload, ["writing"], false, lease), proof => [
      statement(c.env, `INSERT INTO drive_upload_parts(upload_id,part_number,size,etag) SELECT ?,?,?,? WHERE ${proof}
        ON CONFLICT(upload_id,part_number) DO UPDATE SET size=excluded.size,etag=excluded.etag`, upload.id, part, size, result.etag),
      statement(c.env, `UPDATE drive_uploads SET status='open',lease_token=NULL,lease_until=0 WHERE id=? AND ${proof}`, upload.id),
    ]);
    return c.json({ part_number: part, size, etag: result.etag });
  } catch (error) {
    await statement(c.env, "UPDATE drive_uploads SET status='open',lease_token=NULL,lease_until=0 WHERE id=? AND status='writing' AND lease_token=?", upload.id, lease).run();
    throw error;
  }
});
uploads.post("/:uploadId/complete", async c => {
  await body(c, []);
  const upload = await requireUpload(c);
  if (upload.status === "completed") return c.json({ item: await requireItem(c, upload.item_id), upload: uploadView(upload) });
  if (upload.status === "committing" && leaseExpired(upload)) await statement(c.env, "UPDATE drive_uploads SET status='ready' WHERE id=? AND status='committing' AND lease_until<=?", upload.id, now()).run();
  const lease = uuid(), versionId = uuid();
  const parts = upload.mode === "multipart" ? await rows<{ part_number: number; etag: string; size: number }>(c.env, "SELECT part_number,etag,size FROM drive_upload_parts WHERE upload_id=? ORDER BY part_number", upload.id) : [];
  if (upload.mode === "multipart" && (parts.length !== Math.ceil(upload.size / PART_BYTES) || parts.some((part, index) => part.part_number !== index + 1 || part.size !== Math.min(PART_BYTES, upload.size - index * PART_BYTES)))) fail(409, "Upload has missing parts");
  await mutate(c, uploadChecks(c, upload, upload.mode === "single" ? ["ready"] : ["open", "ready"], true), proof => [statement(c.env,
    `UPDATE drive_uploads SET status='committing',lease_token=?,lease_until=? WHERE id=? AND ${proof}`, lease, now() + 300, upload.id)]);
  try {
    let object = await c.env.DRIVE_BUCKET.head(upload.blob_key);
    if (!object && upload.mode === "multipart" && upload.multipart_id) object = await c.env.DRIVE_BUCKET.resumeMultipartUpload(upload.blob_key, upload.multipart_id).complete(parts.map(part => ({ partNumber: part.part_number, etag: part.etag })));
    if (!object || object.size !== upload.size) fail(409, "Upload content is incomplete");
    const recipients = upload.base_version ? await audience(c, upload.item_id) : upload.parent_id ? await audience(c, upload.parent_id) : [upload.owner_user_id];
    const objectEtag = object.etag, hash = upload.sha256;
    await mutate(c, uploadChecks(c, upload, ["committing"], true, lease), proof => [
      upload.base_version ? statement(c.env, `UPDATE drive_items SET current_version_id=?,version=version+1,updated_at=? WHERE id=? AND ${proof}`, versionId, now(), upload.item_id) :
        statement(c.env, `INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,current_version_id,created_by) SELECT ?,?,?,'file',?,?,? WHERE ${proof}`,
          upload.item_id, upload.owner_user_id, upload.parent_id, upload.name, versionId, c.get("identity").user.id),
      statement(c.env, `INSERT INTO drive_versions(id,item_id,blob_key,size,content_type,etag,sha256,created_by) SELECT ?,?,?,?,?,?,?,? WHERE ${proof}`,
        versionId, upload.item_id, upload.blob_key, upload.size, upload.content_type, objectEtag, hash, c.get("identity").user.id),
      statement(c.env, `UPDATE drive_uploads SET status='completed',completed_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND ${proof}`, now(), upload.id),
    ], { item_id: upload.item_id, action: upload.base_version ? "content_updated" : "file_created", details: { version_id: versionId, size: upload.size }, recipients,
      notification: { type: "drive.updated", title: "Drive file updated", body: "A file in your shared Drive was updated.", recipients } });
    return c.json({ item: await requireItem(c, upload.item_id), version_id: versionId });
  } catch (error) {
    await statement(c.env, "UPDATE drive_uploads SET status='ready',lease_token=NULL,lease_until=0 WHERE id=? AND status='committing' AND lease_token=?", upload.id, lease).run();
    throw error;
  }
});
uploads.delete("/:uploadId", async c => {
  const upload = await requireUpload(c);
  if (upload.status === "completed") fail(409, "A completed upload cannot be cancelled");
  await mutate(c, uploadChecks(c, upload, ["allocating", "open", "ready", "writing"]), proof => [
    statement(c.env, `UPDATE drive_uploads SET status='cancelled' WHERE id=? AND ${proof}`, upload.id),
    statement(c.env, `INSERT INTO drive_garbage(blob_key,not_before) SELECT ?,? WHERE ${proof} ON CONFLICT(blob_key) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)`, upload.blob_key, Math.max(now(), upload.lease_until)),
  ]);
  return c.body(null, 204);
});

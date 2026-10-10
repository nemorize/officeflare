import { Hono } from "hono";
import { body } from "../auth/input";
import { now, uuid, type AppEnv } from "../auth/types";
import { activeUser, audience, cleanPath, condition, descendants, driveEnabled, first, itemCondition, requireItem, rows, statement, treeSnapshot } from "./access";
import { describe, limit } from "./items";
import { bool, fail, identifier, integer, role, text } from "./input";
import { mutate } from "./mutations";
import { ensureCapacity, quotaCondition } from "./storage";
import type { DriveItem } from "./types";

interface Comment { id: string; item_id: string; parent_id: string | null; author_user_id: string; body: string; resolved: number; version: number; created_at: number; updated_at: number; deleted_at: number | null }
interface AccessRequest { id: string; item_id: string; user_id: string; role: string; message: string; status: string }
export const collaboration = new Hono<AppEnv>();
const pathId = (c: Parameters<typeof requireItem>[0]) => identifier(c.req.param("itemId"));
collaboration.get("/:itemId/comments", async c => {
  const item = await requireItem(c, pathId(c)), pageSize = limit(c);
  const after = c.req.query("after") ? identifier(c.req.query("after"), "after") : null;
  const previous = after ? await first<Comment>(c.env, "SELECT * FROM drive_comments WHERE id=? AND item_id=?", after, item.id) : null;
  if (after && !previous) fail(400, "Invalid comment cursor");
  const comments = await rows<Comment>(c.env, `SELECT * FROM drive_comments WHERE item_id=? AND deleted_at IS NULL
    ${previous ? "AND (created_at>? OR (created_at=? AND id>?))" : ""} ORDER BY created_at,id LIMIT ?`, item.id,
    ...(previous ? [previous.created_at, previous.created_at, previous.id] : []), pageSize + 1);
  const page = comments.slice(0, pageSize);
  return c.json({ comments: page.map(comment => ({ ...comment, resolved: !!comment.resolved })), next_cursor: comments.length > pageSize ? page.at(-1)!.id : null });
});
collaboration.post("/:itemId/comments", async c => {
  const data = await body(c, ["body", "parent_id"]), item = await requireItem(c, pathId(c), "comment"), id = uuid(), content = text(data.body, "body", 5000);
  if (!content.trim()) fail(400, "Comment cannot be empty");
  const parent = data.parent_id == null ? null : identifier(data.parent_id, "parent_id");
  const parentCheck = parent ? condition("EXISTS(SELECT 1 FROM drive_comments WHERE id=? AND item_id=? AND parent_id IS NULL AND deleted_at IS NULL)", parent, item.id) : condition("1");
  if (!await first(c.env, `SELECT 1 WHERE ${parentCheck.sql}`, ...parentCheck.args)) fail(400, "Invalid comment thread");
  const recipients = await audience(c, item.id);
  await mutate(c, [itemCondition(c, item.id, undefined, "comment"), parentCheck], proof => [statement(c.env,
    `INSERT INTO drive_comments(id,item_id,parent_id,author_user_id,body) SELECT ?,?,?,?,? WHERE ${proof}`, id, item.id, parent, c.get("identity").user.id, content)],
    { item_id: item.id, action: "comment_created", details: { comment_id: id, parent_id: parent }, recipients,
      notification: { type: "drive.comment", title: "New Drive comment", body: "A comment was added to a shared Drive item.", recipients } });
  return c.json({ comment: await first(c.env, "SELECT * FROM drive_comments WHERE id=?", id) }, 201);
});
collaboration.patch("/:itemId/comments/:commentId", async c => {
  const data = await body(c, ["version", "body", "resolved", "deleted"]), item = await requireItem(c, pathId(c), "comment"), id = identifier(c.req.param("commentId")), expected = integer(data.version, "version", 1);
  if (Object.keys(data).length < 2) fail(400, "No changes supplied");
  const comment = await first<Comment>(c.env, "SELECT * FROM drive_comments WHERE id=? AND item_id=? AND deleted_at IS NULL", id, item.id);
  if (!comment) fail(404, "Comment not found");
  if (data.body !== undefined && comment.author_user_id !== c.get("identity").user.id) fail(403, "Only the author can edit comment text");
  if (data.deleted !== undefined && !bool(data.deleted, "deleted")) fail(400, "Deleted comments cannot be restored");
  const action = data.resolved !== undefined || data.deleted === true && comment.author_user_id !== c.get("identity").user.id ? "edit" : "comment";
  if (action === "edit") await requireItem(c, item.id, "edit");
  const updates = ["version=version+1", "updated_at=?"], args: (string | number | null)[] = [now()];
  if (data.body !== undefined) { const content = text(data.body, "body", 5000); if (!content.trim()) fail(400, "Comment cannot be empty"); updates.push("body=?"); args.push(content); }
  if (data.resolved !== undefined) { if (comment.parent_id) fail(400, "Resolve the thread's first comment"); updates.push("resolved=?"); args.push(+bool(data.resolved, "resolved")); }
  if (data.deleted) { updates.push("deleted_at=?"); args.push(now()); }
  await mutate(c, [itemCondition(c, item.id, undefined, action), condition("EXISTS(SELECT 1 FROM drive_comments WHERE id=? AND item_id=? AND version=? AND deleted_at IS NULL)", id, item.id, expected),
    ...(data.body !== undefined || data.deleted && action === "comment" ? [condition("EXISTS(SELECT 1 FROM drive_comments WHERE id=? AND author_user_id=?)", id, c.get("identity").user.id)] : [])], proof => [
      statement(c.env, `UPDATE drive_comments SET ${updates.join(",")} WHERE id=? AND ${proof}`, ...args, id),
      ...(data.deleted && !comment.parent_id ? [statement(c.env, `UPDATE drive_comments SET deleted_at=?,version=version+1 WHERE parent_id=? AND deleted_at IS NULL AND ${proof}`, now(), id)] : []),
    ], { item_id: item.id, action: data.deleted ? "comment_deleted" : data.resolved !== undefined ? "comment_resolved" : "comment_updated", details: { comment_id: id }, recipients: await audience(c, item.id) });
  return c.json({ comment: await first(c.env, "SELECT * FROM drive_comments WHERE id=?", id) });
});
collaboration.post("/:itemId/access-requests", async c => {
  const data = await body(c, ["role", "message"]), id = pathId(c), requestedRole = role(data.role ?? "viewer"), message = text(data.message ?? "", "message", 1000), requestId = uuid();
  const item = await first<DriveItem>(c.env, `SELECT d.* FROM drive_items d JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND ${cleanPath("d.id")} AND ${activeUser("u")} AND ${driveEnabled("u")}`, id);
  // A request never reveals whether a guessed resource exists or who owns it.
  if (!item || item.owner_user_id === c.get("identity").user.id) return c.json({ accepted: true }, 202);
  const pending = await first(c.env, "SELECT 1 FROM drive_access_requests WHERE item_id=? AND user_id=? AND (status='pending' OR created_at>unixepoch()-3600)", id, c.get("identity").user.id);
  if (pending) return c.json({ accepted: true }, 202);
  await mutate(c, [condition(`EXISTS(SELECT 1 FROM drive_items d JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND ${cleanPath("d.id")} AND ${activeUser("u")} AND ${driveEnabled("u")})`, id),
    condition("NOT EXISTS(SELECT 1 FROM drive_access_requests WHERE item_id=? AND user_id=? AND (status='pending' OR created_at>unixepoch()-3600))", id, c.get("identity").user.id)], proof => [
    statement(c.env, `INSERT OR IGNORE INTO drive_access_requests(id,item_id,user_id,role,message) SELECT ?,?,?,?,? WHERE ${proof}`, requestId, id, c.get("identity").user.id, requestedRole, message),
  ], { item_id: id, action: "access_requested", details: { user_id: c.get("identity").user.id }, recipients: [item.owner_user_id],
    notification: { type: "drive.access_requested", title: "Drive access requested", body: "An account requested access to one of your Drive items.", recipients: [item.owner_user_id] } });
  return c.json({ accepted: true }, 202);
});
collaboration.get("/:itemId/access-requests", async c => {
  const item = await requireItem(c, pathId(c), "owner");
  const requests = await rows<AccessRequest>(c.env, "SELECT * FROM drive_access_requests WHERE item_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT ?", item.id, limit(c));
  return c.json({ requests });
});
collaboration.patch("/:itemId/access-requests/:requestId", async c => {
  const data = await body(c, ["version", "approved", "role"]), item = await requireItem(c, pathId(c), "owner"), requestId = identifier(c.req.param("requestId")), approved = bool(data.approved, "approved");
  const request = await first<AccessRequest>(c.env, "SELECT * FROM drive_access_requests WHERE id=? AND item_id=? AND status='pending'", requestId, item.id);
  if (!request) fail(404, "Access request not found");
  const granted = role(data.role ?? request.role), recipient = condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")})`, request.user_id);
  await mutate(c, [itemCondition(c, item.id, integer(data.version, "version", 1), "owner"), condition("EXISTS(SELECT 1 FROM drive_access_requests WHERE id=? AND item_id=? AND status='pending')", requestId, item.id), ...(approved ? [recipient] : [])], proof => [
    ...(approved ? [statement(c.env, `INSERT INTO drive_permissions(item_id,user_id,role,created_by) SELECT ?,?,?,? WHERE ${proof}
      ON CONFLICT(item_id,user_id) DO UPDATE SET role=excluded.role,expires_at=NULL,created_by=excluded.created_by`, item.id, request.user_id, granted, c.get("identity").user.id)] : []),
    statement(c.env, `UPDATE drive_access_requests SET status=?,decided_at=? WHERE id=? AND ${proof}`, approved ? "approved" : "denied", now(), requestId),
    statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), item.id),
  ], { item_id: item.id, action: approved ? "access_approved" : "access_denied", details: { request_id: requestId, user_id: request.user_id }, recipients: [...await audience(c, item.id), request.user_id], tree_changes: approved && item.kind === "folder", kind: "permissions",
    notification: { type: "drive.shared", title: "Drive access request updated", body: approved ? "Your Drive access request was approved." : "Your Drive access request was declined.", recipients: [request.user_id] } });
  return c.json({ version: integer(data.version, "version", 1) + 1, status: approved ? "approved" : "denied" });
});
collaboration.post("/:itemId/transfer", async c => {
  const data = await body(c, ["version", "user_id"]), item = await requireItem(c, pathId(c), "owner"), recipient = identifier(data.user_id, "user_id");
  if (recipient === item.owner_user_id) fail(400, "Item already belongs to this account");
  const eligible = condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")})`, recipient);
  if (!await first(c.env, `SELECT 1 WHERE ${eligible.sql}`, ...eligible.args)) fail(400, "Recipient must be an active Drive account");
  const tree = await rows<DriveItem>(c.env, `SELECT * FROM drive_items WHERE id IN (${descendants("?")}) AND purged_at IS NULL LIMIT 201`, item.id);
  if (tree.length > 200) fail(413, "Transfer at most 200 items per operation");
  const totals = await first<{ size: number }>(c.env, `SELECT COALESCE(SUM(size),0) size FROM drive_versions WHERE item_id IN (${descendants("?")})`, item.id);
  const size = totals?.size ?? 0; await ensureCapacity(c, recipient, size);
  const ordered: DriveItem[] = [], pending = new Set(tree.map(node => node.id));
  while (pending.size) { const next = tree.find(node => pending.has(node.id) && (node.id === item.id || !pending.has(node.parent_id!))); if (!next) fail(409, "Invalid folder hierarchy"); ordered.push(next); pending.delete(next.id); }
  const recipients = [...await audience(c, item.id), recipient];
  await mutate(c, [itemCondition(c, item.id, integer(data.version, "version", 1), "owner"), eligible, quotaCondition(recipient, size),
    condition(`NOT EXISTS(SELECT 1 FROM drive_uploads WHERE (item_id IN (${descendants("?")}) OR parent_id IN (${descendants("?")})) AND status NOT IN ('cancelled','completed'))`, item.id, item.id),
    condition(`?=(SELECT COALESCE(SUM(size),0) FROM drive_versions WHERE item_id IN (${descendants("?")}))`, size, item.id), treeSnapshot(c, item.id, ordered, true)], proof => [
    ...ordered.map(node => statement(c.env, `UPDATE drive_items SET owner_user_id=?,${node.id === item.id ? "parent_id=NULL," : ""}version=version+1,updated_at=? WHERE id=? AND ${proof}`, recipient, now(), node.id)),
    statement(c.env, `UPDATE drive_accounts SET used_bytes=used_bytes-? WHERE user_id=? AND ${proof}`, size, item.owner_user_id),
    statement(c.env, `UPDATE drive_accounts SET used_bytes=used_bytes+? WHERE user_id=? AND ${proof}`, size, recipient),
    statement(c.env, `DELETE FROM drive_permissions WHERE item_id IN (${descendants("?")}) AND user_id=? AND ${proof}`, item.id, recipient),
    statement(c.env, `INSERT INTO drive_permissions(item_id,user_id,role,created_by) SELECT ?,?,'editor',? WHERE ${proof}
      ON CONFLICT(item_id,user_id) DO UPDATE SET role='editor',expires_at=NULL`, item.id, item.owner_user_id, c.get("identity").user.id),
    statement(c.env, `UPDATE drive_links SET revoked_at=? WHERE item_id IN (${descendants("?")}) AND ${proof}`, now(), item.id),
  ], { item_id: item.id, action: "ownership_transferred", details: { from_user_id: item.owner_user_id, to_user_id: recipient, items: tree.length }, recipients, tree_changes: true, kind: "permissions",
    notification: { type: "drive.shared", title: "Drive ownership transferred", body: "Ownership of a Drive item was transferred to your account.", recipients: [recipient] } });
  return c.json({ item: await describe(c, await requireItem(c, item.id)) });
});

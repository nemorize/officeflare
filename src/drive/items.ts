import { Hono } from "hono";
import { body } from "../auth/input";
import { now, uuid, type AppEnv } from "../auth/types";
import { access, ancestors, audience, cleanPath, condition, descendants, first, identity, itemCondition, requireItem, rows, statement, treeSnapshot } from "./access";
import { cursor, readCursor } from "./cursor";
import { bool, fail, identifier, integer, name, text } from "./input";
import { mutate } from "./mutations";
import { purgeStatements } from "./lifecycle";
import { account, destination, ensureCapacity, quotaCondition } from "./storage";
import type { Bind, DriveContext, DriveItem, DriveVersion } from "./types";

export const items = new Hono<AppEnv>();
export async function describe(c: DriveContext, item: DriveItem) {
  const version = item.current_version_id ? await first<DriveVersion>(c.env, "SELECT * FROM drive_versions WHERE id=? AND item_id=?", item.current_version_id, item.id) : null;
  const user = c.get("identity").user.id;
  const owner = await first(c.env, "SELECT id,display_name,email_address FROM users WHERE id=?", item.owner_user_id);
  const grant = item.owner_user_id === user ? "owner" : (await first<{ role: string }>(c.env,
    `SELECT role FROM drive_permissions WHERE user_id=? AND item_id IN (${ancestors("?")} SELECT id FROM ancestors)
      AND (expires_at IS NULL OR expires_at>unixepoch()) ORDER BY CASE role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END DESC LIMIT 1`, user, item.id))?.role;
  return { ...item, purged_at: undefined, effective_role: grant ?? null, owner,
    current_version: version ? { id: version.id, size: version.size, content_type: version.content_type, etag: version.etag, sha256: version.sha256,
      created_at: version.created_at, created_by: version.created_by } : null };
}
const version = (data: Record<string, unknown>) => integer(data.version, "version", 1);
const pathId = (c: DriveContext) => identifier(c.req.param("itemId"));
export function limit(c: DriveContext) { const value = c.req.query("limit") ?? "50"; if (!/^\d+$/.test(value)) fail(400, "Invalid limit"); return integer(Number(value), "limit", 1, 100); }

items.get("/", async c => {
  const user = c.get("identity").user.id, view = c.req.query("view") ?? "my", kind = c.req.query("kind");
  if (!["my", "shared", "starred", "recent", "trash", "all"].includes(view)) fail(400, "Invalid Drive view");
  if (kind && kind !== "file" && kind !== "folder") fail(400, "Invalid kind");
  const q = text(c.req.query("q") ?? "", "q", 255), contentType = c.req.query("content_type"), parent = c.req.query("parent_id") ?? (view === "my" && !q ? "root" : "all");
  if (parent !== "root" && parent !== "all") { const folder = await requireItem(c, identifier(parent, "parent_id")); if (folder.kind !== "folder") fail(400, "Not a folder"); }
  const check = access(user, view === "trash" ? "owner" : "read", "d.id", view === "trash");
  const filters = [check.sql], bindings: Bind[] = [...check.args];
  if (view === "my" || view === "trash") { filters.push("d.owner_user_id=?"); bindings.push(user); }
  if (view === "shared") { filters.push("d.owner_user_id<>?"); bindings.push(user); }
  if (view === "starred") filters.push("s.item_id IS NOT NULL");
  if (view === "recent") filters.push("r.item_id IS NOT NULL");
  if (view === "trash") filters.push("d.trashed_at IS NOT NULL");
  if (parent === "root") filters.push("d.parent_id IS NULL");
  else if (parent !== "all") { filters.push("d.parent_id=?"); bindings.push(parent); }
  if (kind) { filters.push("d.kind=?"); bindings.push(kind); }
  if (contentType) { filters.push("v.content_type=?"); bindings.push(contentType); }
  if (q) { filters.push("(d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\')"); const search = `%${q.replace(/[\\%_]/g, value => "\\" + value)}%`; bindings.push(search, search); }
  const sort = c.req.query("sort"), order = c.req.query("order") ?? "asc";
  if (sort && !["name", "updated_at", "size"].includes(sort) || !["asc", "desc"].includes(order)) fail(400, "Invalid sort order");
  const scope = JSON.stringify(["items", view, kind ?? "", contentType ?? "", parent, q, sort ?? "", sort ? order : ""]), pageSize = limit(c);
  const ordering = sort === "name" ? "d.name COLLATE NOCASE" : sort === "size" ? "COALESCE(v.size,0)" : view === "recent" && !sort ? "r.viewed_at" : "d.updated_at";
  const direction = sort ? order.toUpperCase() : "DESC", operator = direction === "ASC" ? ">" : "<", group = "CASE WHEN d.kind='folder' THEN 0 ELSE 1 END";
  const after = c.req.query("cursor") ? await readCursor(c.env, user, scope, c.req.query("cursor")!) : null;
  if (after && sort) {
    let tuple: unknown; try { tuple = JSON.parse(after[1]); } catch { fail(400, "Invalid Drive cursor"); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || ![0, 1].includes(tuple[0]) || typeof tuple[1] !== "string" || typeof tuple[2] !== "string") fail(400, "Invalid Drive cursor");
    const [folderGroup, nameValue, id] = tuple as [number, string, string], value = sort === "name" ? nameValue : after[0];
    filters.push(`(${group}>? OR (${group}=? AND (${ordering}${operator}? OR (${ordering}=? AND d.id${operator}?))))`);
    bindings.push(folderGroup, folderGroup, value, value, id);
  } else if (after) { filters.push(`(${ordering}<? OR (${ordering}=? AND d.id<?))`); bindings.push(after[0], after[0], after[1]); }
  const result = await rows<DriveItem & { size: number | null; content_type: string | null; sha256: string | null; starred: number; sort_time: number | string; owner_name: string; owner_email: string; effective_role: string | null }>(c.env,
    `SELECT d.*,v.size,v.content_type,v.sha256,CASE WHEN s.item_id IS NULL THEN 0 ELSE 1 END starred,${ordering} sort_time,u.display_name owner_name,u.email_address owner_email,
      CASE WHEN d.owner_user_id=? THEN 'owner' ELSE (SELECT p.role FROM drive_permissions p WHERE p.user_id=?
        AND p.item_id IN (${ancestors("d.id")} SELECT id FROM ancestors) AND (p.expires_at IS NULL OR p.expires_at>unixepoch())
        ORDER BY CASE p.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END DESC LIMIT 1) END effective_role
      FROM drive_items d LEFT JOIN drive_versions v ON v.id=d.current_version_id
      JOIN users u ON u.id=d.owner_user_id
      LEFT JOIN drive_stars s ON s.item_id=d.id AND s.user_id=? LEFT JOIN drive_recents r ON r.item_id=d.id AND r.user_id=?
      WHERE ${filters.map(filter => `(${filter})`).join(" AND ")} ORDER BY ${sort ? `${group} ASC,` : ""}${ordering} ${direction},d.id ${direction} LIMIT ?`, user, user, user, user, ...bindings, pageSize + 1);
  const page = result.slice(0, pageSize);
  const last = page.at(-1);
  return c.json({ items: page.map(({ sort_time: _, purged_at: _purged, starred, owner_name, owner_email, ...item }) => ({ ...item, starred: !!starred, owner: { id: item.owner_user_id, display_name: owner_name, email_address: owner_email } })),
    next_cursor: result.length > pageSize && last ? await cursor(c.env, user, scope, sort
      ? [sort === "name" ? 0 : Number(last.sort_time), JSON.stringify([last.kind === "folder" ? 0 : 1, sort === "name" ? last.name : "", last.id])]
      : [Number(last.sort_time), last.id]) : null });
});
items.get("/:itemId", async c => {
  const id = pathId(c), trash = c.req.query("include_trashed") === "true", item = await requireItem(c, id, trash ? "owner" : "read", trash);
  const check = identity(c), read = itemCondition(c, id, undefined, trash ? "owner" : "read", trash);
  await statement(c.env, `INSERT INTO drive_recents(user_id,item_id,viewed_at) SELECT ?,?,? WHERE ${check.sql} AND ${read.sql}
    ON CONFLICT(user_id,item_id) DO UPDATE SET viewed_at=excluded.viewed_at`, c.get("identity").user.id, id, now(), ...check.args, ...read.args).run();
  return c.json({ item: await describe(c, item) });
});
export async function createFolder(c: DriveContext) {
  const data = await body(c, ["name", "parent_id", "description"]), target = await destination(c, data.parent_id), id = uuid();
  const itemName = name(data.name), description = text(data.description ?? "", "description", 2000);
  await account(c, target.owner_user_id);
  const recipients = target.parent_id ? await audience(c, target.parent_id) : [target.owner_user_id];
  await mutate(c, [target.check, ...(target.access ? [target.access] : [])], proof => [statement(c.env,
    `INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,description,created_by) SELECT ?,?,?,'folder',?,?,? WHERE ${proof}`,
    id, target.owner_user_id, target.parent_id, itemName, description, c.get("identity").user.id)], { item_id: id, action: "folder_created", recipients });
  return c.json({ item: await describe(c, await requireItem(c, id)) }, 201);
}
items.patch("/:itemId", async c => {
  const data = await body(c, ["version", "name", "description", "parent_id", "trashed"]), expected = version(data), id = pathId(c);
  if (Object.keys(data).length < 2) fail(400, "No changes supplied");
  const trash = data.trashed === undefined ? undefined : bool(data.trashed, "trashed");
  const item = await requireItem(c, id, trash === undefined ? "edit" : "owner", trash !== undefined);
  const target = data.parent_id === undefined ? null : await destination(c, data.parent_id);
  if (target && target.owner_user_id !== item.owner_user_id) fail(400, "Use ownership transfer or copy to move between owners");
  if (target?.parent_id && (await first(c.env, `SELECT id FROM drive_items WHERE id=? AND id IN (${descendants("?")})`, target.parent_id, id))) fail(400, "A folder cannot be moved into its descendants");
  if (trash === false && !target && item.parent_id) await requireItem(c, item.parent_id, "edit");
  const updates = ["version=version+1", "updated_at=?"], args: Bind[] = [now()];
  if (data.name !== undefined) { updates.push("name=?"); args.push(name(data.name)); }
  if (data.description !== undefined) { updates.push("description=?"); args.push(text(data.description, "description", 2000)); }
  if (target) { updates.push("parent_id=?"); args.push(target.parent_id); }
  if (trash !== undefined) { updates.push("trashed_at=?"); args.push(trash ? now() : null); }
  const recipients = [...await audience(c, id), ...(target?.parent_id ? await audience(c, target.parent_id) : [])];
  await mutate(c, [itemCondition(c, id, expected, trash === undefined ? "edit" : "owner", trash !== undefined),
    ...(target ? [target.check, ...(target.access ? [target.access] : [])] : []),
    ...(target?.parent_id ? [condition(`? NOT IN (${descendants("?")})`, target.parent_id, id)] : []),
    ...(trash === false && !target && item.parent_id ? [itemCondition(c, item.parent_id, undefined, "edit")] : [])], proof => [
      statement(c.env, `UPDATE drive_items SET ${updates.join(",")} WHERE id=? AND ${proof}`, ...args, id),
    ], { item_id: id, action: trash === true ? "trashed" : trash === false ? "restored" : target ? "moved" : "metadata_updated",
      details: { ...data, before: { name: item.name, parent_id: item.parent_id } }, recipients,
      tree_changes: item.kind === "folder" ? trash === false ? "after" : true : false, kind: trash === true ? "removed" : "updated" });
  return c.json({ item: await describe(c, await requireItem(c, id, trash === true ? "owner" : "read", trash === true)) });
});
items.delete("/:itemId", async c => {
  const id = pathId(c), expected = integer(Number(c.req.query("version")), "version", 1), item = await requireItem(c, id, "owner", true);
  if (!item.trashed_at) fail(409, "Move the item to trash before permanent deletion");
  const recipients = await audience(c, id);
  await mutate(c, [itemCondition(c, id, expected, "owner", true), condition("EXISTS(SELECT 1 FROM drive_items WHERE id=? AND trashed_at IS NOT NULL)", id)], proof => purgeStatements(c.env, id, proof),
    { item_id: id, action: "purged", recipients, tree_changes: true, kind: "removed" });
  return c.body(null, 204);
});
items.put("/:itemId/star", async c => {
  const data = await body(c, ["starred"]), starred = bool(data.starred, "starred"), id = pathId(c);
  await requireItem(c, id);
  await mutate(c, [itemCondition(c, id, undefined, "read")], proof => [starred ? statement(c.env,
    `INSERT OR IGNORE INTO drive_stars(user_id,item_id) SELECT ?,? WHERE ${proof}`, c.get("identity").user.id, id) :
    statement(c.env, `DELETE FROM drive_stars WHERE user_id=? AND item_id=? AND ${proof}`, c.get("identity").user.id, id)]);
  return c.json({ starred });
});
items.get("/:itemId/versions", async c => {
  const item = await requireItem(c, pathId(c));
  if (item.kind !== "file") fail(400, "Folders have no content versions");
  const pageSize = limit(c), scope = `versions:${item.id}`, after = c.req.query("cursor") ? await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!) : null;
  const result = await rows<DriveVersion>(c.env, `SELECT * FROM drive_versions WHERE item_id=?${after ? " AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
    item.id, ...(after ? [after[0], after[0], after[1]] : []), pageSize + 1);
  const page = result.slice(0, pageSize);
  return c.json({ versions: page.map(({ blob_key: _, ...entry }) => ({ ...entry, current: entry.id === item.current_version_id })),
    next_cursor: result.length > pageSize ? await cursor(c.env, c.get("identity").user.id, scope, [page.at(-1)!.created_at, page.at(-1)!.id]) : null });
});
items.post("/:itemId/versions/:versionId/restore", async c => {
  const data = await body(c, ["version"]), id = pathId(c), sourceId = identifier(c.req.param("versionId")), item = await requireItem(c, id, "edit");
  const source = await first<DriveVersion>(c.env, "SELECT * FROM drive_versions WHERE id=? AND item_id=?", sourceId, id);
  if (!source) fail(404, "Version not found");
  const newId = uuid(), recipients = await audience(c, id); await ensureCapacity(c, item.owner_user_id, source.size);
  await mutate(c, [itemCondition(c, id, version(data), "edit"), quotaCondition(item.owner_user_id, source.size),
    condition("EXISTS(SELECT 1 FROM drive_versions WHERE id=? AND item_id=?)", sourceId, id)], proof => [
    statement(c.env, `INSERT INTO drive_versions(id,item_id,blob_key,size,content_type,etag,sha256,created_by) SELECT ?,item_id,blob_key,size,content_type,etag,sha256,? FROM drive_versions WHERE id=? AND ${proof}`, newId, c.get("identity").user.id, sourceId),
    statement(c.env, `UPDATE drive_items SET current_version_id=?,version=version+1,updated_at=? WHERE id=? AND ${proof}`, newId, now(), id),
  ], { item_id: id, action: "version_restored", details: { source_version_id: sourceId, version_id: newId }, recipients,
    notification: { type: "drive.updated", title: "Drive file updated", body: "A previous version of a shared Drive file was restored.", recipients } });
  return c.json({ item: await describe(c, await requireItem(c, id)) });
});
items.delete("/:itemId/versions/:versionId", async c => {
  const id = pathId(c), versionId = identifier(c.req.param("versionId")), item = await requireItem(c, id, "owner"), expected = integer(Number(c.req.query("version")), "version", 1);
  if (item.current_version_id === versionId) fail(409, "The current version cannot be deleted");
  const source = await first<DriveVersion>(c.env, "SELECT * FROM drive_versions WHERE id=? AND item_id=?", versionId, id);
  if (!source) fail(404, "Version not found");
  await mutate(c, [itemCondition(c, id, expected, "owner"), condition("EXISTS(SELECT 1 FROM drive_versions WHERE id=? AND item_id=?)", versionId, id),
    condition("EXISTS(SELECT 1 FROM drive_items WHERE id=? AND current_version_id<>?)", id, versionId)], proof => [
      statement(c.env, `INSERT OR IGNORE INTO drive_garbage(blob_key) SELECT ? WHERE ${proof}`, source.blob_key),
      statement(c.env, `DELETE FROM drive_versions WHERE id=? AND item_id=? AND ${proof}`, versionId, id),
      statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), id),
    ], { item_id: id, action: "version_deleted", details: { version_id: versionId }, recipients: await audience(c, id) });
  return c.body(null, 204);
});
items.post("/:itemId/copy", async c => {
  const data = await body(c, ["name", "parent_id", "version"]), source = await requireItem(c, pathId(c)), target = await destination(c, data.parent_id), copiedId = uuid();
  const sourceRows = await rows<DriveItem>(c.env, `SELECT d.* FROM drive_items d WHERE id IN (${descendants("?")}) AND ${cleanPath("d.id")} LIMIT 201`, source.id);
  if (sourceRows.length > 200) fail(413, "Copy at most 200 items per operation");
  if (target.parent_id && sourceRows.some(row => row.id === target.parent_id)) fail(400, "A folder cannot be copied into itself");
  const ids = new Map(sourceRows.map(item => [item.id, item.id === source.id ? copiedId : uuid()]));
  const versions = await rows<DriveVersion>(c.env, "SELECT v.* FROM drive_versions v JOIN drive_items d ON d.current_version_id=v.id WHERE d.id IN (SELECT value FROM json_each(?))", JSON.stringify(sourceRows.map(item => item.id)));
  const total = versions.reduce((sum, entry) => sum + entry.size, 0); await ensureCapacity(c, target.owner_user_id, total);
  const rootName = data.name === undefined ? source.name : name(data.name);
  const ordered: DriveItem[] = [], pending = new Set(sourceRows.map(item => item.id));
  while (pending.size) { const next = sourceRows.find(item => pending.has(item.id) && (item.id === source.id || !pending.has(item.parent_id!))); if (!next) fail(409, "Invalid folder hierarchy"); ordered.push(next); pending.delete(next.id); }
  const recipients = target.parent_id ? await audience(c, target.parent_id) : [target.owner_user_id];
  await mutate(c, [itemCondition(c, source.id, data.version === undefined ? source.version : version(data), "read"), target.check,
    ...(target.access ? [target.access] : []), quotaCondition(target.owner_user_id, total),
    treeSnapshot(c, source.id, ordered)], proof => {
    const statements: D1PreparedStatement[] = [];
    for (const item of ordered) {
      const entry = versions.find(entry => entry.item_id === item.id), newVersion = entry ? uuid() : null, id = ids.get(item.id)!;
      statements.push(statement(c.env, `INSERT INTO drive_items(id,owner_user_id,parent_id,kind,name,description,current_version_id,created_by)
        SELECT ?,?,?,?,?,?,?,? WHERE ${proof}`, id, target.owner_user_id, item.id === source.id ? target.parent_id : ids.get(item.parent_id!)!, item.kind, item.id === source.id ? rootName : item.name, item.description, newVersion, c.get("identity").user.id));
      if (entry) statements.push(statement(c.env, `INSERT INTO drive_versions(id,item_id,blob_key,size,content_type,etag,sha256,created_by)
        SELECT ?,?,blob_key,size,content_type,etag,sha256,? FROM drive_versions WHERE id=? AND ${proof}`, newVersion, id, c.get("identity").user.id, entry.id));
    }
    return statements;
  }, { item_id: copiedId, action: "copied", details: { source_item_id: source.id, items: ordered.length }, recipients });
  return c.json({ item: await describe(c, await requireItem(c, copiedId)) }, 201);
});
items.get("/:itemId/activity", async c => {
  const id = pathId(c), pageSize = limit(c), scope = `activity:${id}:${c.req.query("recursive") === "true"}`, user = c.get("identity").user.id;
  const item = await first<DriveItem>(c.env, "SELECT * FROM drive_items WHERE id=? AND owner_user_id=?", id, user);
  if (!item) await requireItem(c, id);
  const after: [number, string] = c.req.query("cursor") ? await readCursor(c.env, user, scope, c.req.query("cursor")!) : [Number.MAX_SAFE_INTEGER, ""];
  const check = access(user, "read", "d.id");
  const result = await rows<{ seq: number; item_id: string; actor_user_id: string | null; link_id: string | null; action: string; details_json: string; created_at: number }>(c.env,
    `SELECT a.seq,a.item_id,a.actor_user_id,u.display_name actor_name,a.link_id,a.action,CASE WHEN d.owner_user_id=? THEN a.details_json ELSE '{}' END details_json,a.created_at FROM drive_activity a JOIN drive_items d ON d.id=a.item_id LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE a.seq<? AND a.item_id ${c.req.query("recursive") === "true" ? `IN (${descendants("?")})` : "=?"} AND (d.owner_user_id=? OR (${check.sql})) ORDER BY a.seq DESC LIMIT ?`, user, after[0], id, user, ...check.args, pageSize + 1);
  const page = result.slice(0, pageSize);
  return c.json({ activity: page.map(({ details_json, ...event }) => ({ ...event, details: JSON.parse(details_json) })),
    next_cursor: result.length > pageSize ? await cursor(c.env, user, scope, [page.at(-1)!.seq, ""]) : null });
});

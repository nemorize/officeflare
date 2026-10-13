import { Hono } from "hono";
import { body } from "../auth/input";
import { digest, random } from "../auth/crypto";
import { hashPassword } from "../auth/password";
import { now, uuid, type AppEnv } from "../auth/types";
import { activeUser, ancestors, audience, condition, driveEnabled, first, itemCondition, requireItem, rows, statement } from "./access";
import { bool, expiry, fail, identifier, integer, role, text } from "./input";
import { mutate } from "./mutations";
import { linkPolicy } from "./policy";

export const sharing = new Hono<AppEnv>();
const itemId = (c: Parameters<typeof requireItem>[0]) => identifier(c.req.param("itemId"));
const expected = (data: Record<string, unknown>) => integer(data.version, "version", 1);
sharing.get("/:itemId/permissions", async c => {
  const item = await requireItem(c, itemId(c), "owner");
  const grants = await rows<{ item_id: string; user_id: string; role: string; expires_at: number | null; created_at: number; created_by: string; display_name: string | null; email_address: string; source_name: string; inherited: number; has_profile_image: number; profile_image_version: string | null }>(c.env, `SELECT p.item_id,p.user_id,p.role,p.expires_at,p.created_at,p.created_by,u.display_name,u.email_address,u.profile_image_key IS NOT NULL has_profile_image,u.profile_image_key profile_image_version,d.name source_name,CASE WHEN p.item_id=? THEN 0 ELSE 1 END inherited
    FROM drive_permissions p JOIN users u ON u.id=p.user_id JOIN drive_items d ON d.id=p.item_id WHERE p.item_id IN (${ancestors("?")} SELECT id FROM ancestors) AND (p.expires_at IS NULL OR p.expires_at>unixepoch()) ORDER BY p.item_id,p.user_id`, item.id, item.id);
  return c.json({ owner_user_id: item.owner_user_id, permissions: grants.map(grant => ({ ...grant, has_profile_image: !!grant.has_profile_image, profile_image_version: grant.profile_image_version?.split("/").at(-1) ?? null })) });
});
sharing.put("/:itemId/permissions/:userId", async c => {
  const data = await body(c, ["version", "role", "expires_at"]), id = itemId(c), item = await requireItem(c, id, "owner"), recipient = identifier(c.req.param("userId"), "user_id");
  if (recipient === item.owner_user_id) fail(400, "The owner's access cannot be changed");
  const grantRole = role(data.role), expires = expiry(data.expires_at);
  const eligible = condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")})`, recipient);
  if (!await first(c.env, `SELECT 1 WHERE ${eligible.sql}`, ...eligible.args)) fail(400, "Recipient must be an active Drive account");
  const recipients = [...await audience(c, id), recipient];
  await mutate(c, [itemCondition(c, id, expected(data), "owner"), eligible], proof => [
    statement(c.env, `INSERT INTO drive_permissions(item_id,user_id,role,expires_at,created_by) SELECT ?,?,?,?,? WHERE ${proof}
      ON CONFLICT(item_id,user_id) DO UPDATE SET role=excluded.role,expires_at=excluded.expires_at,created_by=excluded.created_by`, id, recipient, grantRole, expires, c.get("identity").user.id),
    statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), id),
  ], { item_id: id, action: "permission_granted", details: { user_id: recipient, role: grantRole, expires_at: expires }, recipients, tree_changes: item.kind === "folder", kind: "permissions",
    notification: { type: "drive.shared", title: "Drive access updated", body: "A Drive file or folder was shared with your account.", recipients: [recipient] } });
  return c.json({ version: expected(data) + 1, permission: { user_id: recipient, role: grantRole, expires_at: expires } });
});
sharing.delete("/:itemId/permissions/:userId", async c => {
  const id = itemId(c), item = await requireItem(c, id, "owner"), recipient = identifier(c.req.param("userId"), "user_id"), version = integer(Number(c.req.query("version")), "version", 1);
  if (recipient === item.owner_user_id) fail(400, "The owner's access cannot be changed");
  const recipients = [...await audience(c, id), recipient];
  await mutate(c, [itemCondition(c, id, version, "owner"), condition("EXISTS(SELECT 1 FROM drive_permissions WHERE item_id=? AND user_id=?)", id, recipient)], proof => [
    statement(c.env, `DELETE FROM drive_permissions WHERE item_id=? AND user_id=? AND ${proof}`, id, recipient),
    statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), id),
  ], { item_id: id, action: "permission_revoked", details: { user_id: recipient }, recipients, tree_changes: item.kind === "folder", kind: "permissions",
    notification: { type: "drive.shared", title: "Drive access updated", body: "Your access to a Drive file or folder changed.", recipients: [recipient] } });
  return c.json({ version: version + 1 });
});
sharing.get("/:itemId/links", async c => {
  await requireItem(c, itemId(c), "owner");
  const links = await rows(c.env, "SELECT id,item_id,allow_download,expires_at,revoked_at,created_at,created_by,CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END password_protected FROM drive_links WHERE item_id=? ORDER BY created_at DESC,id DESC", itemId(c));
  return c.json({ links });
});
sharing.post("/:itemId/links", async c => {
  const data = await body(c, ["version", "expires_at", "password", "allow_download"]), id = itemId(c); await requireItem(c, id, "owner");
  const token = `ofd_${random()}`, link = uuid(), expires = expiry(data.expires_at), allow = data.allow_download === undefined ? true : bool(data.allow_download, "allow_download");
  const password = data.password === undefined || data.password === null ? null : text(data.password, "password", 128);
  if (password !== null && password.length < 8) fail(400, "Link passwords need at least 8 characters");
  const hash = password ? await hashPassword(password) : null, tokenHash = await digest(token);
  const policy = linkPolicy(!!hash, expires);
  if (!await first(c.env, `SELECT 1 WHERE ${policy.sql}`, ...policy.args)) fail(403, "Public link must satisfy the workspace password and expiry policy");
  await mutate(c, [policy, itemCondition(c, id, expected(data), "owner")], proof => [
    statement(c.env, `INSERT INTO drive_links(id,item_id,token_hash,password_hash,allow_download,expires_at,created_by) SELECT ?,?,?,?,?,?,? WHERE ${proof}`,
      link, id, tokenHash, hash, +allow, expires, c.get("identity").user.id),
    statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), id),
  ], { item_id: id, action: "link_created", details: { link_id: link, expires_at: expires, allow_download: allow, password_protected: !!hash }, recipients: await audience(c, id), kind: "permissions" });
  return c.json({ version: expected(data) + 1, link: { id: link, token, url: new URL(`/api/drive/public/${token}`, c.req.url).href,
    expires_at: expires, allow_download: allow, password_protected: !!hash } }, 201);
});
sharing.patch("/:itemId/links/:linkId", async c => {
  const data = await body(c, ["version", "expires_at", "password", "allow_download", "revoked"]), id = itemId(c), linkId = identifier(c.req.param("linkId"));
  await requireItem(c, id, "owner");
  if (Object.keys(data).length < 2) fail(400, "No changes supplied");
  const current = await first<{ password_hash: string | null; expires_at: number | null; created_at: number }>(c.env, "SELECT password_hash,expires_at,created_at FROM drive_links WHERE id=? AND item_id=? AND revoked_at IS NULL", linkId, id);
  if (!current) fail(404, "Share link not found");
  const policy = data.revoked === true ? condition("1") : linkPolicy(data.password === undefined ? !!current.password_hash : data.password !== null, data.expires_at === undefined ? current.expires_at : expiry(data.expires_at), current.created_at);
  if (!await first(c.env, `SELECT 1 WHERE ${policy.sql}`, ...policy.args)) fail(403, "Public link must satisfy the workspace password and expiry policy");
  const updates: string[] = [], args: (string | number | null)[] = [];
  if (data.expires_at !== undefined) { updates.push("expires_at=?"); args.push(expiry(data.expires_at)); }
  if (data.allow_download !== undefined) { updates.push("allow_download=?"); args.push(+bool(data.allow_download, "allow_download")); }
  if (data.revoked !== undefined) { if (!bool(data.revoked, "revoked")) fail(400, "Revoked links cannot be restored"); updates.push("revoked_at=?"); args.push(now()); }
  if (data.password !== undefined) { const password = data.password === null ? null : text(data.password, "password", 128); if (password !== null && password.length < 8) fail(400, "Link passwords need at least 8 characters"); updates.push("password_hash=?"); args.push(password ? await hashPassword(password) : null); }
  await mutate(c, [policy, itemCondition(c, id, expected(data), "owner"), condition("EXISTS(SELECT 1 FROM drive_links WHERE id=? AND item_id=? AND revoked_at IS NULL)", linkId, id)], proof => [
    statement(c.env, `UPDATE drive_links SET ${updates.join(",")} WHERE id=? AND item_id=? AND ${proof}`, ...args, linkId, id),
    statement(c.env, `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`, now(), id),
  ], { item_id: id, action: data.revoked ? "link_revoked" : "link_updated", details: { link_id: linkId, ...(data.expires_at === undefined ? {} : { expires_at: data.expires_at }),
    ...(data.allow_download === undefined ? {} : { allow_download: data.allow_download }), ...(data.password === undefined ? {} : { password_protected: data.password !== null }) }, recipients: await audience(c, id), kind: "permissions" });
  return c.json({ version: expected(data) + 1 });
});

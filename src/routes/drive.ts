import { Hono } from "hono";
import { requireAccess } from "../auth/store";
import { requirePermission } from "../authorization/access";
import type { AppEnv } from "../auth/types";
import { access, activeUser, driveEnabled, first, identity, rows, writableOwner } from "../drive/access";
import { fail, identifier, text } from "../drive/input";
import { collaboration } from "../drive/collaboration";
import { privateContent } from "../drive/content";
import { cursor, readCursor } from "../drive/cursor";
import { createFolder, items, limit } from "../drive/items";
import { publicDrive } from "../drive/public";
import { sharing } from "../drive/sharing";
import { account, uploads } from "../drive/storage";
import { PART_BYTES } from "../drive/types";
import { adminDrive } from "../drive/admin";
import { requireDriveAction, requestSettings, requestWritable } from "../drive/policy";
import { requestPermissions } from "../authorization/access";
import { profileImageResponse } from "../profile/image-response";

const drive = new Hono<AppEnv>();
drive.route("/admin", adminDrive);
drive.route("/public", publicDrive);
drive.use("*", requireAccess, requirePermission("drive.access"));
drive.use("*", requireDriveAction);
async function driveBootstrap(c: import("../drive/types").DriveContext) {
  const [policy, quota, permissions, writable] = await Promise.all([requestSettings(c), account(c), requestPermissions(c), requestWritable(c)]);
  return { quota: { ...quota, available_bytes: Math.max(0, quota.quota_bytes - quota.used_bytes - quota.reserved_bytes) }, capabilities: {
    max_file_bytes: policy.max_file_bytes, part_bytes: PART_BYTES,
    upload_lifetime_seconds: 86400, trash_retention_days: policy.trash_retention_days, max_tree_operation_items: 200,
    sharing_roles: ["viewer", "commenter", "editor"], public_links: "read_only",
    internal_sharing_enabled: !!policy.internal_sharing_enabled, public_sharing_enabled: !!policy.public_sharing_enabled,
    public_link_password_required: !!policy.public_link_password_required, public_link_max_days: policy.public_link_max_days,
    write_locked: !writable, permissions: permissions.filter(key => key.startsWith("drive.")), account_status: quota.status,
  } };
}
drive.get("/bootstrap", async c => c.json(await driveBootstrap(c)));
drive.get("/capabilities", async c => c.json((await driveBootstrap(c)).capabilities));
drive.get("/people/:userId/profile-image", async c => {
  const ownerId = identifier(c.req.param("userId"), "userId"), auth = identity(c), read = access(c.get("identity").user.id), owned = access(c.get("identity").user.id, "owner");
  const query = `SELECT u.id,u.profile_image_key FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")} AND ${auth.sql}
    AND (EXISTS(SELECT 1 FROM drive_items d WHERE d.owner_user_id=u.id AND ${read.sql})
      OR EXISTS(SELECT 1 FROM drive_permissions p JOIN drive_items d ON d.id=p.item_id
        WHERE p.user_id=u.id AND (p.expires_at IS NULL OR p.expires_at>unixepoch()) AND ${owned.sql}))`;
  const args = [ownerId, ...auth.args, ...read.args, ...owned.args];
  const owner = await first<{ id: string; profile_image_key: string | null }>(c.env, query, ...args);
  if (!owner) fail(404, "No profile image");
  const response = await profileImageResponse(c, owner);
  if (!await first(c.env, `${query} AND u.profile_image_key=?`, ...args, owner.profile_image_key)) fail(404, "No profile image");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});
drive.get("/people", async c => {
  const q = text(c.req.query("q") ?? "", "q", 255).trim();
  if (q.length < 2) return c.json({ people: [] });
  const query = `%${q.replace(/[\\%_]/g, value => "\\" + value)}%`;
  const people = await rows(c.env, `SELECT u.id,u.display_name,u.email_address FROM users u
    WHERE ${activeUser("u")} AND ${driveEnabled("u")} AND u.id<>?
    AND (u.display_name LIKE ? ESCAPE '\\' OR u.email_address LIKE ? ESCAPE '\\') ORDER BY u.display_name,u.id LIMIT 20`,
    c.get("identity").user.id, query, query);
  return c.json({ people });
});
drive.get("/quota", async c => {
  const quota = (await account(c))!;
  return c.json({ ...quota, available_bytes: Math.max(0, quota.quota_bytes - quota.used_bytes - quota.reserved_bytes) });
});
drive.get("/changes", async c => {
  const user = c.get("identity").user.id, pageSize = limit(c);
  const after: [number, string] = c.req.query("cursor") ? await readCursor(c.env, user, "changes", c.req.query("cursor")!) : [0, ""];
  const read = access(user, "read", "d.id");
  const result = await rows<{ seq: number; item_id: string; kind: string; available: number }>(c.env,
    `SELECT change.seq,change.item_id,change.kind,CASE WHEN ${read.sql} THEN 1 ELSE 0 END available
      FROM drive_changes change JOIN drive_items d ON d.id=change.item_id WHERE change.user_id=? AND change.seq>?
      ORDER BY change.seq LIMIT ?`, ...read.args, user, after[0], pageSize + 1);
  const page = result.slice(0, pageSize);
  return c.json({ changes: page.map(({ seq: _, available, ...entry }) => ({ ...entry, available: !!available })),
    has_more: result.length > pageSize, cursor: await cursor(c.env, user, "changes", [page.at(-1)?.seq ?? after[0], ""]) });
});
drive.post("/folders", createFolder);
drive.route("/uploads", uploads);
for (const suffix of ["content", "preview"] as const) drive.on(["GET", "HEAD"], `/items/:itemId/${suffix}`, c => privateContent(c, suffix === "preview"));
drive.route("/items", sharing);
drive.route("/items", collaboration);
drive.route("/items", items);
export default drive;

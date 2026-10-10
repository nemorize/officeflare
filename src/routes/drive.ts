import { Hono } from "hono";
import { requireAccess } from "../auth/store";
import { requirePermission } from "../authorization/access";
import type { AppEnv } from "../auth/types";
import { access, rows } from "../drive/access";
import { collaboration } from "../drive/collaboration";
import { privateContent } from "../drive/content";
import { cursor, readCursor } from "../drive/cursor";
import { createFolder, items, limit } from "../drive/items";
import { publicDrive } from "../drive/public";
import { sharing } from "../drive/sharing";
import { account, uploads } from "../drive/storage";
import { MAX_FILE_BYTES, PART_BYTES } from "../drive/types";

const drive = new Hono<AppEnv>();
drive.route("/public", publicDrive);
drive.use("*", requireAccess, requirePermission("drive.access"));
drive.get("/capabilities", c => c.json({ max_file_bytes: MAX_FILE_BYTES, part_bytes: PART_BYTES,
  upload_lifetime_seconds: 86400, trash_retention_days: 30, max_tree_operation_items: 200,
  sharing_roles: ["viewer", "commenter", "editor"], public_links: "read_only" }));
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

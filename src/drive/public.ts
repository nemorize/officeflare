import { Hono } from "hono";
import { digest } from "../auth/crypto";
import { verifyPassword } from "../auth/password";
import { now, type AppEnv } from "../auth/types";
import { activeUser, cleanPath, condition, descendants, driveEnabled, first, rows } from "./access";
import { content } from "./content";
import { cursor, readCursor } from "./cursor";
import { fail, identifier, integer } from "./input";
import type { DriveContext, DriveItem } from "./types";
interface Link { id: string; item_id: string; token_hash: string; password_hash: string | null; allow_download: number; expires_at: number | null }
const scope = (hash: string, item: string, password: string | null, reference = false) => condition(`EXISTS(SELECT 1 FROM drive_links l JOIN drive_items root ON root.id=l.item_id JOIN users owner ON owner.id=root.owner_user_id
  WHERE l.token_hash=? AND l.password_hash IS ? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>unixepoch())
  AND ${activeUser("owner")} AND ${driveEnabled("owner")} AND ${cleanPath("root.id")} AND ${reference ? item : "?"} IN (${descendants("l.item_id")})
  AND ${cleanPath(reference ? item : "?")})`, hash, password, ...(reference ? [] : [item, item]));
async function validate(c: DriveContext) {
  c.header("Referrer-Policy", "no-referrer"); c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  const token = c.req.param("token"); if (!token || !/^ofd_[A-Za-z0-9_-]{43}$/.test(token)) fail(404, "Share link not found");
  const hash = await digest(token), limitKey = await digest(`drive-public:${c.req.header("cf-connecting-ip") ?? "local"}:${hash}:${Math.floor(now() / 900)}`);
  const rate = await first<{ attempts: number }>(c.env, `INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`, limitKey, now() + 900);
  if (rate && rate.attempts > 60) { c.header("Retry-After", "900"); fail(429, "Too many share link requests"); }
  const link = await first<Link>(c.env, `SELECT l.id,l.item_id,l.token_hash,l.password_hash,l.allow_download,l.expires_at FROM drive_links l JOIN drive_items root ON root.id=l.item_id JOIN users owner ON owner.id=root.owner_user_id
    WHERE l.token_hash=? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>unixepoch()) AND ${activeUser("owner")} AND ${driveEnabled("owner")} AND ${cleanPath("root.id")}`, hash);
  if (!link) fail(404, "Share link not found");
  if (link.password_hash) {
    const password = c.req.header("x-drive-link-password");
    if (!password || password.length > 128 || !await verifyPassword(password, link.password_hash)) fail(403, "A valid share link password is required");
  }
  return link;
}
async function publicItem(c: DriveContext, link: Link, id: string) {
  const check = scope(link.token_hash, id, link.password_hash);
  const item = await first<DriveItem>(c.env, `SELECT d.* FROM drive_items d WHERE d.id=? AND ${check.sql}`, id, ...check.args);
  if (!item) fail(404, "Shared item not found");
  return { item, check };
}
async function dto(c: DriveContext, item: DriveItem) {
  const version = item.current_version_id ? await first<{ size: number; content_type: string }>(c.env, "SELECT size,content_type FROM drive_versions WHERE id=? AND item_id=?", item.current_version_id, item.id) : null;
  return { id: item.id, name: item.name, kind: item.kind, description: item.description, updated_at: item.updated_at, size: version?.size ?? null, content_type: version?.content_type ?? null };
}
export const publicDrive = new Hono<AppEnv>();
publicDrive.get("/:token", async c => { const link = await validate(c), result = await publicItem(c, link, link.item_id); return c.json({ item: await dto(c, result.item), allow_download: !!link.allow_download, expires_at: link.expires_at }); });
publicDrive.get("/:token/items", async c => {
  const link = await validate(c), parentId = c.req.query("parent_id") ? identifier(c.req.query("parent_id"), "parent_id") : link.item_id;
  const parent = await publicItem(c, link, parentId); if (parent.item.kind !== "folder") fail(400, "Shared item is not a folder");
  const pageSize = integer(Number(c.req.query("limit") ?? "50"), "limit", 1, 100), cursorScope = `public:${link.id}:${parentId}`;
  const after = c.req.query("cursor") ? await readCursor(c.env, link.id, cursorScope, c.req.query("cursor")!) : null;
  const check = scope(link.token_hash, "d.id", link.password_hash, true);
  const result = await rows<DriveItem>(c.env, `SELECT d.* FROM drive_items d WHERE d.parent_id=? AND d.trashed_at IS NULL AND d.purged_at IS NULL AND ${check.sql}
    ${after ? "AND (d.updated_at<? OR (d.updated_at=? AND d.id<?))" : ""} ORDER BY d.updated_at DESC,d.id DESC LIMIT ?`, parentId,
    ...check.args, ...(after ? [after[0], after[0], after[1]] : []), pageSize + 1);
  const page = result.slice(0, pageSize);
  return c.json({ items: await Promise.all(page.map(item => dto(c, item))), next_cursor: result.length > pageSize ? await cursor(c.env, link.id, cursorScope, [page.at(-1)!.updated_at, page.at(-1)!.id]) : null });
});
for (const suffix of ["content", "preview"] as const) publicDrive.on(["GET", "HEAD"], `/:token/items/:itemId/${suffix}`, async c => {
  const link = await validate(c); if (!link.allow_download) fail(403, "File downloads are disabled for this link");
  if (c.req.query("version_id")) fail(400, "Public links expose only the current file version");
  const result = await publicItem(c, link, identifier(c.req.param("itemId")));
  const check = { sql: `${result.check.sql} AND EXISTS(SELECT 1 FROM drive_links WHERE id=? AND allow_download=1)`, args: [...result.check.args, link.id] };
  return content(c, result.item, check, link.id, suffix === "preview");
});

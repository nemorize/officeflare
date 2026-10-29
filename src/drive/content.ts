import { now, uuid } from "../auth/types";
import { first, identity, itemCondition, requireItem, statement } from "./access";
import { fail, identifier } from "./input";
import type { Condition, DriveContext, DriveItem, DriveVersion } from "./types";

const previewTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
  "application/pdf",
]);
const disposition = (name: string, inline: boolean) =>
  `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;
function range(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) fail(416, "Invalid byte range");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) fail(416, "Invalid byte range");
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) };
  }
  const offset = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset)
    fail(416, "Invalid byte range");
  return { offset, length: Math.min(size - 1, end) - offset + 1 };
}
export async function content(
  c: DriveContext,
  item: DriveItem,
  check: Condition,
  linkId: string | null = null,
  preview = false,
) {
  if (item.kind !== "file") fail(400, "Folders have no file content");
  const versionId = c.req.query("version_id")
    ? identifier(c.req.query("version_id"), "version_id")
    : item.current_version_id;
  const version = await first<DriveVersion>(
    c.env,
    "SELECT * FROM drive_versions WHERE id=? AND item_id=?",
    versionId,
    item.id,
  );
  if (!version) fail(404, "File version not found");
  if (preview && !previewTypes.has(version.content_type))
    fail(400, "This file type does not support inline preview");
  const object = await c.env.DRIVE_BUCKET.head(version.blob_key);
  if (!object || object.size !== version.size || object.etag !== version.etag)
    fail(503, "File content is unavailable");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    ETag: object.httpEtag,
    "Accept-Ranges": "bytes",
    "Content-Type": version.content_type,
    "Content-Disposition": disposition(item.name, preview),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
    "Last-Modified": new Date(version.created_at * 1000).toUTCString(),
  });
  let requestedRange: { offset: number; length: number } | null;
  try {
    requestedRange = range(
      !c.req.header("if-range") || c.req.header("if-range") === object.httpEtag
        ? c.req.header("range")
        : undefined,
      version.size,
    );
  } catch (error) {
    c.header("Content-Range", `bytes */${version.size}`);
    throw error;
  }
  const body =
    c.req.method === "HEAD"
      ? null
      : await c.env.DRIVE_BUCKET.get(
          version.blob_key,
          requestedRange ? { range: requestedRange } : undefined,
        );
  if (c.req.method !== "HEAD" && (!body || !("body" in body)))
    fail(503, "File content is unavailable");
  // Recheck session/ACL or link after R2 I/O, immediately before exposing bytes.
  const allowed = await first(
    c.env,
    `SELECT 1 WHERE ${check.sql} AND EXISTS(SELECT 1 FROM drive_versions WHERE id=? AND item_id=?)`,
    ...check.args,
    version.id,
    item.id,
  );
  if (!allowed) fail(404, "File not found");
  if (
    (c.req.header("if-none-match") ?? "")
      .split(",")
      .some((value) => value.trim() === object.httpEtag || value.trim() === "*")
  )
    return new Response(null, { status: 304, headers });
  if (c.req.method !== "HEAD") {
    const actor = linkId ? null : c.get("identity").user.id;
    const logged = await statement(
      c.env,
      `INSERT INTO drive_activity(operation_id,item_id,owner_user_id,actor_user_id,link_id,action,details_json)
      SELECT ?,id,owner_user_id,?,?,?,? FROM drive_items WHERE id=? AND ${check.sql}`,
      uuid(),
      actor,
      linkId,
      linkId ? "public_download" : preview ? "previewed" : "downloaded",
      JSON.stringify({ version_id: version.id }),
      item.id,
      ...check.args,
    ).run();
    if (logged.meta.changes !== 1) fail(404, "File not found");
  }
  headers.set("Content-Length", String(requestedRange?.length ?? version.size));
  if (requestedRange)
    headers.set(
      "Content-Range",
      `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${version.size}`,
    );
  return new Response(body && "body" in body ? body.body : null, {
    status: requestedRange ? 206 : 200,
    headers,
  });
}
export async function privateContent(c: DriveContext, preview = false) {
  const item = await requireItem(c, identifier(c.req.param("itemId")));
  const auth = identity(c),
    allowed = itemCondition(c, item.id, undefined, "read");
  const result = await content(
    c,
    item,
    { sql: `(${auth.sql}) AND (${allowed.sql})`, args: [...auth.args, ...allowed.args] },
    null,
    preview,
  );
  if (result.ok && c.req.method !== "HEAD")
    await statement(
      c.env,
      `INSERT INTO drive_recents(user_id,item_id,viewed_at) SELECT ?,?,? WHERE ${auth.sql} AND ${allowed.sql}
    ON CONFLICT(user_id,item_id) DO UPDATE SET viewed_at=excluded.viewed_at`,
      c.get("identity").user.id,
      item.id,
      now(),
      ...auth.args,
      ...allowed.args,
    ).run();
  return result;
}

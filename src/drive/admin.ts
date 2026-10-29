import { Hono } from "hono";
import { body } from "../auth/input";
import { now, type AppEnv } from "../auth/types";
import { requireAccess } from "../auth/store";
import { requirePermission } from "../authorization/access";
import { effectivePermissions } from "../authorization/permissions";
import {
  activeUser,
  availableItem,
  cleanPath,
  condition,
  driveEnabled,
  first,
  rows,
  statement,
} from "./access";
import { adminMutate, itemEvent, noTransfer, notificationStatements, reason } from "./admin-store";
import { cursor, readCursor } from "./cursor";
import { bool, expiry, fail, identifier, integer, role, text } from "./input";
import { limit } from "./items";
import { purgeStatements } from "./lifecycle";
import { publicLinkPolicy, settings, type DriveSettings } from "./policy";
import { transferRoutes } from "./transfers";
import type { Bind, DriveContext, DriveItem } from "./types";

export const adminDrive = new Hono<AppEnv>();
adminDrive.use("*", requireAccess, requirePermission("console.access"));
const q = (c: DriveContext) => text(c.req.query("q") ?? "", "q", 255).trim();
const search = (value: string) => `%${value.replace(/[\\%_]/g, (char) => "\\" + char)}%`;
const expected = (data: Record<string, unknown>) => integer(data.version, "version", 0);
const snapshot = (item: DriveItem) =>
  condition(
    "EXISTS(SELECT 1 FROM drive_items WHERE id=? AND version=? AND owner_user_id=? AND purged_at IS NULL)",
    item.id,
    item.version,
    item.owner_user_id,
  );
async function item(c: DriveContext) {
  const value = await first<DriveItem>(
    c.env,
    "SELECT * FROM drive_items WHERE id=? AND purged_at IS NULL",
    identifier(c.req.param("itemId")),
  );
  if (!value) fail(404, "Drive item not found");
  return value;
}
async function page<T extends { page_id: string }>(
  c: DriveContext,
  scope: string,
  query: string,
  args: Bind[],
  column: string,
) {
  const after = c.req.query("cursor")
    ? (await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!))[1]
    : "";
  const size = limit(c),
    result = await rows<T>(
      c.env,
      `${query} AND ${column}>? ORDER BY ${column} LIMIT ?`,
      ...args,
      after,
      size + 1,
    );
  const entries = result.slice(0, size);
  return {
    items: entries.map(({ page_id: _, ...entry }) => entry),
    next_cursor:
      result.length > size
        ? await cursor(c.env, c.get("identity").user.id, scope, [0, entries.at(-1)!.page_id])
        : null,
  };
}

adminDrive.get("/overview", requirePermission("admin.drive.accounts.read"), async (c) => {
  const summary = await first(
    c.env,
    `SELECT COALESCE(SUM(used_bytes),0) used_bytes,COALESCE(SUM(reserved_bytes),0) reserved_bytes,COALESCE(SUM(quota_bytes),0) quota_bytes,COUNT(*) accounts,SUM(CASE WHEN used_bytes+reserved_bytes>quota_bytes THEN 1 ELSE 0 END) over_quota FROM drive_accounts`,
  );
  const items = await first(
    c.env,
    "SELECT COUNT(*) total_items,SUM(kind='file') files,SUM(kind='folder') folders,SUM(trashed_at IS NOT NULL) trashed FROM drive_items WHERE purged_at IS NULL",
  );
  const operations = await first(
    c.env,
    `SELECT (SELECT COUNT(*) FROM drive_uploads WHERE status NOT IN ('completed','cancelled')) uploads,(SELECT COUNT(*) FROM drive_garbage) pending_cleanup,(SELECT COUNT(*) FROM drive_admin_jobs WHERE status IN ('queued','running','failed')) transfers`,
  );
  return c.json({ summary: { ...summary!, ...items!, ...operations! } });
});
adminDrive.get("/settings", requirePermission("admin.drive.settings.read"), async (c) =>
  c.json({ settings: await settings(c.env) }),
);
adminDrive.patch("/settings", requirePermission("admin.drive.settings.manage"), async (c) => {
  const keys = [
    "default_quota_bytes",
    "max_file_bytes",
    "internal_sharing_enabled",
    "public_sharing_enabled",
    "public_link_password_required",
    "public_link_max_days",
    "trash_retention_days",
  ] as const;
  const data = await body(c, ["version", "reason", ...keys]),
    before = await settings(c.env),
    next: DriveSettings = { ...before };
  if (!keys.some((key) => data[key] !== undefined)) fail(400, "No settings supplied");
  for (const key of keys)
    if (data[key] !== undefined) {
      if (key.endsWith("enabled") || key.endsWith("required")) next[key] = +bool(data[key], key);
      else
        next[key] = integer(
          data[key],
          key,
          key === "max_file_bytes" || key === "trash_retention_days" ? 1 : 0,
          key === "max_file_bytes"
            ? 5368709120
            : key.endsWith("days")
              ? 3650
              : Number.MAX_SAFE_INTEGER,
        );
    }
  await adminMutate(
    c,
    "admin.drive.settings.manage",
    [condition("EXISTS(SELECT 1 FROM drive_settings WHERE id=1 AND version=?)", expected(data))],
    (proof) => [
      statement(
        c.env,
        `UPDATE drive_settings SET ${keys.map((key) => `${key}=?`).join(",")},version=version+1,updated_at=?,updated_by=? WHERE id=1 AND ${proof}`,
        ...keys.map((key) => next[key]),
        now(),
        c.get("identity").user.id,
      ),
      statement(
        c.env,
        `UPDATE drive_accounts SET quota_bytes=?,version=version+1,updated_at=? WHERE quota_override_bytes IS NULL AND quota_bytes<>? AND ${proof}`,
        next.default_quota_bytes,
        now(),
        next.default_quota_bytes,
      ),
    ],
    {
      action: "settings_updated",
      type: "settings",
      id: "1",
      details: { reason: reason(data.reason), before, after: next },
    },
  );
  return c.json({ settings: await settings(c.env) });
});

const accountSelect = `SELECT u.id page_id,u.id user_id,u.email_address,u.display_name,u.disabled_at,u.deleted_at,u.password_reset_required,
  COALESCE(a.quota_bytes,s.default_quota_bytes) quota_bytes,a.quota_override_bytes,COALESCE(a.used_bytes,0) used_bytes,COALESCE(a.reserved_bytes,0) reserved_bytes,COALESCE(a.status,'active') status,COALESCE(a.version,0) version,
  EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND rp.permission_key='drive.access') role_has_drive
  FROM users u CROSS JOIN drive_settings s LEFT JOIN drive_accounts a ON a.user_id=u.id WHERE s.id=1`;
adminDrive.get("/accounts", requirePermission("admin.drive.accounts.read"), async (c) => {
  const query = q(c),
    args: Bind[] = [],
    state = c.req.query("state") ?? "all";
  if (!["all", "enabled", "disabled", "deleted", "over_quota"].includes(state))
    fail(400, "Invalid account filter");
  let extra = "";
  if (query) {
    extra += " AND (u.email_address LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')";
    args.push(search(query), search(query));
  }
  if (state === "enabled") extra += ` AND ${activeUser("u")} AND ${driveEnabled("u")}`;
  if (state === "disabled") extra += " AND (u.disabled_at IS NOT NULL OR a.status='suspended')";
  if (state === "deleted") extra += " AND u.deleted_at IS NOT NULL";
  if (state === "over_quota") extra += " AND a.used_bytes+a.reserved_bytes>a.quota_bytes";
  return c.json(
    await page<{ page_id: string }>(
      c,
      JSON.stringify(["admin.accounts", query, state]),
      accountSelect + extra,
      args,
      "u.id",
    ),
  );
});
adminDrive.get("/accounts/:userId", requirePermission("admin.drive.accounts.read"), async (c) => {
  const user = identifier(c.req.param("userId")),
    account = await first(c.env, accountSelect + " AND u.id=?", user);
  if (!account) fail(404, "User not found");
  const grants = await rows<{ permission_key: string }>(
    c.env,
    "SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=?",
    user,
  );
  const totals = await first(
    c.env,
    "SELECT COUNT(*) total_items,SUM(kind='file') files,SUM(kind='folder') folders,SUM(trashed_at IS NOT NULL) trashed,(SELECT COUNT(*) FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled')) active_uploads FROM drive_items WHERE owner_user_id=? AND purged_at IS NULL",
    user,
    user,
  );
  return c.json({
    account: {
      ...account,
      permissions: effectivePermissions(grants.map((grant) => grant.permission_key)).filter((key) =>
        key.startsWith("drive."),
      ),
      ...totals!,
    },
  });
});
adminDrive.patch(
  "/accounts/:userId",
  requirePermission("admin.drive.accounts.manage"),
  async (c) => {
    const user = identifier(c.req.param("userId")),
      data = await body(c, ["version", "quota_override_bytes", "status", "reason"]);
    const exists = await first(c.env, "SELECT id FROM users WHERE id=?", user);
    if (!exists) fail(404, "User not found");
    const before = await first<Record<string, unknown>>(
      c.env,
      "SELECT * FROM drive_accounts WHERE user_id=?",
      user,
    );
    if (expected(data) !== (before?.version ?? 0))
      fail(412, "Drive account changed. Reload and try again.");
    if (data.quota_override_bytes === undefined && data.status === undefined)
      fail(400, "No account changes supplied");
    const override =
      data.quota_override_bytes === undefined
        ? (before?.quota_override_bytes ?? null)
        : data.quota_override_bytes === null
          ? null
          : integer(data.quota_override_bytes, "quota_override_bytes");
    const state = data.status ?? before?.status ?? "active";
    if (!["active", "read_only", "suspended"].includes(String(state)))
      fail(400, "Invalid Drive status");
    const policy = await settings(c.env),
      quota = override === null ? policy.default_quota_bytes : (override as number);
    await adminMutate(
      c,
      "admin.drive.accounts.manage",
      [
        before
          ? condition(
              "EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND version=?)",
              user,
              expected(data),
            )
          : condition("NOT EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=?)", user),
        condition("EXISTS(SELECT 1 FROM drive_settings WHERE id=1 AND version=?)", policy.version),
      ],
      (proof, operation) => [
        statement(
          c.env,
          `INSERT INTO drive_accounts(user_id,quota_bytes,quota_override_bytes,status,version,updated_at) SELECT ?,?,?,?,1,? WHERE ${proof}
      ON CONFLICT(user_id) DO UPDATE SET quota_bytes=excluded.quota_bytes,quota_override_bytes=excluded.quota_override_bytes,status=excluded.status,version=drive_accounts.version+1,updated_at=excluded.updated_at`,
          user,
          quota,
          override as number | null,
          String(state),
          now(),
        ),
        ...notificationStatements(
          c,
          operation,
          proof,
          [user],
          "Drive account updated",
          "An administrator updated your Drive storage limit or availability.",
        ),
      ],
      {
        action: "account_updated",
        type: "account",
        id: user,
        details: {
          reason: reason(data.reason),
          before,
          after: { quota_bytes: quota, quota_override_bytes: override, status: state },
        },
      },
    );
    return c.json({ account: await first(c.env, accountSelect + " AND u.id=?", user) });
  },
);
adminDrive.post(
  "/accounts/:userId/cancel-uploads",
  requirePermission("admin.drive.accounts.manage"),
  async (c) => {
    const user = identifier(c.req.param("userId")),
      data = await body(c, ["version", "reason"]);
    const pending = await rows<{ id: string; size: number }>(
      c.env,
      "SELECT id,size FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled')",
      user,
    );
    if (!pending.length) fail(409, "There are no unfinished uploads to cancel");
    await adminMutate(
      c,
      "admin.drive.accounts.manage",
      [
        condition(
          "EXISTS(SELECT 1 FROM drive_accounts WHERE user_id=? AND version=?)",
          user,
          expected(data),
        ),
        condition(
          "?=(SELECT COUNT(*) FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled'))",
          pending.length,
          user,
        ),
      ],
      (proof) => [
        statement(
          c.env,
          `INSERT INTO drive_garbage(blob_key,not_before) SELECT blob_key,MAX(lease_until,unixepoch()) FROM drive_uploads WHERE owner_user_id=? AND status NOT IN ('completed','cancelled') AND ${proof} ON CONFLICT(blob_key) DO UPDATE SET not_before=MAX(drive_garbage.not_before,excluded.not_before)`,
          user,
        ),
        statement(
          c.env,
          `UPDATE drive_uploads SET status='cancelled' WHERE owner_user_id=? AND status NOT IN ('completed','cancelled') AND ${proof}`,
          user,
        ),
      ],
      {
        action: "uploads_cancelled",
        type: "account",
        id: user,
        details: {
          reason: reason(data.reason),
          upload_ids: pending.map((upload) => upload.id),
          reserved_bytes: pending.reduce((sum, upload) => sum + upload.size, 0),
        },
      },
    );
    return c.json({ cancelled: pending.length });
  },
);

adminDrive.get("/items", requirePermission("admin.drive.items.read"), async (c) => {
  const query = q(c),
    owner = c.req.query("owner") ? identifier(c.req.query("owner"), "owner") : "",
    state = c.req.query("state") ?? "active",
    args: Bind[] = [];
  if (!["active", "trash", "all"].includes(state)) fail(400, "Invalid inventory filter");
  let filters = "d.purged_at IS NULL";
  if (state === "active") filters += ` AND ${cleanPath("d.id")}`;
  if (state === "trash") filters += ` AND NOT (${cleanPath("d.id")})`;
  if (owner) {
    filters += " AND d.owner_user_id=?";
    args.push(owner);
  }
  if (query) {
    filters += " AND d.name LIKE ? ESCAPE '\\'";
    args.push(search(query));
  }
  return c.json(
    await page<{ page_id: string }>(
      c,
      JSON.stringify(["admin.items", query, owner, state]),
      `SELECT d.id page_id,d.id,d.name,d.kind,d.parent_id,d.owner_user_id,d.version,d.updated_at,d.trashed_at,NOT (${cleanPath("d.id")}) in_trash,u.display_name owner_name,u.email_address owner_email,v.size,
    (SELECT COALESCE(SUM(size),0) FROM drive_versions WHERE item_id=d.id) version_bytes FROM drive_items d JOIN users u ON u.id=d.owner_user_id LEFT JOIN drive_versions v ON v.id=d.current_version_id WHERE ${filters}`,
      args,
      "d.id",
    ),
  );
});
adminDrive.get("/sharing", requirePermission("admin.drive.sharing.read"), async (c) => {
  const query = q(c),
    owner = c.req.query("owner") ? identifier(c.req.query("owner")) : "",
    kind = c.req.query("kind") ?? "links",
    state = c.req.query("state") ?? "active",
    args: Bind[] = [];
  if (!["links", "grants"].includes(kind) || !["active", "all"].includes(state))
    fail(400, "Invalid sharing filter");
  let filters = "d.purged_at IS NULL";
  if (owner) {
    filters += " AND d.owner_user_id=?";
    args.push(owner);
  }
  if (query) {
    filters += " AND (d.name LIKE ? ESCAPE '\\' OR owner.email_address LIKE ? ESCAPE '\\')";
    args.push(search(query), search(query));
  }
  if (kind === "links") {
    if (state === "active")
      filters += " AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>unixepoch())";
    return c.json(
      await page<{ page_id: string }>(
        c,
        JSON.stringify(["admin.links", query, owner, state]),
        `SELECT l.id page_id,l.id,d.id item_id,d.name,d.kind,d.version,d.owner_user_id,owner.email_address owner_email,l.allow_download,l.expires_at,l.revoked_at,l.created_at,l.created_by,l.password_hash IS NOT NULL password_protected,
      (${publicLinkPolicy("l")} AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>unixepoch()) AND ${availableItem("d.id")} AND ${activeUser("owner")} AND ${driveEnabled("owner")} AND ${cleanPath("d.id")}) policy_allowed FROM drive_links l JOIN drive_items d ON d.id=l.item_id JOIN users owner ON owner.id=d.owner_user_id WHERE ${filters}`,
        args,
        "l.id",
      ),
    );
  }
  if (state === "active") filters += " AND (p.expires_at IS NULL OR p.expires_at>unixepoch())";
  return c.json(
    await page<{ page_id: string }>(
      c,
      JSON.stringify(["admin.grants", query, owner, state]),
      `SELECT p.item_id||':'||p.user_id page_id,p.item_id,d.name,d.kind,d.version,d.owner_user_id,owner.email_address owner_email,p.user_id,u.display_name,u.email_address,p.role,p.expires_at,p.created_at FROM drive_permissions p JOIN drive_items d ON d.id=p.item_id JOIN users owner ON owner.id=d.owner_user_id JOIN users u ON u.id=p.user_id WHERE ${filters}`,
      args,
      "p.item_id||':'||p.user_id",
    ),
  );
});
adminDrive.post(
  "/items/:itemId/permissions",
  requirePermission("admin.drive.sharing.manage"),
  async (c) => {
    const data = await body(c, ["version", "user_id", "role", "expires_at", "reason"]),
      current = await item(c),
      recipient = identifier(data.user_id, "user_id"),
      granted = role(data.role),
      expires = expiry(data.expires_at);
    if (current.version !== expected(data)) fail(412, "Drive item changed. Reload and try again.");
    if (recipient === current.owner_user_id) fail(400, "Owner access cannot be changed");
    const eligible = condition(
      `EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${activeUser("u")} AND ${driveEnabled("u")})`,
      recipient,
    );
    if (!(await first(c.env, `SELECT 1 WHERE ${eligible.sql}`, ...eligible.args)))
      fail(400, "Recipient must have active Drive access");
    const before = await first(
      c.env,
      "SELECT role,expires_at FROM drive_permissions WHERE item_id=? AND user_id=?",
      current.id,
      recipient,
    );
    await adminMutate(
      c,
      "admin.drive.sharing.manage",
      [
        snapshot(current),
        noTransfer(current.owner_user_id),
        eligible,
        condition(
          `(SELECT internal_sharing_enabled FROM drive_settings WHERE id=1)=1 AND ${cleanPath("?")}`,
          current.id,
        ),
      ],
      (proof, operation) => [
        statement(
          c.env,
          `INSERT INTO drive_permissions(item_id,user_id,role,expires_at,created_by) SELECT ?,?,?,?,? WHERE ${proof} ON CONFLICT(item_id,user_id) DO UPDATE SET role=excluded.role,expires_at=excluded.expires_at,created_by=excluded.created_by`,
          current.id,
          recipient,
          granted,
          expires,
          c.get("identity").user.id,
        ),
        statement(
          c.env,
          `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`,
          now(),
          current.id,
        ),
        ...itemEvent(
          c,
          current,
          proof,
          operation,
          "admin_permission_granted",
          { user_id: recipient, role: granted, expires_at: expires },
          [recipient],
        ),
        ...notificationStatements(
          c,
          operation,
          proof,
          [recipient],
          "Drive access updated",
          "An administrator updated your access to a Drive item.",
        ),
      ],
      {
        action: "permission_granted",
        type: "item",
        id: current.id,
        details: {
          reason: reason(data.reason),
          user_id: recipient,
          before,
          after: { role: granted, expires_at: expires },
        },
      },
    );
    return c.json({ version: current.version + 1 });
  },
);
adminDrive.delete(
  "/items/:itemId/permissions/:userId",
  requirePermission("admin.drive.sharing.manage"),
  async (c) => {
    const data = await body(c, ["version", "reason"]),
      current = await item(c),
      recipient = identifier(c.req.param("userId"));
    const before = await first(
      c.env,
      "SELECT role,expires_at FROM drive_permissions WHERE item_id=? AND user_id=?",
      current.id,
      recipient,
    );
    if (!before)
      fail(404, "Direct grant not found; inherited access must be changed on its source folder");
    await adminMutate(
      c,
      "admin.drive.sharing.manage",
      [
        condition(
          "EXISTS(SELECT 1 FROM drive_items WHERE id=? AND version=? AND purged_at IS NULL)",
          current.id,
          expected(data),
        ),
        noTransfer(current.owner_user_id),
        condition(
          "EXISTS(SELECT 1 FROM drive_permissions WHERE item_id=? AND user_id=?)",
          current.id,
          recipient,
        ),
      ],
      (proof, operation) => [
        statement(
          c.env,
          `DELETE FROM drive_permissions WHERE item_id=? AND user_id=? AND ${proof}`,
          current.id,
          recipient,
        ),
        statement(
          c.env,
          `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`,
          now(),
          current.id,
        ),
        ...itemEvent(
          c,
          current,
          proof,
          operation,
          "admin_permission_revoked",
          { user_id: recipient },
          [recipient],
        ),
        ...notificationStatements(
          c,
          operation,
          proof,
          [recipient],
          "Drive access updated",
          "An administrator revoked a Drive sharing grant.",
        ),
      ],
      {
        action: "permission_revoked",
        type: "item",
        id: current.id,
        details: { reason: reason(data.reason), user_id: recipient, before },
      },
    );
    return c.json({ version: current.version + 1 });
  },
);
adminDrive.post(
  "/items/:itemId/links/:linkId/revoke",
  requirePermission("admin.drive.sharing.manage"),
  async (c) => {
    const data = await body(c, ["version", "reason"]),
      current = await item(c),
      link = identifier(c.req.param("linkId"));
    await adminMutate(
      c,
      "admin.drive.sharing.manage",
      [
        condition(
          "EXISTS(SELECT 1 FROM drive_items WHERE id=? AND version=? AND purged_at IS NULL)",
          current.id,
          expected(data),
        ),
        noTransfer(current.owner_user_id),
        condition(
          "EXISTS(SELECT 1 FROM drive_links WHERE id=? AND item_id=? AND revoked_at IS NULL)",
          link,
          current.id,
        ),
      ],
      (proof, operation) => [
        statement(
          c.env,
          `UPDATE drive_links SET revoked_at=? WHERE id=? AND ${proof}`,
          now(),
          link,
        ),
        statement(
          c.env,
          `UPDATE drive_items SET version=version+1,updated_at=? WHERE id=? AND ${proof}`,
          now(),
          current.id,
        ),
        ...itemEvent(c, current, proof, operation, "admin_link_revoked", { link_id: link }),
      ],
      {
        action: "link_revoked",
        type: "item",
        id: current.id,
        details: { reason: reason(data.reason), link_id: link },
      },
    );
    return c.json({ version: current.version + 1 });
  },
);

for (const action of ["restore", "purge"] as const)
  adminDrive.post(
    `/items/:itemId/${action}`,
    requirePermission(`admin.drive.trash.${action}`),
    async (c) => {
      const data = await body(c, ["version", "reason"]),
        current = await item(c);
      if (!current.trashed_at)
        fail(409, "Select the trashed folder itself, or an item directly in trash");
      const checks = [
        condition(
          "EXISTS(SELECT 1 FROM drive_items WHERE id=? AND version=? AND trashed_at IS NOT NULL AND purged_at IS NULL)",
          current.id,
          expected(data),
        ),
        noTransfer(current.owner_user_id),
      ];
      if (action === "restore" && current.parent_id)
        checks.push(
          condition(
            `EXISTS(SELECT 1 FROM drive_items WHERE id=? AND ${cleanPath("?")})`,
            current.parent_id,
            current.parent_id,
          ),
        );
      await adminMutate(
        c,
        `admin.drive.trash.${action}`,
        checks,
        (proof, operation) => [
          ...(action === "purge"
            ? [
                ...itemEvent(c, current, proof, operation, "admin_purged", {}, [], "removed"),
                ...purgeStatements(c.env, current.id, proof),
              ]
            : [
                statement(
                  c.env,
                  `UPDATE drive_items SET trashed_at=NULL,version=version+1,updated_at=? WHERE id=? AND ${proof}`,
                  now(),
                  current.id,
                ),
                ...itemEvent(c, current, proof, operation, "admin_restored", {}, [], "updated"),
              ]),
        ],
        {
          action: action === "purge" ? "item_purged" : "item_restored",
          type: "item",
          id: current.id,
          details: {
            reason: reason(data.reason),
            name: current.name,
            owner_user_id: current.owner_user_id,
          },
        },
      );
      return c.json({ version: current.version + 1 });
    },
  );

adminDrive.get("/activity", requirePermission("admin.drive.audit.read"), async (c) => {
  const query = q(c);
  const actor = c.req.query("actor") ? identifier(c.req.query("actor")) : "",
    owner = c.req.query("owner") ? identifier(c.req.query("owner")) : "",
    action = text(c.req.query("action") ?? "", "action", 100),
    kind = c.req.query("kind") ?? "all",
    itemId = c.req.query("item") ? identifier(c.req.query("item")) : "";
  if (!["all", "admin", "items"].includes(kind)) fail(400, "Invalid audit filter");
  const from = c.req.query("from") ? integer(Number(c.req.query("from")), "from") : 0,
    to = c.req.query("to") ? integer(Number(c.req.query("to")), "to") : Number.MAX_SAFE_INTEGER;
  if (from > to) fail(400, "Invalid audit date range");
  const scope = JSON.stringify([
      "admin.activity",
      query,
      actor,
      owner,
      action,
      kind,
      itemId,
      from,
      to,
    ]),
    after = c.req.query("cursor")
      ? await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!)
      : ([Number.MAX_SAFE_INTEGER, "~"] as [number, string]),
    args: Bind[] = [];
  let filter = "created_at>=? AND created_at<=? AND (created_at<? OR (created_at=? AND page_id<?))";
  args.push(from, to, after[0], after[0], after[1]);
  if (actor) {
    filter += " AND actor_user_id=?";
    args.push(actor);
  }
  if (query) {
    filter += " AND (actor_email LIKE ? ESCAPE '\\' OR item_name LIKE ? ESCAPE '\\')";
    args.push(search(query), search(query));
  }
  if (owner) {
    filter += " AND owner_user_id=?";
    args.push(owner);
  }
  if (itemId) {
    filter += " AND item_id=?";
    args.push(itemId);
  }
  if (action) {
    filter += " AND action=?";
    args.push(action);
  }
  if (kind !== "all") {
    filter += " AND source=?";
    args.push(kind);
  }
  const result = await rows<{ page_id: string; created_at: number; details_json: string }>(
    c.env,
    `SELECT * FROM (
    SELECT 'items:'||a.seq page_id,'items' source,a.action,a.actor_user_id,u.display_name actor_name,u.email_address actor_email,a.owner_user_id,a.item_id,d.name item_name,'item' target_type,a.item_id target_id,a.details_json,a.created_at FROM drive_activity a JOIN drive_items d ON d.id=a.item_id LEFT JOIN users u ON u.id=a.actor_user_id
    UNION ALL SELECT 'admin:'||a.seq,'admin',a.action,a.actor_user_id,u.display_name,u.email_address,CASE WHEN a.target_type='account' THEN a.target_id ELSE d.owner_user_id END,CASE WHEN a.target_type='item' THEN a.target_id END,d.name,a.target_type,a.target_id,a.details_json,a.created_at FROM drive_admin_activity a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN drive_items d ON a.target_type='item' AND d.id=a.target_id
  ) WHERE ${filter} ORDER BY created_at DESC,page_id DESC LIMIT ?`,
    ...args,
    limit(c) + 1,
  );
  const entries = result.slice(0, limit(c));
  return c.json({
    items: entries.map(({ details_json, ...entry }) => ({
      ...entry,
      details: JSON.parse(details_json),
    })),
    next_cursor:
      result.length > entries.length
        ? await cursor(c.env, c.get("identity").user.id, scope, [
            entries.at(-1)!.created_at,
            entries.at(-1)!.page_id,
          ])
        : null,
  });
});
adminDrive.route("/transfers", transferRoutes);

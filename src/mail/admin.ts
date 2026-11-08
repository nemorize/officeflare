import { Hono, type Context } from "hono";
import { t } from "../../shared/i18n/index.ts";
import { cursor, readCursor } from "../drive/cursor";
import { administrator, administrativeControl, all, first } from "./control";
import { flag, integer, jsonBody, strictId, text } from "./input";
import { refreshMailStorage } from "./admin-store";
import { providerSendMaximum } from "./limits";
import { workspaceMailPolicy } from "./policy";
import { epoch, fail, type MailAppEnv } from "./types";

type AdminContext = Context<MailAppEnv>;
type Bind = string | number | null;
export const adminMail = new Hono<MailAppEnv>();
adminMail.use("*", async (c, next) => {
  if (c.get("mail_actor").api_key_id) fail(403, t("mailControl.sessionAuthenticationRequired"));
  c.header("Cache-Control", "private, no-store");
  await next();
});
const query = (c: AdminContext) => text(c.req.query("q") ?? "", "q", 200, true).trim();
const like = (value: string) => `%${value.replace(/[\\%_]/g, (char) => "\\" + char)}%`;
function choice(c: AdminContext, key: string, options: string[]) {
  const value = c.req.query(key) ?? "";
  if (value && !options.includes(value)) fail(400, t("mailInput.invalidField", { field: key }));
  return value;
}
function timeFilters(c: AdminContext, column: string, args: Bind[]) {
  let sql = "";
  for (const key of ["after", "before"] as const) {
    const value = c.req.query(key);
    if (value !== undefined) {
      sql += ` AND ${column}${key === "after" ? ">=" : "<"}?`;
      args.push(integer(Number(value), key, 0, 8640000000000));
    }
  }
  return sql;
}
async function page(
  c: AdminContext,
  name: string,
  sql: string,
  args: Bind[],
  columns: [string, string],
) {
  const filters = [...new URL(c.req.url).searchParams].filter(([key]) => key !== "cursor").sort();
  const scope = `mail.admin.${name}:${JSON.stringify(filters)}`;
  let after: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
  if (c.req.query("cursor")) {
    try {
      after = await readCursor(c.env, c.get("mail_actor").user_id, scope, c.req.query("cursor")!);
    } catch {
      fail(400, t("mailAdmin.invalidCursor"));
    }
  }
  const size = integer(Number(c.req.query("limit") ?? 25), "limit", 1, 100);
  const records = await all<{ page_id: string; page_time: number; [key: string]: unknown }>(
    c.env,
    `${sql} AND (${columns[0]}<? OR (${columns[0]}=? AND ${columns[1]}<?)) ORDER BY ${columns[0]} DESC,${columns[1]} DESC LIMIT ?`,
    ...args,
    after[0],
    after[0],
    after[1],
    size + 1,
  );
  const items = records.slice(0, size);
  const last = items.at(-1);
  return {
    items: items.map(({ page_id: _, page_time: __, ...record }) => record),
    next_cursor:
      records.length > size && last
        ? await cursor(c.env, c.get("mail_actor").user_id, scope, [last.page_time, last.page_id])
        : null,
  };
}

adminMail.get("/overview", async (c) => {
  await administrator(c, "admin.mail.overview.read");
  const summary = await first(
    c.env,
    `SELECT
    (SELECT count(*) FROM mail_domains) domains,
    (SELECT count(*) FROM mail_mailboxes WHERE status<>'deleted') mailboxes,
    (SELECT count(*) FROM mail_mailboxes WHERE kind='shared' AND status<>'deleted') shared_mailboxes,
    (SELECT count(*) FROM mail_mailboxes WHERE status='disabled') disabled_mailboxes,
    (SELECT count(*) FROM mail_domains WHERE (inbound_enabled=1 AND json_type(provider_settings_json,'$.inbound')='object') OR (outbound_enabled=1 AND json_type(provider_settings_json,'$.outbound')='object')) active_domains,
    (SELECT count(*) FROM mail_admin_storage s JOIN mail_mailboxes b ON b.id=s.mailbox_id WHERE b.status<>'deleted') measured_mailboxes,
    (SELECT coalesce(sum(s.database_bytes),0) FROM mail_admin_storage s JOIN mail_mailboxes b ON b.id=s.mailbox_id WHERE b.status<>'deleted') database_bytes,
    (SELECT coalesce(sum(s.attachment_bytes),0) FROM mail_admin_storage s JOIN mail_mailboxes b ON b.id=s.mailbox_id WHERE b.status<>'deleted') attachment_bytes`,
  );
  const flow = await first(
    c.env,
    `SELECT count(*) total,coalesce(sum(direction='inbound' AND status IN ('received','forwarded')),0) received,
    coalesce(sum(direction='outbound' AND status IN ('accepted','delivered')),0) sent,
    coalesce(sum(status IN ('failed','rejected','unknown','complained')),0) failed,
    coalesce(sum(status IN ('queued','scheduled','retry_wait','processing')),0) pending
    FROM mail_admin_flow WHERE created_at>=?`,
    epoch() - 86400,
  );
  return c.json({ summary, flow, tracking_since: (await workspaceMailPolicy(c.env)).created_at });
});
adminMail.get("/mailboxes", async (c) => {
  await administrator(c, "admin.mail.mailboxes.read");
  const q = query(c),
    kind = choice(c, "kind", ["personal", "shared"]),
    status = choice(c, "status", ["active", "disabled", "provisioning"]);
  return c.json(
    await page(
      c,
      "mailboxes",
      `SELECT b.id page_id,b.created_at page_time,b.*,u.email_address owner_email,u.display_name owner_name,
    a.local_part||'@'||d.name email_address,
    (SELECT count(*) FROM mail_mailbox_members m WHERE m.mailbox_id=b.id) member_count,
    s.message_count,s.database_bytes,s.attachment_bytes,s.updated_at storage_updated_at
    FROM mail_mailboxes b JOIN users u ON u.id=b.owner_user_id
    LEFT JOIN mail_addresses a ON a.mailbox_id=b.id AND a.is_primary=1 LEFT JOIN mail_domains d ON d.id=a.domain_id
    LEFT JOIN mail_admin_storage s ON s.mailbox_id=b.id
    WHERE b.status<>'deleted' AND (?='' OR b.kind=?) AND (?='' OR b.status=?)
    AND (?='' OR b.name LIKE ? ESCAPE '\\' OR u.email_address LIKE ? ESCAPE '\\' OR a.local_part||'@'||d.name LIKE ? ESCAPE '\\')`,
      [kind, kind, status, status, q, like(q), like(q), like(q)],
      ["b.created_at", "b.id"],
    ),
  );
});
adminMail.get("/mailboxes/:id/storage", async (c) => {
  await administrator(c, "admin.mail.mailboxes.read");
  const id = strictId(c.req.param("id"));
  if (!(await first(c.env, "SELECT id FROM mail_mailboxes WHERE id=? AND status<>'deleted'", id)))
    fail(404, t("mailAdmin.mailboxNotFound"));
  return c.json({ storage: await refreshMailStorage(c.env, id) });
});
adminMail.get("/flow", async (c) => {
  await administrator(c, "admin.mail.flow.read");
  const q = query(c),
    direction = choice(c, "direction", ["inbound", "outbound"]);
  const status = choice(c, "status", [
    "received",
    "forwarded",
    "queued",
    "scheduled",
    "processing",
    "retry_wait",
    "accepted",
    "delivered",
    "failed",
    "rejected",
    "unknown",
    "canceled",
    "complained",
  ]);
  const args: Bind[] = [direction, direction, status, status, q, like(q), like(q), like(q)];
  const dates = timeFilters(c, "f.created_at", args);
  const result = await page(
    c,
    "flow",
    `SELECT f.id page_id,f.created_at page_time,f.*,b.name mailbox_name,a.local_part||'@'||d.name email_address
    FROM mail_admin_flow f LEFT JOIN mail_mailboxes b ON b.id=f.mailbox_id
    LEFT JOIN mail_addresses a ON a.mailbox_id=b.id AND a.is_primary=1 LEFT JOIN mail_domains d ON d.id=a.domain_id
    WHERE (?='' OR f.direction=?) AND (?='' OR f.status=?) AND (?='' OR b.name LIKE ? ESCAPE '\\' OR f.id LIKE ? ESCAPE '\\' OR a.local_part||'@'||d.name LIKE ? ESCAPE '\\')${dates}`,
    args,
    ["f.created_at", "f.id"],
  );
  return c.json({ ...result, tracking_since: (await workspaceMailPolicy(c.env)).created_at });
});
adminMail.get("/settings", async (c) => {
  await administrator(c, "admin.mail.settings.read");
  return c.json({
    settings: await workspaceMailPolicy(c.env),
    max_send_bytes: providerSendMaximum(),
  });
});
adminMail.patch("/settings", async (c) => {
  await administrator(c, "admin.mail.settings.manage");
  const keys = ["default_retention_days", "max_send_bytes", "external_forwarding_enabled"] as const;
  const data = await jsonBody(c.req.raw, ["version", ...keys]);
  const version = integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER);
  const current = await workspaceMailPolicy(c.env);
  if (!keys.some((key) => key in data)) fail(400, t("mailAdmin.noSettings"));
  const retention =
    "default_retention_days" in data
      ? data.default_retention_days === null
        ? null
        : integer(data.default_retention_days, "default_retention_days", 1, 3650)
      : current.default_retention_days;
  const maximum =
    "max_send_bytes" in data
      ? data.max_send_bytes === null
        ? null
        : integer(data.max_send_bytes, "max_send_bytes", 1, providerSendMaximum())
      : current.max_send_bytes;
  const forwarding =
    "external_forwarding_enabled" in data
      ? flag(data.external_forwarding_enabled, "external_forwarding_enabled")
      : current.external_forwarding_enabled;
  const result = await administrativeControl(c, "admin.mail.settings.manage")
    .prepare(
      "UPDATE mail_workspace_settings SET default_retention_days=?,max_send_bytes=?,external_forwarding_enabled=?,version=version+1,updated_at=?,updated_by=? WHERE id=1 AND version=?",
    )
    .bind(retention, maximum, forwarding, epoch(), c.get("mail_actor").user_id, version)
    .run();
  if (!result.meta.changes) fail(409, t("mailAdmin.settingsChanged"));
  return c.json({ settings: await workspaceMailPolicy(c.env) });
});
adminMail.get("/activity", async (c) => {
  await administrator(c, "admin.mail.activity.read");
  const q = query(c),
    operation = choice(c, "operation", ["POST", "PATCH", "PUT", "DELETE"]);
  const args: Bind[] = [
    operation,
    operation,
    operation,
    q,
    like(q),
    like(q),
    like(q),
    like(q),
    like(q),
    like(q),
  ];
  const dates = timeFilters(c, "a.created_at", args);
  return c.json(
    await page(
      c,
      "activity",
      `SELECT cast(a.sequence AS TEXT) page_id,a.sequence page_time,a.*,u.email_address actor_email,u.display_name actor_name,coalesce(d.name,b.name) resource_name
    FROM mail_admin_audit a LEFT JOIN users u ON u.id=a.actor_user_id
    LEFT JOIN mail_domains d ON d.id=a.resource_id LEFT JOIN mail_mailboxes b ON b.id=a.resource_id
    WHERE (?='' OR a.operation=? OR (?='PATCH' AND a.operation='PUT')) AND (?='' OR u.email_address LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR a.resource_path LIKE ? ESCAPE '\\' OR a.resource_id LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\')${dates}`,
      args,
      ["a.sequence", "a.sequence"],
    ),
  );
});

export async function recordMailAdministration(c: AdminContext) {
  if (c.res.status >= 400 || !["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method)) return;
  const path = c.req.path.replace(/^\/api\/mail/, "");
  if (
    !/^\/(?:admin\/settings|domains|addresses)(?:\/|$)/.test(path) &&
    !/^\/mailboxes(?:\/[^/]+(?:\/configuration|\/members(?:\/[^/]+)?)?)?$/.test(path)
  )
    return;
  let resourceId: string | null = path === "/admin/settings" ? null : (path.split("/")[2] ?? null);
  if (c.req.method === "POST" && !resourceId) {
    try {
      const result = (await c.res.clone().json()) as Record<string, { id?: string }>;
      resourceId =
        result.domain?.id ??
        result.mailbox?.id ??
        result.connection?.id ??
        result.address?.id ??
        null;
    } catch {
      /* The path still identifies the operation. */
    }
  }
  await c.env.DB.prepare(
    "INSERT INTO mail_admin_audit(actor_user_id,operation,resource_path,resource_id) VALUES(?,?,?,?)",
  )
    .bind(c.get("mail_actor").user_id, c.req.method, c.req.path, resourceId)
    .run();
}

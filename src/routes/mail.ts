import { HTTPException } from "hono/http-exception";
import { putStream } from "../mail/objects";
import { Hono } from "hono";
import {
  all,
  administrativeControl,
  resourceControl,
  authenticateMail,
  administrator,
  authorize,
  connection,
  control,
  first,
  activeAccountSql,
  mailAccessSql,
} from "../mail/control";
import {
  cleanHtml,
  domain,
  email,
  flag,
  hash,
  htmlText,
  integer,
  jsonBody,
  localPart,
  recipients,
  strictId,
  text,
} from "../mail/input";
import { mailbox, partition } from "../mail/mailbox";
import { providers, provider } from "../mail/providers";
import {
  exportStream,
  startImport,
  startExport,
  startRestore,
} from "../mail/data";
import { jmap, mcp } from "../mail/protocols";
import { seal } from "../mail/secrets";
import {
  belongs,
  bodyKey,
  createDraft,
  flushOutbox,
  getMessage,
  queryMessages,
  readBody,
  submitDraft,
} from "../mail/service";
import {
  epoch,
  fail,
  id,
  locator,
  publicSubmission,
  type Address,
  type Attachment,
  type Connection,
  type Domain,
  type MailAppEnv,
  type Mailbox,
  type MessageRow,
  type RuleAction,
  type RuleCondition,
} from "../mail/types";

import type { RoutingRule } from "../mail/routing";

const mail = new Hono<MailAppEnv>();
const actor = (c: Parameters<typeof authenticateMail>[0]) =>
  c.get("mail_actor");
const input = (c: Parameters<typeof authenticateMail>[0], fields: string[]) =>
  jsonBody(c.req.raw, fields);
const resource = (c: Parameters<typeof authenticateMail>[0]) =>
  c.req.param("m")!;
const key = (c: Parameters<typeof authenticateMail>[0]) => {
  const supplied = c.req.header("Idempotency-Key");
  if (supplied !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(supplied))
    fail(400, "Invalid Idempotency-Key");
  return supplied ?? id();
};
const publicMessage = ({
  body_r2_key: _body,
  raw_r2_key: _raw,
  ...message
}: MessageRow) => message;
mail.get("/mailboxes/:m/events/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    fail(400, "Expected WebSocket upgrade");
  const ticket = text(c.req.query("ticket"), "ticket", 72);
  // WebSockets are transferable through fetch responses, not DO RPC serialization.
  return mailbox(c.env, resource(c)).fetch(
    new Request(
      "https://mail-events.internal/?ticket=" + encodeURIComponent(ticket),
      { headers: { Upgrade: "websocket" } },
    ),
  );
});
mail.use("*", authenticateMail);
mail.use("/mailboxes/:m/*", async (c, next) => {
  const mailboxId = resource(c);
  await next();
  if (
    c.res.status < 400 &&
    ["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method)
  )
    await mailbox(c.env, mailboxId).audit(
      actor(c).user_id,
      c.req.method,
      c.req.path,
    );
});
mail.onError((error, c) => {
  if (error instanceof HTTPException) {
    const headers = new Headers(error.getResponse().headers);
    headers.delete("content-type");
    headers.delete("content-length");
    return c.json({ error: error.message }, { status: error.status, headers });
  }
  const found = /MAIL:(\d{3}):([^\n]+)/.exec(error.message);
  if (found) {
    if (found[1] === "401") c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: found[2] }, { status: Number(found[1]) as 400 });
  }
  if (/UNIQUE constraint failed/i.test(error.message))
    return c.json({ error: "Value is already assigned" }, 409);
  if (/FOREIGN KEY constraint failed/i.test(error.message))
    return c.json({ error: "Referenced resource is unavailable" }, 409);
  console.error("Mail API failure", error);
  return c.json({ error: "Internal server error" }, 500);
});
mail.get("/providers", (c) =>
  c.json({
    providers: providers.map(({ id, capabilities }) => ({
      provider: id,
      capabilities,
    })),
  }),
);
mail.get("/capabilities", (c) =>
  c.json({
    providers: providers.map(({ id, capabilities }) => ({
      provider: id,
      ...capabilities,
    })),
    features: {
      mailboxes: true,
      shared_mailboxes: true,
      aliases: true,
      search: true,
      attachments: true,
      drafts: true,
      scheduled_send: true,
      rules: true,
      webhooks: !!c.env.MAIL_ENCRYPTION_KEY,
      realtime: true,
      threads: true,
      signatures: true,
      auto_reply: true,
      routing_rules: true,
      contacts: true,
      templates: true,
      api_keys: true,
      imports: true,
      exports: true,
      backups: true,
      audit_logs: true,
      jmap_subset: true,
      mcp: true,
    },
    limits: {
      max_upload_bytes: 5 * 1024 * 1024,
      max_inbound_bytes: 25 * 1024 * 1024,
      max_page_size: 100,
    },
    domain_setup: "cloudflare_dashboard",
  }),
);
mail.get("/provider-connections", async (c) => {
  await administrator(c, "admin.mail.providers.read");
  return c.json({
    connections: await all<Connection>(
      c.env,
      "SELECT * FROM mail_provider_connections ORDER BY created_at,id",
    ),
  });
});
mail.post("/provider-connections", async (c) => {
  await administrator(c, "admin.mail.providers.manage");
  const data = await input(c, ["provider", "name", "enabled"]),
    name = text(data.name, "name", 100),
    selected = provider(text(data.provider, "provider", 64)),
    connectionId = id();
  await administrativeControl(c, "admin.mail.providers.manage")
    .prepare(
      "INSERT INTO mail_provider_connections(id,provider,name,enabled) VALUES(?,?,?,?)",
    )
    .bind(
      connectionId,
      selected.id,
      name,
      data.enabled === undefined ? 1 : flag(data.enabled, "enabled"),
    )
    .run();
  return c.json(
    {
      connection: await first(
        c.env,
        "SELECT * FROM mail_provider_connections WHERE id=?",
        connectionId,
      ),
    },
    201,
  );
});
mail.patch("/provider-connections/:id", async (c) => {
  await administrator(c, "admin.mail.providers.manage");
  const data = await input(c, ["name", "enabled", "version"]),
    version = integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER);
  const existing = await first<Connection>(
    c.env,
    "SELECT * FROM mail_provider_connections WHERE id=?",
    c.req.param("id"),
  );
  if (!existing) fail(404, "Connection not found");
  const result = await administrativeControl(c, "admin.mail.providers.manage")
    .prepare(
      "UPDATE mail_provider_connections SET name=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?",
    )
    .bind(
      data.name === undefined ? existing.name : text(data.name, "name", 100),
      data.enabled === undefined
        ? existing.enabled
        : flag(data.enabled, "enabled"),
      epoch(),
      existing.id,
      version,
    )
    .run();
  if (!result.meta.changes) fail(409, "Connection version changed");
  return c.json({
    connection: await first(
      c.env,
      "SELECT * FROM mail_provider_connections WHERE id=?",
      existing.id,
    ),
  });
});
mail.get("/domains", async (c) => {
  await administrator(c, "admin.mail.domains.read");
  return c.json({
    domains: await all(c.env, "SELECT d.*,i.provider inbound_provider,o.provider outbound_provider FROM mail_domains d LEFT JOIN mail_provider_connections i ON i.id=d.inbound_connection_id LEFT JOIN mail_provider_connections o ON o.id=d.outbound_connection_id ORDER BY d.name"),
    providers: providers.map(({ id, capabilities }) => ({
      provider: id,
      capabilities,
      default_connection_id: id === "cloudflare" ? "cloudflare-bindings" : null,
    })),
  });
});
mail.post("/domains", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  const data = await input(c, [
      "name",
      "inbound_connection_id",
      "outbound_connection_id",
      "inbound_enabled",
      "outbound_enabled",
      "plus_addressing",
    ]),
    domainId = id();
  const inbound =
    data.inbound_connection_id === null
      ? null
      : text(
          data.inbound_connection_id ?? "cloudflare-bindings",
          "inbound_connection_id",
          100,
        );
  const outbound =
    data.outbound_connection_id === null
      ? null
      : text(
          data.outbound_connection_id ?? "cloudflare-bindings",
          "outbound_connection_id",
          100,
        );
  if (inbound) await connection(c.env, inbound);
  if (outbound) await connection(c.env, outbound);
  const receive =
      data.inbound_enabled === undefined
        ? 0
        : flag(data.inbound_enabled, "inbound_enabled"),
    send =
      data.outbound_enabled === undefined
        ? 0
        : flag(data.outbound_enabled, "outbound_enabled");
  if ((receive && !inbound) || (send && !outbound))
    fail(400, "Enabled direction requires a provider connection");
  await administrativeControl(c, "admin.mail.domains.manage")
    .prepare(
      "INSERT INTO mail_domains(id,name,inbound_connection_id,outbound_connection_id,inbound_enabled,outbound_enabled,plus_addressing) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      domainId,
      domain(data.name),
      inbound,
      outbound,
      receive,
      send,
      data.plus_addressing === undefined
        ? 1
        : flag(data.plus_addressing, "plus_addressing"),
    )
    .run();
  return c.json(
    {
      domain: await first(
        c.env,
        "SELECT * FROM mail_domains WHERE id=?",
        domainId,
      ),
    },
    201,
  );
});
mail.patch("/domains/:id", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  const data = await input(c, [
    "inbound_connection_id",
    "outbound_connection_id",
    "inbound_enabled",
    "outbound_enabled",
    "plus_addressing",
    "catch_all_mailbox_id",
  ]);
  const existing = await first<Domain>(
    c.env,
    "SELECT * FROM mail_domains WHERE id=?",
    c.req.param("id"),
  );
  if (!existing) fail(404, "Domain not found");
  const values: Record<string, string | number | null> = {};
  for (const field of [
    "inbound_connection_id",
    "outbound_connection_id",
  ] as const)
    if (field in data) {
      values[field] =
        data[field] === null ? null : text(data[field], field, 100);
      if (values[field]) await connection(c.env, String(values[field]));
    }
  for (const field of [
    "inbound_enabled",
    "outbound_enabled",
    "plus_addressing",
  ])
    if (field in data) values[field] = flag(data[field], field);
  if ("catch_all_mailbox_id" in data) {
    values.catch_all_mailbox_id =
      data.catch_all_mailbox_id === null
        ? null
        : strictId(data.catch_all_mailbox_id);
    if (
      values.catch_all_mailbox_id &&
      !(await first(
        c.env,
        "SELECT id FROM mail_mailboxes WHERE id=? AND status='active'",
        values.catch_all_mailbox_id,
      ))
    )
      fail(400, "Catch-all mailbox is not active");
  }
  const inbound =
      values.inbound_connection_id === undefined
        ? existing.inbound_connection_id
        : values.inbound_connection_id,
    outbound =
      values.outbound_connection_id === undefined
        ? existing.outbound_connection_id
        : values.outbound_connection_id;
  if (
    ((values.inbound_enabled ?? existing.inbound_enabled) && !inbound) ||
    ((values.outbound_enabled ?? existing.outbound_enabled) && !outbound)
  )
    fail(400, "Enabled direction requires a provider connection");
  const fields = Object.keys(values);
  if (!fields.length) fail(400, "No changes supplied");
  await administrativeControl(c, "admin.mail.domains.manage")
    .prepare(
      "UPDATE mail_domains SET " +
        fields.map((f) => f + "=?").join(",") +
        ",updated_at=? WHERE id=?",
    )
    .bind(...fields.map((f) => values[f]), epoch(), existing.id)
    .run();
  return c.json({
    domain: await first(
      c.env,
      "SELECT * FROM mail_domains WHERE id=?",
      existing.id,
    ),
  });
});
mail.get("/domains/:id/setup", async (c) => {
  await administrator(c, "admin.mail.domains.read");
  const entry = await first<Domain>(
    c.env,
    "SELECT * FROM mail_domains WHERE id=?",
    c.req.param("id"),
  );
  if (!entry) fail(404, "Domain not found");
  return c.json({
    domain: entry,
    receive: {
      provider: entry.inbound_connection_id
        ? (await connection(c.env, entry.inbound_connection_id)).provider
        : null,
      action: "Enable Email Routing and route catch-all to this Worker",
    },
    send: {
      provider: entry.outbound_connection_id
        ? (await connection(c.env, entry.outbound_connection_id)).provider
        : null,
      action:
        "Onboard and verify the sending domain in Cloudflare Email Service",
    },
    verification:
      "Cloudflare validates sending readiness on each send; enabling a local domain does not configure DNS",
  });
});
mail.get("/domains/:id/rules", async (c) => {
  await administrator(c, "admin.mail.domains.read");
  return c.json({
    rules: await all(
      c.env,
      "SELECT * FROM mail_routing_rules WHERE domain_id=? ORDER BY priority DESC,id",
      c.req.param("id"),
    ),
  });
});
mail.post("/domains/:id/rules", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  const data = await input(c, [
    "id",
    "version",
    "name",
    "priority",
    "enabled",
    "conditions",
    "action",
    "forward_to",
    "reject_reason",
  ]);
  if (
    !Array.isArray(data.conditions) ||
    !data.conditions.length ||
    data.conditions.length > 20 ||
    !["store", "forward", "reject"].includes(String(data.action))
  )
    fail(400, "Invalid routing rule");
  const conditions = data.conditions.map((value) => {
    if (
      !value ||
      !["from", "to", "subject"].includes(value.field) ||
      !["contains", "equals", "prefix", "suffix"].includes(value.operator)
    )
      fail(400, "Invalid routing condition");
    return {
      field: value.field,
      operator: value.operator,
      value: text(value.value, "value", 1000),
    };
  });
  const ruleId = data.id === undefined ? id() : strictId(data.id),
    existing = await first<RoutingRule>(
      c.env,
      "SELECT * FROM mail_routing_rules WHERE id=? AND domain_id=?",
      ruleId,
      c.req.param("id"),
    );
  const version =
    data.version === undefined
      ? 1
      : integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER);
  if (existing && existing.version !== version)
    fail(409, "Rule version changed");
  if (
    !existing &&
    (
      await all(
        c.env,
        "SELECT id FROM mail_routing_rules WHERE domain_id=?",
        c.req.param("id"),
      )
    ).length >= 100
  )
    fail(409, "Routing rule limit reached");
  const reason =
    data.reject_reason === undefined
      ? null
      : text(data.reject_reason, "reject_reason", 200);
  if (reason && /[\r\n]/.test(reason)) fail(400, "Invalid rejection reason");
  const values = [
    text(data.name, "name", 100),
    integer(data.priority ?? 0, "priority", -1000, 1000),
    data.enabled === undefined ? 1 : flag(data.enabled, "enabled"),
    JSON.stringify(conditions),
    String(data.action),
    data.action === "forward" ? email(data.forward_to) : null,
    reason,
  ];
  const db = administrativeControl(c, "admin.mail.domains.manage");
  const result = existing
    ? await db
        .prepare(
          "UPDATE mail_routing_rules SET name=?,priority=?,enabled=?,conditions_json=?,action=?,forward_to=?,reject_reason=?,version=version+1 WHERE id=? AND domain_id=? AND version=?",
        )
        .bind(...values, ruleId, c.req.param("id"), version)
        .run()
    : await db
        .prepare(
          "INSERT INTO mail_routing_rules(id,domain_id,name,priority,enabled,conditions_json,action,forward_to,reject_reason) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(ruleId, c.req.param("id"), ...values)
        .run();
  if (!result.meta.changes) fail(409, "Rule or permissions changed");
  return c.json(
    {
      rule: await first(
        c.env,
        "SELECT * FROM mail_routing_rules WHERE id=?",
        ruleId,
      ),
    },
    existing ? 200 : 201,
  );
});
mail.delete("/domains/:id/rules/:rule", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  await administrativeControl(c, "admin.mail.domains.manage")
    .prepare("DELETE FROM mail_routing_rules WHERE id=? AND domain_id=?")
    .bind(c.req.param("rule"), c.req.param("id"))
    .run();
  return c.body(null, 204);
});
mail.get("/mailboxes", async (c) => {
  if (c.req.query("all") === "true") {
    await administrator(c, "admin.mail.mailboxes.read");
    return c.json({
      mailboxes: await all(
        c.env,
        "SELECT * FROM mail_mailboxes WHERE status<>'deleted' ORDER BY created_at,id LIMIT 1000",
      ),
    });
  }
  const owner = actor(c);
  const entries = await all<Mailbox & { can_read: number; can_write: number; can_send_as: number; can_send_on_behalf: number; can_manage: number }>(
    c.env,
    "SELECT DISTINCT b.*,m.can_read,m.can_write,m.can_send_as,m.can_send_on_behalf,m.can_manage FROM mail_mailboxes b JOIN users u ON u.id=? LEFT JOIN mail_mailbox_members m ON m.mailbox_id=b.id AND m.user_id=u.id WHERE " + activeAccountSql + " AND " + mailAccessSql + " AND b.status='active' AND (b.owner_user_id=? OR m.can_read=1 OR m.can_write=1 OR m.can_manage=1 OR m.can_send_as=1 OR m.can_send_on_behalf=1) ORDER BY b.created_at,b.id LIMIT 1000",
    owner.user_id,
    owner.user_id,
  );
  const scoped = owner.api_key_id ? await all<{ mailbox_id: string; action: string }>(
    c.env,
    "SELECT mailbox_id,action FROM mail_api_key_scopes WHERE key_id=?",
    owner.api_key_id,
  ) : null;
  return c.json({
    mailboxes: entries.filter((b) => !scoped || scoped.some((s) => s.mailbox_id === b.id)).map(({ can_read, can_write, can_send_as, can_send_on_behalf, can_manage, ...b }) => ({
      ...b,
      access: Object.fromEntries(Object.entries({ read: can_read, write: can_write, send_as: can_send_as, send_on_behalf: can_send_on_behalf, manage: can_manage }).map(([action, granted]) => [action,
        (b.owner_user_id === owner.user_id || granted === 1) && (!scoped || scoped.some((s) => s.mailbox_id === b.id && s.action === action)),
      ])),
    })),
  });
});
mail.post("/mailboxes", async (c) => {
  await administrator(c, "admin.mail.mailboxes.manage");
  const data = await input(c, ["name", "owner_user_id", "kind"]),
    owner = text(data.owner_user_id ?? actor(c).user_id, "owner_user_id", 100),
    name = text(data.name, "name", 100),
    kind = data.kind ?? "personal";
  if (!["personal", "shared"].includes(String(kind)))
    fail(400, "Invalid mailbox kind");
  if (
    !(await first(
      c.env,
      "SELECT id FROM users WHERE id=? AND deleted_at IS NULL",
      owner,
    ))
  )
    fail(400, "Owner is unavailable");
  const operationId = await hash(actor(c).user_id + ":mailbox:" + key(c)),
    requestHash = await hash(JSON.stringify({ name, owner, kind }));
  const previous = await first<{ resource_id: string; request_hash: string }>(
    c.env,
    "SELECT * FROM mail_control_operations WHERE id=?",
    operationId,
  );
  if (previous && previous.request_hash !== requestHash)
    fail(409, "Idempotency key reused with different request");
  const mailboxId = previous?.resource_id ?? id(),
    db = administrativeControl(c, "admin.mail.mailboxes.manage");
  if (!previous) {
    const result = await db.batch([
      db
        .prepare(
          "INSERT INTO mail_mailboxes(id,owner_user_id,name,kind) VALUES(?,?,?,?)",
        )
        .bind(mailboxId, owner, name, kind),
      db
        .prepare(
          "INSERT INTO mail_control_operations(id,actor_id,operation,resource_id,request_hash) VALUES(?,?,'provision_mailbox',?,?)",
        )
        .bind(operationId, actor(c).user_id, mailboxId, requestHash),
    ]);
    if (!result[0]!.meta.changes)
      fail(409, "Permissions changed during mailbox provisioning");
  }
  await mailbox(c.env, mailboxId).initialize(mailboxId);
  await db.batch([
    db
      .prepare(
        "UPDATE mail_mailboxes SET status='active',updated_at=? WHERE id=? AND status='provisioning'",
      )
      .bind(epoch(), mailboxId),
    db
      .prepare(
        "UPDATE mail_control_operations SET status='completed' WHERE id=?",
      )
      .bind(operationId),
  ]);
  return c.json(
    {
      mailbox: await first(
        c.env,
        "SELECT * FROM mail_mailboxes WHERE id=?",
        mailboxId,
      ),
    },
    previous ? 200 : 201,
  );
});
mail.patch("/mailboxes/:m", async (c) => {
  await administrator(c, "admin.mail.mailboxes.manage");
  const data = await input(c, ["name", "status"]),
    existing = await first<Mailbox>(
      c.env,
      "SELECT * FROM mail_mailboxes WHERE id=?",
      resource(c),
    );
  if (!existing) fail(404, "Mailbox not found");
  const status = data.status ?? existing.status;
  if (!["active", "disabled"].includes(String(status)))
    fail(400, "Invalid mailbox status");
  await administrativeControl(c, "admin.mail.mailboxes.manage")
    .prepare(
      "UPDATE mail_mailboxes SET name=?,status=?,updated_at=? WHERE id=?",
    )
    .bind(
      data.name === undefined ? existing.name : text(data.name, "name", 100),
      status,
      epoch(),
      existing.id,
    )
    .run();
  return c.json({
    mailbox: await first(
      c.env,
      "SELECT * FROM mail_mailboxes WHERE id=?",
      existing.id,
    ),
  });
});
mail.get("/mailboxes/:m/members", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  return c.json({
    members: await all(
      c.env,
      "SELECT m.*,u.email_address,u.display_name FROM mail_mailbox_members m JOIN users u ON u.id=m.user_id WHERE m.mailbox_id=?",
      resource(c),
    ),
    candidates: await all(c.env,
      "SELECT u.id,u.email_address,u.display_name FROM users u WHERE " + activeAccountSql + " AND " + mailAccessSql + " AND (u.email_address LIKE ? ESCAPE '\\' OR coalesce(u.display_name,'') LIKE ? ESCAPE '\\') ORDER BY u.email_address LIMIT 100",
      "%" + (c.req.query("search") ?? "").slice(0, 200).replace(/[\\%_]/g, "\\$&") + "%",
      "%" + (c.req.query("search") ?? "").slice(0, 200).replace(/[\\%_]/g, "\\$&") + "%"),
  });
});
mail.put("/mailboxes/:m/members/:user", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const data = await input(c, [
    "read",
    "write",
    "send_as",
    "send_on_behalf",
    "manage",
  ]);
  if (
    !(await first(
      c.env,
      "SELECT id FROM users WHERE id=? AND deleted_at IS NULL",
      c.req.param("user"),
    ))
  )
    fail(400, "User is unavailable");
  await resourceControl(c, resource(c), "manage")
    .prepare(
      "INSERT INTO mail_mailbox_members VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(mailbox_id,user_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write,can_send_as=excluded.can_send_as,can_send_on_behalf=excluded.can_send_on_behalf,can_manage=excluded.can_manage,updated_at=excluded.updated_at",
    )
    .bind(
      resource(c),
      c.req.param("user"),
      ...["read", "write", "send_as", "send_on_behalf", "manage"].map((f) =>
        data[f] === undefined ? 0 : flag(data[f], f),
      ),
      epoch(),
    )
    .run();
  return c.json({
    member: await first(
      c.env,
      "SELECT * FROM mail_mailbox_members WHERE mailbox_id=? AND user_id=?",
      resource(c),
      c.req.param("user"),
    ),
  });
});
mail.delete("/mailboxes/:m/members/:user", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  await resourceControl(c, resource(c), "manage")
    .prepare(
      "DELETE FROM mail_mailbox_members WHERE mailbox_id=? AND user_id=?",
    )
    .bind(resource(c), c.req.param("user"))
    .run();
  return c.body(null, 204);
});
mail.get("/mailboxes/:m/addresses", async (c) => {
  try { await authorize(c.env, actor(c), resource(c), "read"); }
  catch { await administrator(c, "admin.mail.domains.read"); }
  return c.json({
    addresses: await all(
      c.env,
      "SELECT a.*,a.local_part||'@'||d.name email_address FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE a.mailbox_id=?",
      resource(c),
    ),
  });
});
mail.post("/addresses", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  const data = await input(c, [
      "domain_id",
      "mailbox_id",
      "local_part",
      "is_primary",
      "receive_enabled",
      "send_enabled",
    ]),
    addressId = id();
  if (
    !(await first(
      c.env,
      "SELECT id FROM mail_mailboxes WHERE id=? AND status='active'",
      strictId(data.mailbox_id),
    ))
  )
    fail(400, "Mailbox is unavailable");
  await administrativeControl(c, "admin.mail.domains.manage")
    .prepare(
      "INSERT INTO mail_addresses(id,domain_id,mailbox_id,local_part,is_primary,receive_enabled,send_enabled) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      addressId,
      strictId(data.domain_id),
      data.mailbox_id,
      localPart(data.local_part),
      data.is_primary === undefined ? 0 : flag(data.is_primary, "is_primary"),
      data.receive_enabled === undefined
        ? 1
        : flag(data.receive_enabled, "receive_enabled"),
      data.send_enabled === undefined
        ? 1
        : flag(data.send_enabled, "send_enabled"),
    )
    .run();
  return c.json(
    {
      address: await first(
        c.env,
        "SELECT * FROM mail_addresses WHERE id=?",
        addressId,
      ),
    },
    201,
  );
});
mail.delete("/addresses/:id", async (c) => {
  await administrator(c, "admin.mail.domains.manage");
  await administrativeControl(c, "admin.mail.domains.manage")
    .prepare("DELETE FROM mail_addresses WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  return c.body(null, 204);
});
mail.get("/mailboxes/:m/settings", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  return c.json({ settings: await mailbox(c.env, resource(c)).settings() });
});
mail.patch("/mailboxes/:m/settings", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const data = await input(c, [
      "signature",
      "retention_days",
      "auto_reply_enabled",
      "auto_reply_subject",
      "auto_reply_text",
    ]),
    values: Record<string, string | number | null> = {};
  for (const f of ["signature", "auto_reply_subject", "auto_reply_text"])
    if (f in data)
      values[f] = text(
        data[f],
        f,
        f === "auto_reply_subject" ? 998 : 10000,
        true,
      );
  if ("auto_reply_enabled" in data)
    values.auto_reply_enabled = flag(
      data.auto_reply_enabled,
      "auto_reply_enabled",
    );
  if ("retention_days" in data)
    values.retention_days =
      data.retention_days === null
        ? null
        : integer(data.retention_days, "retention_days", 1, 3650);
  return c.json({
    settings: await mailbox(c.env, resource(c)).updateSettings(values),
  });
});
mail.get("/mailboxes/:m/folders", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  return c.json({ folders: await mailbox(c.env, resource(c)).folders() });
});
mail.post("/mailboxes/:m/folders", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, ["name"]);
  return c.json(
    {
      folder: await mailbox(c.env, resource(c)).putFolder(
        id(),
        text(data.name, "name", 100),
      ),
    },
    201,
  );
});
mail.patch("/mailboxes/:m/folders/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, ["name", "version"]);
  return c.json({
    folder: await mailbox(c.env, resource(c)).putFolder(
      c.req.param("id"),
      text(data.name, "name", 100),
      integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER),
    ),
  });
});
mail.delete("/mailboxes/:m/folders/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  await mailbox(c.env, resource(c)).deleteFolder(
    c.req.param("id"),
    integer(
      Number(c.req.query("version")),
      "version",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  );
  return c.body(null, 204);
});
async function listMessages(c: Parameters<typeof authenticateMail>[0]) {
  const query = {
    limit: integer(Number(c.req.query("limit") ?? 50), "limit", 1, 100) + 1,
    search: c.req.query("q"),
    folder_id: c.req.query("folder_id"),
    thread_id: c.req.query("thread_id"),
    include_snoozed: c.req.query("include_snoozed") === "true",
    snoozed_only: c.req.query("snoozed_only") === "true",
  };
  let cursor:
    | {
        before: { received_at: number; id: string };
        partitions: string[];
        fingerprint: string;
      }
    | undefined;
  const fingerprint = await hash(
    JSON.stringify({ mailbox: resource(c), actor: actor(c), ...query }),
  );
  if (c.req.query("cursor")) {
    try {
      cursor = JSON.parse(atob(c.req.query("cursor")!));
    } catch {
      fail(400, "Invalid cursor");
    }
    if (
      !cursor ||
      cursor.fingerprint !== fingerprint ||
      !Array.isArray(cursor.partitions) ||
      cursor.partitions.length > 10000 ||
      !cursor.before ||
      !Number.isSafeInteger(cursor.before.received_at) ||
      typeof cursor.before.id !== "string"
    )
      fail(400, "Invalid cursor");
  }
  const result = await queryMessages(
      c.env,
      actor(c),
      resource(c),
      { ...query, before: cursor?.before },
      cursor?.partitions,
    ),
    hasNext = result.messages.length === query.limit;
  const page = result.messages.slice(0, query.limit - 1),
    last = page.at(-1);
  return c.json({
    messages: page.map(publicMessage),
    next_cursor:
      hasNext && last
        ? btoa(
            JSON.stringify({
              before: { received_at: last.received_at, id: last.id },
              partitions: result.partitions,
              fingerprint,
            }),
          )
        : null,
  });
}
mail.get("/mailboxes/:m/messages", listMessages);
mail.get("/mailboxes/:m/search", listMessages);
mail.get("/mailboxes/:m/threads/:thread", async (c) => {
  const result = await queryMessages(c.env, actor(c), resource(c), {
    limit: 101,
    thread_id: strictId(c.req.param("thread")),
    include_snoozed: true,
  });
  return c.json({
    thread_id: c.req.param("thread"),
    messages: result.messages.slice(0, 100).map(publicMessage),
    has_more: result.messages.length > 100,
  });
});
mail.post("/mailboxes/:m/search/rebuild", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  await authorize(c.env, actor(c), resource(c), "write");
  const jobId = await startExport(c.env, actor(c), resource(c), "reindex");
  return c.json({ job: { id: jobId, status: "queued" } }, 202);
});
mail.get("/mailboxes/:m/messages/:id", async (c) =>
  c.json({
    message: await getMessage(c.env, actor(c), resource(c), c.req.param("id")),
  }),
);
mail.get("/mailboxes/:m/messages/:id/original", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  const message = await partition(c.env, locator(c.req.param("id"))).get(
    c.req.param("id"),
    actor(c).user_id,
  );
  if (!message.raw_r2_key) fail(404, "Original wire message is unavailable");
  const object = await c.env.MAIL_BUCKET.get(message.raw_r2_key);
  if (!object) fail(503, "Original is unavailable");
  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": "attachment; filename=message.eml",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
mail.get("/mailboxes/:m/messages/:id/attachments/:a", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  const message = await partition(c.env, locator(c.req.param("id"))).get(
      c.req.param("id"),
      actor(c).user_id,
    ),
    file = message.attachments.find((f) => f.id === c.req.param("a"));
  if (!file) fail(404, "Attachment not found");
  const object = await c.env.MAIL_BUCKET.get(file.r2_key);
  if (!object) fail(503, "Attachment unavailable");
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(file.content_type);
  return new Response(object.body, {
    headers: {
      "Content-Type": file.content_type,
      "Content-Disposition":
        (inline ? "inline" : "attachment") +
        "; filename*=UTF-8''" +
        encodeURIComponent(file.filename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
});
mail.patch("/mailboxes/:m/messages/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await authorize(c.env, actor(c), resource(c), "write");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  const data = await input(c, [
      "version",
      "folder_id",
      "is_read",
      "is_starred",
      "is_spam",
      "snoozed_until",
    ]),
    changes: {
      folder_id?: string;
      is_read?: number;
      is_starred?: number;
      is_spam?: number;
      snoozed_until?: number | null;
    } = {};
  if ("folder_id" in data)
    changes.folder_id = text(data.folder_id, "folder_id", 100);
  for (const f of ["is_read", "is_starred", "is_spam"] as const)
    if (f in data) changes[f] = flag(data[f], f);
  if ("snoozed_until" in data)
    changes.snoozed_until =
      data.snoozed_until === null
        ? null
        : integer(
            data.snoozed_until,
            "snoozed_until",
            epoch() + 1,
            epoch() + 366 * 86400,
          );
  const message = await mailbox(c.env, resource(c)).changeMessage(
    locator(c.req.param("id")),
    c.req.param("id"),
    actor(c).user_id,
    integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER),
    changes,
  );
  if (changes.snoozed_until)
    await mailbox(c.env, resource(c)).schedule({
      id: "snooze:" + message.id,
      partition_id: locator(message.id),
      kind: "snooze",
      reference_id: message.id,
      due_at: changes.snoozed_until,
    });
  await flushOutbox(c.env, resource(c), locator(message.id));
  return c.json({ message: publicMessage(message) });
});
mail.post("/mailboxes/:m/messages/:id/permanent-delete", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await authorize(c.env, actor(c), resource(c), "write");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  await partition(c.env, locator(c.req.param("id"))).purge(
    c.req.param("id"),
    actor(c).user_id,
  );
  await flushOutbox(c.env, resource(c), locator(c.req.param("id")));
  return c.body(null, 204);
});
mail.post("/mailboxes/:m/uploads", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length < 0 || length > 5 * 1024 * 1024)
    fail(413, "Upload requires Content-Length and must not exceed 5 MiB");
  let suppliedFilename = c.req.header("x-filename") ?? "attachment";
  if (c.req.header("x-filename-encoded")) {
    try { suppliedFilename = decodeURIComponent(c.req.header("x-filename-encoded")!); }
    catch { fail(400, "Invalid encoded filename"); }
  }
  const filename = text(
      suppliedFilename,
      "filename",
      255,
    ),
    contentType = c.req.header("content-type") ?? "application/octet-stream",
    uploadId = id();
  if (!c.req.raw.body) fail(400, "Missing upload body");
  await putStream(
    c.env.MAIL_BUCKET,
    "uploads/" + resource(c) + "/" + actor(c).user_id + "/" + uploadId,
    c.req.raw.body,
    {
      httpMetadata: { contentType },
      customMetadata: { filename, expires_at: String(epoch() + 86400) },
    },
    length,
  );
  return c.json(
    {
      upload: {
        id: uploadId,
        filename,
        content_type: contentType,
        size_bytes: length,
        expires_at: epoch() + 86400,
      },
    },
    201,
  );
});
mail.post("/mailboxes/:m/drafts", async (c) => {
  const data = await input(c, [
    "subject",
    "text",
    "html",
    "to",
    "cc",
    "bcc",
    "attachment_ids",
    "reply_to_message_id",
    "include_signature",
  ]);
  return c.json(
    { message: await createDraft(c.env, actor(c), resource(c), data, key(c)) },
    201,
  );
});
mail.get("/mailboxes/:m/drafts/:id", async (c) =>
  c.json({
    message: await getMessage(c.env, actor(c), resource(c), c.req.param("id")),
  }),
);
mail.patch("/mailboxes/:m/drafts/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await authorize(c.env, actor(c), resource(c), "write");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  const data = await input(c, [
      "version",
      "subject",
      "text",
      "html",
      "to",
      "cc",
      "bcc",
      "attachment_ids",
      "retained_attachment_ids",
    ]),
    store = partition(c.env, locator(c.req.param("id"))),
    current = await store.get(c.req.param("id"), actor(c).user_id),
    old = await readBody(c.env, current.body_r2_key);
  const version = integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER),
    body = {
      text:
        data.text === undefined
          ? old.text
          : text(data.text, "text", 2 * 1024 * 1024, true),
      html:
        data.html === undefined
          ? old.html
          : cleanHtml(text(data.html, "html", 2 * 1024 * 1024, true)),
    };
  const select = (kind: string) =>
      current.recipients
        .filter((r) => r.kind === kind)
        .map((r) => r.email_address),
    to = data.to === undefined ? select("to") : recipients(data.to, "to"),
    cc = data.cc === undefined ? select("cc") : recipients(data.cc, "cc"),
    bcc = data.bcc === undefined ? select("bcc") : recipients(data.bcc, "bcc");
  if (to.length + cc.length + bcc.length > 50) fail(400, "Too many recipients");
  if (!current.draft || current.draft.state !== "editable" || current.draft.version !== version) fail(409, "Draft version changed or is not editable");
  let attachments: Attachment[] | undefined;
  const addedKeys: string[] = [];
  let committed = false;
  try {
  if (data.attachment_ids !== undefined || data.retained_attachment_ids !== undefined) {
    const retained = data.retained_attachment_ids ?? current.attachments.map((file) => file.id);
    const uploads = data.attachment_ids ?? [];
    if (!Array.isArray(retained) || !Array.isArray(uploads) || retained.length + uploads.length > 32 || new Set(retained).size !== retained.length || new Set(uploads).size !== uploads.length) fail(400, "Invalid attachments");
    attachments = retained.map((value) => current.attachments.find((file) => file.id === strictId(value)) ?? fail(400, "Unknown retained attachment"));
    for (const value of uploads) {
      const upload = await c.env.MAIL_BUCKET.get("uploads/" + resource(c) + "/" + actor(c).user_id + "/" + strictId(value));
      if (!upload || Number(upload.customMetadata?.expires_at ?? 0) < epoch()) fail(400, "Upload is missing or expired");
      const fileId = id(), r2Key = "attachments/" + resource(c) + "/" + current.id + "/" + fileId;
      addedKeys.push(r2Key); await c.env.MAIL_BUCKET.put(r2Key, upload.body, { httpMetadata: upload.httpMetadata });
      attachments.push({ id: fileId, filename: upload.customMetadata?.filename ?? "attachment", content_type: upload.httpMetadata?.contentType ?? "application/octet-stream", size_bytes: upload.size, content_id: null, r2_key: r2Key, disposition: "attachment" });
    }
  }
  const keyBody = bodyKey(resource(c), current.id, id());
  addedKeys.push(keyBody);
  await c.env.MAIL_BUCKET.put(keyBody, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  const message = await store.editDraft(current.id, actor(c).user_id, version, {
    subject:
      data.subject === undefined
        ? current.subject
        : text(data.subject, "subject", 998, true),
    to,
    cc,
    bcc,
    body_r2_key: keyBody,
    snippet: (body.text || htmlText(body.html)).slice(0, 200),
    search_text: body.text || htmlText(body.html),
    attachments,
  });
  committed = true;
  await flushOutbox(c.env, resource(c), locator(message.id));
  return c.json({
    message: await getMessage(c.env, actor(c), resource(c), message.id),
  });
  } catch (error) {
    if (!committed) await Promise.allSettled(addedKeys.map((objectKey) => c.env.MAIL_BUCKET.delete(objectKey)));
    throw error;
  }
});
mail.delete("/mailboxes/:m/drafts/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await authorize(c.env, actor(c), resource(c), "write");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  await partition(c.env, locator(c.req.param("id"))).purge(
    c.req.param("id"),
    actor(c).user_id,
    true,
  );
  await flushOutbox(c.env, resource(c), locator(c.req.param("id")));
  return c.body(null, 204);
});
mail.post("/mailboxes/:m/drafts/:id/submissions", async (c) => {
  const data = await input(c, [
    "address_id",
    "version",
    "send_mode",
    "provider",
    "connection_id",
    "scheduled_at",
  ]);
  return c.json(
    {
      submission: publicSubmission(
        await submitDraft(
          c.env,
          actor(c),
          resource(c),
          c.req.param("id"),
          data,
          key(c),
        ),
      ),
    },
    202,
  );
});
mail.get("/mailboxes/:m/submissions/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await belongs(c.env, resource(c), locator(c.req.param("id")));
  return c.json({
    submission: await partition(
      c.env,
      locator(c.req.param("id")),
    ).submissionView(c.req.param("id"), actor(c).user_id),
  });
});
for (const action of ["cancel", "retry"] as const)
  mail.post("/mailboxes/:m/submissions/:id/" + action, async (c) => {
    await authorize(c.env, actor(c), resource(c), "read");
    await belongs(c.env, resource(c), locator(c.req.param("id")!));
    const store = partition(c.env, locator(c.req.param("id")!)),
      existing = await store.submissionView(
        c.req.param("id")!,
        actor(c).user_id,
      );
    await authorize(c.env, actor(c), resource(c), existing.send_mode);
    const job =
      action === "cancel"
        ? await store.cancel(existing.id, actor(c).user_id)
        : await store.retry(existing.id, actor(c).user_id);
    if (action === "retry")
      await mailbox(c.env, resource(c)).schedule({
        id: job.id,
        partition_id: locator(job.id),
        kind: "send",
        reference_id: job.id,
        due_at: epoch(),
      });
    return c.json({ submission: publicSubmission(job) });
  });
mail.get("/mailboxes/:m/audit-logs", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  return c.json({
    events: await mailbox(c.env, resource(c)).auditLog(
      integer(
        Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER),
        "before",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    ),
  });
});
mail.get("/mailboxes/:m/storage", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const entries = await mailbox(c.env, resource(c)).partitions();
  return c.json({
    partitions: await Promise.all(
      entries.map(async (p) => ({
        ...p,
        database_bytes: await partition(c.env, p.id).size(),
      })),
    ),
    target_bytes: Number(c.env.MAIL_PARTITION_TARGET_BYTES),
  });
});
mail.post("/mailboxes/:m/events/ticket", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  return c.json({
    ticket: await mailbox(c.env, resource(c)).ticket(actor(c)),
    expires_in: 60,
  });
});
for (const noun of [
  "contacts",
  "templates",
  "blocked-senders",
  "rules",
] as const)
  mail.get("/mailboxes/:m/" + noun, async (c) => {
    await authorize(c.env, actor(c), resource(c), "read");
    const store = mailbox(c.env, resource(c));
    return c.json({
      [noun]:
        noun === "contacts"
          ? await store.contacts()
          : noun === "templates"
            ? await store.templates()
            : noun === "rules"
              ? await store.rules()
              : await store.blockedSenders(),
    });
  });
mail.post("/mailboxes/:m/contacts", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, ["email_address", "name"]);
  return c.json(
    {
      contact: await mailbox(c.env, resource(c)).putContact({
        id: id(),
        email_address: email(data.email_address),
        name: text(data.name ?? "", "name", 200, true),
      }),
    },
    201,
  );
});
mail.delete("/mailboxes/:m/contacts/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  await mailbox(c.env, resource(c)).deleteContact(c.req.param("id"));
  return c.body(null, 204);
});
mail.post("/mailboxes/:m/templates", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, ["name", "subject", "text"]);
  return c.json(
    {
      template: await mailbox(c.env, resource(c)).putTemplate({
        id: id(),
        name: text(data.name, "name", 100),
        subject: text(data.subject ?? "", "subject", 998, true),
        text_body: text(data.text, "text", 10000, true),
      }),
    },
    201,
  );
});
mail.delete("/mailboxes/:m/templates/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  await mailbox(c.env, resource(c)).deleteTemplate(c.req.param("id"));
  return c.body(null, 204);
});
mail.put("/mailboxes/:m/blocked-senders", async (c) => {
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, ["email_address", "blocked"]);
  await mailbox(c.env, resource(c)).blockSender(
    email(data.email_address),
    !!flag(data.blocked, "blocked"),
  );
  return c.body(null, 204);
});
mail.post("/mailboxes/:m/rules", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const data = await input(c, [
    "id",
    "version",
    "name",
    "priority",
    "enabled",
    "conditions",
    "actions",
  ]);
  if (
    !Array.isArray(data.conditions) ||
    data.conditions.length > 20 ||
    !data.conditions.length ||
    !Array.isArray(data.actions) ||
    !data.actions.length ||
    data.actions.length > 10
  )
    fail(400, "Invalid rule");
  const conditions: RuleCondition[] = data.conditions.map((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      !["from", "to", "subject", "body"].includes(v.field) ||
      !["contains", "equals", "prefix", "suffix"].includes(v.operator)
    )
      fail(400, "Invalid rule condition");
    return {
      field: v.field,
      operator: v.operator,
      value: text(v.value, "value", 1000),
    };
  });
  const actions: RuleAction[] = [];
  for (const v of data.actions) {
    if (
      !v ||
      typeof v !== "object" ||
      !["move", "star", "read", "spam"].includes(v.type)
    )
      fail(400, "Invalid rule action");
    if (
      v.type === "move" &&
      !(await mailbox(c.env, resource(c)).hasFolder(
        text(v.folder_id, "folder_id", 100),
      ))
    )
      fail(400, "Unknown folder");
    actions.push({
      type: v.type,
      ...(v.type === "move" ? { folder_id: v.folder_id } : {}),
    });
  }
  return c.json(
    {
      rule: await mailbox(c.env, resource(c)).putRule({
        id: data.id === undefined ? id() : strictId(data.id),
        version:
          data.version === undefined
            ? 1
            : integer(data.version, "version", 1, Number.MAX_SAFE_INTEGER),
        name: text(data.name, "name", 100),
        priority: integer(data.priority ?? 0, "priority", -1000, 1000),
        enabled: data.enabled === undefined ? 1 : flag(data.enabled, "enabled"),
        conditions_json: JSON.stringify(conditions),
        actions_json: JSON.stringify(actions),
      }),
    },
    201,
  );
});
mail.delete("/mailboxes/:m/rules/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  await mailbox(c.env, resource(c)).deleteRule(c.req.param("id"));
  return c.body(null, 204);
});
mail.post("/mailboxes/:m/rules/evaluate", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const data = await input(c, ["from", "to", "subject", "body"]);
  return c.json({
    result: await mailbox(c.env, resource(c)).evaluate({
      from: text(data.from ?? "", "from", 254, true),
      to: text(data.to ?? "", "to", 1000, true),
      subject: text(data.subject ?? "", "subject", 998, true),
      body: text(data.body ?? "", "body", 10000, true),
    }),
  });
});
mail.get("/api-keys", async (c) => {
  if (actor(c).api_key_id) fail(403, "Session authentication required");
  return c.json({
    keys: await all(
      c.env,
      "SELECT id,name,expires_at,revoked_at,created_at FROM mail_api_keys WHERE user_id=?",
      actor(c).user_id,
    ),
    scopes: await all(c.env, "SELECT s.key_id,s.mailbox_id,s.action FROM mail_api_key_scopes s JOIN mail_api_keys k ON k.id=s.key_id WHERE k.user_id=?", actor(c).user_id),
  });
});
mail.post("/api-keys", async (c) => {
  if (actor(c).api_key_id) fail(403, "Session authentication required");
  const data = await input(c, ["name", "expires_at", "scopes"]),
    expires = integer(
      data.expires_at,
      "expires_at",
      epoch() + 1,
      epoch() + 366 * 86400,
    );
  if (
    !Array.isArray(data.scopes) ||
    !data.scopes.length ||
    data.scopes.length > 100
  )
    fail(400, "Invalid scopes");
  const scopes: {
    mailbox_id: string;
    action: "read" | "write" | "send_as" | "send_on_behalf";
  }[] = [];
  for (const value of data.scopes) {
    if (
      !value ||
      typeof value !== "object" ||
      !["read", "write", "send_as", "send_on_behalf"].includes(value.action)
    )
      fail(400, "Invalid scope");
    await authorize(c.env, actor(c), strictId(value.mailbox_id), value.action);
    scopes.push({ mailbox_id: value.mailbox_id, action: value.action });
  }
  const token = "ofm_" + id().replaceAll("-", "") + id().replaceAll("-", ""),
    keyId = id(),
    db = control(c.env);
  await db.batch([
    db
      .prepare(
        "INSERT INTO mail_api_keys(id,user_id,name,token_hash,auth_version,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        keyId,
        actor(c).user_id,
        text(data.name, "name", 100),
        await hash(token),
        actor(c).auth_version,
        expires,
      ),
    ...scopes.map((s) =>
      db
        .prepare("INSERT OR IGNORE INTO mail_api_key_scopes VALUES(?,?,?)")
        .bind(keyId, s.mailbox_id, s.action),
    ),
  ]);
  return c.json(
    { key: { id: keyId, token, expires_at: expires, scopes } },
    201,
  );
});
mail.delete("/api-keys/:id", async (c) => {
  if (actor(c).api_key_id) fail(403, "Session authentication required");
  await control(c.env)
    .prepare("UPDATE mail_api_keys SET revoked_at=? WHERE id=? AND user_id=?")
    .bind(epoch(), c.req.param("id"), actor(c).user_id)
    .run();
  return c.body(null, 204);
});
mail.get("/mailboxes/:m/webhooks", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  return c.json({
    webhooks: await all(
      c.env,
      "SELECT id,url,enabled,created_at FROM mail_webhooks WHERE mailbox_id=?",
      resource(c),
    ),
  });
});
mail.post("/mailboxes/:m/webhooks", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const data = await input(c, ["url"]);
  let url: URL;
  try {
    url = new URL(text(data.url, "url", 2000));
  } catch {
    fail(400, "Invalid webhook URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !url.hostname.includes(".") ||
    url.hostname.includes(":") ||
    /^[\d.[\]:]+$/.test(url.hostname) ||
    /\.(local|internal|localhost)$/.test(url.hostname)
  )
    fail(400, "Webhook URL must use a public HTTPS hostname");
  const secret = id() + id(),
    encrypted = await seal(c.env, secret),
    hookId = id();
  await resourceControl(c, resource(c), "manage")
    .prepare(
      "INSERT INTO mail_webhooks(id,mailbox_id,owner_user_id,url,secret_hash,secret_ciphertext,secret_nonce) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      hookId,
      resource(c),
      actor(c).user_id,
      url.href,
      await hash(secret),
      encrypted.ciphertext,
      encrypted.nonce,
    )
    .run();
  return c.json({ webhook: { id: hookId, url: url.href, secret } }, 201);
});
mail.delete("/mailboxes/:m/webhooks/:id", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  await resourceControl(c, resource(c), "manage")
    .prepare("UPDATE mail_webhooks SET enabled=0 WHERE id=? AND mailbox_id=?")
    .bind(c.req.param("id"), resource(c))
    .run();
  return c.body(null, 204);
});
mail.get("/mailboxes/:m/webhooks/deliveries", async (c) => {
  await authorize(c.env, actor(c), resource(c), "manage");
  const results = [];
  for (const entry of await mailbox(c.env, resource(c)).partitions())
    results.push(...(await partition(c.env, entry.id).webhookDeliveries()));
  return c.json({ deliveries: results });
});
mail.post("/mailboxes/:m/messages/bulk", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  await authorize(c.env, actor(c), resource(c), "write");
  const data = await input(c, [
    "items",
    "folder_id",
    "is_read",
    "is_starred",
    "is_spam",
  ]);
  if (
    !Array.isArray(data.items) ||
    !data.items.length ||
    data.items.length > 200
  )
    fail(400, "Invalid bulk items");
  const changes: {
    folder_id?: string;
    is_read?: number;
    is_starred?: number;
    is_spam?: number;
  } = {};
  if (data.folder_id !== undefined)
    changes.folder_id = text(data.folder_id, "folder_id", 100);
  for (const name of ["is_read", "is_starred", "is_spam"] as const)
    if (name in data) changes[name] = flag(data[name], name);
  const results = [];
  for (const item of data.items) {
    if (!item || typeof item !== "object") fail(400, "Invalid bulk item");
    const resourceId = text(item.id, "id", 73),
      version = integer(item.version, "version", 1, Number.MAX_SAFE_INTEGER);
    try {
      await belongs(c.env, resource(c), locator(resourceId));
      const message = await mailbox(c.env, resource(c)).changeMessage(
        locator(resourceId),
        resourceId,
        actor(c).user_id,
        version,
        changes,
      );
      await flushOutbox(c.env, resource(c), locator(resourceId));
      results.push({ id: resourceId, success: true, version: message.version });
    } catch (error) {
      results.push({
        id: resourceId,
        success: false,
        error:
          error instanceof Error
            ? (/MAIL:\d{3}:([^\n]+)/.exec(error.message)?.[1] ??
              "Operation failed")
            : "Operation failed",
      });
    }
  }
  return c.json({ results });
});
for (const operation of ["reply", "reply-all", "forward"] as const)
  mail.post("/mailboxes/:m/messages/:id/" + operation, async (c) => {
    await authorize(c.env, actor(c), resource(c), "read");
    await authorize(c.env, actor(c), resource(c), "write");
    const data = await input(c, ["text", "to", "subject"]),
      sourceId = c.req.param("id")!;
    await belongs(c.env, resource(c), locator(sourceId));
    const source = await partition(c.env, locator(sourceId)).get(
        sourceId,
        actor(c).user_id,
      ),
      content = await readBody(c.env, source.body_r2_key);
    const own = new Set(
      (
        await all<{ email_address: string }>(
          c.env,
          "SELECT a.local_part||'@'||d.name email_address FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE a.mailbox_id=?",
          resource(c),
        )
      ).map((a) => a.email_address.toLowerCase()),
    );
    const to =
      operation === "forward"
        ? recipients(data.to, "to")
        : operation === "reply"
          ? own.has(source.from_address.toLowerCase())
            ? source.recipients
                .filter((r) => r.kind === "to")
                .map((r) => r.email_address)
            : [source.reply_to_address ?? source.from_address]
          : [
              ...new Set([
                source.reply_to_address ?? source.from_address,
                ...source.recipients
                  .filter((r) => r.kind === "to" || r.kind === "cc")
                  .map((r) => r.email_address),
              ]),
            ].filter((address) => !own.has(address.toLowerCase()));
    const requestKey = key(c), uploads: string[] = [];
    if (operation === "forward")
      for (const file of source.attachments) {
        const object = await c.env.MAIL_BUCKET.get(file.r2_key);
        if (!object) fail(503, "Attachment unavailable");
        const digest = await hash(JSON.stringify([actor(c).user_id, requestKey, sourceId, file.id]));
        const uploadId = `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
        await c.env.MAIL_BUCKET.put(
          "uploads/" + resource(c) + "/" + actor(c).user_id + "/" + uploadId,
          object.body,
          {
            httpMetadata: { contentType: file.content_type },
            customMetadata: {
              filename: file.filename,
              expires_at: String(epoch() + 86400),
            },
          },
        );
        uploads.push(uploadId);
      }
    const prefix = operation === "forward" ? "Fwd: " : "Re: ",
      subject =
        data.subject === undefined
          ? source.subject.toLowerCase().startsWith(prefix.toLowerCase())
            ? source.subject
            : (prefix + source.subject).slice(0, 998)
          : text(data.subject, "subject", 998, true);
    const draft = await createDraft(
      c.env,
      actor(c),
      resource(c),
      {
        subject,
        to,
        text:
          text(data.text ?? "", "text", 10000, true) + "\n\n" + (content.text || htmlText(content.html)),
        attachment_ids: uploads,
        ...(operation !== "forward" ? { reply_to_message_id: sourceId } : {}),
      },
      requestKey,
    );
    return c.json({ message: draft }, 201);
  });
mail.post("/mailboxes/:m/imports", async (c) => {
  if (!c.req.raw.body) fail(400, "Missing import");
  const jobId = await startImport(
    c.env,
    actor(c),
    resource(c),
    c.req.raw.body,
    c.req.query("format") ?? "eml",
  );
  return c.json({ job: { id: jobId, status: "queued" } }, 202);
});
for (const operation of ["exports", "backups"] as const)
  mail.post("/mailboxes/:m/" + operation, async (c) => {
    const jobId = await startExport(
      c.env,
      actor(c),
      resource(c),
      operation === "backups",
    );
    return c.json({ job: { id: jobId, status: "queued" } }, 202);
  });
mail.post("/mailboxes/:m/backups/:id/restore", async (c) => {
  const data = await input(c, ["target_mailbox_id", "restore_settings"]);
  const target = strictId(data.target_mailbox_id ?? resource(c));
  const jobId = await startRestore(
    c.env,
    actor(c),
    resource(c),
    c.req.param("id"),
    target,
    data.restore_settings === undefined
      ? false
      : !!flag(data.restore_settings, "restore_settings"),
  );
  return c.json(
    { job: { id: jobId, mailbox_id: target, status: "queued" } },
    202,
  );
});
async function ownedJob(
  c: Parameters<typeof authenticateMail>[0],
  jobId: string,
) {
  await authorize(c.env, actor(c), resource(c), "read");
  const job = await mailbox(c.env, resource(c)).dataJob(jobId);
  if (JSON.parse(job.actor_json).user_id !== actor(c).user_id)
    fail(403, "Job access denied");
  return job;
}
mail.get("/mailboxes/:m/jobs", async (c) => {
  await authorize(c.env, actor(c), resource(c), "read");
  return c.json({
    jobs: await mailbox(c.env, resource(c)).dataJobs(actor(c).user_id),
  });
});
mail.get("/mailboxes/:m/jobs/:id", async (c) => {
  const {
    actor_json: _actor,
    source_r2_key: _source,
    output_prefix: _output,
    cursor_json: _cursor,
    ...job
  } = await ownedJob(c, c.req.param("id"));
  if (job.kind === "backup" && job.status === "completed") {
    const full = await ownedJob(c, c.req.param("id"));
    const listed = await c.env.MAIL_BUCKET.list({ prefix: full.output_prefix, limit: 100, cursor: c.req.query("files_cursor") });
    return c.json({ job, files: listed.objects.map((object) => ({ name: object.key.slice(full.output_prefix.length), size: object.size })), next_file_cursor: listed.truncated ? listed.cursor : null });
  }
  return c.json({ job });
});
mail.get("/mailboxes/:m/jobs/:id/download", async (c) => {
  const job = await ownedJob(c, c.req.param("id"));
  if (job.status !== "completed") fail(409, "Job is not completed");
  if (job.kind === "export")
    return new Response(await exportStream(c.env, job.output_prefix), {
      headers: {
        "Content-Type": "application/mbox",
        "Content-Disposition": "attachment; filename=mailbox.mbox",
        "Cache-Control": "no-store",
      },
    });
  if (job.kind === "backup") {
    const object = await c.env.MAIL_BUCKET.get(
      job.output_prefix + "manifest.json",
    );
    if (!object) fail(503, "Backup manifest unavailable");
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }
  fail(409, "This job has no downloadable output");
});
mail.get("/mailboxes/:m/jobs/:id/files/:file", async (c) => {
  const job = await ownedJob(c, c.req.param("id"));
  if (job.kind !== "backup" || job.status !== "completed")
    fail(409, "Backup unavailable");
  const filename = c.req.param("file");
  if (!/^[a-z0-9.-]{1,100}$/.test(filename)) fail(400, "Invalid backup file");
  const object = await c.env.MAIL_BUCKET.get(job.output_prefix + filename);
  if (!object) fail(404, "Backup file not found");
  return new Response(object.body, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": "attachment",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
});
mail.post("/mailboxes/:m/jobs/:id/retry", async (c) => {
  const job = await ownedJob(c, c.req.param("id"));
  if (job.status !== "failed") fail(409, "Only failed jobs may be retried");
  await authorize(
    c.env,
    actor(c),
    resource(c),
    job.kind.startsWith("import") || job.kind === "restore" ? "write" : "read",
  );
  await mailbox(c.env, resource(c)).retryDataJob(job.id, actor(c));
  await c.env.MAIL_QUEUE.send({
    kind: "data_job",
    mailbox_id: resource(c),
    reference_id: job.id,
  });
  return c.json({ job: { id: job.id, status: "queued" } }, 202);
});
mail.route("/jmap", jmap);
mail.post("/mcp", mcp);
mail.get("/mcp", (c) => c.body(null, 405));
export default mail;

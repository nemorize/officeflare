import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import type { CalendarContext, Bind } from "./types";
import type { Settings } from "./collaboration-types";
import {
  calendarCondition,
  condition,
  first,
  requireCalendar,
  rows,
  active,
} from "./access";
import {
  body,
  choice,
  expectedVersion,
  fail,
  flag,
  identifier,
  integer,
  text,
} from "./input";
import { change, insert, mutate, update } from "./mutations";
import { wakeCalendar } from "./jobs";
export const settings = (c: CalendarContext) =>
  first<Settings>(
    c.env,
    "SELECT * FROM calendar_workspace_settings WHERE id='workspace'",
  ).then((value) => value!);
export const bumpEpoch = (c: CalendarContext, proof: string) =>
  c.env.DB.prepare(
    `UPDATE calendar_workspace_settings SET authorization_epoch=authorization_epoch+1 WHERE id='workspace' AND ${proof}`,
  );
export const adminSettings = new Hono<AppEnv>();
adminSettings.post(
  "/admin/invitation-deliveries/:deliveryId/resolve",
  async (c) => {
    const data = await body(c, [
        "decision",
        "provider_message_id",
        "confirmed_not_accepted",
        "reason",
      ]),
      id = identifier(c.req.param("deliveryId")),
      decision = choice(data.decision, "decision", [
        "accepted",
        "retry",
        "failed",
      ]),
      reason = text(data.reason, "reason", 1000),
      receipt =
        decision === "accepted"
          ? text(data.provider_message_id, "provider_message_id", 255)
          : null;
    if (decision === "retry" && data.confirmed_not_accepted !== true)
      fail(
        400,
        "PROVIDER_CONFIRMATION_REQUIRED",
        "Confirm that the provider did not accept this message before retrying",
      );
    await mutate(c, {
      action: "admin.calendar.settings.manage",
      operation: `delivery.resolve:${id}`,
      idempotent: true,
      request: data,
      result: { status: decision === "retry" ? "queued" : decision },
      details: { reason },
      checks: [
        condition(
          "EXISTS(SELECT 1 FROM calendar_invitation_deliveries WHERE id=? AND status='unknown')",
          id,
        ),
      ],
      build: (proof) => [
        update(
          c,
          "calendar_invitation_deliveries",
          {
            status: decision === "retry" ? "queued" : decision,
            provider_message_id: receipt,
            error_code:
              decision === "failed" ? "operator_confirmed_failure" : null,
            accepted_at: decision === "accepted" ? now() : null,
          },
          "id=?",
          [id],
          proof,
        ),
        update(
          c,
          "calendar_outbox",
          {
            run_at: now(),
            lease_until: 0,
            completed_at: decision === "retry" ? null : now(),
          },
          "id=?",
          [id],
          proof,
        ),
      ],
    });
    wakeCalendar(c);
    return c.json({ status: decision === "retry" ? "queued" : decision });
  },
);
adminSettings.get("/admin/settings", async (c) =>
  c.json({ settings: await settings(c) }),
);
adminSettings.patch("/admin/settings", async (c) => {
  const data = await body(c, [
      "version",
      "system_address_id",
      "internal_sharing_enabled",
      "external_sharing_enabled",
      "public_link_max_days",
      "public_link_password_required",
    ]),
    version = expectedVersion(c, data),
    values: Record<string, Bind> = { version: version + 1, updated_at: now() };
  for (const key of [
    "internal_sharing_enabled",
    "external_sharing_enabled",
    "public_link_password_required",
  ])
    if (key in data) values[key] = flag(data[key], key);
  if ("public_link_max_days" in data)
    values.public_link_max_days = integer(
      data.public_link_max_days,
      "public_link_max_days",
      1,
      365,
    );
  if ("system_address_id" in data) {
    values.system_address_id =
      data.system_address_id === null
        ? null
        : identifier(data.system_address_id);
    if (
      values.system_address_id &&
      !(await first(
        c.env,
        "SELECT 1 FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id JOIN mail_provider_connections p ON p.id=d.outbound_connection_id WHERE a.id=? AND a.send_enabled=1 AND d.outbound_enabled=1 AND p.enabled=1",
        values.system_address_id,
      ))
    )
      fail(400, "INVALID_SENDER", "Choose an enabled system sending address");
  }
  await mutate(c, {
    action: "admin.calendar.settings.manage",
    operation: "settings.update",
    request: data,
    result: null,
    checks: [
      condition(
        "EXISTS(SELECT 1 FROM calendar_workspace_settings WHERE id='workspace' AND version=?)",
        version,
      ),
    ],
    build: (proof) => [
      update(
        c,
        "calendar_workspace_settings",
        values,
        "id='workspace'",
        [],
        proof,
      ),
      bumpEpoch(c, proof),
    ],
  });
  return c.json({ settings: await settings(c) });
});
const routes = new Hono<AppEnv>();
const aclRole = (value: unknown) =>
  choice(value, "role", [
    "free_busy",
    "reader",
    "writer_without_private",
    "writer",
    "manager",
  ]);
function expires(value: unknown) {
  return value === undefined || value === null
    ? null
    : integer(value, "expires_at", now() + 1, now() + 365 * 86400);
}
routes.get("/calendars/:calendarId/acl", async (c) => {
  const cal = await requireCalendar(
    c,
    identifier(c.req.param("calendarId")),
    4,
  );
  return c.json({
    acl: await rows(
      c.env,
      "SELECT * FROM calendar_acl WHERE calendar_id=? ORDER BY created_at,id",
      cal.id,
    ),
  });
});
routes.post("/calendars/:calendarId/acl", async (c) => {
  const data = await body(c, ["scope_type", "scope_key", "role", "expires_at"]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    config = await settings(c);
  const type = choice(data.scope_type, "scope_type", [
      "user",
      "group",
      "organization",
      "domain",
      "public",
    ]),
    key = text(data.scope_key, "scope_key", 255),
    id = uuid(),
    role = aclRole(data.role);
  const external = type === "public";
  if (
    !(external
      ? config.external_sharing_enabled
      : config.internal_sharing_enabled)
  )
    fail(403, "SHARING_DISABLED", "Calendar sharing is disabled");
  let valid = condition("1");
  if (type === "user") {
    if (key === cal.data_owner_user_id)
      fail(400, "INVALID_GRANT", "The owner already has full access");
    valid = condition(
      `EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${active("u")})`,
      key,
    );
  }
  if (type === "group")
    valid = condition(
      "EXISTS(SELECT 1 FROM calendar_groups g WHERE g.id=? AND g.deleted_at IS NULL AND (g.owner_user_id=? OR EXISTS(SELECT 1 FROM calendar_group_members gm WHERE gm.group_id=g.id AND gm.user_id=?)))",
      key,
      c.get("identity").user.id,
      c.get("identity").user.id,
    );
  if (type === "domain")
    valid = condition(
      "EXISTS(SELECT 1 FROM mail_domains WHERE name=? AND (inbound_enabled=1 OR outbound_enabled=1))",
      key.toLowerCase(),
    );
  if (
    (type === "organization" || type === "public") &&
    (key !== "workspace" || !["free_busy", "reader"].includes(role))
  )
    fail(400, "INVALID_GRANT", "Workspace grants allow read access only");
  if (!(await first(c.env, `SELECT 1 WHERE ${valid.sql}`, ...valid.args)))
    fail(400, "INVALID_GRANT", "Unknown or unavailable sharing subject");
  const value = {
    id,
    calendar_id: cal.id,
    scope_type: type,
    scope_key: type === "domain" ? key.toLowerCase() : key,
    role,
    expires_at: expires(data.expires_at),
    granted_by: c.get("identity").user.id,
    version: 1,
    created_at: now(),
    updated_at: now(),
  };
  const result = await mutate(c, {
    action: external
      ? "calendar.sharing.external"
      : "calendar.sharing.internal",
    operation: `acl.create:${cal.id}`,
    idempotent: true,
    request: data,
    result: { acl: value },
    calendar: cal.id,
    checks: [
      calendarCondition(c, cal, 5),
      valid,
      condition(
        `EXISTS(SELECT 1 FROM calendar_workspace_settings WHERE id='workspace' AND version=? AND ${external ? "external" : "internal"}_sharing_enabled=1)`,
        config.version,
      ),
    ],
    build: (proof) => [
      insert(c, "calendar_acl", value, proof),
      update(
        c,
        "calendars",
        { version: cal.version + 1, updated_at: now() },
        "id=?",
        [cal.id],
        proof,
      ),
      bumpEpoch(c, proof),
      change(
        c,
        proof,
        cal.id,
        "calendar",
        cal.id,
        cal.version + 1,
        "visibility_changed",
      ),
    ],
  });
  return c.json(result, 201);
});
routes.on(
  ["PATCH", "DELETE"],
  "/calendars/:calendarId/acl/:aclId",
  async (c) => {
    const data =
        c.req.method === "PATCH"
          ? await body(c, ["version", "role", "expires_at"])
          : {},
      version = expectedVersion(c, data),
      cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
      id = identifier(c.req.param("aclId")),
      old = await first<{ role: string; scope_type: string }>(
        c.env,
        "SELECT role,scope_type FROM calendar_acl WHERE id=? AND calendar_id=?",
        id,
        cal.id,
      );
    if (!old) fail(404, "ACL_NOT_FOUND", "Grant not found");
    const external = old.scope_type === "public" && c.req.method === "PATCH";
    const config = await settings(c);
    if (external && !config.external_sharing_enabled)
      fail(403, "SHARING_DISABLED", "External sharing is disabled");
    const values: Record<string, Bind> = {
      version: version + 1,
      updated_at: now(),
    };
    if (external) values.granted_by = c.get("identity").user.id;
    if ("role" in data) values.role = aclRole(data.role);
    if ("expires_at" in data) values.expires_at = expires(data.expires_at);
    if (
      ["organization", "public"].includes(old.scope_type) &&
      values.role &&
      !["reader", "free_busy"].includes(String(values.role))
    )
      fail(400, "INVALID_GRANT", "Workspace grants allow read access only");
    await mutate(c, {
      action: external
        ? "calendar.sharing.external"
        : "calendar.sharing.internal",
      operation: "acl.change",
      request: { id, ...data, version },
      result: null,
      calendar: cal.id,
      checks: [
        calendarCondition(c, cal, 5),
        ...(external
          ? [
              condition(
                "EXISTS(SELECT 1 FROM calendar_workspace_settings WHERE id='workspace' AND version=? AND external_sharing_enabled=1)",
                config.version,
              ),
            ]
          : []),
        condition(
          "EXISTS(SELECT 1 FROM calendar_acl WHERE id=? AND calendar_id=? AND version=?)",
          id,
          cal.id,
          version,
        ),
      ],
      build: (proof) => [
        c.req.method === "DELETE"
          ? c.env.DB.prepare(
              `DELETE FROM calendar_acl WHERE id=? AND ${proof}`,
            ).bind(id)
          : update(c, "calendar_acl", values, "id=?", [id], proof),
        update(
          c,
          "calendars",
          { version: cal.version + 1, updated_at: now() },
          "id=?",
          [cal.id],
          proof,
        ),
        bumpEpoch(c, proof),
        change(
          c,
          proof,
          cal.id,
          "calendar",
          cal.id,
          cal.version + 1,
          "visibility_changed",
        ),
      ],
    });
    return c.req.method === "DELETE"
      ? c.body(null, 204)
      : c.json({
          acl: await first(c.env, "SELECT * FROM calendar_acl WHERE id=?", id),
        });
  },
);
routes.get("/groups", async (c) =>
  c.json({
    groups: await rows(
      c.env,
      "SELECT * FROM calendar_groups g WHERE deleted_at IS NULL AND (owner_user_id=? OR EXISTS(SELECT 1 FROM calendar_group_members m WHERE m.group_id=g.id AND m.user_id=?)) ORDER BY name,id",
      c.get("identity").user.id,
      c.get("identity").user.id,
    ),
  }),
);
routes.post("/groups", async (c) => {
  const data = await body(c, ["name", "member_ids"]),
    id = uuid(),
    value = {
      id,
      owner_user_id: c.get("identity").user.id,
      name: text(data.name, "name", 255),
      version: 1,
    },
    members = await memberIds(c, data.member_ids ?? []);
  const result = await mutate(c, {
    action: "calendar.groups.manage",
    operation: "group.create",
    idempotent: true,
    request: data,
    result: { group: value },
    build: (proof) => [
      insert(c, "calendar_groups", value, proof),
      ...members.map((user_id) =>
        insert(c, "calendar_group_members", { group_id: id, user_id }, proof),
      ),
      bumpEpoch(c, proof),
    ],
  });
  return c.json(result, 201);
});
async function memberIds(c: CalendarContext, value: unknown) {
  if (!Array.isArray(value) || value.length > 100)
    fail(400, "INVALID_INPUT", "At most 100 group members are allowed");
  const members = [...new Set(value.map((v) => identifier(v, "member_id")))];
  const n = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) n FROM users u WHERE id IN(SELECT value FROM json_each(?)) AND ${active("u")}`,
    JSON.stringify(members),
  );
  if (n?.n !== members.length)
    fail(400, "INVALID_MEMBER", "Members must be active users");
  return members;
}
routes.get("/groups/:groupId", async (c) => {
  const id = identifier(c.req.param("groupId")),
    user = c.get("identity").user.id,
    group = await first(
      c.env,
      "SELECT * FROM calendar_groups g WHERE id=? AND deleted_at IS NULL AND (owner_user_id=? OR EXISTS(SELECT 1 FROM calendar_group_members m WHERE m.group_id=g.id AND m.user_id=?))",
      id,
      user,
      user,
    );
  if (!group) fail(404, "GROUP_NOT_FOUND", "Group not found");
  return c.json({
    group,
    members: await rows(
      c.env,
      "SELECT user_id FROM calendar_group_members WHERE group_id=? ORDER BY user_id",
      id,
    ),
  });
});
routes.on(["PUT", "DELETE"], "/groups/:groupId", async (c) => {
  const data =
      c.req.method === "PUT"
        ? await body(c, ["version", "name", "member_ids"])
        : {},
    id = identifier(c.req.param("groupId")),
    version = expectedVersion(c, data),
    user = c.get("identity").user.id,
    members = c.req.method === "PUT" ? await memberIds(c, data.member_ids) : [];
  const values: Record<string, Bind> = { version: version + 1 };
  if (c.req.method === "DELETE") values.deleted_at = now();
  else values.name = text(data.name, "name", 255);
  await mutate(c, {
    action: "calendar.groups.manage",
    operation: "group.update",
    request: { id, ...data, version },
    result: null,
    checks: [
      condition(
        "EXISTS(SELECT 1 FROM calendar_groups WHERE id=? AND owner_user_id=? AND deleted_at IS NULL AND version=?)",
        id,
        user,
        version,
      ),
    ],
    build: (proof) => [
      update(c, "calendar_groups", values, "id=?", [id], proof),
      c.env.DB.prepare(
        `DELETE FROM calendar_group_members WHERE group_id=? AND ${proof}`,
      ).bind(id),
      ...members.map((user_id) =>
        insert(c, "calendar_group_members", { group_id: id, user_id }, proof),
      ),
      bumpEpoch(c, proof),
    ],
  });
  return c.req.method === "DELETE"
    ? c.body(null, 204)
    : c.json({ version: version + 1 });
});
export default routes;

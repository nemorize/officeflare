import { t } from "../../shared/i18n/index.ts";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, max, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { body, invalid, string, unauthorized } from "../auth/input";
import { digest, random } from "../auth/crypto";
import { accessClaim, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv, type AuthContext } from "../auth/types";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import {
  notificationChanges,
  notificationEvents,
  notificationInbox as inbox,
  notificationPreferences as preferences,
  notificationWsTickets as tickets,
} from "../db/schema";
import { knownType, notificationTypes } from "../notifications/catalog";
import { cursor, readCursor } from "../notifications/cursor";
import { recoverNotifications } from "../notifications/jobs";
import { connectionValid } from "../notifications/session";
import { visibleInbox } from "../notifications/service";

const routes = new Hono<AppEnv>();
const integer = (value: unknown, name: string, minimum = 0) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    invalid(t("routesNotifications.invalid", { name: name }));
  return value;
};
const wake = (c: AuthContext) =>
  c.executionCtx.waitUntil(
    recoverNotifications(c.env).catch((error) =>
      console.error("Notification recovery failed", error),
    ),
  );

routes.get("/events/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    throw new HTTPException(426, { message: t("routesNotifications.expectedWebsocketUpgrade") });
  if (c.req.header("origin") !== new URL(c.req.url).origin)
    throw new HTTPException(403, { message: t("routesNotifications.invalidWebsocketOrigin") });
  const protocols = (c.req.header("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim());
  const token = protocols.find((value) => /^ticket\.ofn_[A-Za-z0-9_-]{43}$/.test(value))?.slice(7);
  if (!token || !protocols.includes("officeflare.notifications")) unauthorized();
  const connection = await c.env.DB.withSession("first-primary")
    .prepare(
      `DELETE FROM notification_ws_tickets
    WHERE token_hash = ? AND expires_at > ? RETURNING user_id, session_id, auth_version, expires_at`,
    )
    .bind(await digest(token), now())
    .first<{
      user_id: string;
      session_id: string;
      auth_version: number;
      expires_at: number;
    }>();
  if (!connection || !(await connectionValid(c.env.DB, connection))) unauthorized();
  const stub = c.env.NOTIFICATION_HUB.get(c.env.NOTIFICATION_HUB.idFromName(connection.user_id));
  return stub.fetch(
    new Request("https://notifications.internal/connect", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "officeflare.notifications",
        "x-notification-user": connection.user_id,
        "x-notification-session": connection.session_id,
        "x-notification-version": String(connection.auth_version),
      },
    }),
  );
});
routes.use("*", requireAccess);
routes.get("/types", (c) =>
  c.json({
    types: Object.entries(notificationTypes).map(([type, definition]) => ({ type, ...definition })),
  }),
);

routes.get("/summary", async (c) => {
  const db = c.get("db"),
    userId = c.get("identity").user.id,
    timestamp = now();
  const [counts, changes] = await db.batch([
    db
      .select({
        unread: sql<number>`COALESCE(SUM(CASE WHEN read_at IS NULL AND archived_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ${timestamp}) AND deleted_at IS NULL THEN 1 ELSE 0 END), 0)`,
        through_seq: sql<number>`COALESCE(MAX(seq), 0)`,
        next_snoozed_until: sql<
          number | null
        >`MIN(CASE WHEN snoozed_until > ${timestamp} AND deleted_at IS NULL THEN snoozed_until END)`,
      })
      .from(inbox)
      .where(eq(inbox.user_id, userId)),
    db
      .select({ seq: max(notificationChanges.seq) })
      .from(notificationChanges)
      .where(eq(notificationChanges.user_id, userId)),
  ]);
  return c.json({
    unread: counts[0]!.unread,
    next_snoozed_until: counts[0]!.next_snoozed_until,
    read_all_cursor: await cursor(c.env, userId, "read-all", counts[0]!.through_seq),
    change_cursor: await cursor(c.env, userId, "changes", changes[0]?.seq ?? 0),
  });
});

routes.get("/preferences", async (c) => {
  const row = await c
    .get("db")
    .select()
    .from(preferences)
    .where(eq(preferences.user_id, c.get("identity").user.id))
    .get();
  return c.json({
    enabled: row ? !!row.enabled : true,
    rules: row ? (JSON.parse(row.rules_json) as Record<string, boolean>) : {},
    version: row?.version ?? 0,
  });
});
routes.put("/preferences", async (c) => {
  const data = await body(c, ["enabled", "rules", "version"]),
    version = integer(data.version, "version");
  if (
    typeof data.enabled !== "boolean" ||
    !data.rules ||
    typeof data.rules !== "object" ||
    Array.isArray(data.rules)
  )
    invalid();
  const allowed = new Set<string>();
  for (const [type, definition] of Object.entries(notificationTypes)) {
    allowed.add(`type:${type}`);
    allowed.add(`service:${definition.service}`);
    allowed.add(`category:${definition.service}:${definition.category}`);
  }
  const rules = data.rules as Record<string, unknown>;
  if (
    Object.keys(rules).length > allowed.size ||
    Object.entries(rules).some(([key, value]) => !allowed.has(key) || typeof value !== "boolean")
  )
    invalid(t("routesNotifications.invalidNotificationRules"));
  for (const [type, definition] of Object.entries(notificationTypes)) {
    if (
      definition.required &&
      (rules[`type:${type}`] === false ||
        rules[`category:${definition.service}:${definition.category}`] === false ||
        rules[`service:${definition.service}`] === false)
    )
      invalid(t("routesNotifications.requiredNotificationsCannotBeDisabled"));
  }
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const won = accessWon(db, session.id, operation);
  const results = await db.batch([
    accessClaim(c, operation),
    version === 0
      ? insertWhen(
          db,
          preferences,
          {
            user_id: user.id,
            enabled: +data.enabled,
            rules_json: JSON.stringify(rules),
            version: 1,
          },
          won,
        )
          .onConflictDoNothing()
          .returning({ version: preferences.version })
      : db
          .update(preferences)
          .set({
            enabled: +data.enabled,
            rules_json: JSON.stringify(rules),
            version: version + 1,
            updated_at: now(),
          })
          .where(and(eq(preferences.user_id, user.id), eq(preferences.version, version), won))
          .returning({ version: preferences.version }),
  ]);
  if (results[0].meta.changes !== 1) unauthorized();
  if (results[1].length !== 1)
    throw new HTTPException(412, {
      message: t("routesNotifications.settingsChangedElsewhereReloadAndTryAgain"),
    });
  wake(c);
  return c.json({ enabled: data.enabled, rules, version: version + 1 });
});

routes.get("/changes", async (c) => {
  const db = c.get("db"),
    userId = c.get("identity").user.id;
  const after = c.req.query("cursor")
    ? await readCursor(c.env, userId, "changes", c.req.query("cursor")!)
    : 0;
  const rows = await db
    .select({
      seq: notificationChanges.seq,
      notification_id: notificationChanges.notification_id,
      kind: notificationChanges.kind,
    })
    .from(notificationChanges)
    .where(and(eq(notificationChanges.user_id, userId), gt(notificationChanges.seq, after)))
    .orderBy(asc(notificationChanges.seq))
    .limit(101);
  const page = rows.slice(0, 100);
  return c.json({
    changes: page.map(({ seq: _seq, ...row }) => row),
    has_more: rows.length > 100,
    cursor: await cursor(c.env, userId, "changes", page.at(-1)?.seq ?? after),
  });
});

routes.post("/events/tickets", async (c) => {
  await body(c, []);
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    token = `ofn_${random()}`,
    operation = uuid(),
    expiresAt = now() + 60;
  const results = await db.batch([
    db.delete(tickets).where(lte(tickets.expires_at, now())),
    accessClaim(c, operation),
    insertWhen(
      db,
      tickets,
      {
        token_hash: await digest(token),
        user_id: user.id,
        session_id: session.id,
        auth_version: user.auth_version,
        expires_at: expiresAt,
      },
      and(
        accessWon(db, session.id, operation),
        sql`(SELECT COUNT(*) FROM notification_ws_tickets WHERE user_id = ${user.id}) < 10`,
      )!,
    ),
  ]);
  if (results[1].meta.changes !== 1) unauthorized();
  if (results[2].meta.changes !== 1)
    throw new HTTPException(429, { message: t("routesNotifications.tooManyPendingConnections") });
  return c.json({ ticket: token, expires_at: expiresAt }, 201);
});

routes.post("/read-all", async (c) => {
  const data = await body(c, ["cursor"]),
    userId = c.get("identity").user.id;
  const cutoff = await readCursor(c.env, userId, "read-all", string(data.cursor, "cursor", 1024));
  const db = c.get("db"),
    operation = uuid(),
    timestamp = now();
  const results = await db.batch([
    accessClaim(c, operation),
    db
      .update(inbox)
      .set({ read_at: timestamp, updated_at: timestamp, version: sql`${inbox.version} + 1` })
      .where(
        and(
          visibleInbox(userId),
          lte(inbox.seq, cutoff),
          isNull(inbox.read_at),
          isNull(inbox.archived_at),
          or(isNull(inbox.snoozed_until), lte(inbox.snoozed_until, timestamp)),
          accessWon(db, c.get("identity").session.id, operation),
        ),
      )
      .returning({ id: inbox.id }),
  ]);
  if (results[0].meta.changes !== 1) unauthorized();
  wake(c);
  return c.json({ updated: results[1].length });
});

routes.get("/", async (c) => {
  const db = c.get("db"),
    userId = c.get("identity").user.id,
    timestamp = now();
  const state = c.req.query("state") ?? "inbox",
    service = c.req.query("service"),
    type = c.req.query("type");
  if (!["inbox", "unread", "archived", "snoozed", "all"].includes(state))
    invalid(t("routesNotifications.invalidNotificationState"));
  if (type && !knownType(type)) invalid(t("routesNotifications.unknownNotificationType"));
  const types = Object.entries(notificationTypes)
    .filter(([key, value]) => (!type || key === type) && (!service || value.service === service))
    .map(([key]) => key);
  if (!types.length) invalid(t("routesNotifications.unknownNotificationService"));
  const limitText = c.req.query("limit") ?? "30";
  if (!/^\d+$/.test(limitText)) invalid(t("routesNotifications.invalidLimit"));
  const limit = integer(Number(limitText), "limit", 1);
  if (limit > 100) invalid(t("routesNotifications.invalidLimit"));
  const scope = JSON.stringify(["list", state, service ?? "", type ?? ""]);
  const before = c.req.query("cursor")
    ? await readCursor(c.env, userId, scope, c.req.query("cursor")!)
    : Number.MAX_SAFE_INTEGER;
  const rows = await db
    .select({
      id: inbox.id,
      seq: inbox.seq,
      type: notificationEvents.type,
      title: notificationEvents.title,
      body: notificationEvents.body,
      target_path: notificationEvents.target_path,
      created_at: inbox.created_at,
      read_at: inbox.read_at,
      archived_at: inbox.archived_at,
      snoozed_until: inbox.snoozed_until,
      version: inbox.version,
    })
    .from(inbox)
    .innerJoin(notificationEvents, eq(inbox.event_id, notificationEvents.id))
    .where(
      and(
        visibleInbox(userId),
        sql`${notificationEvents.type} IN (SELECT value FROM json_each(${JSON.stringify(types)}))`,
        sql`${inbox.seq} < ${before}`,
        ["inbox", "unread"].includes(state)
          ? and(
              isNull(inbox.archived_at),
              or(isNull(inbox.snoozed_until), lte(inbox.snoozed_until, timestamp)),
            )
          : undefined,
        state === "unread" ? isNull(inbox.read_at) : undefined,
        state === "archived" ? isNotNull(inbox.archived_at) : undefined,
        state === "snoozed" ? gt(inbox.snoozed_until, timestamp) : undefined,
      ),
    )
    .orderBy(desc(inbox.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return c.json({
    notifications: page.map(({ seq: _seq, ...row }) => ({
      ...row,
      ...notificationTypes[row.type as keyof typeof notificationTypes],
    })),
    next_cursor: rows.length > limit ? await cursor(c.env, userId, scope, page.at(-1)!.seq) : null,
  });
});

routes.patch("/:id", async (c) => {
  const data = await body(c, ["version", "read", "archived", "snoozed_until", "deleted"]),
    version = integer(data.version, "version", 1);
  if (Object.keys(data).length < 2) invalid(t("routesNotifications.noChangesSupplied"));
  for (const key of ["read", "archived", "deleted"])
    if (data[key] !== undefined && typeof data[key] !== "boolean")
      invalid(t("routesNotifications.invalid2", { key: key }));
  if (data.deleted === false)
    invalid(t("routesNotifications.deletedNotificationsCannotBeRestored"));
  const timestamp = now();
  if (data.snoozed_until !== undefined && data.snoozed_until !== null) {
    const until = integer(data.snoozed_until, "snoozed_until", timestamp + 60);
    if (until > timestamp + 30 * 86400) invalid(t("routesNotifications.snoozeMustBeWithin30Days"));
  }
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid(),
    id = string(c.req.param("id"), "id", 128);
  const own = and(visibleInbox(user.id), eq(inbox.id, id));
  const results = await db.batch([
    accessClaim(c, operation),
    db
      .update(inbox)
      .set({
        ...(data.read !== undefined ? { read_at: data.read ? timestamp : null } : {}),
        ...(data.archived !== undefined ? { archived_at: data.archived ? timestamp : null } : {}),
        ...(data.snoozed_until !== undefined
          ? { snoozed_until: data.snoozed_until as number | null }
          : {}),
        ...(data.deleted ? { deleted_at: timestamp } : {}),
        updated_at: timestamp,
        version: version + 1,
      })
      .where(and(own, eq(inbox.version, version), accessWon(db, session.id, operation)))
      .returning({ version: inbox.version }),
    db.select({ version: inbox.version }).from(inbox).where(own).limit(1),
  ]);
  if (results[0].meta.changes !== 1) unauthorized();
  if (results[1].length !== 1)
    throw new HTTPException(results[2].length ? 412 : 404, {
      message: results[2].length
        ? t("routesNotifications.notificationChangedElsewhereReloadAndTryAgain")
        : t("routesNotifications.notificationNotFound"),
    });
  wake(c);
  return c.json({ version: version + 1 });
});

export default routes;

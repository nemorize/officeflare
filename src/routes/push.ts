import { and, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";
import { body, invalid, string, unauthorized } from "../auth/input";
import { accessClaim, requireAccess } from "../auth/store";
import { now, uuid, type AppEnv } from "../auth/types";
import { permissionCondition, requirePermission } from "../authorization/access";
import { accessWon } from "../db/auth-conditions";
import { insertWhen } from "../db/conditional-insert";
import { pushSettings, pushTokens } from "../db/schema";
import { fcmWebConfig } from "../notifications/fcm";

const routes = new Hono<AppEnv>();
routes.use("*", requireAccess);
routes.get("/config", async (c) => {
  const settings = await c
    .get("db")
    .select()
    .from(pushSettings)
    .where(eq(pushSettings.id, 1))
    .get();
  const config = settings?.web_push_enabled ? fcmWebConfig(c.env) : null;
  return c.json(config ? { available: true, ...config } : { available: false });
});
routes.get("/settings", requirePermission("admin.notifications.settings.read"), async (c) => {
  const row = await c.get("db").select().from(pushSettings).where(eq(pushSettings.id, 1)).get();
  return c.json({
    configured: !!fcmWebConfig(c.env),
    web_push_enabled: !!row?.web_push_enabled,
    version: row!.version,
  });
});
routes.put("/settings", requirePermission("admin.notifications.settings.manage"), async (c) => {
  const data = await body(c, ["web_push_enabled", "version"]);
  if (
    typeof data.web_push_enabled !== "boolean" ||
    !Number.isSafeInteger(data.version) ||
    Number(data.version) < 1
  )
    invalid();
  if (data.web_push_enabled && !fcmWebConfig(c.env))
    throw new HTTPException(409, { message: t("push.notConfigured") });
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const [claim, rows] = await db.batch([
    accessClaim(
      c,
      operation,
      permissionCondition(db, user.id, "admin.notifications.settings.manage"),
    ),
    db
      .update(pushSettings)
      .set({
        web_push_enabled: +data.web_push_enabled,
        version: Number(data.version) + 1,
        updated_at: now(),
        updated_by: user.id,
      })
      .where(
        and(
          eq(pushSettings.id, 1),
          eq(pushSettings.version, Number(data.version)),
          accessWon(db, session.id, operation),
        ),
      )
      .returning(),
  ]);
  if (claim.meta.changes !== 1) unauthorized();
  if (!rows.length) throw new HTTPException(412, { message: t("push.settingsChanged") });
  return c.json({
    configured: !!fcmWebConfig(c.env),
    web_push_enabled: !!rows[0]!.web_push_enabled,
    version: rows[0]!.version,
  });
});
routes.put("/tokens", async (c) => {
  const data = await body(c, ["device_id", "token_type", "token", "session_id"]);
  if (data.session_id !== c.get("identity").session.id) unauthorized();
  const deviceId = string(data.device_id, "device_id", 64),
    token = string(data.token, "token", 4096);
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(deviceId) ||
    data.token_type !== "fcm_web" ||
    !/^[A-Za-z0-9_:.-]+$/.test(token)
  )
    invalid();
  if (!fcmWebConfig(c.env)) throw new HTTPException(409, { message: t("push.unavailable") });
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const enabled = sql`EXISTS (SELECT 1 FROM push_settings WHERE id = 1 AND web_push_enabled = 1)`;
  const won = accessWon(db, session.id, operation);
  const allowed = sql`((SELECT COUNT(*) FROM push_tokens WHERE user_id = ${user.id}) < 32 OR EXISTS
    (SELECT 1 FROM push_tokens WHERE user_id = ${user.id} AND device_id = ${deviceId} AND token_type = 'fcm_web'))`;
  const [claim, , rows] = await db.batch([
    accessClaim(c, operation, and(enabled, allowed)),
    db
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.user_id, user.id),
          eq(pushTokens.device_id, deviceId),
          eq(pushTokens.token_type, "fcm_web"),
          ne(pushTokens.token, token),
          won,
        ),
      ),
    insertWhen(
      db,
      pushTokens,
      {
        id: uuid(),
        user_id: user.id,
        session_id: session.id,
        auth_version: user.auth_version,
        device_id: deviceId,
        token_type: "fcm_web",
        token,
      },
      won,
    )
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: {
          user_id: user.id,
          session_id: session.id,
          auth_version: user.auth_version,
          device_id: deviceId,
          token_type: "fcm_web",
          created_at: sql`CASE WHEN ${pushTokens.user_id} != ${user.id} OR ${pushTokens.session_id} != ${session.id} THEN ${now()} ELSE ${pushTokens.created_at} END`,
          updated_at: now(),
        },
      })
      .returning({ id: pushTokens.id }),
  ]);
  if (claim.meta.changes !== 1) throw new HTTPException(409, { message: t("push.unavailable") });
  if (!rows.length) unauthorized();
  return c.json({ registered: true });
});
routes.delete("/tokens", async (c) => {
  const data = await body(c, ["device_id"]),
    deviceId = string(data.device_id, "device_id", 64);
  const db = c.get("db"),
    { user, session } = c.get("identity"),
    operation = uuid();
  const [claim] = await db.batch([
    accessClaim(c, operation),
    db
      .delete(pushTokens)
      .where(
        and(
          eq(pushTokens.user_id, user.id),
          eq(pushTokens.device_id, deviceId),
          eq(pushTokens.token_type, "fcm_web"),
          accessWon(db, session.id, operation),
        ),
      ),
  ]);
  if (claim.meta.changes !== 1) unauthorized();
  return c.body(null, 204);
});
export default routes;

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { t } from "../../shared/i18n/index.ts";
import { COLLABORATION_PROTOCOL } from "../../shared/collaboration";
import { body } from "../auth/input";
import { requireAccess } from "../auth/store";
import type { AppEnv, AuthContext } from "../auth/types";
import { digest, resourceFor } from "./access";
import type { CollaborationActor, CollaborationAdapters } from "./types";
const actor = (c: AuthContext): CollaborationActor => ({
  user_id: c.get("identity").user.id,
  session_id: c.get("identity").session.id,
  auth_version: c.get("identity").user.auth_version,
});
export function collaborationRoutes(adapters: CollaborationAdapters) {
  const routes = new Hono<AppEnv>();
  const room = (c: AuthContext, id: string) =>
    c.env.COLLABORATION_ROOM.get(c.env.COLLABORATION_ROOM.idFromName(id));
  routes.get("/resources/:id/sync", async (c) => {
    const origin = c.req.header("Origin"),
      url = new URL(c.req.url);
    if (
      origin !== url.origin ||
      !c.req
        .header("Sec-WebSocket-Protocol")
        ?.split(",")
        .map((v) => v.trim())
        .includes(COLLABORATION_PROTOCOL)
    )
      return c.json({ error: t("collaboration.denied") }, 403);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426);
    const resource = await resourceFor(c.env, c.req.param("id"), adapters);
    if (!resource) return c.json({ error: t("collaboration.notFound") }, 404);
    url.search = "";
    url.searchParams.set("resource", resource.id);
    return room(c, resource.id).fetch(new Request(url, c.req.raw));
  });
  routes.use("*", requireAccess);
  routes.post("/resources/:id/sessions", async (c) => {
    const resource = await resourceFor(c.env, c.req.param("id"), adapters);
    if (!resource || !(await adapters[resource.service]!.authorize(c.env, actor(c), resource)).read)
      return c.json({ error: t("collaboration.notFound") }, 404);
    const pending = await c.env.DB.prepare(
      "SELECT count(*) AS n FROM collaboration_tickets WHERE user_id=? AND expires_at>unixepoch()",
    )
      .bind(actor(c).user_id)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) >= 60) return c.json({ error: t("collaboration.busy") }, 429);
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO collaboration_tickets(token_hash,resource_id,user_id,session_id,auth_version,origin,expires_at) VALUES(?,?,?,?,?,?,unixepoch()+60)",
    )
      .bind(
        await digest(ticket),
        resource.id,
        actor(c).user_id,
        actor(c).session_id,
        actor(c).auth_version,
        new URL(c.req.url).origin,
      )
      .run();
    return c.json({
      ticket,
      resource_id: resource.id,
      protocol: COLLABORATION_PROTOCOL,
      expires_in: 60,
    });
  });
  for (const [method, path, action] of [
    ["get", "content", "content"],
    ["get", "snapshots", "history"],
    ["post", "snapshots", "checkpoint"],
    ["post", "restores", "restore"],
  ] as const) {
    routes[method](`/resources/:id/${path}`, async (c) => {
      const resource = await resourceFor(c.env, c.req.param("id"), adapters);
      if (!resource) return c.json({ error: t("collaboration.notFound") }, 404);
      let input: { snapshot_id: string; epoch: number; operation_id: string } | undefined;
      if (action === "restore") {
        const data = await body(c, ["snapshot_id", "epoch"]),
          key = c.req.header("Idempotency-Key");
        if (
          typeof data.snapshot_id !== "string" ||
          !Number.isSafeInteger(data.epoch) ||
          !key ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(key)
        )
          throw new HTTPException(400, { message: t("collaboration.invalid") });
        input = {
          snapshot_id: data.snapshot_id,
          epoch: Number(data.epoch),
          operation_id: await digest(
            `${actor(c).user_id}:${key}:${data.snapshot_id}:${data.epoch}`,
          ),
        };
      }
      const result = await room(c, resource.id).inspect(resource.id, actor(c), action, input);
      if (result.status !== 200)
        return c.json(
          {
            error: t(
              result.status === 404
                ? "collaboration.notFound"
                : result.status === 412
                  ? "collaboration.changed"
                  : "collaboration.denied",
            ),
          },
          result.status,
        );
      return c.json(result);
    });
  }
  return routes;
}

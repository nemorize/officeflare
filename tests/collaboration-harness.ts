import worker from "../src/index";
export * from "../src/index";
import { Hono } from "hono";
import { createDatabase } from "../src/db";
import * as Y from "yjs";
import { CollaborationRoom } from "../src/collaboration/room";
import { collaborationRoutes } from "../src/collaboration/routes";
import { recoverCollaboration } from "../src/collaboration/jobs";
import { recoverWiki } from "../src/wiki/jobs";
import { wikiCollaboration } from "../src/wiki/collaboration";
import type { CollaborationAdapters } from "../src/collaboration/types";
import type { AppEnv } from "../src/auth/types";

// A second, non-document domain proves that transport/persistence need no wiki changes.
const adapters: CollaborationAdapters = {
  wiki: wikiCollaboration,
  probe: {
    async authorize(_env, actor, resource) {
      const allowed = actor.user_id === resource.resource_id;
      return { read: allowed, write: allowed, history: allowed, restore: allowed };
    },
    initialize() {
      const doc = new Y.Doc();
      doc.getMap("properties").set("count", 0);
      return doc;
    },
    validate(doc) {
      if (
        [...doc.share.keys()].some((key) => key !== "properties") ||
        !Number.isSafeInteger(doc.getMap("properties").get("count"))
      )
        throw new Error("invalid_schema");
    },
    async project(env, resource, { state, epoch, seq }) {
      await env.WIKI_BUCKET.put(
        `probe/${resource.id}`,
        JSON.stringify({ count: state.getMap("properties").get("count"), epoch, seq }),
      );
    },
  },
};
export class CollaborationRoomDO extends CollaborationRoom {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, adapters);
  }
  restart() {
    this.ctx.abort("test restart");
  }
}
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("db", createDatabase(c.env.DB));
  await next();
});
app.route("/api/collaboration", collaborationRoutes(adapters));
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/collaboration/")) return app.fetch(request, env, ctx);
    if (path === "/test-collaboration/recover") {
      await recoverCollaboration(env);
      await recoverWiki(env);
      return Response.json({ ok: true });
    }
    if (path === "/test-collaboration/restart") {
      const { id } = (await request.json()) as { id: string };
      try {
        await (
          env.COLLABORATION_ROOM.get(
            env.COLLABORATION_ROOM.idFromName(id),
          ) as unknown as CollaborationRoomDO
        ).restart();
      } catch {}
      return Response.json({ ok: true });
    }
    return worker.fetch(request, env, ctx);
  },
};

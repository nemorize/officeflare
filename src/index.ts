import { withRequestLanguage } from "./i18n";
import { t } from "../shared/i18n/index.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import api from "./routes/api";
import { renderPage } from "./routes/web";
import type { AppEnv } from "./auth/types";
import { receive } from "./mail/service";
import { consume, recover } from "./mail/jobs";
import { consumeNotifications, recoverNotifications } from "./notifications/jobs";
import { recoverDrive } from "./drive/jobs";
import { recoverContacts } from "./contacts/jobs";
import { recoverCollaboration } from "./collaboration/jobs";
import { recoverWiki } from "./wiki/jobs";
import { consumeCalendar, recoverCalendar } from "./calendar/jobs";
import { recoverCalendarFeeds, syncCalendarFeed } from "./calendar/feed-sync";
import { consumeAI, recoverAI } from "./ai/jobs";
import { recoverRuns } from "./ai/hub";
import { oauthMetadata, resourceUrl } from "./mcp/authorization";
import { scopes as mcpScopes } from "./mcp/registry";
export { MailboxDO } from "./mail/mailbox";
export { MailPartitionDO } from "./mail/partition";
export { NotificationHubDO } from "./notifications/hub";
export { CollaborationRoomDO } from "./collaboration-bindings";

const app = new Hono<AppEnv>();

app.route("/api", api);
app.get("/.well-known/oauth-authorization-server", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  return c.json(oauthMetadata(new URL(c.req.url).origin));
});
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
])
  app.get(path, (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-store");
    const origin = new URL(c.req.url).origin;
    return c.json({
      resource: resourceUrl(origin),
      authorization_servers: [origin],
      scopes_supported: mcpScopes,
      bearer_methods_supported: ["header"],
    });
  });
app.all("/.well-known/jmap", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/api/mail/jmap/session";
  return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});
for (const path of ["/jmap", "/jmap/*", "/mcp"])
  app.all(path, (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/api/mail" + url.pathname;
    return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  });

app.notFound((c) => c.html(renderPage(t("index.pageNotFound")), 404));

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  const message = status >= 500 ? t("index.internalServerError") : error.message;
  const headers = new Headers(
    error instanceof HTTPException ? error.getResponse().headers : undefined,
  );
  headers.delete("content-type");
  headers.delete("content-length");

  if (status >= 500) {
    console.error(error);
  }

  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    // Preserve structured domain errors and the headers set by API middleware.
    if (
      error instanceof HTTPException &&
      error.getResponse().headers.get("content-type")?.startsWith("application/json")
    ) {
      return c.newResponse(error.getResponse().body, {
        status,
        headers: error.getResponse().headers,
      });
    }
    return c.json({ error: message }, { status, headers });
  }

  const title = status >= 500 ? t("index.anErrorOccurred") : message;
  return c.html(renderPage(title), { status, headers });
});

export default {
  fetch: (request, env, context) =>
    withRequestLanguage(request, () => app.fetch(request, env, context)),
  email: receive,
  queue: async (batch, env) => {
    if (batch.queue === (env.AI_QUEUE_NAME ?? "officeflare-ai")) {
      await consumeAI(batch as MessageBatch<{ id?: unknown }>, env);
      return;
    }
    if (batch.queue === (env.NOTIFICATION_QUEUE_NAME ?? "officeflare-notifications"))
      await consumeNotifications(batch, env);
    else {
      const calendarMessages = batch.messages.filter(
        (message) => (message.body as { kind?: string })?.kind === "calendar.delivery",
      );
      const feedMessages = batch.messages.filter(
        (message) => (message.body as { kind?: string })?.kind === "calendar.feed",
      );
      const mailMessages = batch.messages.filter(
        (message) =>
          !["calendar.delivery", "calendar.feed"].includes(
            (message.body as { kind?: string })?.kind ?? "",
          ),
      );
      for (const message of feedMessages) {
        const id = (message.body as { id?: unknown }).id;
        if (typeof id === "string") {
          try {
            await syncCalendarFeed(env, id);
            message.ack();
          } catch {
            message.retry();
          }
        } else message.ack();
      }
      if (calendarMessages.length)
        await consumeCalendar({ ...batch, messages: calendarMessages }, env);
      if (mailMessages.length) await consume({ ...batch, messages: mailMessages }, env);
    }
  },
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(
      Promise.all([
        recover(env),
        recoverNotifications(env),
        recoverDrive(env),
        recoverContacts(env),
        recoverCollaboration(env),
        recoverWiki(env),
        recoverCalendar(env),
        recoverCalendarFeeds(env),
        recoverAI(env).then(() => recoverRuns(env)),
      ]),
    );
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

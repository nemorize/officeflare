import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import api from "./routes/api";
import { renderPage } from "./routes/web";
import type { AppEnv } from "./auth/types";
import { receive } from "./mail/service";
import { consume, recover } from "./mail/jobs";
import { consumeNotifications, recoverNotifications } from "./notifications/jobs";
import { recoverDrive } from "./drive/jobs";
import { consumeCalendar, recoverCalendar } from "./calendar/jobs";
import { recoverCalendarFeeds, syncCalendarFeed } from "./calendar/feed-sync";
export { MailboxDO } from "./mail/mailbox";
export { MailPartitionDO } from "./mail/partition";
export { NotificationHubDO } from "./notifications/hub";

const app = new Hono<AppEnv>();

app.route("/api", api);
app.all("/.well-known/jmap",(c)=>{
  const url=new URL(c.req.url);url.pathname="/api/mail/jmap/session";
  return app.fetch(new Request(url,c.req.raw),c.env,c.executionCtx);
});
for(const path of ["/jmap","/jmap/*","/mcp"])app.all(path,(c)=>{
  const url=new URL(c.req.url);url.pathname="/api/mail"+url.pathname;
  return app.fetch(new Request(url,c.req.raw),c.env,c.executionCtx);
});

app.notFound((c) => c.html(renderPage("Page not found"), 404));

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  const message = status >= 500 ? "Internal server error" : error.message;
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
    if (error instanceof HTTPException && error.getResponse().headers.get("content-type")?.startsWith("application/json")) {
      return c.newResponse(error.getResponse().body, { status, headers: error.getResponse().headers });
    }
    return c.json({ error: message }, { status, headers });
  }

  const title = status >= 500 ? "An error occurred" : message;
  return c.html(renderPage(title), { status, headers });
});

export default {
  fetch: app.fetch,
  email: receive,
  queue: async (batch, env) => {
    if (batch.queue === (env.NOTIFICATION_QUEUE_NAME ?? "officeflare-notifications")) await consumeNotifications(batch, env);
    else {
      const calendarMessages = batch.messages.filter(message => (message.body as { kind?: string })?.kind === 'calendar.delivery');
      const feedMessages = batch.messages.filter(message => (message.body as { kind?: string })?.kind === 'calendar.feed');
      const mailMessages = batch.messages.filter(message => !['calendar.delivery', 'calendar.feed'].includes((message.body as { kind?: string })?.kind ?? ''));
      for (const message of feedMessages) {
        const id = (message.body as { id?: unknown }).id;
        if (typeof id === 'string') { try { await syncCalendarFeed(env, id); message.ack(); } catch { message.retry(); } }
        else message.ack();
      }
      if (calendarMessages.length) await consumeCalendar({ ...batch, messages: calendarMessages }, env);
      if (mailMessages.length) await consume({ ...batch, messages: mailMessages }, env);
    }
  },
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(Promise.all([recover(env), recoverNotifications(env), recoverDrive(env), recoverCalendar(env), recoverCalendarFeeds(env)]));
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

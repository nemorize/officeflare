import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import api from "./routes/api";
import { renderPage } from "./routes/web";
import type { AppEnv } from "./auth/types";
import { receive } from "./mail/service";
import { consume, recover } from "./mail/jobs";
import { consumeNotifications, recoverNotifications } from "./notifications/jobs";
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
    else await consume(batch, env);
  },
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(Promise.all([recover(env), recoverNotifications(env)]));
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

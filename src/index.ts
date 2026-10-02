import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import api from "./routes/api";
import web, { renderPage } from "./routes/web";
import type { AppEnv } from "./auth/types";

const app = new Hono<AppEnv>();

app.route("/api", api);
app.route("/", web);

app.notFound((c) => c.html(renderPage("페이지를 찾을 수 없습니다"), 404));

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

  const title = status >= 500 ? "오류가 발생했습니다" : message;
  return c.html(renderPage(title), { status, headers });
});

export default app;

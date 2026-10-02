import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth/types";
import { createDatabase } from "../db";
import auth from "./auth";
import me from "./me";

const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  // Start each auth request at the primary, including when D1 read replicas are enabled.
  c.set("db", createDatabase(c.env.DB));
  await next();
});
api.use("*", bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new HTTPException(413, { message: "Request body is too large" }); } }));
api.route("/auth", auth);
api.route("/me", me);

// Register JSON API routes above this fallback to keep unknown API paths out of the web UI.
api.all("*", (c) => c.json({ error: "Not found" }, 404));

export default api;

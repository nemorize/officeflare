import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth/types";
import { requestDatabase } from "../db/request";
import { RequestPerformance, observedObjects } from "../observability/performance";
import { createDatabase } from "../db";
import auth from "./auth";
import me from "./me";
import users from "./users";
import mail from "./mail";
import notifications from "./notifications";
import drive from "./drive";
import calendar from "./calendar";
import { PART_BYTES } from "../drive/types";
import { roleRoutes, userRoleRoutes } from "./authorization";
import { requireAccess } from "../auth/store";
import { requirePermission } from "../authorization/access";
import { permissionCatalog, permissionGroups } from "../authorization/permissions";

const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  const trace = new RequestPerformance();
  c.set("performance", trace);
  c.env = { ...c.env, DB: requestDatabase(c.env.DB, trace), MAILBOX: c.env.MAILBOX && observedObjects(c.env.MAILBOX, trace), MAIL_PARTITION: c.env.MAIL_PARTITION && observedObjects(c.env.MAIL_PARTITION, trace) };
  // Start each auth request at the primary, including when D1 read replicas are enabled.
  c.set("db", createDatabase(c.env.DB));
  await next();
  c.header("Server-Timing", trace.header());
});
api.use("*", async (c, next) => {
  const path = c.req.path;
  const largeUpload = /^\/api\/mail\/mailboxes\/[^/]+\/imports$/.test(path);
  const mailBody = path.startsWith("/api/mail/");
  const profileImage = path === "/api/me/profile-image";
  const driveUpload = /^\/api\/drive\/uploads\/[^/]+\/(?:content|parts\/[^/]+)$/.test(path);
  // JSON escaping can expand the 1 MiB calendar payload up to sixfold.
  const calendarImport = /^\/api\/calendar\/calendars\/[^/]+\/imports$/.test(path);
  const maxSize = driveUpload ? PART_BYTES : calendarImport ? 6 * 1024 * 1024 + 1024 : profileImage ? 2 * 1024 * 1024 : largeUpload ? 26 * 1024 * 1024 : mailBody ? 5 * 1024 * 1024 : 64 * 1024;
  return bodyLimit({ maxSize, onError: () => { throw new HTTPException(413, { message: "Request body is too large" }); } })(c, next);
});
api.route("/mail", mail);
api.route("/notifications", notifications);
api.route("/drive", drive);
api.route("/calendar", calendar);
api.route("/auth", auth);
api.route("/me", me);
api.get("/permissions", requireAccess, requirePermission("admin.roles.read"), (c) => c.json({
  permissions: Object.entries(permissionCatalog).map(([key, definition]) => ({ key, ...definition })),
  groups: permissionGroups,
}));
api.route("/roles", roleRoutes);
api.route("/users", userRoleRoutes);
api.route("/users", users);

// Register JSON API routes above this fallback to keep unknown API paths out of the web UI.
api.all("*", (c) => c.json({ error: "Not found" }, 404));

export default api;

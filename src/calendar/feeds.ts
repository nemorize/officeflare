import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import { requirePermission } from "../authorization/access";
import { calendarDto, preferences } from "./calendars";
import { calendarCondition, condition, first, requireCalendar } from "./access";
import { body, expectedVersion, fail, flag, identifier, text } from "./input";
import { change, insert, mutate, replay, update } from "./mutations";
import { zone } from "./time";
import { feedUrl } from "./feed-fetch";
import { encryptFeedUrl, feedDto, wakeFeed, type CalendarFeed } from "./feed-sync";
import type { Calendar, CalendarContext } from "./types";

const routes = new Hono<AppEnv>();
async function target(c: CalendarContext) {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 6);
  const feed = cal.kind === "external" ? await first<CalendarFeed>(c.env, "SELECT * FROM calendar_feeds WHERE calendar_id=?", cal.id) : null;
  if (!feed) fail(404, "FEED_NOT_FOUND", "External calendar not found");
  return { cal, feed };
}
function urlInput(value: unknown) {
  try { return feedUrl(text(value, "url", 4096)).href; }
  catch { fail(400, "INVALID_FEED_URL", "Use a public HTTPS or webcal calendar subscription URL without a username or password."); }
}
routes.post("/feeds", requirePermission("calendar.calendars.create"), async c => {
  const data = await body(c, ["name", "url", "time_zone"]);
  const previous = await replay<{ calendar: ReturnType<typeof calendarDto>; feed: ReturnType<typeof feedDto> }>(c, "calendar.feed.create", data, "calendar.calendars.create");
  if (previous) { await wakeFeed(c, previous.result.calendar.id); return c.json(previous.result, 201); }
  const id = uuid(), user = c.get("identity").user.id, stamp = now(), url = urlInput(data.url), hash = await digest(url);
  const cal: Calendar = { id, data_owner_user_id: user, kind: "external", name: text(data.name, "name", 255), description: "", location: "", time_zone: zone(data.time_zone ?? (await preferences(c)).time_zone), default_visibility: "private", status: "active", version: 1, created_at: stamp, updated_at: stamp, trashed_at: null, effective_role: "data_owner", is_primary: 0 };
  const duplicate = condition("NOT EXISTS(SELECT 1 FROM calendar_feeds f JOIN calendars cal ON cal.id=f.calendar_id WHERE cal.data_owner_user_id=? AND cal.trashed_at IS NULL AND f.source_hash=?)", user, hash);
  if (!(await first(c.env, `SELECT 1 WHERE ${duplicate.sql}`, ...duplicate.args))) fail(409, "FEED_EXISTS", "This calendar URL is already registered.");
  const count = await first<{ count: number }>(c.env, "SELECT COUNT(*) count FROM calendars WHERE data_owner_user_id=? AND kind='external' AND trashed_at IS NULL", user);
  if (count!.count >= 20) fail(422, "FEED_LIMIT", "You can subscribe to at most 20 external calendars.");
  const feed: CalendarFeed = { calendar_id: id, source_secret: await encryptFeedUrl(c.env, id, url), source_hash: hash, source_host: new URL(url).hostname, enabled: 1, version: 1, etag: null, last_modified: null, last_attempt_at: null, last_success_at: null, next_sync_at: stamp, lease_token: null, lease_until: 0, failure_count: 0, error_code: null, error_message: null, event_count: 0, warnings_json: "[]" };
  const { effective_role, is_primary, ...row } = cal;
  const output = await mutate(c, {
    operation: "calendar.feed.create", action: "calendar.calendars.create", idempotent: true, request: data,
    result: { calendar: calendarDto(cal), feed: feedDto(feed) }, calendar: id,
    checks: [duplicate, condition("(SELECT COUNT(*) FROM calendars WHERE data_owner_user_id=? AND kind='external' AND trashed_at IS NULL)<20", user)],
    build: proof => [insert(c, "calendars", row, proof), insert(c, "calendar_feeds", { ...feed }, proof), insert(c, "calendar_subscriptions", { user_id: user, calendar_id: id }, proof), change(c, proof, id, "calendar", id, 1), change(c, proof, null, "subscription", id, 1, "upsert", user)],
  });
  await wakeFeed(c, output.calendar.id);
  return c.json(output, 201);
});
routes.get("/calendars/:calendarId/feed", async c => c.json({ feed: feedDto((await target(c)).feed) }));
routes.patch("/calendars/:calendarId/feed", requirePermission("calendar.calendars.create"), async c => {
  const { cal, feed } = await target(c), data = await body(c, ["version", "url", "enabled"]), version = expectedVersion(c, data);
  const values: Record<string, string | number | null> = { version: version + 1, lease_until: 0, lease_token: null, updated_at: now() };
  if ("url" in data) {
    const url = urlInput(data.url);
    values.source_secret = await encryptFeedUrl(c.env, cal.id, url); values.source_hash = await digest(url); values.source_host = new URL(url).hostname;
    values.etag = null; values.last_modified = null; values.failure_count = 0; values.error_code = null; values.error_message = null; values.last_attempt_at = null;
  }
  if ("enabled" in data) values.enabled = flag(data.enabled, "enabled");
  if ((values.enabled ?? feed.enabled) && !(values.source_secret ?? feed.source_secret)) fail(400, "URL_REQUIRED", "Enter a calendar subscription URL to reconnect.");
  values.next_sync_at = now();
  await mutate(c, { operation: "calendar.feed.update", action: "calendar.calendars.create", request: data, result: null, calendar: cal.id,
    checks: [calendarCondition(c, cal, 6), condition("EXISTS(SELECT 1 FROM calendar_feeds WHERE calendar_id=? AND version=?)", cal.id, version)],
    build: proof => [update(c, "calendar_feeds", values, "calendar_id=?", [cal.id], proof)],
  });
  await wakeFeed(c, cal.id);
  return c.json({ feed: feedDto((await first<CalendarFeed>(c.env, "SELECT * FROM calendar_feeds WHERE calendar_id=?", cal.id))!) });
});
routes.post("/calendars/:calendarId/feed/refresh", async c => {
  const { cal, feed } = await target(c), data = await body(c, ["version"]), version = expectedVersion(c, data);
  if (!feed.enabled) fail(409, "FEED_PAUSED", "Resume this calendar before refreshing.");
  if (feed.lease_until > now()) fail(409, "SYNC_RUNNING", "This calendar is already synchronizing.");
  if (feed.last_attempt_at && feed.last_attempt_at > now() - 300) fail(429, "REFRESH_LIMIT", "Wait five minutes between manual calendar refreshes.");
  await mutate(c, { operation: "calendar.feed.refresh", request: data, result: null, calendar: cal.id,
    checks: [calendarCondition(c, cal, 6), condition("EXISTS(SELECT 1 FROM calendar_feeds WHERE calendar_id=? AND version=? AND enabled=1 AND lease_until<=unixepoch() AND (last_attempt_at IS NULL OR last_attempt_at<=unixepoch()-300))", cal.id, version)],
    build: proof => [update(c, "calendar_feeds", { next_sync_at: now(), version: version + 1 }, "calendar_id=?", [cal.id], proof)],
  });
  await wakeFeed(c, cal.id);
  return c.json({ feed: feedDto((await first<CalendarFeed>(c.env, "SELECT * FROM calendar_feeds WHERE calendar_id=?", cal.id))!) });
});
routes.delete("/calendars/:calendarId/feed", async c => {
  const { cal, feed } = await target(c), version = expectedVersion(c);
  await mutate(c, { operation: "calendar.feed.disconnect", request: { id: cal.id, version }, result: null, calendar: cal.id,
    checks: [calendarCondition(c, cal, 6), condition("EXISTS(SELECT 1 FROM calendar_feeds WHERE calendar_id=? AND version=?)", cal.id, version)],
    build: proof => [update(c, "calendar_feeds", { source_secret: null, source_hash: null, etag: null, last_modified: null, enabled: 0, lease_until: 0, lease_token: null, version: feed.version + 1, updated_at: now() }, "calendar_id=?", [cal.id], proof), update(c, "calendars", { trashed_at: now(), version: cal.version + 1, updated_at: now() }, "id=?", [cal.id], proof), change(c, proof, cal.id, "calendar", cal.id, cal.version + 1, "delete")],
  });
  return c.body(null, 204);
});
export default routes;

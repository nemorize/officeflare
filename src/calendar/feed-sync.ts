import { now, uuid } from "../auth/types";
import { digest } from "../auth/crypto";
import { active, combine, condition, first, permission, rows } from "./access";
import { mutate } from "./mutations";
import { makeCopy } from "./event-data";
import { parseCalendarImport } from "./ical-import";
import { seal, unseal } from "./secrets";
import { FEED_INTERVAL, FeedError, MAX_FEED_BYTES, MAX_FEED_ENTRIES, fetchCalendarFeed } from "./feed-fetch";
import type { RemoteFetcher } from "../mail/remote";
import type { Bind, Calendar, CalendarContext, CalendarEnv, Event } from "./types";

export interface CalendarFeed {
  calendar_id: string; source_secret: string | null; source_hash: string | null; source_host: string;
  enabled: number; version: number; etag: string | null; last_modified: string | null;
  last_attempt_at: number | null; last_success_at: number | null; next_sync_at: number;
  lease_token: string | null; lease_until: number; failure_count: number;
  error_code: string | null; error_message: string | null; event_count: number; warnings_json: string;
}
export const feedDto = (feed: CalendarFeed) => ({
  calendar_id: feed.calendar_id, source_host: feed.source_host, configured: !!feed.source_secret,
  enabled: !!feed.enabled, version: feed.version, interval_seconds: FEED_INTERVAL,
  last_attempt_at: feed.last_attempt_at, last_success_at: feed.last_success_at,
  next_sync_at: feed.enabled ? feed.next_sync_at : null,
  status: !feed.enabled ? "paused" : feed.lease_until > now() ? "syncing" : feed.error_code ? "error" : !feed.last_success_at || feed.next_sync_at <= now() ? "pending" : "healthy",
  error_code: feed.error_code, error_message: feed.error_message,
  event_count: feed.event_count, warnings: JSON.parse(feed.warnings_json) as string[],
});
const available = (alias = "f") => `EXISTS(SELECT 1 FROM calendars cal JOIN users owner ON owner.id=cal.data_owner_user_id WHERE cal.id=${alias}.calendar_id AND cal.kind='external' AND cal.status='active' AND cal.trashed_at IS NULL AND ${active("owner")} AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=owner.id AND rp.permission_key='calendar.access'))`;
function bulk(env: CalendarEnv, table: string, values: Record<string, Bind>[], proof: string, upsert = false) {
  if (!values.length) return [];
  const columns = Object.keys(values[0]!);
  const groups: Record<string, Bind>[][] = [];
  let chunk: Record<string, Bind>[] = [], size = 0;
  for (const row of values) {
    const length = JSON.stringify(row).length;
    if (chunk.length && size + length > 128_000) { groups.push(chunk); chunk = []; size = 0; }
    chunk.push(row); size += length;
  }
  if (chunk.length) groups.push(chunk);
  return groups.map(group => env.DB.prepare(
    `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map(key => `json_extract(j.value,'$.${key}')`).join(",")} FROM json_each(?) j WHERE ${proof}${upsert ? ` ON CONFLICT(id) DO UPDATE SET ${columns.filter(key => key !== "id").map(key => `${key}=excluded.${key}`).join(",")} WHERE ${proof}` : ""}`,
  ).bind(JSON.stringify(group)));
}
const contentFields = ["title", "description_html", "location_json", "time_kind", "start_at", "end_at", "start_date", "end_date", "start_local", "end_local", "start_time_zone", "end_time_zone", "recurrence_json", "visibility", "transparency", "status"] as const;

export async function syncCalendarFeed(env: CalendarEnv, calendarId: string, fetcher?: RemoteFetcher) {
  const token = uuid(), stamp = now(), db = env.DB.withSession("first-primary");
  const feed = await db.prepare(
    `UPDATE calendar_feeds AS f SET lease_token=?,lease_until=?+120,last_attempt_at=? WHERE calendar_id=? AND enabled=1 AND source_secret IS NOT NULL AND next_sync_at<=? AND lease_until<=? AND ${available()} RETURNING *`,
  ).bind(token, stamp, stamp, calendarId, stamp, stamp).first<CalendarFeed>();
  if (!feed) return;
  const cal = await first<Calendar>(env, "SELECT * FROM calendars WHERE id=?", calendarId);
  if (!cal) return;
  const auth = combine(condition(
    `EXISTS(SELECT 1 FROM calendar_feeds f WHERE f.calendar_id=? AND f.lease_token=? AND f.version=? AND f.enabled=1 AND f.lease_until>unixepoch() AND ${available()})`, calendarId, token, feed.version,
  ), permission(cal.data_owner_user_id, "calendar.access"));
  const c = { env } as CalendarContext;
  try {
    const url = await unseal<string>(env, `feed:${calendarId}`, JSON.parse(feed.source_secret!));
    const response = await fetchCalendarFeed(url, { etag: feed.etag, last_modified: feed.last_modified }, fetcher);
    const writes: Record<string, Bind>[] = [], scopes: Record<string, Bind>[] = [], overrides: Record<string, Bind>[] = [], copies: Record<string, Bind>[] = [], changes: Record<string, Bind>[] = [];
    const changedIds: string[] = [];
    let eventCount = feed.event_count, warnings = JSON.parse(feed.warnings_json) as string[];
    if (response.content !== null) {
      let parsed: ReturnType<typeof parseCalendarImport>;
      try { parsed = parseCalendarImport(response.content, cal, { maxBytes: MAX_FEED_BYTES, maxEntries: MAX_FEED_ENTRIES, allowEmpty: true }); }
      catch { throw new FeedError("INVALID_FEED", "The URL did not return a supported iCalendar file (up to 2 MiB and 2,000 entries). Check the subscription URL."); }
      const invalid = parsed.entries.filter(entry => entry.status === "error");
      if (invalid.length) throw new FeedError("INVALID_ENTRIES", `${invalid.length} calendar entries are invalid or unsupported. The previous events have been kept. First error: ${invalid[0]!.message}`);
      if (parsed.plans.filter(plan => plan.event.recurrence_json !== "[]").length > 100) throw new FeedError("TOO_MANY_SERIES", "The calendar exceeds the limit of 100 recurring series. Use a smaller calendar feed.");
      eventCount = parsed.plans.length;
      warnings = [...new Set(parsed.entries.flatMap(entry => entry.warnings))];
      const skipped = parsed.entries.filter(entry => entry.status === "skipped").length;
      if (skipped) warnings.push(`${skipped} non-event components were skipped.`);
      const old = await rows<Event>(env, "SELECT * FROM calendar_events WHERE organizer_calendar_id=? AND authority='remote' AND (trashed_at IS NULL OR i_cal_uid IN(SELECT value FROM json_each(?)))", calendarId, JSON.stringify(parsed.plans.map(plan => plan.event.i_cal_uid)));
      const byUid = new Map(old.map(event => [event.i_cal_uid, event]));
      const present = new Set(parsed.plans.map(plan => plan.event.i_cal_uid));
      for (const plan of parsed.plans) {
        const prior = byUid.get(plan.event.i_cal_uid);
        const signature = await digest(JSON.stringify([contentFields.map(key => plan.event[key]), plan.overrides.map(value => [value.key, value.patch, value.cancelled]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]));
        if (prior && !prior.trashed_at && JSON.parse(prior.source_json).content_hash === signature) continue;
        const event: Event = { ...plan.event, id: prior?.id ?? plan.event.id, authority: "remote", organizer_user_id: null, organizer_email: "", creator_user_id: cal.data_owner_user_id,
          version: (prior?.version ?? 0) + 1, created_at: prior?.created_at ?? stamp, updated_at: stamp, trashed_at: null, source_json: JSON.stringify({ type: "ical_feed", content_hash: signature }) };
        writes.push(event as unknown as Record<string, Bind>); changedIds.push(event.id);
        if (!prior) {
          copies.push(makeCopy(event) as unknown as Record<string, Bind>);
          scopes.push({ id: uuid(), event_id: event.id, occurrence_key: "" });
        }
        for (const override of plan.overrides) {
          const id = uuid(); scopes.push({ id, event_id: event.id, occurrence_key: override.key });
          overrides.push({ scope_id: id, cancelled: override.cancelled, patch_json: JSON.stringify(override.patch), effective_start_at: override.event.start_at, effective_end_at: override.event.end_at, effective_start_date: override.event.start_date, effective_end_date: override.event.end_date, version: 1, created_at: stamp, updated_at: stamp });
        }
        changes.push({ calendar_id: calendarId, resource_type: "event", resource_id: event.id, version: event.version, operation: "upsert" });
      }
      for (const event of old.filter(event => !event.trashed_at && !present.has(event.i_cal_uid))) {
        writes.push({ ...event, trashed_at: stamp, updated_at: stamp, version: event.version + 1 } as unknown as Record<string, Bind>);
        changes.push({ calendar_id: calendarId, resource_type: "event", resource_id: event.id, version: event.version + 1, operation: "delete" });
      }
    }
    await mutate(c, {
      principal: { actor_key: `calendar-feed:${calendarId}`, actor_user_id: cal.data_owner_user_id, auth },
      operation: "calendar.feed.sync", request: { calendar_id: calendarId, token }, result: null, calendar: calendarId,
      details: { event_count: eventCount, changes: changes.length },
      build: proof => [
        ...bulk(env, "calendar_events", writes, proof, true),
        env.DB.prepare(`DELETE FROM calendar_event_scopes WHERE occurrence_key<>'' AND event_id IN(SELECT value FROM json_each(?)) AND ${proof}`).bind(JSON.stringify(changedIds)),
        ...bulk(env, "calendar_event_scopes", scopes, proof),
        ...bulk(env, "calendar_event_overrides", overrides, proof),
        ...bulk(env, "calendar_event_copies", copies, proof),
        ...bulk(env, "calendar_changes", changes, proof),
        env.DB.prepare(`UPDATE calendar_feeds SET etag=?,last_modified=?,last_success_at=?,next_sync_at=?,lease_until=0,lease_token=NULL,failure_count=0,error_code=NULL,error_message=NULL,event_count=?,warnings_json=?,updated_at=? WHERE calendar_id=? AND ${proof}`).bind(response.etag, response.last_modified, stamp, stamp + FEED_INTERVAL, eventCount, JSON.stringify(warnings), stamp, calendarId),
      ],
    });
  } catch (error) {
    const failure = error instanceof FeedError ? error : new FeedError("SYNC_FAILED", "Unable to synchronize this calendar. Previous events have been kept; Officeflare will retry automatically.");
    const next = stamp + Math.min(86400, 300 * 2 ** Math.min(feed.failure_count, 9));
    // URL replacement, disconnect and lease expiry fence off obsolete results.
    await db.prepare("UPDATE calendar_feeds SET lease_until=0,lease_token=NULL,failure_count=failure_count+1,error_code=?,error_message=?,next_sync_at=?,updated_at=? WHERE calendar_id=? AND lease_token=? AND version=?").bind(failure.code, failure.message.slice(0, 768), next, stamp, calendarId, token, feed.version).run();
  }
}
export async function recoverCalendarFeeds(env: CalendarEnv, fetcher?: RemoteFetcher) {
  const due = await rows<{ calendar_id: string }>(env, `SELECT f.calendar_id FROM calendar_feeds f WHERE enabled=1 AND source_secret IS NOT NULL AND next_sync_at<=unixepoch() AND lease_until<=unixepoch() AND ${available()} ORDER BY next_sync_at,calendar_id LIMIT 20`);
  if (env.MAIL_QUEUE) {
    if (due.length) await env.MAIL_QUEUE.sendBatch(due.map(feed => ({ body: { kind: "calendar.feed", id: feed.calendar_id } })));
  } else for (const feed of due) await syncCalendarFeed(env, feed.calendar_id, fetcher);
}
export async function wakeFeed(c: CalendarContext, id: string) {
  if (c.env.MAIL_QUEUE) c.executionCtx.waitUntil(c.env.MAIL_QUEUE.send({ kind: "calendar.feed", id }));
}
export const encryptFeedUrl = async (env: CalendarEnv, id: string, url: string) => JSON.stringify(await seal(env, `feed:${id}`, url));

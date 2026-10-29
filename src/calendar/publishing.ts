import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import type { Calendar, CalendarContext, Event } from "./types";
import type { ShareLink } from "./collaboration-types";
import { active, calendarAccess, first, permission, rows } from "./access";
import { fail, identifier, pageLimit } from "./input";
import { queryRange } from "./time";
import { expand } from "./recurrence";
import { loadOverrides } from "./event-data";
import { publicEvent } from "./public";
async function published(c: CalendarContext) {
  const id = identifier(c.req.param("calendarId")),
    grant = await first<{ granted_by: string; role: string }>(
      c.env,
      "SELECT granted_by,role FROM calendar_acl WHERE calendar_id=? AND scope_type='public' AND scope_key='workspace' AND granted_by IS NOT NULL AND (expires_at IS NULL OR expires_at>unixepoch())",
      id,
    );
  if (!grant) fail(404, "CALENDAR_NOT_FOUND", "Calendar not found");
  const access = calendarAccess(grant.granted_by, "cal", 5),
    allowed = permission(grant.granted_by, "calendar.sharing.external"),
    cal = await first<Calendar>(
      c.env,
      `SELECT cal.* FROM calendars cal JOIN users creator ON creator.id=? JOIN calendar_workspace_settings cfg ON cfg.id='workspace' WHERE cal.id=? AND cfg.external_sharing_enabled=1 AND ${active("creator")} AND ${access.sql} AND ${allowed.sql}`,
      grant.granted_by,
      id,
      ...access.args,
      ...allowed.args,
    );
  if (!cal) fail(404, "CALENDAR_NOT_FOUND", "Calendar not found");
  return {
    cal,
    role: grant.role,
    link: {
      target_type: "calendar",
      shared_fields_json: JSON.stringify(
        grant.role === "reader" ? ["title", "description_html", "location", "organizer"] : [],
      ),
    } as ShareLink,
  };
}
export const publishingRoutes = new Hono<AppEnv>();
publishingRoutes.get("/public/calendars/:calendarId", async (c) => {
  const { cal, role } = await published(c);
  return c.json({
    calendar: {
      id: cal.id,
      name: cal.name,
      time_zone: cal.time_zone,
      ...(role === "reader" ? { description: cal.description, location: cal.location } : {}),
    },
  });
});
publishingRoutes.get("/public/calendars/:calendarId/events", async (c) => {
  const { cal, link, role } = await published(c),
    range = queryRange(c.req.query("time_min"), c.req.query("time_max")),
    events = await rows<Event>(
      c.env,
      "SELECT * FROM calendar_events WHERE organizer_calendar_id=? AND trashed_at IS NULL AND status<>'cancelled' AND (recurrence_json<>'[]' OR (start_at<? AND end_at>?) OR (start_date<? AND end_date>?)) ORDER BY id LIMIT 201",
      cal.id,
      range.max,
      range.min,
      new Date((range.max + 172800) * 1000).toISOString().slice(0, 10),
      new Date((range.min - 172800) * 1000).toISOString().slice(0, 10),
    );
  if (events.length > 200) fail(422, "TOO_MANY_EVENTS", "Narrow the published calendar scope");
  const overrides = await loadOverrides(
      c,
      events.map((value) => value.id),
    ),
    values = events
      .flatMap((event) =>
        expand(
          event,
          overrides.filter((value) => value.event_id === event.id),
          range.min,
          range.max,
          cal.time_zone,
        ),
      )
      .filter((value) => role === "reader" || value.event.transparency === "busy");
  if (values.length > 500) fail(422, "TOO_MANY_OCCURRENCES", "Narrow the date range");
  return c.json({
    events: values
      .slice(0, pageLimit(c))
      .map((value) => publicEvent(value.event, cal, link, value.key)),
    total: values.length,
  });
});

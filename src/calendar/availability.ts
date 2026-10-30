import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { Temporal } from "@js-temporal/polyfill";
import { now, type AppEnv } from "../auth/types";
import type { Calendar, CalendarContext, Event } from "./types";
import { first, rows, requireCalendar, condition, active } from "./access";
import {
  body,
  expectedVersion,
  fail,
  fields,
  flag,
  identifier,
  integer,
  jsonObject,
  object,
  text,
} from "./input";
import { insert, mutate, update } from "./mutations";
import { date, interval, queryRange, zone } from "./time";
import { expand } from "./recurrence";
import { loadOverrides } from "./event-data";
import { attendeeStates } from "./attendance-store";
interface Hours {
  user_id: string;
  time_zone: string;
  weekly_json: string;
  exceptions_json: string;
  version: number;
  updated_at: number;
}
function minute(value: unknown, end = false) {
  const raw = text(value, "time", 5);
  if (end && raw === "24:00") return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw))
    fail(400, "INVALID_WORKING_HOURS", t("calendarAvailability.useHhMmTimes"));
  return Number(raw.slice(0, 2)) * 60 + Number(raw.slice(3));
}
function ranges(value: unknown) {
  if (!Array.isArray(value) || value.length > 10)
    fail(400, "INVALID_WORKING_HOURS", t("calendarAvailability.atMostTenIntervalsPerDay"));
  const parsed = value
    .map((item) => {
      const data = object(item);
      fields(data, ["start", "end"]);
      const start = minute(data.start),
        end = minute(data.end, true);
      if (end <= start)
        fail(400, "INVALID_WORKING_HOURS", t("calendarAvailability.endMustFollowStart"));
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);
  if (parsed.some((value, index) => index > 0 && value.start < parsed[index - 1]!.end))
    fail(400, "INVALID_WORKING_HOURS", t("calendarAvailability.workingIntervalsCannotOverlap"));
  return parsed;
}
const dto = (value: Hours) => {
  const { weekly_json, exceptions_json, ...rest } = value;
  return {
    ...rest,
    weekly: JSON.parse(weekly_json),
    exceptions: JSON.parse(exceptions_json),
  };
};
export async function workingHours(c: CalendarContext, user: string) {
  return (
    (await first<Hours>(c.env, "SELECT * FROM calendar_working_hours WHERE user_id=?", user)) ?? {
      user_id: user,
      time_zone: "UTC",
      weekly_json: "{}",
      exceptions_json: "{}",
      version: 0,
      updated_at: 0,
    }
  );
}
const routes = new Hono<AppEnv>();
routes.get("/working-hours", async (c) =>
  c.json({
    working_hours: dto(await workingHours(c, c.get("identity").user.id)),
  }),
);
routes.put("/working-hours", async (c) => {
  const data = await body(c, ["version", "time_zone", "weekly", "exceptions"]),
    user = c.get("identity").user.id,
    old = await workingHours(c, user),
    version = old.version ? expectedVersion(c, data) : integer(data.version ?? 0, "version", 0, 0),
    weekly = jsonObject(data.weekly, "weekly"),
    exceptions = jsonObject(data.exceptions ?? {}, "exceptions", 20000),
    value = {
      user_id: user,
      time_zone: zone(data.time_zone),
      weekly_json: JSON.stringify(
        Object.fromEntries(
          Object.entries(weekly).map(([day, value]) => {
            if (!/^[0-6]$/.test(day))
              fail(400, "INVALID_WORKING_HOURS", t("calendarAvailability.weekdaysRangeFrom0To6"));
            return [day, ranges(value)];
          }),
        ),
      ),
      exceptions_json: JSON.stringify(
        Object.fromEntries(
          Object.entries(exceptions).map(([day, value]) => [date(day).toString(), ranges(value)]),
        ),
      ),
      version: version + 1,
      updated_at: now(),
    };
  await mutate(c, {
    operation: "working-hours.update",
    request: data,
    result: null,
    checks: [
      old.version
        ? condition(
            "EXISTS(SELECT 1 FROM calendar_working_hours WHERE user_id=? AND version=?)",
            user,
            version,
          )
        : condition("NOT EXISTS(SELECT 1 FROM calendar_working_hours WHERE user_id=?)", user),
    ],
    build: (proof) => [
      old.version
        ? update(c, "calendar_working_hours", value, "user_id=?", [user], proof)
        : insert(c, "calendar_working_hours", value, proof),
    ],
  });
  return c.json({ working_hours: dto(value) });
});
export async function calendarBusy(c: CalendarContext, cal: Calendar, min: number, max: number) {
  const candidates = await rows<Event>(
    c.env,
    `SELECT e.* FROM calendar_events e JOIN calendars organizer ON organizer.id=e.organizer_calendar_id JOIN users owner ON owner.id=organizer.data_owner_user_id WHERE e.trashed_at IS NULL AND e.status<>'cancelled' AND organizer.trashed_at IS NULL AND organizer.status='active' AND ${active("owner")} AND (e.organizer_calendar_id=? OR EXISTS(SELECT 1 FROM calendar_event_copies cp JOIN calendar_event_attendees a ON a.user_id=? JOIN calendar_event_scopes s ON s.id=a.scope_id AND s.event_id=e.id WHERE cp.event_id=e.id AND cp.calendar_id=? AND cp.removed_at IS NULL AND a.removed_at IS NULL)) AND (e.recurrence_json<>'[]' OR (e.start_at<? AND e.end_at>?) OR (e.start_date<? AND e.end_date>?)) LIMIT 2001`,
    cal.id,
    cal.data_owner_user_id,
    cal.id,
    max,
    min,
    new Date((max + 172800) * 1000).toISOString().slice(0, 10),
    new Date((min - 172800) * 1000).toISOString().slice(0, 10),
  );
  if (candidates.length > 2000)
    fail(422, "TOO_MANY_EVENTS", t("calendarAvailability.narrowTheCalendarSelection"));
  const overrides = await loadOverrides(
      c,
      candidates.map((value) => value.id),
    ),
    state = await attendeeStates(
      c,
      candidates.map((value) => value.id),
      cal.data_owner_user_id,
    ),
    prefs = await first<{ invitation_policy: string }>(
      c.env,
      "SELECT invitation_policy FROM calendar_preferences WHERE user_id=?",
      cal.data_owner_user_id,
    ),
    busy: { start: number; end: number }[] = [];
  for (const event of candidates) {
    const values = expand(
      event,
      overrides.filter((value) => value.event_id === event.id),
      min,
      max,
      cal.time_zone,
    );
    for (const value of values) {
      if (value.event.transparency === "free") continue;
      if (event.organizer_calendar_id !== cal.id) {
        const attendee = state(event.id, value.key);
        if (!attendee || attendee.response_status === "declined") continue;
        if (
          attendee.response_status === "needs_action" &&
          prefs?.invitation_policy === "on_response"
        )
          continue;
      }
      const range = interval(value.event, cal.time_zone);
      busy.push({
        start: Math.max(min, range.min),
        end: Math.min(max, range.max),
      });
      if (busy.length > 5000)
        fail(422, "TOO_MANY_OCCURRENCES", t("calendarAvailability.narrowTheDateRange"));
    }
  }
  return merge(busy);
}
export function merge(values: { start: number; end: number }[]) {
  const result: { start: number; end: number }[] = [];
  for (const value of values.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
    else result.push({ ...value });
  }
  return result;
}
const wire = (value: { start: number; end: number }) => ({
  start: new Date(value.start * 1000).toISOString().replace(".000Z", "Z"),
  end: new Date(value.end * 1000).toISOString().replace(".000Z", "Z"),
});
async function selection(c: CalendarContext, input: unknown) {
  if (!Array.isArray(input) || !input.length || input.length > 50)
    fail(400, "INVALID_INPUT", t("calendarAvailability.choose150Calendars"));
  const result: Calendar[] = [];
  for (const id of [...new Set(input.map((value) => identifier(value)))])
    result.push(await requireCalendar(c, id));
  return result;
}
routes.post("/freebusy/query", async (c) => {
  const data = await body(c, ["calendar_ids", "time_min", "time_max"]),
    range = queryRange(data.time_min, data.time_max),
    calendars = await selection(c, data.calendar_ids),
    values = [];
  for (const cal of calendars)
    values.push({
      calendar_id: cal.id,
      time_zone: cal.time_zone,
      busy: (await calendarBusy(c, cal, range.min, range.max)).map(wire),
    });
  return c.json({
    time_min: data.time_min,
    time_max: data.time_max,
    calendars: values,
  });
});
function insideWorking(value: { start: number; end: number }, hours: Hours) {
  if (hours.version === 0) return false;
  const weekly = JSON.parse(hours.weekly_json),
    exceptions = JSON.parse(hours.exceptions_json),
    start = Temporal.Instant.fromEpochMilliseconds(value.start * 1000).toZonedDateTimeISO(
      hours.time_zone,
    ),
    day = start.toPlainDate(),
    key = day.toString(),
    ranges = (exceptions[key] ?? weekly[start.dayOfWeek % 7] ?? []) as {
      start: number;
      end: number;
    }[];
  return ranges.some((range) => {
    const from =
        day
          .toPlainDateTime()
          .add({ minutes: range.start })
          .toZonedDateTime(hours.time_zone, { disambiguation: "compatible" }).epochMilliseconds /
        1000,
      to =
        day
          .toPlainDateTime()
          .add({ minutes: range.end })
          .toZonedDateTime(hours.time_zone, { disambiguation: "compatible" }).epochMilliseconds /
        1000;
    return value.start >= from && value.end <= to;
  });
}
routes.post("/availability/query", async (c) => {
  const data = await body(c, [
      "calendar_ids",
      "time_min",
      "time_max",
      "duration_minutes",
      "step_minutes",
      "working_hours_only",
    ]),
    workingOnly =
      data.working_hours_only === undefined
        ? false
        : !!flag(data.working_hours_only, "working_hours_only"),
    range = queryRange(data.time_min, data.time_max),
    selected = await selection(c, data.calendar_ids),
    duration = integer(data.duration_minutes ?? 30, "duration_minutes", 1, 1440) * 60,
    step = integer(data.step_minutes ?? 15, "step_minutes", 1, 1440) * 60,
    busy = merge(
      (await Promise.all(selected.map((cal) => calendarBusy(c, cal, range.min, range.max)))).flat(),
    ),
    hours = await Promise.all(
      [...new Set(selected.map((cal) => cal.data_owner_user_id))].map((user) =>
        workingHours(c, user),
      ),
    ),
    values = [];
  if (range.max - range.min > 31 * 86400)
    fail(400, "INVALID_RANGE", t("calendarAvailability.availabilityQueriesAreLimitedTo31Days"));
  for (
    let start = Math.ceil(range.min / step) * step;
    start + duration <= range.max;
    start += step
  ) {
    const value = { start, end: start + duration };
    if (
      !busy.some((block) => value.start < block.end && value.end > block.start) &&
      (!workingOnly || hours.every((hours) => insideWorking(value, hours)))
    )
      values.push(wire(value));
    if (values.length >= 500) break;
  }
  return c.json({ slots: values, duration_minutes: duration / 60 });
});
export default routes;

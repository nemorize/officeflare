import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import {
  body,
  choice,
  color,
  expectedVersion,
  fail,
  fields,
  flag,
  identifier,
  integer,
  jsonObject,
  text,
} from "./input";
import {
  calendarCondition,
  calendars,
  condition,
  first,
  requireCalendar,
  rows,
} from "./access";
import { change, insert, mutate, update } from "./mutations";
import type { Calendar, CalendarContext, Event } from "./types";
import { zone } from "./time";
import { cursor, readCursor } from "./cursor";
import { allAttendees } from "./attendance-store";
import { prepareDeliveries } from "./delivery";
import { wakeCalendar } from "./jobs";
async function participantLifecycle(
  c: CalendarContext,
  cal: Calendar,
  action: "cancel" | "update",
) {
  const source = await rows<Event>(
    c.env,
    "SELECT e.* FROM calendar_events e WHERE organizer_calendar_id=? AND trashed_at IS NULL AND status<>'cancelled' AND EXISTS(SELECT 1 FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=e.id AND a.removed_at IS NULL) ORDER BY e.id LIMIT 101",
    cal.id,
  );
  if (source.length > 100)
    fail(
      422,
      "TOO_MANY_ATTENDEES",
      "Cancel participating events individually before trashing this calendar",
    );
  const snapshot = condition(
    "NOT EXISTS(SELECT 1 FROM calendar_events e WHERE e.organizer_calendar_id=? AND e.trashed_at IS NULL AND e.status<>'cancelled' AND EXISTS(SELECT 1 FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=e.id AND a.removed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM json_each(?) v WHERE json_extract(v.value,'$.id')=e.id AND json_extract(v.value,'$.version')=e.version))",
    cal.id,
    JSON.stringify(
      source.map((value) => ({ id: value.id, version: value.version })),
    ),
  );
  const prepared: {
    value: Event;
    notice: Awaited<ReturnType<typeof prepareDeliveries>>;
  }[] = [];
  let count = 0;
  for (const event of source) {
    const attendees = await allAttendees(c, event.id);
    count += attendees.length;
    if (count > 100)
      fail(
        422,
        "TOO_MANY_ATTENDEES",
        "At most 100 recipients can be changed in one calendar operation",
      );
    const value = {
      ...event,
      version: event.version + 1,
      sequence: event.sequence + 1,
      updated_at: now(),
    };
    prepared.push({
      value,
      notice: await prepareDeliveries(c, cal, value, attendees, action),
    });
  }
  const unchanged = condition(
    "NOT EXISTS(SELECT 1 FROM json_each(?) v LEFT JOIN calendar_events e ON e.id=json_extract(v.value,'$.id') WHERE e.id IS NULL OR e.version<>json_extract(v.value,'$.version') OR e.trashed_at IS NOT NULL OR e.status='cancelled')",
    JSON.stringify(
      source.map((value) => ({ id: value.id, version: value.version })),
    ),
  );
  return {
    checks: [snapshot, unchanged],
    build: (proof: string, operation: string) =>
      prepared.flatMap(({ value, notice }) => [
        update(
          c,
          "calendar_events",
          {
            version: value.version,
            sequence: value.sequence,
            updated_at: value.updated_at,
          },
          "id=?",
          [value.id],
          proof,
        ),
        change(c, proof, cal.id, "event", value.id, value.version),
        ...notice(proof, operation),
      ]),
  };
}
export const calendarDto = (value: Calendar) => ({
  ...value,
  ...(value.effective_role === "free_busy"
    ? { description: "", location: "" }
    : {}),
  is_primary: !!value.is_primary,
});
const prefDefaults = {
  time_zone: "UTC",
  secondary_time_zone: null,
  locale: "en",
  week_start: 1,
  default_view: "week",
  default_duration_minutes: 30,
  invitation_policy: "all",
  display_options_json: "{}",
  default_reminders_json: "[]",
  version: 1,
};
export async function ensurePrimary(c: CalendarContext) {
  const user = c.get("identity").user;
  if (
    await first(
      c.env,
      "SELECT 1 FROM calendar_primary_calendars WHERE user_id=?",
      user.id,
    )
  )
    return;
  const id = uuid(),
    stamp = now(),
    pref = await first<{ time_zone: string }>(
      c.env,
      "SELECT time_zone FROM calendar_preferences WHERE user_id=?",
      user.id,
    );
  try {
    await mutate(c, {
      operation: "calendar.bootstrap",
      request: { user: user.id },
      result: null,
      checks: [
        condition(
          "NOT EXISTS(SELECT 1 FROM calendar_primary_calendars WHERE user_id=?)",
          user.id,
        ),
      ],
      calendar: id,
      build: (proof) => [
        insert(
          c,
          "calendars",
          {
            id,
            data_owner_user_id: user.id,
            kind: "personal",
            name: "My calendar",
            time_zone: pref?.time_zone ?? "UTC",
            created_at: stamp,
            updated_at: stamp,
          },
          proof,
        ),
        insert(
          c,
          "calendar_primary_calendars",
          { user_id: user.id, calendar_id: id },
          proof,
        ),
        // Seed preferences once even when provisioning follows an existing preferences row.
        c.env.DB.prepare(
          `INSERT INTO calendar_preferences(user_id) SELECT ? WHERE ${proof} ON CONFLICT(user_id) DO NOTHING`,
        ).bind(user.id),
        insert(
          c,
          "calendar_subscriptions",
          { user_id: user.id, calendar_id: id },
          proof,
        ),
        c.env.DB.prepare(
          `INSERT INTO calendar_event_copies(id,event_id,calendar_id,copy_kind) SELECT lower(hex(randomblob(16))),s.event_id,?,'attendee' FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE a.user_id=? AND a.removed_at IS NULL AND ${proof} GROUP BY s.event_id ON CONFLICT(event_id,calendar_id) DO NOTHING`,
        ).bind(id, user.id),
        change(c, proof, id, "calendar", id, 1),
        change(c, proof, null, "subscription", id, 1, "upsert", user.id),
      ],
    });
  } catch (error) {
    if (
      !(
        error instanceof HTTPException &&
        error.status === 412 &&
        (await first(
          c.env,
          "SELECT 1 FROM calendar_primary_calendars WHERE user_id=?",
          user.id,
        ))
      )
    )
      throw error;
  }
}
export async function preferences(c: CalendarContext) {
  let value = await first<
    typeof prefDefaults & {
      user_id: string;
      created_at: number;
      updated_at: number;
    }
  >(
    c.env,
    "SELECT * FROM calendar_preferences WHERE user_id=?",
    c.get("identity").user.id,
  );
  if (!value) {
    await ensurePrimary(c);
    value = await first<typeof prefDefaults & { user_id: string; created_at: number; updated_at: number }>(c.env, "SELECT * FROM calendar_preferences WHERE user_id=?", c.get("identity").user.id);
  }
  if (!value)
    fail(404, "PREFERENCES_NOT_FOUND", "Calendar preferences not found");
  const { default_reminders_json, display_options_json, ...rest } = value;
  return {
    ...rest,
    default_reminders: JSON.parse(default_reminders_json),
    display_options: JSON.parse(display_options_json),
  };
}
export async function subscriptions(c: CalendarContext, known?: Calendar[]) {
  const available = known ?? await calendars(c),
    values = await rows<Record<string, unknown>>(
      c.env,
      "SELECT * FROM calendar_subscriptions WHERE user_id=? ORDER BY sort_order,calendar_id",
      c.get("identity").user.id,
    );
  return values
    .filter((value) => available.some((cal) => cal.id === value.calendar_id))
    .map((value) => {
      const { default_reminders_json, notification_policy_json, ...rest } =
        value;
      return {
        ...rest,
        calendar_id: String(value.calendar_id),
        selected: !!value.selected,
        hidden: !!value.hidden,
        default_reminders: JSON.parse(String(default_reminders_json)),
        notification_policy: JSON.parse(String(notification_policy_json)),
        calendar: calendarDto(
          available.find((cal) => cal.id === value.calendar_id)!,
        ),
      };
    });
}
const routes = new Hono<AppEnv>();
routes.get("/preferences", async (c) => {
  const result = await preferences(c);
  c.header("ETag", `"v${result.version}"`);
  return c.json(result);
});
routes.patch("/preferences", async (c) => {
  const data = await body(c, [
    "version",
    "time_zone",
    "secondary_time_zone",
    "locale",
    "week_start",
    "default_view",
    "default_duration_minutes",
    "invitation_policy",
    "display_options",
  ]);
  const version = expectedVersion(c, data),
    user = c.get("identity").user.id;
  const values: Record<string, string | number | null> = {
    version: version + 1,
    updated_at: now(),
  };
  if ("time_zone" in data) values.time_zone = zone(data.time_zone);
  if ("secondary_time_zone" in data)
    values.secondary_time_zone =
      data.secondary_time_zone === null ? null : zone(data.secondary_time_zone);
  if ("locale" in data) {
    const locale = text(data.locale, "locale", 64);
    try {
      Intl.getCanonicalLocales(locale);
    } catch {
      fail(400, "INVALID_INPUT", "Invalid locale");
    }
    values.locale = locale;
  }
  if ("week_start" in data)
    values.week_start = integer(data.week_start, "week_start", 0, 6);
  if ("default_view" in data)
    values.default_view = choice(data.default_view, "default_view", [
      "day",
      "week",
      "month",
      "agenda",
    ]);
  if ("default_duration_minutes" in data)
    values.default_duration_minutes = integer(
      data.default_duration_minutes,
      "default_duration_minutes",
      1,
      1440,
    );
  if ("invitation_policy" in data)
    values.invitation_policy = choice(
      data.invitation_policy,
      "invitation_policy",
      ["all", "known_senders", "on_response"],
    );
  if ("display_options" in data) {
    const options = jsonObject(data.display_options, "display_options");
    fields(options, ["show_weekends", "show_week_numbers", "show_declined"]);
    for (const [key, value] of Object.entries(options)) flag(value, key);
    values.display_options_json = JSON.stringify(options);
  }
  await mutate(c, {
    operation: "preferences.update",
    request: data,
    result: null,
    checks: [
      condition(
        "EXISTS(SELECT 1 FROM calendar_preferences WHERE user_id=? AND version=?)",
        user,
        version,
      ),
    ],
    build: (proof) => [
      update(c, "calendar_preferences", values, "user_id=?", [user], proof),
      change(c, proof, null, "preferences", user, version + 1, "upsert", user),
    ],
  });
  c.header("ETag", `"v${version + 1}"`);
  return c.json(await preferences(c));
});
routes.get("/calendars", async (c) => {
  const limit = integer(Number(c.req.query("limit") ?? 100), "limit", 1, 500),
    scope = "calendars",
    after = c.req.query("cursor")
      ? String(
          await readCursor(
            c.env,
            c.get("identity").user.id,
            scope,
            c.req.query("cursor")!,
          ),
        )
      : "";
  const all = (await calendars(c))
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((value) => value.id > after),
    page = all.slice(0, limit);
  return c.json({
    calendars: page.map(calendarDto),
    next_cursor:
      all.length > limit
        ? await cursor(c.env, c.get("identity").user.id, scope, page.at(-1)!.id)
        : null,
  });
});
routes.post("/calendars", async (c) => {
  const data = await body(c, [
    "name",
    "description",
    "location",
    "time_zone",
    "default_visibility",
    "kind",
  ]);
  const id = uuid(),
    stamp = now(),
    result: Calendar = {
      id,
      data_owner_user_id: c.get("identity").user.id,
      kind: choice(data.kind ?? "personal", "kind", ["personal", "shared"]),
      name: text(data.name, "name", 255),
      description: text(data.description ?? "", "description", 10000, true),
      location: text(data.location ?? "", "location", 1024, true),
      time_zone: zone(data.time_zone ?? (await preferences(c)).time_zone),
      default_visibility: choice(
        data.default_visibility ?? "private",
        "default_visibility",
        ["private", "public"],
      ),
      status: "active",
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      trashed_at: null,
      effective_role: "data_owner",
      is_primary: 0,
    };
  const { effective_role, is_primary, ...row } = result;
  const output = await mutate(c, {
    operation: "calendar.create",
    action: "calendar.calendars.create",
    idempotent: true,
    request: data,
    result: { calendar: calendarDto(result) },
    calendar: id,
    build: (proof) => [
      insert(c, "calendars", row, proof),
      insert(
        c,
        "calendar_subscriptions",
        { user_id: c.get("identity").user.id, calendar_id: id },
        proof,
      ),
      change(c, proof, id, "calendar", id, 1),
      change(
        c,
        proof,
        null,
        "subscription",
        id,
        1,
        "upsert",
        c.get("identity").user.id,
      ),
    ],
  });
  c.header("ETag", `"v${output.calendar.version}"`);
  return c.json(output, 201);
});
routes.get("/calendars/:calendarId", async (c) => {
  const value = await requireCalendar(c, identifier(c.req.param("calendarId")));
  c.header("ETag", `"v${value.version}"`);
  return c.json({ calendar: calendarDto(value) });
});
routes.patch("/calendars/:calendarId", async (c) => {
  const data = await body(c, [
      "version",
      "name",
      "description",
      "location",
      "time_zone",
      "default_visibility",
    ]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 5),
    version = expectedVersion(c, data);
  const values: Record<string, string | number | null> = {
    version: version + 1,
    updated_at: now(),
  };
  for (const key of ["name", "description", "location"] as const)
    if (key in data)
      values[key] = text(
        data[key],
        key,
        key === "name" ? 255 : key === "location" ? 1024 : 10000,
        key !== "name",
      );
  if ("time_zone" in data) values.time_zone = zone(data.time_zone);
  if ("default_visibility" in data)
    values.default_visibility = choice(
      data.default_visibility,
      "default_visibility",
      ["private", "public"],
    );
  await mutate(c, {
    operation: "calendar.update",
    request: data,
    result: null,
    calendar: cal.id,
    checks: [calendarCondition(c, { ...cal, version }, 5)],
    build: (proof) => [
      update(c, "calendars", values, "id=?", [cal.id], proof),
      ...(cal.kind === "external" && values.time_zone && values.time_zone !== cal.time_zone ? [c.env.DB.prepare(`UPDATE calendar_feeds SET etag=NULL,last_modified=NULL,next_sync_at=unixepoch(),version=version+1,lease_until=0,lease_token=NULL WHERE calendar_id=? AND ${proof}`).bind(cal.id)] : []),
      change(c, proof, cal.id, "calendar", cal.id, version + 1),
    ],
  });
  c.header("ETag", `"v${version + 1}"`);
  return c.json({ calendar: calendarDto({ ...cal, ...values } as Calendar) });
});
routes.delete("/calendars/:calendarId", async (c) => {
  const cal = await requireCalendar(
      c,
      identifier(c.req.param("calendarId")),
      6,
    ),
    version = expectedVersion(c);
  if (cal.is_primary)
    fail(409, "PRIMARY_CALENDAR", "The primary calendar cannot be deleted");
  const participants = await participantLifecycle(c, cal, "cancel");
  await mutate(c, {
    operation: "calendar.trash",
    request: { id: cal.id, version },
    result: null,
    calendar: cal.id,
    checks: [
      calendarCondition(c, { ...cal, version }, 6),
      ...participants.checks,
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendars",
        { trashed_at: now(), version: version + 1, updated_at: now() },
        "id=?",
        [cal.id],
        proof,
      ),
      change(c, proof, cal.id, "calendar", cal.id, version + 1, "delete"),
      ...participants.build(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.body(null, 204);
});
routes.post("/calendars/:calendarId/restore", async (c) => {
  const data = await body(c, ["version"]),
    version = expectedVersion(c, data),
    cal = await requireCalendar(
      c,
      identifier(c.req.param("calendarId")),
      6,
      true,
    );
  if (!cal.trashed_at) fail(409, "NOT_TRASHED", "Calendar is not in trash");
  const participants = await participantLifecycle(c, cal, "update");
  await mutate(c, {
    operation: "calendar.restore",
    request: data,
    result: null,
    calendar: cal.id,
    checks: [
      calendarCondition(c, { ...cal, version }, 6, true),
      ...participants.checks,
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendars",
        { trashed_at: null, version: version + 1, updated_at: now() },
        "id=?",
        [cal.id],
        proof,
      ),
      change(c, proof, cal.id, "calendar", cal.id, version + 1),
      ...participants.build(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json({
    calendar: calendarDto({ ...cal, trashed_at: null, version: version + 1 }),
  });
});
routes.get("/subscriptions", async (c) =>
  c.json({ subscriptions: await subscriptions(c) }),
);
routes.on(["PUT", "PATCH"], "/subscriptions/:calendarId", async (c) => {
  const data = await body(c, [
      "version",
      "name_override",
      "color",
      "selected",
      "hidden",
      "sort_order",
    ]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId"))),
    user = c.get("identity").user.id;
  const old = await first<Record<string, string | number | null>>(
    c.env,
    "SELECT * FROM calendar_subscriptions WHERE user_id=? AND calendar_id=?",
    user,
    cal.id,
  );
  if (!old && c.req.method === "PATCH")
    fail(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");
  const version = old ? expectedVersion(c, data) : 0,
    values: Record<string, string | number | null> = {
      version: version + 1,
      updated_at: now(),
    };
  if ("name_override" in data)
    values.name_override =
      data.name_override === null
        ? null
        : text(data.name_override, "name_override", 255);
  if ("color" in data) values.color = color(data.color);
  for (const key of ["selected", "hidden"] as const)
    if (key in data) values[key] = flag(data[key], key);
  if ("sort_order" in data)
    values.sort_order = integer(
      data.sort_order,
      "sort_order",
      -1000000,
      1000000,
    );
  await mutate(c, {
    operation: "subscription.update",
    request: data,
    result: null,
    checks: [
      calendarCondition(c, cal),
      old
        ? condition(
            "EXISTS(SELECT 1 FROM calendar_subscriptions WHERE user_id=? AND calendar_id=? AND version=?)",
            user,
            cal.id,
            version,
          )
        : condition(
            "NOT EXISTS(SELECT 1 FROM calendar_subscriptions WHERE user_id=? AND calendar_id=?)",
            user,
            cal.id,
          ),
    ],
    build: (proof) => [
      old
        ? update(
            c,
            "calendar_subscriptions",
            values,
            "user_id=? AND calendar_id=?",
            [user, cal.id],
            proof,
          )
        : insert(
            c,
            "calendar_subscriptions",
            { user_id: user, calendar_id: cal.id, ...values },
            proof,
          ),
      change(
        c,
        proof,
        null,
        "subscription",
        cal.id,
        version + 1,
        "upsert",
        user,
      ),
    ],
  });
  return c.json({
    subscription: (await subscriptions(c)).find(
      (value) => value.calendar_id === cal.id,
    ),
  });
});
routes.delete("/subscriptions/:calendarId", async (c) => {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId"))),
    version = expectedVersion(c),
    user = c.get("identity").user.id;
  if (cal.is_primary)
    fail(
      409,
      "PRIMARY_CALENDAR",
      "The primary calendar subscription cannot be removed",
    );
  await mutate(c, {
    operation: "subscription.remove",
    request: { id: cal.id, version },
    result: null,
    checks: [
      calendarCondition(c, cal),
      condition(
        "EXISTS(SELECT 1 FROM calendar_subscriptions WHERE user_id=? AND calendar_id=? AND version=?)",
        user,
        cal.id,
        version,
      ),
    ],
    build: (proof) => [
      c.env.DB.prepare(
        `DELETE FROM calendar_subscriptions WHERE user_id=? AND calendar_id=? AND ${proof}`,
      ).bind(user, cal.id),
      change(
        c,
        proof,
        null,
        "subscription",
        cal.id,
        version + 1,
        "delete",
        user,
      ),
    ],
  });
  return c.body(null, 204);
});
export default routes;

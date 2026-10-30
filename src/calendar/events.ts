import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { now, uuid } from "../auth/types";
import {
  calendars,
  calendarCondition,
  canSeeDetails,
  condition,
  eventCondition,
  first,
  requireCalendar,
  requireEvent,
  rows,
} from "./access";
import {
  body,
  choice,
  expectedVersion,
  fail,
  identifier,
  pageLimit,
  queryFlag,
  text,
} from "./input";
import { cursor, readCursor } from "./cursor";
import type { Bind, Calendar, CalendarContext, Copy, Event, Occurrence, Override } from "./types";
import {
  eventFields,
  createFields,
  eventDto,
  getCopy,
  insertEvent,
  loadOverrides,
  makeCopy,
  overridePatch,
  writeEvent,
} from "./event-data";
import {
  applyOverride,
  expand,
  keyOf,
  MAX_OCCURRENCES,
  originalOccurrence,
  ruleContains,
  shiftedStart,
  splitRecurrence,
} from "./recurrence";
import { endpoint, interval, queryRange } from "./time";
import { change, insert, mutate, replay, update } from "./mutations";
import { prepareNewAttendees } from "./attendees";
import { prepareDeliveries } from "./delivery";
import { allAttendees, effectiveAttendees, attendeeStatesForUsers } from "./attendance-store";
import { wakeCalendar } from "./jobs";
import {
  participatingScopes,
  detachParticipants,
  splitParticipants,
} from "./participants-lifecycle";

const paths = "/calendars/:calendarId/events";
const scopeOf = (data: Record<string, unknown>) => {
  const scope = choice(data.scope === undefined ? "all" : data.scope, "scope", [
    "all",
    "single",
    "following",
  ]);
  if (scope === "all" && data.occurrence_key !== undefined)
    fail(400, "INVALID_SCOPE", t("calendarEvents.occurrenceKeyRequiresSingleOrFollowingScope"));
  return scope;
};
const occurrenceKey = (data: Record<string, unknown>) =>
  text(data.occurrence_key, "occurrence_key", 64);
function requireDetails(event: Event, cal: Calendar) {
  if (!canSeeDetails(event, cal)) fail(404, "EVENT_NOT_FOUND", t("calendarEvents.eventNotFound"));
}
function requireSeriesDetails(event: Event, cal: Calendar, overrides: Override[]) {
  requireDetails(event, cal);
  for (const override of overrides)
    requireDetails({ ...event, ...JSON.parse(override.patch_json) }, cal);
}
async function target(c: CalendarContext, edit = false, trash = false) {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), edit ? 3 : 1, trash),
    event = await requireEvent(c, cal, identifier(c.req.param("eventId")), edit, trash);
  return { cal, event };
}
async function labelCheck(c: CalendarContext, cal: Calendar, label: string | null) {
  if (!label) return condition("1");
  const check = condition(
    "EXISTS(SELECT 1 FROM calendar_labels WHERE id=? AND calendar_id=? AND deleted_at IS NULL)",
    label,
    cal.id,
  );
  if (!(await first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args)))
    fail(400, "INVALID_LABEL", t("calendarEvents.labelDoesNotBelongToThisCalendar"));
  return check;
}
function changed(event: Event, proof: string, c: CalendarContext, operation = "upsert") {
  return change(c, proof, event.organizer_calendar_id, "event", event.id, event.version, operation);
}
export async function listEvents(
  c: CalendarContext,
  input?: URLSearchParams,
  available?: Calendar[],
) {
  const param = (key: string) => (input ? (input.get(key) ?? undefined) : c.req.query(key));
  const all = available ?? (await calendars(c));
  // Resolve every requested calendar against the same authorized snapshot.
  const byId = new Map(all.map((cal) => [cal.id, cal]));
  const resolve = (id: string) => {
    const cal = id === "primary" ? all.find((cal) => cal.is_primary) : byId.get(id);
    if (!cal) fail(404, "CALENDAR_NOT_FOUND", t("calendarEvents.calendarNotFound"));
    return cal;
  };
  let selected: Calendar[];
  if (c.req.param("calendarId")) selected = [resolve(identifier(c.req.param("calendarId")))];
  else if (param("calendar_ids")) {
    const ids = [
      ...new Set(
        param("calendar_ids")!
          .split(",")
          .map((value) => identifier(value)),
      ),
    ];
    if (ids.length > 50)
      fail(400, "INVALID_INPUT", t("calendarEvents.atMost50CalendarsMayBeQueried"));
    selected = [...new Set(ids.map(resolve))];
  } else {
    const subs = await rows<{ calendar_id: string }>(
      c.env,
      "SELECT calendar_id FROM calendar_subscriptions WHERE user_id=? AND selected=1 AND hidden=0",
      c.get("identity").user.id,
    );
    selected = all.filter((cal) => subs.some((sub) => sub.calendar_id === cal.id));
  }
  const expanded = queryFlag(c, "expand_recurring", true, input),
    showDeleted = queryFlag(c, "show_deleted", false, input),
    range = queryRange(param("time_min"), param("time_max")),
    query = text(param("q") ?? "", "q", 255, true).toLocaleLowerCase(),
    limit = pageLimit(c, input);
  const filter = JSON.stringify([
      "events",
      selected.map((cal) => [cal.id, cal.version, cal.effective_role]).sort(),
      range,
      expanded,
      showDeleted,
      query,
    ]),
    after = param("cursor")
      ? String(await readCursor(c.env, c.get("identity").user.id, filter, param("cursor")!))
      : "";
  if (!selected.length) return { events: [], next_cursor: null };
  const candidates = await rows<Event>(
    c.env,
    `SELECT e.* FROM calendar_events e JOIN calendars organizer ON organizer.id=e.organizer_calendar_id JOIN users owner ON owner.id=organizer.data_owner_user_id WHERE organizer.status='active' AND organizer.trashed_at IS NULL AND owner.disabled_at IS NULL AND owner.deleted_at IS NULL AND owner.password_hash IS NOT NULL AND owner.password_reset_required=0 AND (e.organizer_calendar_id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM calendar_event_copies cp JOIN calendar_event_attendees a ON a.user_id=(SELECT data_owner_user_id FROM calendars WHERE id=cp.calendar_id) JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE cp.event_id=e.id AND s.event_id=e.id AND a.removed_at IS NULL AND cp.removed_at IS NULL AND cp.calendar_id IN(SELECT value FROM json_each(?)))) ${showDeleted ? "" : "AND e.trashed_at IS NULL"} AND (e.recurrence_json<>'[]' OR (e.start_at<? AND e.end_at>?) OR (e.start_date<? AND e.end_date>?)) ORDER BY e.id LIMIT 2001`,
    JSON.stringify(selected.map((cal) => cal.id)),
    JSON.stringify(selected.map((cal) => cal.id)),
    range.max,
    range.min,
    new Date((range.max + 172800) * 1000).toISOString().slice(0, 10),
    new Date((range.min - 172800) * 1000).toISOString().slice(0, 10),
  );
  if (candidates.length > 2000)
    fail(422, "TOO_MANY_EVENTS", t("calendarEvents.narrowTheDateRangeOrCalendarSelection"));
  if (candidates.filter((event) => event.recurrence_json !== "[]").length > 100)
    fail(422, "TOO_MANY_SERIES", t("calendarEvents.queryFewerCalendarsOrRecurringSeries"));
  if (!candidates.length) return { events: [], next_cursor: null };
  const foreign = candidates.some(
    (event) => !selected.some((cal) => cal.id === event.organizer_calendar_id),
  );
  const [overrides, copies, invitationState, sourceCalendars, prefs] = await Promise.all([
    loadOverrides(
      c,
      candidates.map((event) => event.id),
    ),
    rows<Copy>(
      c.env,
      "SELECT * FROM calendar_event_copies WHERE event_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL",
      JSON.stringify(candidates.map((event) => event.id)),
    ),
    foreign
      ? attendeeStatesForUsers(
          c,
          candidates.map((value) => value.id),
          [...new Set(selected.map((cal) => cal.data_owner_user_id))],
        )
      : Promise.resolve(() => null),
    foreign
      ? rows<Calendar>(
          c.env,
          "SELECT * FROM calendars WHERE id IN(SELECT value FROM json_each(?))",
          JSON.stringify([...new Set(candidates.map((value) => value.organizer_calendar_id))]),
        )
      : Promise.resolve([]),
    foreign
      ? rows<{
          user_id: string;
          invitation_policy: string;
          display_options_json: string;
        }>(
          c.env,
          "SELECT user_id,invitation_policy,display_options_json FROM calendar_preferences WHERE user_id IN(SELECT value FROM json_each(?))",
          JSON.stringify([...new Set(selected.map((value) => value.data_owner_user_id))]),
        )
      : Promise.resolve([]),
  ]);
  const result: { key: string; value: ReturnType<typeof eventDto> }[] = [];
  for (const event of candidates) {
    const cal =
      selected.find((value) => value.id === event.organizer_calendar_id) ??
      selected.find((value) =>
        copies.some((copy) => copy.event_id === event.id && copy.calendar_id === value.id),
      );
    if (!cal) continue;
    const foreign = cal.id !== event.organizer_calendar_id;
    if (foreign && (event.trashed_at || event.status === "cancelled")) continue;
    const viewCal = foreign
        ? {
            ...cal,
            default_visibility: sourceCalendars.find(
              (value) => value.id === event.organizer_calendar_id,
            )!.default_visibility,
          }
        : cal,
      copy =
        cal.data_owner_user_id === c.get("identity").user.id
          ? copies.find((value) => value.event_id === event.id && value.calendar_id === cal.id)
          : undefined;
    if (copy?.hidden_at) continue;
    const instances = expand(
      event,
      overrides.filter((value) => value.event_id === event.id),
      range.min,
      range.max,
      cal.time_zone,
      showDeleted,
    );
    if (expanded || cal.effective_role === "free_busy" || foreign)
      for (const item of instances) {
        const attendee = foreign
            ? invitationState(cal.data_owner_user_id, event.id, item.key)
            : null,
          personal = prefs.find((value) => value.user_id === cal.data_owner_user_id);
        if (
          foreign &&
          (!attendee ||
            (attendee.response_status === "declined" &&
              !JSON.parse(personal?.display_options_json ?? "{}").show_declined) ||
            (attendee.response_status === "needs_action" &&
              personal?.invitation_policy === "on_response"))
        )
          continue;
        const value = {
          ...eventDto(
            item.event,
            foreign && cal.data_owner_user_id === c.get("identity").user.id
              ? {
                  ...viewCal,
                  effective_role: item.event.status === "cancelled" ? "free_busy" : "writer",
                }
              : viewCal,
            item,
            copy,
          ),
          ...(attendee && cal.data_owner_user_id === c.get("identity").user.id
            ? {
                invitation_id: attendee.id,
                response_status: attendee.response_status,
              }
            : {}),
        };
        if (
          query &&
          (value.is_redacted ||
            !`${item.event.title}\n${item.event.description_html}\n${item.event.location_json}`
              .toLocaleLowerCase()
              .includes(query))
        )
          continue;
        const start = String(interval(item.event, cal.time_zone).min).padStart(12, "0");
        result.push({ key: `${start}:${event.id}:${item.key}`, value });
      }
    else if (instances.length) {
      const value = eventDto(event, cal, undefined, copy);
      if (
        query &&
        (value.is_redacted ||
          !`${event.title}\n${event.description_html}\n${event.location_json}`
            .toLocaleLowerCase()
            .includes(query))
      )
        continue;
      result.push({ key: event.id, value });
    }
    if (result.length > MAX_OCCURRENCES)
      fail(422, "TOO_MANY_OCCURRENCES", t("calendarEvents.tooManyOccurrencesNarrowTheDateRange"));
  }
  result.sort((a, b) => a.key.localeCompare(b.key));
  const page = result.filter((value) => value.key > after).slice(0, limit),
    hasMore = result.some((value) => value.key > (page.at(-1)?.key ?? after));
  return {
    events: page.map((value) => value.value),
    next_cursor: hasMore
      ? await cursor(c.env, c.get("identity").user.id, filter, page.at(-1)!.key)
      : null,
  };
}
const routes = new Hono<AppEnv>();
routes.get("/events", async (c) => c.json(await listEvents(c)));
routes.get(paths, async (c) => c.json(await listEvents(c)));
routes.post(paths, async (c) => {
  const data = await body(c, createFields),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 3),
    event = writeEvent(data, cal),
    copy = makeCopy(event, data.copy_preferences),
    owner = await first<{ email_address: string }>(
      c.env,
      "SELECT email_address FROM users WHERE id=?",
      cal.data_owner_user_id,
    );
  if (data.copy_preferences !== undefined && cal.data_owner_user_id !== c.get("identity").user.id)
    fail(
      403,
      "PERMISSION_DENIED",
      t("calendarEvents.onlyTheCalendarOwnerMaySetPersonalCopyPreferences"),
    );
  event.organizer_email = owner!.email_address;
  event.creator_user_id = c.get("identity").user.id;
  const baseScopeId = uuid(),
    invited = await prepareNewAttendees(
      c,
      cal,
      event,
      data.attendees,
      baseScopeId,
      "",
      data.send_updates,
    );
  const result = await mutate(c, {
    operation: `event.create:${cal.id}`,
    action: "calendar.events.create",
    idempotent: true,
    request: data,
    result: { event: eventDto(event, cal), copy_id: copy.id },
    calendar: cal.id,
    event: event.id,
    checks: [
      calendarCondition(c, cal, 3),
      await labelCheck(c, cal, copy.label_id),
      ...invited.checks,
    ],
    build: (proof, operation) => [
      ...insertEvent(c, event, copy, proof, baseScopeId),
      ...invited.build(proof, operation),
      changed(event, proof, c),
    ],
  });
  c.header("ETag", `"v${result.event.version}"`);
  wakeCalendar(c);
  return c.json(result, 201);
});
routes.get(`${paths}/:eventId`, async (c) => {
  const { cal, event } = await target(c, false, queryFlag(c, "include_trashed")),
    copy =
      cal.data_owner_user_id === c.get("identity").user.id ? await getCopy(c, event) : undefined;
  c.header("ETag", `"v${event.version}"`);
  return c.json({ event: eventDto(event, cal, undefined, copy ?? undefined) });
});
routes.get(`${paths}/:eventId/instances`, async (c) => {
  const { cal, event } = await target(c),
    range = queryRange(c.req.query("time_min"), c.req.query("time_max")),
    showDeleted = queryFlag(c, "show_deleted"),
    limit = pageLimit(c),
    scope = JSON.stringify([
      "instances",
      event.id,
      event.version,
      cal.version,
      cal.effective_role,
      range,
      showDeleted,
    ]);
  const after = c.req.query("cursor")
    ? Number(await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!))
    : 0;
  const values = expand(
      event,
      await loadOverrides(c, [event.id]),
      range.min,
      range.max,
      cal.time_zone,
      showDeleted,
    ),
    page = values.slice(after, after + limit);
  const copy =
    cal.data_owner_user_id === c.get("identity").user.id ? await getCopy(c, event) : undefined;
  return c.json({
    instances: page.map((value) => eventDto(value.event, cal, value, copy ?? undefined)),
    next_cursor:
      after + limit < values.length
        ? await cursor(c.env, c.get("identity").user.id, scope, after + limit)
        : null,
  });
});
routes.get(`${paths}/:eventId/instances/:occurrenceKey`, async (c) => {
  const { cal, event } = await target(c),
    key = text(c.req.param("occurrenceKey"), "occurrence_key", 64),
    original = originalOccurrence(event, key),
    override = (await loadOverrides(c, [event.id])).find((value) => value.occurrence_key === key),
    effective = applyOverride(event, original, override);
  const copy =
    cal.data_owner_user_id === c.get("identity").user.id ? await getCopy(c, event) : undefined;
  c.header("ETag", `"v${event.version}"`);
  return c.json({
    event: eventDto(
      effective,
      cal,
      { key, original, event: effective, override },
      copy ?? undefined,
    ),
  });
});
export function setOverride(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  version: number,
  key: string,
  patch: Record<string, Bind>,
  cancelled: number,
  old: Override | undefined,
  proof: string,
) {
  const effective = applyOverride(event, originalOccurrence(event, key), old);
  Object.assign(effective, patch);
  const merged = { ...JSON.parse(old?.patch_json ?? "{}"), ...patch },
    values = {
      cancelled,
      patch_json: JSON.stringify(merged),
      effective_start_at: effective.start_at,
      effective_end_at: effective.end_at,
      effective_start_date: effective.start_date,
      effective_end_date: effective.end_date,
      version: (old?.version ?? 0) + 1,
      updated_at: now(),
    };
  const scopeId = old?.scope_id ?? uuid();
  return [
    ...(old
      ? []
      : [
          c.env.DB.prepare(
            `INSERT INTO calendar_event_scopes(id,event_id,occurrence_key) SELECT ?,?,? WHERE ${proof} ON CONFLICT(event_id,occurrence_key) DO NOTHING`,
          ).bind(scopeId, event.id, key),
        ]),
    c.env.DB.prepare(
      `INSERT INTO calendar_event_overrides(scope_id,${Object.keys(values).join(",")}) SELECT s.id,${Object.keys(
        values,
      )
        .map(() => "?")
        .join(
          ",",
        )} FROM calendar_event_scopes s WHERE s.event_id=? AND s.occurrence_key=? AND ${proof} ON CONFLICT(scope_id) DO UPDATE SET ${Object.keys(
        values,
      )
        .map((column) => `${column}=excluded.${column}`)
        .join(",")} WHERE ${proof}`,
    ).bind(...Object.values(values), event.id, key),
    update(
      c,
      "calendar_events",
      { version: version + 1, updated_at: now(), sequence: event.sequence + 1 },
      "id=?",
      [event.id],
      proof,
    ),
    change(c, proof, cal.id, "event", event.id, version + 1, "upsert", null, key),
  ];
}
async function detach(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  overrides: Override[],
  next: Event,
) {
  const items: { scopeId: string; event: Event }[] = [],
    ids: string[] = [];
  for (const override of overrides) {
    try {
      originalOccurrence(next, override.occurrence_key);
      continue;
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    }
    if (override.cancelled) continue;
    const original = originalOccurrence(event, override.occurrence_key),
      effective = applyOverride(event, original, override),
      value: Event = {
        ...effective,
        id: uuid(),
        i_cal_uid: `${uuid()}@officeflare`,
        recurrence_json: "[]",
        version: 1,
        sequence: 0,
        created_at: now(),
        updated_at: now(),
      };
    ids.push(value.id);
    items.push({ scopeId: override.scope_id, event: value });
  }
  const copies = items.map((item) => makeCopy(item.event));
  const participants = await Promise.all(
    items.map((item) =>
      detachParticipants(
        c,
        cal,
        event,
        item.event,
        overrides.find((value) => value.scope_id === item.scopeId)!.occurrence_key,
        item.scopeId,
        next.sequence,
      ),
    ),
  );
  return {
    ids,
    build: (proof: string, operation: string) =>
      items.flatMap((item, index) => [
        ...insertEvent(c, item.event, copies[index]!, proof, null),
        update(
          c,
          "calendar_event_scopes",
          { event_id: item.event.id, occurrence_key: "" },
          "id=?",
          [item.scopeId],
          proof,
        ),
        c.env.DB.prepare(`DELETE FROM calendar_event_overrides WHERE scope_id=? AND ${proof}`).bind(
          item.scopeId,
        ),
        ...participants[index]!(proof, operation),
        changed(item.event, proof, c),
        change(
          c,
          proof,
          cal.id,
          "event_override",
          event.id,
          next.version,
          "delete",
          null,
          overrides.find((value) => value.scope_id === item.scopeId)!.occurrence_key,
        ),
      ]),
  };
}
routes.patch(`${paths}/:eventId`, async (c) => {
  const data = await body(c, [...eventFields, "version", "scope", "occurrence_key"]),
    { cal, event } = await target(c, true),
    version = expectedVersion(c, data),
    scope = scopeOf(data),
    overrides = await participatingScopes(c, event, await loadOverrides(c, [event.id]));
  if (!Object.keys(data).some((key) => (eventFields as readonly string[]).includes(key)))
    fail(400, "INVALID_INPUT", t("calendarEvents.noEventChangesSupplied"));
  if (scope !== "all" && event.recurrence_json === "[]")
    fail(400, "INVALID_SCOPE", t("calendarEvents.singleAndFollowingScopesRequireARecurringEvent"));
  if (scope === "single") {
    const key = occurrenceKey(data),
      original = originalOccurrence(event, key),
      old = overrides.find((value) => value.occurrence_key === key);
    if (old?.cancelled)
      fail(409, "OCCURRENCE_CANCELLED", t("calendarEvents.restoreTheOccurrenceBeforeEditingIt"));
    const effective = applyOverride(event, original, old),
      { patch, parsed } = overridePatch(data, effective, cal);
    requireDetails(effective, cal);
    const notices = await prepareDeliveries(
      c,
      cal,
      { ...parsed, version: version + 1, sequence: event.sequence + 1 },
      await effectiveAttendees(c, event.id, key),
      "update",
      key,
      { sendUpdates: data.send_updates },
    );
    const result = await mutate(c, {
      operation: "event.override",
      action: "calendar.events.update",
      request: data,
      result: {
        event: eventDto({ ...parsed, version: version + 1, sequence: event.sequence + 1 }, cal, {
          key,
          original,
          event: parsed,
          override: old ?? ({} as Override),
        }),
      },
      calendar: cal.id,
      event: event.id,
      checks: [eventCondition(c, cal, event, version)],
      build: (proof, operation) => [
        ...setOverride(c, cal, event, version, key, patch, 0, old, proof),
        ...notices(proof, operation),
      ],
    });
    wakeCalendar(c);
    return c.json(result);
  }
  if (scope === "following") return following(c, cal, event, version, data, overrides);
  const next = {
      ...writeEvent(data, cal, event),
      version: version + 1,
      updated_at: now(),
      sequence: event.sequence + 1,
    },
    detached = await detach(c, cal, event, overrides, next);
  const notices = await prepareDeliveries(
    c,
    cal,
    next,
    await allAttendees(c, event.id),
    "update",
    "",
    { sendUpdates: data.send_updates },
  );
  const result = await mutate(c, {
    operation: "event.update",
    action: "calendar.events.update",
    request: data,
    result: { event: eventDto(next, cal), detached_event_ids: detached.ids },
    calendar: cal.id,
    event: event.id,
    checks: [eventCondition(c, cal, event, version)],
    build: (proof, operation) => [
      update(
        c,
        "calendar_events",
        next as unknown as Record<string, Bind>,
        "id=?",
        [event.id],
        proof,
      ),
      ...detached.build(proof, operation),
      changed(next, proof, c),
      ...notices(proof, operation),
    ],
  });
  c.header("ETag", `"v${version + 1}"`);
  wakeCalendar(c);
  return c.json(result);
});

async function following(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  version: number,
  data: Record<string, unknown>,
  overrides: Override[],
) {
  const key = occurrenceKey(data),
    boundary = originalOccurrence(event, key);
  if (key < keyOf(event))
    fail(
      422,
      "FEATURE_UNAVAILABLE",
      t("calendarEvents.followingEditsBeforeDtstartAreNotSupported"),
    );
  if (!("recurrence" in data) && key !== keyOf(event) && !ruleContains(event, boundary))
    fail(
      422,
      "EXPLICIT_RECURRENCE_REQUIRED",
      t("calendarEvents.aSplitAtAnAddedRdateNeedsAnExplicit"),
    );
  const split = splitRecurrence(event, boundary),
    firstBoundary = key === keyOf(event),
    stamp = now();
  const newData = {
    ...data,
    ...(!("start" in data) && !("end" in data) ? shiftedStart(event, boundary) : {}),
    recurrence: "recurrence" in data ? data.recurrence : split.after,
  };
  const next: Event = {
    ...writeEvent(newData, cal, event),
    id: uuid(),
    i_cal_uid: `${uuid()}@officeflare`,
    sequence: 0,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    creator_user_id: c.get("identity").user.id,
  };
  const old: Event = {
    ...event,
    version: version + 1,
    sequence: event.sequence + 1,
    updated_at: stamp,
    ...(firstBoundary
      ? { status: "cancelled", trashed_at: stamp }
      : { recurrence_json: JSON.stringify(split.before) }),
  };
  const future = overrides.filter((value) => value.occurrence_key >= key),
    detached = await detach(c, cal, event, future, next),
    sourceCopy = await getCopy(c, event),
    copy = {
      ...(sourceCopy ?? makeCopy(next)),
      id: uuid(),
      event_id: next.id,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
  const matching: Override[] = [];
  for (const value of future) {
    try {
      originalOccurrence(next, value.occurrence_key);
      matching.push(value);
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    }
  }
  const newBaseScope = uuid(),
    participants = await splitParticipants(c, cal, event, old, next, key, newBaseScope);
  const result = await mutate(c, {
    operation: "event.split",
    action: "calendar.events.update",
    request: data,
    result: {
      event: eventDto(next, cal),
      previous_event_id: event.id,
      previous_version: version + 1,
      detached_event_ids: detached.ids,
    },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, version),
      ...(sourceCopy
        ? [
            condition(
              "EXISTS(SELECT 1 FROM calendar_event_copies WHERE id=? AND version=?)",
              sourceCopy.id,
              sourceCopy.version,
            ),
          ]
        : []),
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendar_events",
        old as unknown as Record<string, Bind>,
        "id=?",
        [event.id],
        proof,
      ),
      ...insertEvent(c, next, copy, proof, newBaseScope),
      ...matching.map((value) =>
        update(c, "calendar_event_scopes", { event_id: next.id }, "id=?", [value.scope_id], proof),
      ),
      ...detached.build(proof, operation),
      ...participants(proof, operation),
      insert(
        c,
        "calendar_series_links",
        {
          previous_event_id: event.id,
          next_event_id: next.id,
          split_occurrence_key: key,
          operation_id: operation,
        },
        proof,
      ),
      changed(old, proof, c, firstBoundary ? "delete" : "upsert"),
      changed(next, proof, c),
    ],
  });
  c.header("ETag", '"v1"');
  wakeCalendar(c);
  return c.json(result);
}
routes.delete(`${paths}/:eventId`, async (c) => {
  const { cal, event } = await target(c, true),
    version = expectedVersion(c),
    key = c.req.query("occurrence_key"),
    scope = scopeOf({ scope: c.req.query("scope"), occurrence_key: key }),
    overrides = await loadOverrides(c, [event.id]);
  if (scope !== "all" && event.recurrence_json === "[]")
    fail(400, "INVALID_SCOPE", t("calendarEvents.singleAndFollowingScopesRequireARecurringEvent"));
  if (scope === "single") {
    const selected = occurrenceKey({ occurrence_key: key });
    originalOccurrence(event, selected);
    const old = overrides.find((value) => value.occurrence_key === selected);
    requireDetails(applyOverride(event, originalOccurrence(event, selected), old), cal);
    const notices = await prepareDeliveries(
      c,
      cal,
      {
        ...applyOverride(event, originalOccurrence(event, selected), old),
        status: "cancelled",
        version: version + 1,
        sequence: event.sequence + 1,
      },
      await effectiveAttendees(c, event.id, selected),
      "cancel",
      selected,
    );
    await mutate(c, {
      operation: "event.cancel_occurrence",
      action: "calendar.events.delete",
      request: { version, scope, key },
      result: null,
      calendar: cal.id,
      event: event.id,
      checks: [eventCondition(c, cal, event, version)],
      build: (proof, operation) => [
        ...setOverride(c, cal, event, version, selected, {}, 1, old, proof),
        ...notices(proof, operation),
      ],
    });
    wakeCalendar(c);
    return c.body(null, 204);
  }
  let values: Record<string, Bind> = {
    version: version + 1,
    updated_at: now(),
    sequence: event.sequence + 1,
    status: "cancelled",
    trashed_at: now(),
  };
  if (scope === "following") {
    const selected = occurrenceKey({ occurrence_key: key }),
      boundary = originalOccurrence(event, selected);
    if (selected < keyOf(event))
      fail(
        422,
        "FEATURE_UNAVAILABLE",
        t("calendarEvents.followingCancellationsBeforeDtstartAreNotSupported"),
      );
    if (selected !== keyOf(event))
      values = {
        version: version + 1,
        updated_at: now(),
        sequence: event.sequence + 1,
        recurrence_json: JSON.stringify(splitRecurrence(event, boundary).before),
      };
  }
  const members = await allAttendees(c, event.id),
    truncated = scope === "following" && !values.trashed_at;
  const prefixNotices = truncated
    ? await prepareDeliveries(
        c,
        cal,
        { ...event, ...values } as Event,
        members.filter((value) => value.occurrence_key < (key ?? "")),
        "update",
      )
    : null;
  const notices = await prepareDeliveries(
    c,
    cal,
    {
      ...event,
      sequence: event.sequence + 1,
      version: version + 1,
      status: "cancelled",
    },
    truncated
      ? members.filter((value) => value.occurrence_key >= (key ?? "") && !!value.occurrence_key)
      : members,
    "cancel",
    "",
  );
  await mutate(c, {
    operation: "event.trash",
    action: "calendar.events.delete",
    request: { version, scope, key },
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [eventCondition(c, cal, event, version)],
    build: (proof, operation) => [
      update(c, "calendar_events", values, "id=?", [event.id], proof),
      ...(truncated
        ? [
            c.env.DB.prepare(
              `UPDATE calendar_event_attendees SET removed_at=unixepoch(),version=version+1 WHERE scope_id IN(SELECT id FROM calendar_event_scopes WHERE event_id=? AND occurrence_key>=?) AND ${proof}`,
            ).bind(event.id, key ?? ""),
            c.env.DB.prepare(
              `UPDATE calendar_event_registrations SET status='cancelled',cancelled_at=unixepoch(),version=version+1 WHERE event_id=? AND occurrence_key>=? AND ${proof}`,
            ).bind(event.id, key ?? ""),
          ]
        : []),
      ...notices(proof, operation),
      ...(prefixNotices ? prefixNotices(proof, operation) : []),
      change(
        c,
        proof,
        cal.id,
        "event",
        event.id,
        version + 1,
        values.trashed_at ? "delete" : "upsert",
      ),
    ],
  });
  wakeCalendar(c);
  return c.body(null, 204);
});
routes.post(`${paths}/:eventId/restore`, async (c) => {
  const data = await body(c, ["version", "scope", "occurrence_key", "send_updates"]),
    scope = scopeOf(data),
    { cal, event } = await target(c, true, true),
    version = expectedVersion(c, data);
  if (scope === "following")
    fail(
      422,
      "FEATURE_UNAVAILABLE",
      t("calendarEvents.restoreASingleOccurrenceOrTheEntireDeletedEvent"),
    );
  if (scope === "single") {
    if (event.trashed_at)
      fail(409, "EVENT_TRASHED", t("calendarEvents.restoreTheParentEventFirst"));
    const key = occurrenceKey(data),
      original = originalOccurrence(event, key),
      override = (await loadOverrides(c, [event.id])).find((value) => value.occurrence_key === key);
    if (!override?.cancelled)
      fail(409, "NOT_CANCELLED", t("calendarEvents.occurrenceIsNotCancelled"));
    requireDetails(applyOverride(event, original, override), cal);
    const notices = await prepareDeliveries(
      c,
      cal,
      {
        ...applyOverride(event, original, { ...override, cancelled: 0 }),
        sequence: event.sequence + 1,
        version: version + 1,
      },
      await effectiveAttendees(c, event.id, key),
      "update",
      key,
      { sendUpdates: data.send_updates },
    );
    await mutate(c, {
      operation: "event.restore_occurrence",
      action: "calendar.events.update",
      request: data,
      result: null,
      calendar: cal.id,
      event: event.id,
      checks: [eventCondition(c, cal, event, version, 3, true)],
      build: (proof, operation) => [
        ...setOverride(c, cal, event, version, key, {}, 0, override, proof),
        ...notices(proof, operation),
      ],
    });
    wakeCalendar(c);
    return c.json({
      event: eventDto(
        {
          ...applyOverride(event, original, { ...override, cancelled: 0 }),
          version: version + 1,
          sequence: event.sequence + 1,
        },
        cal,
      ),
    });
  }
  if (!event.trashed_at) fail(409, "NOT_TRASHED", t("calendarEvents.eventIsNotInTrash"));
  const restored = {
    ...event,
    trashed_at: null,
    status: "confirmed",
    version: version + 1,
    sequence: event.sequence + 1,
    updated_at: now(),
  };
  const notices = await prepareDeliveries(
    c,
    cal,
    restored,
    await allAttendees(c, event.id),
    "update",
    "",
    { sendUpdates: data.send_updates },
  );
  await mutate(c, {
    operation: "event.restore",
    action: "calendar.events.update",
    request: data,
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [eventCondition(c, cal, event, version, 3, true)],
    build: (proof, operation) => [
      update(
        c,
        "calendar_events",
        restored as unknown as Record<string, Bind>,
        "id=?",
        [event.id],
        proof,
      ),
      changed(restored, proof, c),
      ...notices(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json({ event: eventDto(restored, cal) });
});
routes.post(`${paths}/:eventId/duplicate`, async (c) => {
  const data = await body(c, ["version", "title", "target_calendar_id"]),
    { cal, event } = await target(c),
    version = expectedVersion(c, data),
    destination = data.target_calendar_id
      ? await requireCalendar(c, identifier(data.target_calendar_id), 3)
      : cal;
  if (destination.kind === "external")
    fail(
      403,
      "READ_ONLY_CALENDAR",
      t("calendarEvents.externalCalendarsAreReadOnlyChooseADifferentDestination"),
    );
  const clone: Event = {
      ...event,
      id: uuid(),
      organizer_calendar_id: destination.id,
      organizer_user_id: destination.data_owner_user_id,
      creator_user_id: c.get("identity").user.id,
      i_cal_uid: `${uuid()}@officeflare`,
      title: data.title === undefined ? event.title : text(data.title, "title", 1024, true),
      version: 1,
      sequence: 0,
      created_at: now(),
      updated_at: now(),
    },
    copy = makeCopy(clone);
  if (cal.effective_role === "free_busy" || eventDto(event, cal).is_redacted)
    fail(404, "EVENT_NOT_FOUND", t("calendarEvents.eventNotFound"));
  clone.organizer_email = (await first<{ email_address: string }>(
    c.env,
    "SELECT email_address FROM users WHERE id=?",
    destination.data_owner_user_id,
  ))!.email_address;
  clone.authority = "native";
  const overrides = await loadOverrides(c, [event.id]),
    clonedScopes = overrides.map((value) => ({ id: uuid(), override: value }));
  requireSeriesDetails(event, cal, overrides);
  const result = await mutate(c, {
    operation: `event.duplicate:${event.id}`,
    action: "calendar.events.create",
    idempotent: true,
    request: data,
    result: { event: eventDto(clone, destination) },
    calendar: destination.id,
    event: clone.id,
    checks: [eventCondition(c, cal, event, version, 1), calendarCondition(c, destination, 3)],
    build: (proof) => [
      ...insertEvent(c, clone, copy, proof),
      ...clonedScopes.flatMap(({ id, override }) => {
        const { scope_id, event_id, occurrence_key, ...value } = override;
        return [
          insert(c, "calendar_event_scopes", { id, event_id: clone.id, occurrence_key }, proof),
          insert(
            c,
            "calendar_event_overrides",
            {
              ...value,
              scope_id: id,
              version: 1,
              created_at: now(),
              updated_at: now(),
            },
            proof,
          ),
        ];
      }),
      changed(clone, proof, c),
    ],
  });
  return c.json(result, 201);
});
routes.post(`${paths}/:eventId/move`, async (c) => {
  const data = await body(c, ["version", "target_calendar_id"]),
    cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 3),
    destination = await requireCalendar(c, identifier(data.target_calendar_id), 3),
    id = identifier(c.req.param("eventId"));
  const previous = await replay<{ event: ReturnType<typeof eventDto> }>(
    c,
    `event.move:${id}`,
    data,
    "calendar.events.update",
  );
  if (previous) {
    await requireEvent(c, destination, id, true);
    return c.json(previous.result);
  }
  const event = await requireEvent(c, cal, id, true),
    version = expectedVersion(c, data);
  requireSeriesDetails(event, cal, await loadOverrides(c, [event.id]));
  if (destination.id === cal.id)
    fail(400, "INVALID_INPUT", t("calendarEvents.chooseADifferentCalendar"));
  const currentCopy = await getCopy(c, event),
    destinationCopy = await getCopy(c, event, destination.id),
    owner = await first<{ email_address: string }>(
      c.env,
      "SELECT email_address FROM users WHERE id=?",
      destination.data_owner_user_id,
    );
  const moved = {
    ...event,
    organizer_calendar_id: destination.id,
    organizer_user_id: destination.data_owner_user_id,
    organizer_email: owner!.email_address,
    version: version + 1,
    sequence: event.sequence + 1,
    updated_at: now(),
  };
  const copyChanges = {
    calendar_id: destination.id,
    label_id: null,
    version: (currentCopy?.version ?? 0) + 1,
    updated_at: now(),
    ...(cal.data_owner_user_id !== destination.data_owner_user_id
      ? { private_properties_json: "{}", color_override: null, hidden_at: null }
      : {}),
  };
  const notices = await prepareDeliveries(
    c,
    destination,
    moved,
    await allAttendees(c, event.id),
    "update",
  );
  const result = await mutate(c, {
    operation: `event.move:${event.id}`,
    action: "calendar.events.update",
    idempotent: true,
    request: data,
    result: { event: eventDto(moved, destination) },
    calendar: destination.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, version),
      calendarCondition(c, destination, 3),
      ...(destinationCopy
        ? [
            condition(
              "EXISTS(SELECT 1 FROM calendar_event_copies WHERE id=? AND version=?)",
              destinationCopy.id,
              destinationCopy.version,
            ),
          ]
        : []),
      ...(currentCopy
        ? [
            condition(
              "EXISTS(SELECT 1 FROM calendar_event_copies WHERE id=? AND version=?)",
              currentCopy.id,
              currentCopy.version,
            ),
          ]
        : []),
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendar_events",
        moved as unknown as Record<string, Bind>,
        "id=?",
        [event.id],
        proof,
      ),
      ...(currentCopy
        ? [
            update(
              c,
              "calendar_event_copies",
              destinationCopy
                ? {
                    removed_at: now(),
                    version: currentCopy.version + 1,
                    updated_at: now(),
                  }
                : copyChanges,
              "id=?",
              [currentCopy.id],
              proof,
            ),
          ]
        : []),
      ...(destinationCopy
        ? [
            update(
              c,
              "calendar_event_copies",
              {
                copy_kind: "organizer",
                removed_at: null,
                version: destinationCopy.version + 1,
                updated_at: now(),
              },
              "id=?",
              [destinationCopy.id],
              proof,
            ),
          ]
        : []),
      c.env.DB.prepare(
        `UPDATE calendar_share_links SET revoked_at=unixepoch(),version=version+1,access_version=access_version+1 WHERE event_id=? AND revoked_at IS NULL AND ${proof}`,
      ).bind(event.id),
      ...notices(proof, operation),
      change(c, proof, cal.id, "event", event.id, version + 1, "delete"),
      changed(moved, proof, c),
    ],
  });
  wakeCalendar(c);
  return c.json(result);
});
routes.post(`${paths}/:eventId/recurrence-preview`, async (c) => {
  const data = await body(c, [...eventFields, "time_min", "time_max"]),
    { cal, event } = await target(c, true),
    range = queryRange(data.time_min, data.time_max),
    preview = writeEvent(data, cal, event),
    overrides = await loadOverrides(c, [event.id]);
  return c.json({
    instances: expand(preview, overrides, range.min, range.max, cal.time_zone).map((value) =>
      eventDto(value.event, cal, value),
    ),
    detached_event_ids: [],
    unmatched_override_keys: overrides
      .filter((value) => {
        try {
          originalOccurrence(preview, value.occurrence_key);
          return false;
        } catch (error) {
          if (error instanceof Error && "status" in error && error.status === 404) return true;
          throw error;
        }
      })
      .map((value) => value.occurrence_key),
  });
});
routes.get("/trash/events", async (c) => {
  const available = (await calendars(c, true)).filter(
      (cal) => cal.effective_role === "data_owner" && cal.kind !== "external",
    ),
    limit = pageLimit(c),
    scope = JSON.stringify(["trash", available.map((cal) => [cal.id, cal.version])]),
    after = c.req.query("cursor")
      ? String(await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!))
      : "";
  const result = await rows<Event>(
      c.env,
      "SELECT * FROM calendar_events WHERE trashed_at IS NOT NULL AND organizer_calendar_id IN (SELECT value FROM json_each(?)) AND id>? ORDER BY id LIMIT ?",
      JSON.stringify(available.map((cal) => cal.id)),
      after,
      limit + 1,
    ),
    page = result.slice(0, limit);
  return c.json({
    events: page.map((event) =>
      eventDto(
        event,
        available.find((cal) => cal.id === event.organizer_calendar_id)!,
      ),
    ),
    next_cursor:
      result.length > limit
        ? await cursor(c.env, c.get("identity").user.id, scope, page.at(-1)!.id)
        : null,
  });
});
routes.get(`${paths}/:eventId/activity`, async (c) => {
  const { cal, event } = await target(c),
    limit = pageLimit(c),
    scope = JSON.stringify(["activity", event.id, cal.effective_role]),
    after = c.req.query("cursor")
      ? String(await readCursor(c.env, c.get("identity").user.id, scope, c.req.query("cursor")!))
      : "";
  if (cal.effective_role !== "data_owner" && cal.effective_role !== "manager")
    fail(404, "EVENT_NOT_FOUND", t("calendarEvents.eventNotFound"));
  const values = await rows<{
      id: string;
      action: string;
      actor_user_id: string;
      details_json: string;
      created_at: number;
    }>(
      c.env,
      "SELECT id,action,actor_user_id,details_json,created_at FROM calendar_activity WHERE event_id=? AND id>? ORDER BY id LIMIT ?",
      event.id,
      after,
      limit + 1,
    ),
    page = values.slice(0, limit);
  return c.json({
    activity: page.map(({ details_json, ...value }) => ({
      ...value,
      details: JSON.parse(details_json),
    })),
    next_cursor:
      values.length > limit
        ? await cursor(c.env, c.get("identity").user.id, scope, page.at(-1)!.id)
        : null,
  });
});
export default routes;

import { Hono } from "hono";
import { now, type AppEnv } from "../auth/types";
import type { Event, Calendar } from "./types";
import type { ShareLink } from "./collaboration-types";
import { privateEvent, rows } from "./access";
import { body, fail, pageLimit } from "./input";
import {
  linkSession,
  publicLink,
  publicHeaders,
  limitPublic,
  inLinkRange,
  assertLinkOccurrence,
} from "./links";
import { applyOverride, expand, keyOf, originalOccurrence } from "./recurrence";
import { loadOverrides } from "./event-data";
import { endpoint, queryRange } from "./time";
import { occurrence, effectiveAttendees } from "./attendance-store";
import { calendarFile, exportCalendar } from "./ical";
import { invitation, invitationDto, respond } from "./attendees";
import { invitationPage, sharePage } from "./public-page";
import { policy } from "./attendance-store";
import { readableAttachments } from "./attachments";
export function publicEvent(event: Event, cal: Calendar, link: ShareLink, key?: string) {
  const redacted = link.target_type === "calendar" && privateEvent(event, cal),
    fields = redacted ? [] : (JSON.parse(link.shared_fields_json) as string[]),
    value = {
      id: event.id,
      occurrence_key: key ?? null,
      start: endpoint(event, "start"),
      end: endpoint(event, "end"),
      title: fields.includes("title") ? event.title : "Busy",
      is_redacted: redacted,
    };
  return {
    ...value,
    ...(fields.includes("description_html") ? { description_html: event.description_html } : {}),
    ...(fields.includes("location") ? { location: JSON.parse(event.location_json) } : {}),
    ...(fields.includes("organizer")
      ? { organizer: { email_address: event.organizer_email } }
      : {}),
  };
}
export async function publicInstances(c: Parameters<typeof publicLink>[0]) {
  const { link, cal, event } = await publicLink(c);
  await linkSession(c, link);
  const range = queryRange(c.req.query("time_min"), c.req.query("time_max"));
  if (
    (link.time_min !== null && range.min < link.time_min) ||
    (link.time_max !== null && range.max > link.time_max)
  )
    fail(400, "LINK_RANGE_EXCEEDED", "Query exceeds the shared date range");
  const candidates = event
    ? [event]
    : await rows<Event>(
        c.env,
        "SELECT * FROM calendar_events WHERE organizer_calendar_id=? AND status<>'cancelled' AND trashed_at IS NULL AND (recurrence_json<>'[]' OR (start_at<? AND end_at>?) OR (start_date<? AND end_date>?)) ORDER BY id LIMIT 201",
        cal.id,
        range.max,
        range.min,
        new Date((range.max + 172800) * 1000).toISOString().slice(0, 10),
        new Date((range.min - 172800) * 1000).toISOString().slice(0, 10),
      );
  if (candidates.length > 200) fail(422, "TOO_MANY_EVENTS", "Narrow the shared calendar scope");
  const overrides = await loadOverrides(
      c,
      candidates.map((value) => value.id),
    ),
    values = candidates.flatMap((value) =>
      expand(
        value,
        overrides.filter((item) => item.event_id === value.id),
        range.min,
        range.max,
        cal.time_zone,
      )
        .filter(
          (item) =>
            (!link.occurrence_key || item.key === link.occurrence_key) &&
            inLinkRange(link, item.event, cal),
        )
        .map((item) => ({
          ...item,
          recurring: value.recurrence_json !== "[]",
        })),
    );
  if (values.length > 500) fail(422, "TOO_MANY_OCCURRENCES", "Narrow the shared date range");
  return { link, cal, values };
}
export const publicRoutes = new Hono<AppEnv>();
publicRoutes.use("/public/*", async (c, next) => {
  publicHeaders(c);
  await limitPublic(c, `public:${c.req.header("cf-connecting-ip") ?? "unknown"}`, 300, 600);
  await next();
});
publicRoutes.use("/invitations/*", async (c, next) => {
  publicHeaders(c);
  await limitPublic(c, `invitation:${c.req.header("cf-connecting-ip") ?? "unknown"}`, 300, 600);
  await next();
});
publicRoutes.get("/public/share-links/:token", async (c) => {
  const { link, cal, event } = await publicLink(c);
  if (c.req.header("Accept")?.includes("text/html")) return sharePage(c);
  if (link.password_hash && !c.req.header("X-Calendar-Link-Session"))
    return c.json({ locked: true, password_protected: true });
  await linkSession(c, link);
  const requested = c.req.query("occurrence_key") ?? link.occurrence_key ?? "";
  if (link.occurrence_key && requested !== link.occurrence_key)
    fail(403, "LINK_SCOPE", "This link covers one occurrence");
  let effective = event ? await occurrence(c, event, requested) : null;
  if (effective && !inLinkRange(link, effective, cal)) {
    if (requested || event?.recurrence_json === "[]") assertLinkOccurrence(link, effective, cal);
    effective = null;
  }
  const p = event && link.mode === "join" ? await policy(c, event.id, requested) : null;
  return c.json({
    link: {
      mode: link.mode,
      target_type: link.target_type,
      allow_ics: !!link.allow_ics,
      expires_at: link.expires_at,
      occurrence_key: link.occurrence_key,
      is_recurring: event?.recurrence_json !== "[]" && !!event,
      time_min: link.time_min,
      time_max: link.time_max,
    },
    calendar: { name: cal.name, time_zone: cal.time_zone },
    event: effective
      ? {
          ...publicEvent(effective, cal, link, requested || undefined),
          ...(JSON.parse(link.shared_fields_json).includes("attachments")
            ? {
                attachments: (await readableAttachments(c, effective, requested)).filter(
                  (value) => "url" in value,
                ),
              }
            : {}),
        }
      : null,
    registration_form: p
      ? {
          form_schema: JSON.parse(p.form_schema_json),
          additional_guests_limit: p.additional_guests_limit,
          approval_mode: p.approval_mode,
          status: p.status,
        }
      : null,
    locked: false,
  });
});
publicRoutes.get("/public/share-links/:token/events", async (c) => {
  const { link, cal, values } = await publicInstances(c);
  return c.json({
    events: values
      .slice(0, pageLimit(c))
      .map((value) => publicEvent(value.event, cal, link, value.key)),
    total: values.length,
  });
});
publicRoutes.get("/public/share-links/:token/export.ics", async (c) => {
  const { link, cal } = await publicLink(c);
  await linkSession(c, link);
  if (!link.allow_ics) fail(403, "ICS_DISABLED", "This link does not allow calendar downloads");
  const fields = JSON.parse(link.shared_fields_json) as string[];
  let values: { event: Event; key?: string }[];
  if (link.target_type === "event" && link.occurrence_key) {
    const { event } = await publicLink(c);
    values = [
      {
        event: await occurrence(c, event!, link.occurrence_key),
        key: link.occurrence_key,
      },
    ];
  } else {
    const result = await publicInstances(c);
    values = result.values.map((value) => ({
      event: value.event,
      key: value.recurring ? value.key : undefined,
    }));
  }
  const sanitized = values.map((value) => {
    const visible = link.target_type === "event" || !privateEvent(value.event, cal);
    return {
      ...value,
      event: {
        ...value.event,
        title: visible && fields.includes("title") ? value.event.title : "Busy",
        description_html:
          visible && fields.includes("description_html") ? value.event.description_html : "",
        location_json: visible && fields.includes("location") ? value.event.location_json : "{}",
        organizer_email: visible && fields.includes("organizer") ? value.event.organizer_email : "",
      },
    };
  });
  return c.body(exportCalendar(sanitized, now()), 200, {
    "Content-Type": "text/calendar; charset=UTF-8; method=PUBLISH",
    "Content-Disposition": 'attachment; filename="calendar.ics"',
  });
});
publicRoutes.get("/invitations/:token", async (c) => {
  const own = await invitation(c);
  return c.req.header("Accept")?.includes("text/html")
    ? invitationPage(c, "invitation")
    : c.json(await invitationDto(c, own));
});
publicRoutes.post("/invitations/:token/rsvp", async (c) =>
  c.json(
    await respond(
      c,
      await invitation(c),
      await body(c, [
        "version",
        "response_status",
        "attendance_mode",
        "comment",
        "scope",
        "occurrence_key",
      ]),
    ),
  ),
);
publicRoutes.get("/invitations/:token/event.ics", async (c) => {
  const context = await invitation(c);
  if (
    context.attendee.removed_at ||
    context.event.trashed_at ||
    context.event.status === "cancelled" ||
    context.cal.trashed_at
  )
    fail(404, "INVITATION_NOT_FOUND", "Invitation is unavailable");
  const event = await occurrence(c, context.event, context.attendee.occurrence_key);
  return c.body(
    calendarFile({
      kind: "invitation",
      action: "invite",
      event,
      attendee: (
        await effectiveAttendees(c, context.event.id, context.attendee.occurrence_key)
      ).find((value) => value.id === context.attendee.id)!,
      occurrence_key: context.attendee.occurrence_key,
    }),
    200,
    {
      "Content-Type": "text/calendar; charset=UTF-8; method=REQUEST",
      "Content-Disposition": 'attachment; filename="invite.ics"',
    },
  );
});

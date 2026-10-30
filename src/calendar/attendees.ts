import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { now, uuid, type AppEnv } from "../auth/types";
import { digest } from "../auth/crypto";
import type { Attendee } from "./collaboration-types";
import type { Bind, Calendar, CalendarContext, Event, Condition } from "./types";
import {
  active,
  calendarCondition,
  canSeeDetails,
  combine,
  condition,
  eventCondition,
  first,
  identity,
  permission,
  requireCalendar,
  requireEvent,
  rows,
} from "./access";
import { body, choice, expectedVersion, fail, identifier, integer, pageLimit, text } from "./input";
import {
  attendeeDto,
  attendeeValues,
  allAttendees,
  bumpAttendance,
  capacityChecks,
  effectiveAttendees,
  eventAvailable,
  expandAttendeeInputs,
  occurrence,
  policy,
  scope,
  scheduleCondition,
} from "./attendance-store";
import { change, insert, mutate, update } from "./mutations";
import { notificationStatements, prepareDeliveries } from "./delivery";
import { calendarFile } from "./ical";
import { eventDto, makeCopy } from "./event-data";
import { keyOf } from "./recurrence";
import { wakeCalendar } from "./jobs";
import { preparePromotion } from "./registrations";
import { attendanceDetails } from "./attendance-store";
import { readableAttachments } from "./attachments";
export function attendeeCopyStatements(
  c: CalendarContext,
  event: Event,
  attendees: Attendee[],
  proof: string,
) {
  return attendees
    .filter((value) => value.user_id && value.user_id !== event.organizer_user_id)
    .flatMap((value) => [
      c.env.DB.prepare(
        `INSERT INTO calendar_event_copies(id,event_id,calendar_id,copy_kind) SELECT ?,?,p.calendar_id,'attendee' FROM calendar_primary_calendars p WHERE p.user_id=? AND ${proof} ON CONFLICT(event_id,calendar_id) DO UPDATE SET removed_at=NULL`,
      ).bind(uuid(), event.id, value.user_id),
      change(c, proof, null, "invitation", value.id, value.version, "upsert", value.user_id),
    ]);
}
export async function prepareNewAttendees(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  input: unknown,
  scopeId: string,
  key = "",
  sendUpdates?: unknown,
) {
  const values =
    input === undefined ? [] : await expandAttendeeInputs(c, input, event, scopeId, key);
  const effective = values.length ? await attendanceDetails(c, cal, event, key) : event;
  if (values.some((value) => ["accepted", "tentative"].includes(value.response_status)))
    fail(
      400,
      "RECIPIENT_RESPONSE_REQUIRED",
      t("calendarAttendees.onlyRecipientsCanAcceptAnInvitation"),
    );
  const delivery = await prepareDeliveries(c, cal, effective, values, "invite", key, {
    sendUpdates,
    resend: true,
  });
  return {
    values,
    checks: values.length ? [permission(c.get("identity").user.id, "calendar.events.invite")] : [],
    build: (proof: string, operation: string) => [
      ...values.map((value) => insert(c, "calendar_event_attendees", attendeeValues(value), proof)),
      ...attendeeCopyStatements(c, event, values, proof),
      ...delivery(proof, operation),
    ],
  };
}
const root = "/calendars/:calendarId/events/:eventId";
async function target(c: CalendarContext, edit = false) {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), edit ? 3 : 1),
    event = await requireEvent(c, cal, identifier(c.req.param("eventId")), edit);
  if (!canSeeDetails(event, cal))
    fail(404, "EVENT_NOT_FOUND", t("calendarAttendees.eventNotFound"));
  return { cal, event };
}
const routes = new Hono<AppEnv>();
routes.get(root + "/attendees", async (c) => {
  const { cal, event } = await target(c),
    key = c.req.query("occurrence_key") ?? "";
  const effective = await occurrence(c, event, key);
  if (!canSeeDetails(effective, cal))
    fail(404, "EVENT_NOT_FOUND", t("calendarAttendees.eventNotFound"));
  const list = await effectiveAttendees(c, event.id, key),
    owner = cal.effective_role === "data_owner" || cal.effective_role === "manager",
    guest = JSON.parse(effective.guest_permissions_json);
  return c.json({
    attendees: (owner || guest.can_see_other_guests === true
      ? list
      : list.filter((value) => value.user_id === c.get("identity").user.id)
    ).map((value) => attendeeDto(value, owner || value.user_id === c.get("identity").user.id)),
  });
});
routes.post(root + "/attendees", async (c) => {
  const data = await body(c, ["version", "attendees", "occurrence_key", "send_updates"]),
    { cal, event } = await target(c, true),
    version = expectedVersion(c, data),
    key = data.occurrence_key === undefined ? "" : text(data.occurrence_key, "occurrence_key", 64),
    selected = await scope(c, event, key),
    newAttendees = await prepareNewAttendees(c, cal, event, data.attendees, selected.id, key);
  const effective = await attendanceDetails(c, cal, event, key);
  if (!newAttendees.values.length)
    fail(400, "INVALID_ATTENDEE", t("calendarAttendees.chooseAtLeastOneAttendee"));
  const old = await effectiveAttendees(c, event.id, key);
  if (old.length + newAttendees.values.length > 100)
    fail(422, "TOO_MANY_ATTENDEES", t("calendarAttendees.atMost100AttendeesAreAllowed"));
  if (
    newAttendees.values.some((value) =>
      old.some(
        (old) =>
          old.email_key === value.email_key || (!!value.user_id && old.user_id === value.user_id),
      ),
    )
  )
    fail(409, "ATTENDEE_EXISTS", t("calendarAttendees.anAttendeeIsAlreadyInvited"));
  const notices = await prepareDeliveries(c, cal, effective, newAttendees.values, "invite", key, {
    sendUpdates: data.send_updates,
    resend: true,
  });
  const result = await mutate(c, {
    action: "calendar.events.invite",
    operation: `attendees.add:${event.id}:${key}`,
    idempotent: true,
    request: data,
    result: {
      attendees: newAttendees.values.map((value) => attendeeDto(value, true)),
    },
    calendar: cal.id,
    event: event.id,
    checks: [eventCondition(c, cal, event, version)],
    build: (proof, operation) => [
      ...selected.build(proof),
      ...(key
        ? [
            c.env.DB.prepare(
              `DELETE FROM calendar_attendee_exclusions WHERE event_id=? AND occurrence_key=? AND email_key IN(SELECT value FROM json_each(?)) AND ${proof}`,
            ).bind(
              event.id,
              key,
              JSON.stringify(newAttendees.values.map((value) => value.email_key)),
            ),
          ]
        : []),
      ...newAttendees.values.map((value) =>
        insert(c, "calendar_event_attendees", attendeeValues(value), proof),
      ),
      ...attendeeCopyStatements(c, event, newAttendees.values, proof),
      ...bumpAttendance(c, event, proof, key),
      ...notices(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json(result, 201);
});
routes.patch(root + "/attendees/:attendeeId", async (c) => {
  const data = await body(c, ["version", "optional", "additional_guests", "display_name"]),
    { cal, event } = await target(c, true),
    version = expectedVersion(c, data),
    id = identifier(c.req.param("attendeeId")),
    value = (await allAttendees(c, event.id)).find((value) => value.id === id);
  if (!value) fail(404, "ATTENDEE_NOT_FOUND", t("calendarAttendees.attendeeNotFound"));
  await attendanceDetails(c, cal, event, value.occurrence_key);
  const parsed = await expandAttendeeInputs(
      c,
      [
        {
          ...(value.user_id ? { user_id: value.user_id } : { email_address: value.email_address }),
          optional: "optional" in data ? data.optional : !!value.optional,
          additional_guests: data.additional_guests ?? value.additional_guests,
          display_name: data.display_name ?? value.display_name,
        },
      ],
      event,
      value.scope_id,
      value.occurrence_key,
    ),
    next = {
      ...value,
      optional: parsed[0]!.optional,
      additional_guests: parsed[0]!.additional_guests,
      display_name: parsed[0]!.display_name,
      version: version + 1,
      updated_at: now(),
    },
    checks = await capacityChecks(c, event, next, value.occurrence_key, value.response_status);
  await mutate(c, {
    action: "calendar.events.invite",
    operation: "attendee.update",
    request: data,
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [
      scheduleCondition(c, cal, event),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_attendees WHERE id=? AND version=? AND removed_at IS NULL)",
        id,
        version,
      ),
      ...checks,
    ],
    build: (proof) => [
      update(
        c,
        "calendar_event_attendees",
        {
          optional: next.optional,
          additional_guests: next.additional_guests,
          display_name: next.display_name,
          version: version + 1,
          updated_at: now(),
        },
        "id=?",
        [id],
        proof,
      ),
      ...bumpAttendance(c, event, proof, value.occurrence_key),
    ],
  });
  wakeCalendar(c);
  return c.json({ attendee: attendeeDto(next, true) });
});
routes.delete(root + "/attendees/:attendeeId", async (c) => {
  const { cal, event } = await target(c, true),
    id = identifier(c.req.param("attendeeId")),
    version = expectedVersion(c),
    key = c.req.query("occurrence_key") ?? "",
    value = (await allAttendees(c, event.id)).find((value) => value.id === id);
  if (!value) fail(404, "ATTENDEE_NOT_FOUND", t("calendarAttendees.attendeeNotFound"));
  const effective = await attendanceDetails(c, cal, event, key || value.occurrence_key),
    cancelled = {
      ...effective,
      sequence: event.sequence + 1,
      version: event.version + 1,
      status: "cancelled",
    },
    notices = await prepareDeliveries(
      c,
      cal,
      cancelled,
      [value],
      "cancel",
      key || value.occurrence_key,
      { resend: true },
    ),
    remaining = (await allAttendees(c, event.id)).filter((item) => item.id !== id),
    updates = await prepareDeliveries(
      c,
      cal,
      { ...event, sequence: event.sequence + 1, version: event.version + 1 },
      remaining,
      "update",
      "",
      { resend: true },
    );
  await mutate(c, {
    action: "calendar.events.invite",
    operation: "attendee.remove",
    request: { id, key, version },
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, event.version),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_attendees WHERE id=? AND version=? AND removed_at IS NULL)",
        id,
        version,
      ),
    ],
    build: (proof, operation) => [
      ...(key && value.occurrence_key === ""
        ? [
            insert(
              c,
              "calendar_attendee_exclusions",
              {
                event_id: event.id,
                occurrence_key: key,
                email_key: value.email_key,
              },
              proof,
            ),
          ]
        : [
            update(
              c,
              "calendar_event_attendees",
              { removed_at: now(), version: version + 1, updated_at: now() },
              "id=?",
              [id],
              proof,
            ),
            c.env.DB.prepare(
              `UPDATE calendar_invitation_tokens SET revoked_at=? WHERE attendee_id=? AND ${proof}`,
            ).bind(now(), id),
            c.env.DB.prepare(
              `UPDATE calendar_event_registrations SET status='cancelled',cancelled_at=unixepoch(),version=version+1 WHERE attendee_id=? AND ${proof}`,
            ).bind(id),
            c.env.DB.prepare(
              `UPDATE calendar_registration_manage_tokens SET revoked_at=unixepoch() WHERE registration_id IN(SELECT id FROM calendar_event_registrations WHERE attendee_id=?) AND ${proof}`,
            ).bind(id),
          ]),
      ...bumpAttendance(c, event, proof, key),
      update(c, "calendar_events", { sequence: event.sequence + 1 }, "id=?", [event.id], proof),
      ...notices(proof, operation),
      ...updates(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.body(null, 204);
});
export interface Invitation {
  attendee: Attendee;
  event: Event;
  cal: Calendar;
  auth: Condition;
  actorKey: string;
  user: string | null;
  occurrenceKey?: string;
  registration?: {
    id: string;
    version: number;
    request: Record<string, unknown>;
  };
}
export async function invitation(c: CalendarContext, internal = false): Promise<Invitation> {
  const id = internal ? identifier(c.req.param("attendeeId")) : null,
    token = internal ? null : text(c.req.param("token"), "token", 100);
  if (token && !/^ofci_[A-Za-z0-9_-]{43}$/.test(token))
    fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.invitationNotFound"));
  const hash = token ? await digest(token) : null,
    user = internal ? c.get("identity").user.id : null;
  const attendee = await first<Attendee>(
    c.env,
    `SELECT a.*,s.event_id,s.occurrence_key FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id ${internal ? "" : "JOIN calendar_invitation_tokens t ON t.attendee_id=a.id"} WHERE ${internal ? "a.id=? AND a.user_id=?" : "t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>unixepoch()"}`,
    internal ? id : hash,
    ...(internal ? [user] : []),
  );
  if (!attendee) fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.invitationNotFound"));
  const event = await first<Event>(
      c.env,
      "SELECT * FROM calendar_events WHERE id=?",
      attendee.event_id,
    ),
    cal = event
      ? await first<Calendar>(
          c.env,
          `SELECT cal.* FROM calendars cal JOIN users owner ON owner.id=cal.data_owner_user_id WHERE cal.id=? AND cal.status='active' AND ${active("owner")}`,
          event.organizer_calendar_id,
        )
      : null;
  if (!event || !cal) fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.invitationNotFound"));
  const recipient = attendee.user_id
    ? condition(`EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${active("u")})`, attendee.user_id)
    : condition("1");
  if (!(await first(c.env, `SELECT 1 WHERE ${recipient.sql}`, ...recipient.args)))
    fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.invitationIsUnavailable"));
  const auth = combine(
    recipient,
    internal
      ? combine(
          identity(c, null),
          condition(
            "EXISTS(SELECT 1 FROM calendar_event_attendees WHERE id=? AND user_id=?)",
            attendee.id,
            user,
          ),
        )
      : condition(
          "EXISTS(SELECT 1 FROM calendar_invitation_tokens WHERE token_hash=? AND attendee_id=? AND revoked_at IS NULL AND expires_at>unixepoch())",
          hash,
          attendee.id,
        ),
  );
  return {
    attendee,
    event,
    cal: { ...cal, effective_role: "writer" },
    auth,
    actorKey: internal ? `user:${user}` : `invitation:${attendee.id}`,
    user,
  };
}
export async function respond(
  c: CalendarContext,
  context: Invitation,
  data: Record<string, unknown>,
) {
  const { attendee, event, cal, auth, actorKey, user } = context,
    version = expectedVersion(c, data),
    selected = choice(data.scope ?? (attendee.occurrence_key ? "single" : "all"), "scope", [
      "single",
      "all",
    ]),
    key =
      selected === "single"
        ? text(data.occurrence_key ?? attendee.occurrence_key, "occurrence_key", 64)
        : "";
  if (attendee.occurrence_key && (selected !== "single" || key !== attendee.occurrence_key))
    fail(403, "INVITATION_SCOPE", t("calendarAttendees.thisInvitationCoversOneOccurrenceOnly"));
  await occurrence(c, event, key);
  if (!(await effectiveAttendees(c, event.id, key)).some((value) => value.id === attendee.id))
    fail(
      404,
      "INVITATION_NOT_FOUND",
      t("calendarAttendees.invitationIsNoLongerValidForThisOccurrence"),
    );
  const status = choice(data.response_status, "response_status", [
      "accepted",
      "tentative",
      "declined",
    ]),
    mode = choice(data.attendance_mode ?? attendee.attendance_mode, "attendance_mode", [
      "unspecified",
      "in_person",
      "virtual",
    ]),
    comment = data.comment === undefined ? "" : text(data.comment, "comment", 1000, true),
    checks = await capacityChecks(c, event, attendee, key, status);
  const registration = await first<{ status: string }>(
    c.env,
    "SELECT status FROM calendar_event_registrations WHERE attendee_id=? AND occurrence_key=?",
    attendee.id,
    key,
  );
  if (registration && registration.status !== "confirmed")
    fail(409, "REGISTRATION_NOT_CONFIRMED", t("calendarAttendees.thisRegistrationIsNotConfirmed"));
  for (const check of checks)
    if (!(await first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args)))
      fail(409, "REGISTRATION_FULL", t("calendarAttendees.thisOccurrenceHasReachedCapacity"));
  const promotion = status === "declined" ? await preparePromotion(c, event, cal, key) : null;
  const result = {
    attendee_id: attendee.id,
    version: version + 1,
    response_status: status,
    attendance_mode: mode,
    occurrence_key: key,
    ...(context.registration ? { registration_version: context.registration.version + 1 } : {}),
  };
  let response = result;
  try {
    response = await mutate(c, {
      operation: `attendee.rsvp:${attendee.id}:${key}`,
      idempotent: true,
      principal: { actor_key: actorKey, actor_user_id: user, auth },
      request: context.registration?.request ?? data,
      result,
      calendar: cal.id,
      event: event.id,
      checks: [
        eventAvailable(event.id, event.sequence),
        condition(
          "EXISTS(SELECT 1 FROM calendar_event_attendees WHERE id=? AND version=? AND removed_at IS NULL)",
          attendee.id,
          version,
        ),
        ...checks,
        ...(context.registration
          ? [
              condition(
                "EXISTS(SELECT 1 FROM calendar_event_registrations WHERE id=? AND version=? AND status='confirmed')",
                context.registration.id,
                context.registration.version,
              ),
            ]
          : []),
      ],
      build: (proof, operation) => [
        ...(key
          ? [
              c.env.DB.prepare(
                `INSERT INTO calendar_attendee_occurrence_responses(attendee_id,occurrence_key,response_status,attendance_mode,comment) SELECT ?,?,?,?,? WHERE ${proof} ON CONFLICT(attendee_id,occurrence_key) DO UPDATE SET response_status=excluded.response_status,attendance_mode=excluded.attendance_mode,comment=excluded.comment,responded_at=unixepoch()`,
              ).bind(attendee.id, key, status, mode, comment),
            ]
          : []),
        update(
          c,
          "calendar_event_attendees",
          {
            ...(key
              ? {}
              : {
                  response_status: status,
                  attendance_mode: mode,
                  response_comment: comment,
                  responded_at: now(),
                }),
            version: version + 1,
            updated_at: now(),
          },
          "id=?",
          [attendee.id],
          proof,
        ),
        ...bumpAttendance(c, event, proof, key),
        c.env.DB.prepare(
          `UPDATE calendar_event_registrations SET requested_response=CASE WHEN ?='declined' THEN requested_response ELSE ? END,requested_attendance_mode=?,version=version+1,updated_at=unixepoch() WHERE attendee_id=? AND status='confirmed' ${key ? "AND occurrence_key=?" : ""} AND ${proof}`,
        ).bind(status, status, mode, attendee.id, ...(key ? [key] : [])),
        ...(promotion ? promotion(proof, operation) : []),
        ...(event.organizer_user_id && event.organizer_user_id !== user
          ? notificationStatements(
              c,
              proof,
              `calendar:response:${operation}`,
              event.organizer_user_id,
              "response",
              null,
            )
          : []),
      ],
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 412) {
      for (const check of checks)
        if (!(await first(c.env, `SELECT 1 WHERE ${check.sql}`, ...check.args)))
          fail(409, "REGISTRATION_FULL", t("calendarAttendees.thisOccurrenceHasReachedCapacity"));
    }
    throw error;
  }
  wakeCalendar(c);
  return response;
}
export async function invitationDto(c: CalendarContext, context: Invitation) {
  const { attendee, event, cal } = context;
  const key = context.occurrenceKey ?? attendee.occurrence_key;
  if (attendee.removed_at || event.trashed_at || event.status === "cancelled" || cal.trashed_at)
    return {
      attendee: { id: attendee.id, version: attendee.version },
      event: { id: event.id, status: "cancelled" },
      is_revoked: true,
    };
  let effective: Event;
  try {
    effective = await occurrence(c, event, key);
  } catch (error) {
    if (error instanceof Error && "status" in error && [404, 409].includes(Number(error.status)))
      return {
        attendee: { id: attendee.id, version: attendee.version },
        event: { id: event.id, status: "cancelled" },
        is_revoked: true,
      };
    throw error;
  }
  const others = await effectiveAttendees(c, event.id, key);
  const own = others.find((value) => value.id === attendee.id);
  if (!own)
    return {
      attendee: { id: attendee.id, version: attendee.version },
      event: { id: event.id, status: "cancelled" },
      is_revoked: true,
    };
  return {
    attendee: attendeeDto(own, true),
    event: eventDto(effective, cal),
    attendees: (JSON.parse(event.guest_permissions_json).can_see_other_guests === true
      ? others
      : others.filter((value) => value.id === attendee.id)
    ).map((value) => attendeeDto(value, value.id === attendee.id)),
    is_revoked: false,
    attachments: await readableAttachments(c, effective, key),
  };
}
export const ownInvitations = new Hono<AppEnv>();
ownInvitations.get("/inbox-invitations", async (c) =>
  c.json({
    invitations: await rows(
      c.env,
      "SELECT a.id,s.event_id,s.occurrence_key,a.response_status,a.version FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE a.user_id=? AND a.removed_at IS NULL ORDER BY a.created_at DESC,a.id LIMIT 100",
      c.get("identity").user.id,
    ),
  }),
);
ownInvitations.get("/inbox-invitations/:attendeeId", async (c) =>
  c.json(await invitationDto(c, await invitation(c, true))),
);
ownInvitations.post("/inbox-invitations/:attendeeId/rsvp", async (c) =>
  c.json(
    await respond(
      c,
      await invitation(c, true),
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
ownInvitations.get("/inbox-invitations/:attendeeId/event.ics", async (c) => {
  const own = await invitation(c, true);
  if (
    own.attendee.removed_at ||
    own.event.trashed_at ||
    own.event.status === "cancelled" ||
    own.cal.trashed_at
  )
    fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.invitationIsUnavailable"));
  const event = await occurrence(c, own.event, own.attendee.occurrence_key);
  return c.body(
    calendarFile({
      kind: "invitation",
      action: "invite",
      event,
      attendee: (await effectiveAttendees(c, own.event.id, own.attendee.occurrence_key)).find(
        (value) => value.id === own.attendee.id,
      )!,
      occurrence_key: own.attendee.occurrence_key,
    }),
    200,
    {
      "Content-Type": "text/calendar; charset=UTF-8; method=REQUEST",
      "Content-Disposition": 'attachment; filename="invite.ics"',
    },
  );
});
routes.post(root + "/rsvp", async (c) => {
  const { event } = await target(c),
    data = await body(c, [
      "version",
      "response_status",
      "attendance_mode",
      "comment",
      "scope",
      "occurrence_key",
    ]),
    mine = (await effectiveAttendees(c, event.id, String(data.occurrence_key ?? ""))).find(
      (value) => value.user_id === c.get("identity").user.id,
    );
  if (!mine) fail(404, "INVITATION_NOT_FOUND", t("calendarAttendees.yourInvitationWasNotFound"));
  c.req.param;
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")));
  return c.json(
    await respond(
      c,
      {
        attendee: mine,
        event,
        cal,
        auth: identity(c, null),
        actorKey: `user:${c.get("identity").user.id}`,
        user: c.get("identity").user.id,
      },
      data,
    ),
  );
});
routes.get(root + "/invitation-deliveries", async (c) => {
  const { cal, event } = await target(c, true);
  if (!["manager", "data_owner"].includes(cal.effective_role))
    fail(404, "EVENT_NOT_FOUND", t("calendarAttendees.eventNotFound"));
  return c.json({
    deliveries: await rows(
      c.env,
      "SELECT id,attendee_id,occurrence_key,action,channel,status,recipient_user_id,recipient_email,provider_message_id,error_code,accepted_at,delivered_at,retry_at,created_at FROM calendar_invitation_deliveries WHERE event_id=? ORDER BY created_at DESC,id LIMIT ?",
      event.id,
      pageLimit(c),
    ),
  });
});
routes.post(root + "/invitations/resend", async (c) => {
  const data = await body(c, ["version", "attendee_ids", "occurrence_key"]),
    { cal, event } = await target(c, true),
    version = expectedVersion(c, data),
    key = String(data.occurrence_key ?? ""),
    values = await effectiveAttendees(c, event.id, key),
    ids = data.attendee_ids;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some(
        (value) => typeof value !== "string" || !values.some((attendee) => attendee.id === value),
      ))
  )
    fail(400, "INVALID_INPUT", t("calendarAttendees.invalidAttendees"));
  const selected =
    ids === undefined ? values : values.filter((value) => (ids as string[]).includes(value.id));
  if (
    await first(
      c.env,
      "SELECT 1 FROM calendar_invitation_deliveries WHERE attendee_id IN(SELECT value FROM json_each(?)) AND status='unknown' LIMIT 1",
      JSON.stringify(selected.map((value) => value.id)),
    )
  )
    fail(
      409,
      "DELIVERY_ACCEPTANCE_UNKNOWN",
      t("calendarAttendees.resolveUnknownProviderAcceptanceBeforeResending"),
    );
  const effective = await occurrence(c, event, key),
    notices = await prepareDeliveries(c, cal, effective, selected, "invite", key, { resend: true });
  await mutate(c, {
    action: "calendar.events.invite",
    operation: `invitation.resend:${event.id}:${key}`,
    idempotent: true,
    request: data,
    result: { queued: true },
    calendar: cal.id,
    event: event.id,
    checks: [eventCondition(c, cal, event, version)],
    build: (proof, operation) => notices(proof, operation),
  });
  wakeCalendar(c);
  return c.json({ queued: true });
});
export default routes;

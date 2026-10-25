import { uuid, now } from "../auth/types";
import type {
  CalendarContext,
  Event,
  Calendar,
  Bind,
  Condition,
} from "./types";
import type { Attendee, Policy } from "./collaboration-types";
import {
  condition,
  first,
  rows,
  calendarCondition,
  active,
  identity,
  combine,
} from "./access";
import {
  choice,
  fail,
  flag,
  identifier,
  integer,
  object,
  fields,
  text,
} from "./input";
import { insert, update, change } from "./mutations";
import { applyOverride, originalOccurrence, keyOf } from "./recurrence";
import { loadOverrides } from "./event-data";
import { canSeeDetails } from "./access";
import { recipientUser } from "./recipients";
export async function attendanceDetails(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  key = "",
) {
  const effective = await occurrence(c, event, key);
  if (!canSeeDetails(effective, cal))
    fail(404, "EVENT_NOT_FOUND", "Event not found");
  if (!key)
    for (const value of await loadOverrides(c, [event.id]))
      if (!canSeeDetails({ ...event, ...JSON.parse(value.patch_json) }, cal))
        fail(404, "EVENT_NOT_FOUND", "Event not found");
  return effective;
}
export const email = (value: unknown) => {
  const result = text(value, "email_address", 254).trim().toLowerCase();
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(
      result,
    ) ||
    /[\r\n]/.test(result)
  )
    fail(400, "INVALID_EMAIL", "Invalid email address");
  return result;
};
export async function occurrence(c: CalendarContext, event: Event, key = "") {
  if (!key) return event;
  const original = originalOccurrence(event, key),
    override = (await loadOverrides(c, [event.id])).find(
      (value) => value.occurrence_key === key,
    ),
    effective = applyOverride(event, original, override);
  if (effective.status === "cancelled" || event.trashed_at)
    fail(409, "OCCURRENCE_CANCELLED", "Occurrence is cancelled");
  return effective;
}
export function registrationKey(event: Event, key: unknown) {
  if (event.recurrence_json === "[]") {
    if (key !== undefined && key !== null && key !== "" && key !== keyOf(event))
      fail(400, "INVALID_SCOPE", "This event has no recurring scope");
    return "";
  }
  return text(key, "occurrence_key", 64);
}
export async function scope(c: CalendarContext, event: Event, key = "") {
  if (key) await occurrence(c, event, key);
  const existing = await first<{ id: string }>(
    c.env,
    "SELECT id FROM calendar_event_scopes WHERE event_id=? AND occurrence_key=?",
    event.id,
    key,
  );
  const id = existing?.id ?? uuid();
  return {
    id,
    check: existing
      ? condition(
          "EXISTS(SELECT 1 FROM calendar_event_scopes WHERE id=? AND event_id=? AND occurrence_key=?)",
          id,
          event.id,
          key,
        )
      : condition(
          "NOT EXISTS(SELECT 1 FROM calendar_event_scopes WHERE event_id=? AND occurrence_key=?)",
          event.id,
          key,
        ),
    build: (proof: string) =>
      existing
        ? []
        : [
            insert(
              c,
              "calendar_event_scopes",
              { id, event_id: event.id, occurrence_key: key },
              proof,
            ),
          ],
  };
}
export const allAttendees = (c: CalendarContext, event: string) =>
  rows<Attendee>(
    c.env,
    "SELECT a.*,s.event_id,s.occurrence_key FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=? AND a.removed_at IS NULL ORDER BY a.id",
    event,
  );
export async function effectiveAttendees(
  c: CalendarContext,
  event: string,
  key = "",
) {
  const values = (await allAttendees(c, event)).filter(
    (value) => value.occurrence_key === "" || value.occurrence_key === key,
  );
  const result = new Map<string, Attendee>();
  values.sort((a, b) => a.occurrence_key.length - b.occurrence_key.length);
  for (const value of values) result.set(value.email_key, value);
  if (key) {
    const excluded = await rows<{ email_key: string }>(
      c.env,
      "SELECT email_key FROM calendar_attendee_exclusions WHERE event_id=? AND occurrence_key=?",
      event,
      key,
    );
    for (const value of excluded) result.delete(value.email_key);
    const responses = await rows<{
      attendee_id: string;
      response_status: Attendee["response_status"];
      attendance_mode: Attendee["attendance_mode"];
      comment: string;
      responded_at: number;
    }>(
      c.env,
      "SELECT * FROM calendar_attendee_occurrence_responses WHERE occurrence_key=? AND attendee_id IN(SELECT value FROM json_each(?))",
      key,
      JSON.stringify([...result.values()].map((value) => value.id)),
    );
    for (const response of responses) {
      const value = [...result.values()].find(
        (value) => value.id === response.attendee_id,
      );
      if (value) {
        value.response_status = response.response_status;
        value.attendance_mode = response.attendance_mode;
        value.response_comment = response.comment;
        value.responded_at = response.responded_at;
      }
    }
  }
  return [...result.values()];
}
export async function attendeeStates(
  c: CalendarContext,
  events: string[],
  user: string,
) {
  const lookup = await attendeeStatesForUsers(c, events, [user]);
  return (event: string, key: string) => lookup(user, event, key);
}
export async function attendeeStatesForUsers(
  c: CalendarContext,
  events: string[],
  users: string[],
) {
  const [attendees, excluded] = await Promise.all([rows<Attendee>(
      c.env,
      "SELECT a.*,s.event_id,s.occurrence_key FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id IN(SELECT value FROM json_each(?)) AND a.user_id IN(SELECT value FROM json_each(?)) AND a.removed_at IS NULL",
      JSON.stringify(events),
      JSON.stringify(users),
    ),
    rows<{
      event_id: string;
      occurrence_key: string;
      email_key: string;
    }>(
      c.env,
      "SELECT * FROM calendar_attendee_exclusions WHERE event_id IN(SELECT value FROM json_each(?))",
      JSON.stringify(events),
    )]);
  const responses = await rows<{
      attendee_id: string;
      occurrence_key: string;
      response_status: Attendee["response_status"];
      attendance_mode: Attendee["attendance_mode"];
    }>(
      c.env,
      "SELECT * FROM calendar_attendee_occurrence_responses WHERE attendee_id IN(SELECT value FROM json_each(?))",
      JSON.stringify(attendees.map((value) => value.id)),
    );
  const members = new Map(
      attendees.map((value) => [
        `${value.user_id}:${value.event_id}:${value.occurrence_key}`,
        value,
      ]),
    ),
    blocks = new Set(
      excluded.map(
        (value) =>
          `${value.event_id}:${value.occurrence_key}:${value.email_key}`,
      ),
    ),
    answers = new Map(
      responses.map((value) => [
        `${value.attendee_id}:${value.occurrence_key}`,
        value,
      ]),
    );
  return (user: string, event: string, key: string) => {
    const value = members.get(`${user}:${event}:${key}`) ?? members.get(`${user}:${event}:`);
    if (!value || blocks.has(`${event}:${key}:${value.email_key}`)) return null;
    const response = answers.get(`${value.id}:${key}`);
    return response
      ? {
          ...value,
          response_status: response.response_status,
          attendance_mode: response.attendance_mode,
        }
      : value;
  };
}
export const attendeeValues = (value: Attendee) => {
  const { event_id, occurrence_key, ...columns } = value;
  return columns as unknown as Record<string, Bind>;
};
export async function parseAttendee(
  c: CalendarContext,
  value: unknown,
  event: Event,
  scopeId: string,
  key = "",
): Promise<Attendee> {
  const data = object(value, "attendee");
  fields(data, [
    "user_id",
    "email_address",
    "display_name",
    "optional",
    "additional_guests",
    "response_status",
    "attendance_mode",
  ]);
  if (data.user_id !== undefined && data.email_address !== undefined)
    fail(400, "INVALID_INPUT", "Use user_id or email_address");
  const resolved =
    data.user_id === undefined
      ? await recipientUser(c.env, email(data.email_address))
      : null;
  if (resolved?.ambiguous)
    fail(
      400,
      "AMBIGUOUS_ATTENDEE",
      "Choose the internal user ID for this address",
    );
  const user =
    data.user_id !== undefined
      ? await first<{
          id: string;
          email_address: string;
          display_name: string | null;
        }>(
          c.env,
          "SELECT id,email_address,display_name FROM users WHERE id=?",
          identifier(data.user_id),
        )
      : (resolved?.user ?? null);
  if (data.user_id !== undefined && !user)
    fail(400, "INVALID_ATTENDEE", "Unknown internal user");
  const address =
      data.email_address === undefined
        ? user!.email_address
        : email(data.email_address),
    stamp = now();
  return {
    id: uuid(),
    scope_id: scopeId,
    event_id: event.id,
    occurrence_key: key,
    principal_type: user ? "user" : "external",
    user_id: user?.id ?? null,
    email_address: address,
    email_key: address.toLowerCase(),
    display_name:
      data.display_name === undefined
        ? (user?.display_name ?? "")
        : text(data.display_name, "display_name", 255, true),
    optional: data.optional === undefined ? 0 : flag(data.optional, "optional"),
    additional_guests:
      data.additional_guests === undefined
        ? 0
        : integer(data.additional_guests, "additional_guests", 0, 20),
    response_status:
      data.response_status === undefined
        ? "needs_action"
        : choice(data.response_status, "response_status", [
            "needs_action",
            "accepted",
            "tentative",
            "declined",
          ]),
    attendance_mode:
      data.attendance_mode === undefined
        ? "unspecified"
        : choice(data.attendance_mode, "attendance_mode", [
            "unspecified",
            "in_person",
            "virtual",
          ]),
    response_comment: "",
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    responded_at: null,
    removed_at: null,
  };
}
export async function expandAttendeeInputs(
  c: CalendarContext,
  value: unknown,
  event: Event,
  scopeId: string,
  key = "",
) {
  if (!Array.isArray(value) || value.length > 50)
    fail(400, "INVALID_INPUT", "At most 50 invitation entries are allowed");
  const inputs: unknown[] = [];
  for (const item of value) {
    const data = object(item, "attendee");
    if ("group_id" in data) {
      fields(data, ["group_id", "optional"]);
      const id = identifier(data.group_id),
        user = c.get("identity").user.id;
      if (
        !(await first(
          c.env,
          "SELECT 1 FROM calendar_groups g WHERE id=? AND deleted_at IS NULL AND (owner_user_id=? OR EXISTS(SELECT 1 FROM calendar_group_members m WHERE m.group_id=g.id AND m.user_id=?))",
          id,
          user,
          user,
        ))
      )
        fail(404, "GROUP_NOT_FOUND", "Group not found");
      const members = await rows<{ user_id: string }>(
        c.env,
        `SELECT gm.user_id FROM calendar_group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND ${active("u")}`,
        id,
      );
      for (const member of members)
        inputs.push({
          ...member,
          ...("optional" in data ? { optional: data.optional } : {}),
        });
    } else inputs.push(item);
  }
  if (inputs.length > 100)
    fail(422, "TOO_MANY_ATTENDEES", "At most 100 attendees are allowed");
  const result = new Map<string, Attendee>();
  for (const input of inputs) {
    const value = await parseAttendee(c, input, event, scopeId, key);
    result.set(
      value.user_id ? `user:${value.user_id}` : `email:${value.email_key}`,
      value,
    );
  }
  return [...result.values()];
}
export const scheduleCondition = (
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  min = 3,
) =>
  combine(
    calendarCondition(c, cal, min),
    condition(
      "EXISTS(SELECT 1 FROM calendar_events WHERE id=? AND organizer_calendar_id=? AND sequence=? AND status<>'cancelled' AND trashed_at IS NULL)",
      event.id,
      cal.id,
      event.sequence,
    ),
  );
export function eventAvailable(event: string, sequence?: number) {
  return condition(
    `EXISTS(SELECT 1 FROM calendar_events e JOIN calendars cal ON cal.id=e.organizer_calendar_id JOIN users owner ON owner.id=cal.data_owner_user_id WHERE e.id=? AND e.status<>'cancelled' AND e.trashed_at IS NULL AND cal.status='active' AND cal.trashed_at IS NULL AND ${active("owner")} ${sequence === undefined ? "" : "AND e.sequence=?"})`,
    event,
    ...(sequence === undefined ? [] : [sequence]),
  );
}
export function attendeeDto(value: Attendee, own = false) {
  const {
    scope_id,
    email_key,
    event_id,
    occurrence_key,
    removed_at,
    response_comment,
    ...rest
  } = value;
  return {
    ...rest,
    optional: !!value.optional,
    ...(own ? { response_comment, event_id, occurrence_key } : {}),
  };
}
export async function policy(
  c: CalendarContext,
  event: string,
  key = "",
): Promise<Policy> {
  return (
    (await first<Policy>(
      c.env,
      "SELECT * FROM calendar_registration_policies WHERE event_id=? AND occurrence_key IN(?,'') ORDER BY length(occurrence_key) DESC LIMIT 1",
      event,
      key,
    )) ?? {
      id: "",
      event_id: event,
      occurrence_key: "",
      approval_mode: "automatic",
      capacity: null,
      waitlist_enabled: 1,
      additional_guests_limit: 0,
      registration_opens_at: null,
      registration_closes_at: null,
      allowed_email_domains_json: "[]",
      form_schema_json: "[]",
      status: "open",
      version: 0,
    }
  );
}
export function policyCondition(value: Policy) {
  return value.id
    ? condition(
        "EXISTS(SELECT 1 FROM calendar_registration_policies WHERE id=? AND version=?)",
        value.id,
        value.version,
      )
    : condition(
        "NOT EXISTS(SELECT 1 FROM calendar_registration_policies WHERE event_id=? AND occurrence_key IN(?,''))",
        value.event_id,
        value.occurrence_key,
      );
}
// Counts effective guest records, including series responses and per-occurrence overrides.
export function capacityCondition(
  event: string,
  key: string,
  emailKey: string,
  guests: number,
  capacity: number | null,
): Condition {
  if (capacity === null) return condition("1");
  return condition(
    `COALESCE((SELECT SUM(1+a.additional_guests) FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=? AND s.occurrence_key IN('',?) AND a.removed_at IS NULL AND a.email_key<>?
 AND (a.user_id IS NULL OR a.user_id<>(SELECT organizer_user_id FROM calendar_events WHERE id=s.event_id))
 AND (s.occurrence_key=? OR NOT EXISTS(SELECT 1 FROM calendar_event_attendees x JOIN calendar_event_scopes xs ON xs.id=x.scope_id WHERE xs.event_id=s.event_id AND xs.occurrence_key=? AND x.email_key=a.email_key AND x.removed_at IS NULL))
 AND NOT EXISTS(SELECT 1 FROM calendar_attendee_exclusions ex WHERE ex.event_id=s.event_id AND ex.occurrence_key=? AND ex.email_key=a.email_key)
 AND COALESCE((SELECT response_status FROM calendar_attendee_occurrence_responses r WHERE r.attendee_id=a.id AND r.occurrence_key=?),a.response_status) IN('accepted','tentative')),0)+?<=?`,
    event,
    key,
    emailKey,
    key,
    key,
    key,
    key,
    1 + guests,
    capacity,
  );
}
export async function capacityChecks(
  c: CalendarContext,
  event: Event,
  attendee: Attendee,
  key: string,
  status: string,
) {
  if (!["accepted", "tentative"].includes(status)) return [];
  if (attendee.user_id === event.organizer_user_id) return [];
  if (!key) {
    const cap = capacityCondition(
      event.id,
      "__scope_key__",
      attendee.email_key,
      attendee.additional_guests,
      0,
    );
    let index = 0;
    const sql = cap.sql.replace(/\?/g, () => {
      const current = index++,
        value = cap.args[current];
      if (current === cap.args.length - 1) return "p.capacity";
      if (value === "__scope_key__") return "k.occurrence_key";
      return typeof value === "number"
        ? String(value)
        : `'${String(value).replaceAll("'", "''")}'`;
    });
    return [
      condition(
        `NOT EXISTS(WITH keys(occurrence_key) AS (SELECT '' UNION SELECT occurrence_key FROM calendar_event_scopes WHERE event_id=? UNION SELECT occurrence_key FROM calendar_registration_instances WHERE event_id=?) SELECT 1 FROM keys k JOIN calendar_registration_policies p ON p.id=(SELECT id FROM calendar_registration_policies WHERE event_id=? AND occurrence_key IN('',k.occurrence_key) ORDER BY length(occurrence_key) DESC LIMIT 1) WHERE p.capacity IS NOT NULL AND NOT (${sql}) AND NOT EXISTS(SELECT 1 FROM calendar_attendee_occurrence_responses r WHERE r.attendee_id=? AND r.occurrence_key=k.occurrence_key AND r.response_status IN('declined','needs_action')) AND NOT EXISTS(SELECT 1 FROM calendar_event_attendees a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=? AND s.occurrence_key=k.occurrence_key AND s.occurrence_key<>'' AND a.email_key=? AND a.removed_at IS NULL))`,
        event.id,
        event.id,
        event.id,
        attendee.id,
        event.id,
        attendee.email_key,
      ),
    ];
  }
  const keys = key
    ? [key]
    : [
        ...new Set([
          "",
          ...(
            await rows<{ occurrence_key: string }>(
              c.env,
              "SELECT occurrence_key FROM calendar_event_scopes WHERE event_id=? UNION SELECT occurrence_key FROM calendar_registration_instances WHERE event_id=?",
              event.id,
              event.id,
            )
          ).map((value) => value.occurrence_key),
        ]),
      ];
  if (keys.length > 500)
    fail(422, "TOO_MANY_SCOPES", "Respond to individual occurrences instead");
  const checks: Condition[] = [];
  for (const item of keys) {
    const p = await policy(c, event.id, item);
    checks.push(
      policyCondition(p),
      capacityCondition(
        event.id,
        item,
        attendee.email_key,
        attendee.additional_guests,
        p.capacity,
      ),
    );
  }
  return checks;
}
export function bumpAttendance(
  c: CalendarContext,
  event: Event,
  proof: string,
  key = "",
) {
  return [
    c.env.DB.prepare(
      `UPDATE calendar_events SET version=version+1,updated_at=? WHERE id=? AND ${proof}`,
    ).bind(now(), event.id),
    c.env.DB.prepare(
      `INSERT INTO calendar_registration_instances(event_id,occurrence_key,revision) SELECT ?,?,1 WHERE ${proof} ON CONFLICT(event_id,occurrence_key) DO UPDATE SET revision=revision+1`,
    ).bind(event.id, key),
    c.env.DB.prepare(
      `INSERT INTO calendar_changes(calendar_id,resource_type,resource_id,occurrence_key,operation,version) SELECT organizer_calendar_id,'event',id,?,'upsert',version FROM calendar_events WHERE id=? AND ${proof}`,
    ).bind(key, event.id),
  ];
}

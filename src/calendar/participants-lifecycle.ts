import { uuid, now } from "../auth/types";
import type { Calendar, CalendarContext, Event, Override, Bind } from "./types";
import type { Attendee, Policy } from "./collaboration-types";
import { first, rows } from "./access";
import { insert, update } from "./mutations";
import {
  allAttendees,
  attendeeValues,
  effectiveAttendees,
  policy,
} from "./attendance-store";
import { attendeeCopyStatements } from "./attendees";
import { prepareDeliveries } from "./delivery";
import { applyOverride, originalOccurrence } from "./recurrence";
export async function participatingScopes(
  c: CalendarContext,
  event: Event,
  overrides: Override[],
) {
  const scopes = await rows<{ id: string; occurrence_key: string }>(
    c.env,
    "SELECT s.id,s.occurrence_key FROM calendar_event_scopes s WHERE s.event_id=? AND s.occurrence_key<>'' AND (EXISTS(SELECT 1 FROM calendar_event_attendees a WHERE a.scope_id=s.id AND a.removed_at IS NULL) OR EXISTS(SELECT 1 FROM calendar_event_registrations r WHERE r.event_id=s.event_id AND r.occurrence_key=s.occurrence_key AND r.status IN('confirmed','pending','waitlisted'))) ORDER BY s.occurrence_key",
    event.id,
  );
  const result = [...overrides];
  for (const value of scopes)
    if (!result.some((override) => override.scope_id === value.id)) {
      const times = originalOccurrence(event, value.occurrence_key);
      result.push({
        scope_id: value.id,
        event_id: event.id,
        occurrence_key: value.occurrence_key,
        cancelled: 0,
        patch_json: "{}",
        effective_start_at: times.start_at,
        effective_end_at: times.end_at,
        effective_start_date: times.start_date,
        effective_end_date: times.end_date,
        version: 1,
        created_at: now(),
        updated_at: now(),
      });
    }
  return result;
}
export async function detachParticipants(
  c: CalendarContext,
  cal: Calendar,
  source: Event,
  destination: Event,
  key: string,
  scopeId: string,
  sourceSequence: number,
) {
  const members = await effectiveAttendees(c, source.id, key),
    clones = members.map((value) => ({
      ...value,
      id: value.scope_id === scopeId ? value.id : uuid(),
      scope_id: scopeId,
      event_id: destination.id,
      occurrence_key: "",
      version: value.scope_id === scopeId ? value.version : 1,
    })),
    p = await policy(c, source.id, key);
  const oldNotices = await prepareDeliveries(
    c,
    cal,
    {
      ...applyOverride(source, originalOccurrence(source, key)),
      sequence: sourceSequence,
      status: "cancelled",
    },
    members,
    "cancel",
    key,
    { resend: true },
  );
  const notices = await prepareDeliveries(
    c,
    cal,
    destination,
    clones,
    "invite",
    "",
    { resend: true },
  );
  return (proof: string, operation: string) => [
    ...clones.flatMap((value, index) =>
      members[index]!.scope_id === scopeId
        ? []
        : [insert(c, "calendar_event_attendees", attendeeValues(value), proof)],
    ),
    ...attendeeCopyStatements(c, destination, clones, proof),
    c.env.DB.prepare(
      `UPDATE calendar_event_registrations SET event_id=?,occurrence_key='',attendee_id=COALESCE((SELECT a.id FROM calendar_event_attendees a WHERE a.scope_id=? AND a.email_key=calendar_event_registrations.email_key AND a.removed_at IS NULL),attendee_id),version=version+1 WHERE event_id=? AND occurrence_key=? AND ${proof}`,
    ).bind(destination.id, scopeId, source.id, key),
    ...(p.id
      ? [
          insert(
            c,
            "calendar_registration_policies",
            {
              ...p,
              id: uuid(),
              event_id: destination.id,
              occurrence_key: "",
              version: 1,
            } as unknown as Record<string, Bind>,
            proof,
          ),
        ]
      : []),
    c.env.DB.prepare(
      `UPDATE calendar_registration_instances SET event_id=?,occurrence_key='' WHERE event_id=? AND occurrence_key=? AND ${proof}`,
    ).bind(destination.id, source.id, key),
    c.env.DB.prepare(
      `UPDATE calendar_share_links SET revoked_at=unixepoch(),access_version=access_version+1,version=version+1 WHERE event_id=? AND occurrence_key=? AND ${proof}`,
    ).bind(source.id, key),
    c.env.DB.prepare(
      `UPDATE calendar_invitation_tokens SET revoked_at=unixepoch() WHERE attendee_id IN(SELECT id FROM calendar_event_attendees WHERE scope_id=?) AND ${proof}`,
    ).bind(scopeId),
    ...oldNotices(proof, operation),
    ...notices(proof, operation),
  ];
}
export async function splitParticipants(
  c: CalendarContext,
  cal: Calendar,
  source: Event,
  previous: Event,
  next: Event,
  boundary: string,
  baseScopeId: string,
) {
  const sourceMembers = await allAttendees(c, source.id),
    base = sourceMembers.filter((value) => !value.occurrence_key),
    clones = base.map((value) => ({
      ...value,
      id: uuid(),
      scope_id: baseScopeId,
      event_id: next.id,
      version: 1,
      created_at: now(),
      updated_at: now(),
    })),
    scoped = sourceMembers.filter((value) => value.occurrence_key >= boundary),
    matching = async () => {
      const result: Attendee[] = [];
      for (const value of scoped) {
        try {
          originalOccurrence(next, value.occurrence_key);
          result.push({ ...value, event_id: next.id });
        } catch {}
      }
      return result;
    },
    future = await matching(),
    overrides = (
      await rows<Override>(
        c.env,
        "SELECT o.*,s.event_id,s.occurrence_key FROM calendar_event_overrides o JOIN calendar_event_scopes s ON s.id=o.scope_id WHERE s.event_id=? AND s.occurrence_key>=?",
        source.id,
        boundary,
      )
    ).filter((value) => {
      try {
        originalOccurrence(next, value.occurrence_key);
        return true;
      } catch {
        return false;
      }
    });
  const newNotices = await prepareDeliveries(
      c,
      cal,
      next,
      [...clones, ...future],
      "invite",
      "",
      { resend: true, overrides },
    ),
    oldNotices = await prepareDeliveries(
      c,
      cal,
      previous,
      sourceMembers.filter((value) => value.occurrence_key < boundary),
      previous.trashed_at ? "cancel" : "update",
      "",
      { resend: true },
    );
  const policies = await rows<Policy>(
    c.env,
    "SELECT * FROM calendar_registration_policies WHERE event_id=? AND occurrence_key=''",
    source.id,
  );
  const keys = await rows<{ occurrence_key: string }>(
      c.env,
      "SELECT occurrence_key FROM calendar_registration_instances WHERE event_id=? AND occurrence_key>=? UNION SELECT occurrence_key FROM calendar_registration_policies WHERE event_id=? AND occurrence_key>=? UNION SELECT occurrence_key FROM calendar_event_scopes WHERE event_id=? AND occurrence_key>=?",
      source.id,
      boundary,
      source.id,
      boundary,
      source.id,
      boundary,
    ),
    matchingKeys = keys
      .filter((value) => {
        try {
          originalOccurrence(next, value.occurrence_key);
          return true;
        } catch {
          return false;
        }
      })
      .map((value) => value.occurrence_key);
  return (proof: string, operation: string) => [
    ...clones.map((value) =>
      insert(c, "calendar_event_attendees", attendeeValues(value), proof),
    ),
    ...attendeeCopyStatements(c, next, [...clones, ...future], proof),
    ...policies.map((value) =>
      insert(
        c,
        "calendar_registration_policies",
        {
          ...value,
          id: uuid(),
          event_id: next.id,
          version: 1,
        } as unknown as Record<string, Bind>,
        proof,
      ),
    ),
    ...[
      "calendar_event_registrations",
      "calendar_registration_instances",
      "calendar_registration_policies",
      "calendar_attendee_exclusions",
    ].map((table) =>
      c.env.DB.prepare(
        `UPDATE ${table} SET event_id=? WHERE event_id=? AND occurrence_key IN(SELECT value FROM json_each(?)) AND ${proof}`,
      ).bind(next.id, source.id, JSON.stringify(matchingKeys)),
    ),
    ...clones.flatMap((value, index) => [
      c.env.DB.prepare(
        `UPDATE calendar_event_registrations SET attendee_id=? WHERE event_id=? AND attendee_id=? AND ${proof}`,
      ).bind(value.id, next.id, base[index]!.id),
      c.env.DB.prepare(
        `UPDATE calendar_attendee_occurrence_responses SET attendee_id=? WHERE attendee_id=? AND occurrence_key IN(SELECT value FROM json_each(?)) AND ${proof}`,
      ).bind(value.id, base[index]!.id, JSON.stringify(matchingKeys)),
    ]),
    c.env.DB.prepare(
      `UPDATE calendar_share_links SET revoked_at=unixepoch(),version=version+1,access_version=access_version+1 WHERE event_id=? AND occurrence_key>=? AND ${proof}`,
    ).bind(source.id, boundary),
    ...oldNotices(proof, operation),
    ...newNotices(proof, operation),
  ];
}

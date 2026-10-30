import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { now, uuid, type AppEnv } from "../auth/types";
import type { CalendarContext, Event } from "./types";
import { body, choice, expectedVersion, fail, identifier, integer, text } from "./input";
import { condition, eventCondition, first, requireCalendar, requireEvent, rows } from "./access";
import { invitation, type Invitation } from "./attendees";
import {
  allAttendees,
  effectiveAttendees,
  attendanceDetails,
  eventAvailable,
  occurrence,
} from "./attendance-store";
import { writeEvent } from "./event-data";
import { insert, mutate, update, change } from "./mutations";
import { notificationStatements, prepareDeliveries } from "./delivery";
import { setOverride } from "./events";
import { keyOf } from "./recurrence";
import { wakeCalendar } from "./jobs";
interface Proposal {
  id: string;
  event_id: string;
  attendee_id: string;
  occurrence_key: string;
  start_json: string;
  end_json: string;
  comment: string;
  status: string;
  version: number;
  resolved_by: string | null;
  created_at: number;
}
export async function propose(
  c: CalendarContext,
  context: Invitation,
  data: Record<string, unknown>,
) {
  const { event, cal, attendee, auth, actorKey, user } = context,
    key =
      attendee.occurrence_key ||
      (event.recurrence_json === "[]" ? "" : text(data.occurrence_key, "occurrence_key", 64));
  if (
    attendee.occurrence_key &&
    data.occurrence_key !== undefined &&
    data.occurrence_key !== attendee.occurrence_key
  )
    fail(403, "INVITATION_SCOPE", t("calendarProposals.thisInvitationCoversOneOccurrence"));
  const effective = await occurrence(c, event, key);
  if (
    attendee.removed_at ||
    !(await effectiveAttendees(c, event.id, key)).some((value) => value.id === attendee.id)
  )
    fail(404, "INVITATION_NOT_FOUND", t("calendarProposals.invitationIsUnavailable"));
  writeEvent({ start: data.start, end: data.end }, cal, {
    ...effective,
    recurrence_json: "[]",
  });
  const id = uuid(),
    value = {
      id,
      event_id: event.id,
      attendee_id: attendee.id,
      occurrence_key: key,
      start_json: JSON.stringify(data.start),
      end_json: JSON.stringify(data.end),
      comment: data.comment === undefined ? "" : text(data.comment, "comment", 1000, true),
      status: "pending",
      version: 1,
    };
  const result = await mutate(c, {
    operation: `proposal.create:${attendee.id}:${key}`,
    idempotent: true,
    principal: { actor_key: actorKey, actor_user_id: user, auth },
    request: data,
    result: {
      proposal: {
        id,
        event_id: event.id,
        attendee_id: attendee.id,
        occurrence_key: key,
        start: data.start,
        end: data.end,
        comment: value.comment,
        status: "pending",
        version: 1,
      },
    },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventAvailable(event.id, event.sequence),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_attendees WHERE id=? AND removed_at IS NULL)",
        attendee.id,
      ),
    ],
    build: (proof, operation) => [
      insert(c, "calendar_time_proposals", value, proof),
      ...(event.organizer_user_id
        ? notificationStatements(
            c,
            proof,
            `calendar:proposal:${operation}`,
            event.organizer_user_id,
            "response",
            null,
          )
        : []),
    ],
  });
  wakeCalendar(c);
  return result;
}
export const ownProposalRoutes = new Hono<AppEnv>();
ownProposalRoutes.post("/inbox-invitations/:attendeeId/time-proposals", async (c) =>
  c.json(
    await propose(
      c,
      await invitation(c, true),
      await body(c, ["start", "end", "comment", "occurrence_key"]),
    ),
    201,
  ),
);
export const publicProposalRoutes = new Hono<AppEnv>();
publicProposalRoutes.post("/invitations/:token/time-proposals", async (c) =>
  c.json(
    await propose(
      c,
      await invitation(c),
      await body(c, ["start", "end", "comment", "occurrence_key"]),
    ),
    201,
  ),
);
const routes = new Hono<AppEnv>(),
  root = "/calendars/:calendarId/events/:eventId";
async function target(c: CalendarContext) {
  const cal = await requireCalendar(c, identifier(c.req.param("calendarId")), 3),
    event = await requireEvent(c, cal, identifier(c.req.param("eventId")), true);
  return { cal, event };
}
routes.get(root + "/time-proposals", async (c) => {
  const { cal, event } = await target(c),
    values = await rows<Proposal>(
      c.env,
      "SELECT * FROM calendar_time_proposals WHERE event_id=? ORDER BY created_at DESC,id LIMIT 100",
      event.id,
    ),
    visible = [];
  for (const value of values) {
    try {
      await attendanceDetails(c, cal, event, value.occurrence_key);
      visible.push(value);
    } catch {}
  }
  return c.json({
    proposals: visible.map(({ start_json, end_json, ...value }) => ({
      ...value,
      start: JSON.parse(start_json),
      end: JSON.parse(end_json),
    })),
  });
});
routes.post(root + "/time-proposals/:proposalId/resolve", async (c) => {
  const data = await body(c, ["version", "decision", "event_version"]),
    { cal, event } = await target(c),
    version = expectedVersion(c, data),
    id = identifier(c.req.param("proposalId")),
    proposal = await first<Proposal>(
      c.env,
      "SELECT * FROM calendar_time_proposals WHERE id=? AND event_id=?",
      id,
      event.id,
    ),
    decision = choice(data.decision, "decision", ["accept", "reject"]);
  if (!proposal || proposal.status !== "pending")
    fail(409, "PROPOSAL_STATE", t("calendarProposals.thisProposalIsNotPending"));
  const effective = await attendanceDetails(c, cal, event, proposal.occurrence_key),
    accepted = decision === "accept",
    eventVersion = accepted ? integer(data.event_version, "event_version", 1) : event.version;
  const next = {
      ...writeEvent(
        {
          start: JSON.parse(proposal.start_json),
          end: JSON.parse(proposal.end_json),
        },
        cal,
        proposal.occurrence_key ? { ...effective, recurrence_json: "[]" } : event,
      ),
      sequence: event.sequence + 1,
      version: eventVersion + 1,
      updated_at: now(),
    },
    notices = accepted
      ? await prepareDeliveries(
          c,
          cal,
          next,
          proposal.occurrence_key
            ? await effectiveAttendees(c, event.id, proposal.occurrence_key)
            : await allAttendees(c, event.id),
          "update",
          proposal.occurrence_key,
        )
      : null;
  const overrides = proposal.occurrence_key
    ? await rows<{
        scope_id: string;
        patch_json: string;
        cancelled: number;
        version: number;
        created_at: number;
        updated_at: number;
        effective_start_at: number | null;
        effective_end_at: number | null;
        effective_start_date: string | null;
        effective_end_date: string | null;
        event_id: string;
        occurrence_key: string;
      }>(
        c.env,
        "SELECT o.*,s.event_id,s.occurrence_key FROM calendar_event_overrides o JOIN calendar_event_scopes s ON s.id=o.scope_id WHERE s.event_id=? AND s.occurrence_key=?",
        event.id,
        proposal.occurrence_key,
      )
    : [];
  await mutate(c, {
    action: "calendar.events.update",
    operation: `proposal.resolve:${id}`,
    idempotent: true,
    request: data,
    result: {
      status: accepted ? "accepted" : "rejected",
      version: version + 1,
      event_version: accepted ? eventVersion + 1 : event.version,
    },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, eventVersion),
      condition(
        "EXISTS(SELECT 1 FROM calendar_time_proposals WHERE id=? AND version=? AND status='pending')",
        id,
        version,
      ),
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendar_time_proposals",
        {
          status: accepted ? "accepted" : "rejected",
          version: version + 1,
          resolved_by: c.get("identity").user.id,
        },
        "id=?",
        [id],
        proof,
      ),
      ...(accepted
        ? proposal.occurrence_key
          ? setOverride(
              c,
              cal,
              event,
              eventVersion,
              proposal.occurrence_key,
              {
                time_kind: next.time_kind,
                start_at: next.start_at,
                end_at: next.end_at,
                start_date: next.start_date,
                end_date: next.end_date,
                start_local: next.start_local,
                end_local: next.end_local,
                start_time_zone: next.start_time_zone,
                end_time_zone: next.end_time_zone,
              },
              0,
              overrides[0],
              proof,
            )
          : [
              update(
                c,
                "calendar_events",
                next as unknown as Record<string, string | number | null>,
                "id=?",
                [event.id],
                proof,
              ),
              change(c, proof, cal.id, "event", event.id, eventVersion + 1),
            ]
        : []),
      ...(notices ? notices(proof, operation) : []),
    ],
  });
  wakeCalendar(c);
  return c.json({
    status: accepted ? "accepted" : "rejected",
    version: version + 1,
    event_version: accepted ? eventVersion + 1 : event.version,
  });
});
export default routes;

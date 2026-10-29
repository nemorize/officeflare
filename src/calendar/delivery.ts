import { sql } from "drizzle-orm";
import { now, uuid } from "../auth/types";
import { digest, random } from "../auth/crypto";
import { prepareNotification } from "../notifications/service";
import type { NotificationType } from "../notifications/catalog";
import type { Calendar, CalendarContext, Bind, Event, Override } from "./types";
import type { Attendee, DeliveryPayload } from "./collaboration-types";
import { first, rows } from "./access";
import { seal } from "./secrets";
import { insert } from "./mutations";
import { applyOverride, originalOccurrence } from "./recurrence";
import { loadOverrides } from "./event-data";
import { choice, fail } from "./input";
export function notificationStatements(
  c: CalendarContext,
  proof: string,
  source: string,
  user: string,
  action: string,
  target: string | null,
) {
  const type: NotificationType =
    action === "invite" || action === "confirmation"
      ? "calendar.invited"
      : action === "cancel"
        ? "calendar.cancelled"
        : action === "response"
          ? "calendar.response"
          : "calendar.updated";
  const title =
    type === "calendar.invited"
      ? "Calendar invitation"
      : type === "calendar.cancelled"
        ? "Calendar event cancelled"
        : type === "calendar.response"
          ? "Calendar response"
          : "Calendar event updated";
  return prepareNotification(
    c.get("db"),
    {
      source_key: source,
      type,
      title,
      body:
        action === "response"
          ? "An attendee responded to your event."
          : "Open this notification to view your invitation.",
      target_path: target,
      recipient_ids: [user],
    },
    sql.raw(proof),
  ).map((query) => {
    const compiled = query.toSQL();
    return c.env.DB.prepare(compiled.sql).bind(...compiled.params);
  });
}
type DeliveryBuild = (proof: string, operation: string) => D1PreparedStatement[];
export async function prepareDeliveries(
  c: CalendarContext,
  cal: Calendar,
  event: Event,
  attendees: Attendee[],
  action: "invite" | "update" | "cancel" | "confirmation",
  occurrenceKey = "",
  options: {
    sendUpdates?: unknown;
    resend?: boolean;
    additionalProof?: string;
    overrides?: Override[];
  } = {},
): Promise<DeliveryBuild> {
  if (options.sendUpdates !== undefined)
    choice(options.sendUpdates, "send_updates", ["external_only", "none"]);
  if (attendees.length > 100)
    fail(422, "TOO_MANY_ATTENDEES", "Synchronous invitation delivery is limited to 100 attendees");
  if (!occurrenceKey && attendees.some((value) => value.occurrence_key)) {
    const builds = [
      await prepareDeliveries(
        c,
        cal,
        event,
        attendees.filter((value) => !value.occurrence_key),
        action,
        "",
        options,
      ),
    ];
    for (const key of new Set(
      attendees.filter((value) => value.occurrence_key).map((value) => value.occurrence_key),
    )) {
      try {
        const original = originalOccurrence(event, key),
          override = (options.overrides ?? (await loadOverrides(c, [event.id]))).find(
            (value) => value.occurrence_key === key,
          ),
          effective = applyOverride(event, original, override);
        builds.push(
          await prepareDeliveries(
            c,
            cal,
            effective,
            attendees.filter((value) => value.occurrence_key === key),
            action,
            key,
            options,
          ),
        );
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
      }
    }
    return (proof: string, operation: string) => builds.flatMap((build) => build(proof, operation));
  }
  const overrides =
    occurrenceKey || event.recurrence_json === "[]"
      ? []
      : (options.overrides ?? (await loadOverrides(c, [event.id])));
  const snapshots = overrides.flatMap((override) => {
    try {
      return [
        {
          original_key: override.occurrence_key,
          event: applyOverride(event, originalOccurrence(event, override.occurrence_key), override),
        },
      ];
    } catch {
      return [];
    }
  });
  const prepared: {
    attendee: Attendee;
    id: string;
    key: string;
    recipient: string;
    token: string | null;
    tokenId: string;
    tokenHash: string | null;
    payload: string | null;
  }[] = [];
  for (const attendee of attendees) {
    if (attendee.user_id === cal.data_owner_user_id) continue;
    const id = uuid(),
      recipient = attendee.user_id ? `user:${attendee.user_id}` : `email:${attendee.email_key}`;
    const key = `${event.i_cal_uid}:${event.sequence}:${occurrenceKey}:${action}:${recipient}${options.resend ? `:${uuid()}` : ""}`;
    const token = attendee.user_id || action === "cancel" ? null : `ofci_${random()}`,
      tokenId = uuid();
    const excluded = !occurrenceKey
      ? await rows<{ occurrence_key: string }>(
          c.env,
          "SELECT occurrence_key FROM calendar_attendee_exclusions WHERE event_id=? AND email_key=?",
          event.id,
          attendee.email_key,
        )
      : [];
    const privateEvent = {
      ...event,
      ...(action === "cancel"
        ? {
            description_html: "",
            location_json: "{}",
            shared_properties_json: "{}",
          }
        : {}),
    };
    if (excluded.length && privateEvent.recurrence_json !== "[]")
      privateEvent.recurrence_json = JSON.stringify([
        ...JSON.parse(privateEvent.recurrence_json),
        ...excluded.map((value) =>
          value.occurrence_key.startsWith("d:")
            ? `EXDATE;VALUE=DATE:${value.occurrence_key.slice(2).replaceAll("-", "")}`
            : `EXDATE:${value.occurrence_key.slice(2).replaceAll("-", "").replaceAll(":", "")}`,
        ),
      ]);
    const payload: DeliveryPayload = {
      kind: "invitation",
      event: privateEvent,
      calendar: { time_zone: cal.time_zone },
      attendee,
      action,
      occurrence_key: occurrenceKey,
      overrides: snapshots.filter(
        (value) => !excluded.some((item) => item.occurrence_key === value.original_key),
      ),
      url: token ? new URL(`/api/calendar/invitations/${token}`, c.req.url).href : undefined,
    };
    prepared.push({
      attendee,
      id,
      key,
      recipient,
      token,
      tokenId,
      tokenHash: token ? await digest(token) : null,
      payload: !attendee.user_id
        ? JSON.stringify(await seal(c.env, `delivery:${id}`, payload))
        : null,
    });
  }
  return (baseProof: string, operation: string) =>
    prepared.flatMap((item) => {
      const proof = options.additionalProof
          ? `(${baseProof}) AND (${options.additionalProof})`
          : baseProof,
        internal = !!item.attendee.user_id,
        allowed = internal || options.sendUpdates !== "none",
        source = `calendar:${item.id}`,
        unique = `(${proof}) AND NOT EXISTS(SELECT 1 FROM calendar_invitation_deliveries WHERE dedup_key='${item.key.replaceAll("'", "''")}')`;
      const out: D1PreparedStatement[] = [];
      if (internal)
        out.push(
          ...notificationStatements(
            c,
            unique,
            source,
            item.attendee.user_id!,
            action,
            `/calendar/invitations/${item.attendee.id}`,
          ),
        );
      out.push(
        insert(
          c,
          "calendar_invitation_deliveries",
          {
            id: item.id,
            operation_id: operation,
            event_id: event.id,
            occurrence_key: occurrenceKey,
            attendee_id: item.attendee.id,
            action,
            sequence: event.sequence,
            source_version: event.version,
            recipient_user_id: item.attendee.user_id,
            recipient_email: internal ? null : item.attendee.email_address,
            recipient_key: item.recipient,
            channel: internal ? "notification_center" : "email",
            status: allowed ? (internal ? "inbox_committed" : "queued") : "suppressed",
            dedup_key: item.key,
            message_id: `<calendar-${item.id}@officeflare>`,
          },
          unique,
        ),
      );
      if (internal)
        out.push(
          c.env.DB.prepare(
            `UPDATE calendar_invitation_deliveries SET status=CASE WHEN EXISTS(SELECT 1 FROM notification_inbox i JOIN notification_events e ON e.id=i.event_id WHERE e.source_key=? AND i.user_id=?) THEN 'inbox_committed' ELSE 'suppressed' END WHERE id=? AND ${proof}`,
          ).bind(source, item.attendee.user_id, item.id),
        );
      else if (allowed) {
        if (item.token)
          out.push(
            insert(
              c,
              "calendar_invitation_tokens",
              {
                id: item.tokenId,
                attendee_id: item.attendee.id,
                token_hash: item.tokenHash,
                expires_at: now() + 365 * 86400,
              },
              `${proof} AND EXISTS(SELECT 1 FROM calendar_invitation_deliveries WHERE id='${item.id}')`,
            ),
          );
        out.push(
          insert(
            c,
            "calendar_outbox",
            { id: item.id, payload_json: item.payload, run_at: now() },
            `${proof} AND EXISTS(SELECT 1 FROM calendar_invitation_deliveries WHERE id='${item.id}')`,
          ),
        );
      }
      return out;
    });
}
export async function prepareMessage(
  c: CalendarContext,
  recipient: string,
  payload: DeliveryPayload,
  event: Event | null = null,
) {
  const id = uuid(),
    encrypted = JSON.stringify(await seal(c.env, `delivery:${id}`, payload));
  return (proof: string, operation: string) => [
    insert(
      c,
      "calendar_invitation_deliveries",
      {
        id,
        operation_id: operation,
        event_id: event?.id ?? null,
        action: payload.kind,
        recipient_key: `email:${recipient.toLowerCase()}`,
        recipient_email: recipient,
        channel: "email",
        status: "queued",
        dedup_key: `message:${id}`,
        message_id: `<calendar-${id}@officeflare>`,
      },
      proof,
    ),
    insert(c, "calendar_outbox", { id, payload_json: encrypted, run_at: now() }, proof),
  ];
}

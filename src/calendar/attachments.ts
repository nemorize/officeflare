import { Hono } from "hono";
import { now, uuid, type AppEnv } from "../auth/types";
import type { CalendarContext, Event } from "./types";
import {
  identity as driveIdentity,
  itemCondition as driveCondition,
  requireItem,
} from "../drive/access";
import type { DriveContext } from "../drive/types";
import {
  canSeeDetails,
  eventCondition,
  first,
  requireCalendar,
  requireEvent,
  rows,
  condition,
} from "./access";
import { body, expectedVersion, fail, identifier, text } from "./input";
import { insert, mutate, update, change } from "./mutations";
import { scope, allAttendees, attendanceDetails } from "./attendance-store";
import { prepareDeliveries } from "./delivery";
import { wakeCalendar } from "./jobs";
interface Attachment {
  id: string;
  scope_id: string;
  drive_item_id: string | null;
  url: string | null;
  title: string;
  mime_type: string;
  version: number;
  removed_at: number | null;
}
export function webUrl(value: unknown) {
  const raw = text(value, "url", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(400, "INVALID_URL", "Invalid attachment URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    fail(400, "INVALID_URL", "Attachment URLs must use HTTP or HTTPS");
  return url.href;
}
export async function attachmentRows(
  c: CalendarContext,
  event: Event,
  key = "",
) {
  return rows<Attachment>(
    c.env,
    "SELECT a.* FROM calendar_event_attachments a JOIN calendar_event_scopes s ON s.id=a.scope_id WHERE s.event_id=? AND s.occurrence_key IN('',?) AND a.removed_at IS NULL ORDER BY a.id",
    event.id,
    key,
  );
}
export async function readableAttachments(
  c: CalendarContext,
  event: Event,
  key = "",
) {
  const values = await attachmentRows(c, event, key),
    result = [];
  for (const value of values) {
    if (value.url) {
      result.push({
        id: value.id,
        title: value.title,
        mime_type: value.mime_type,
        url: value.url,
        version: value.version,
        unavailable: false,
      });
      continue;
    }
    if (!c.get("identity")) {
      result.push({ id: value.id, unavailable: true });
      continue;
    }
    const drive = c as unknown as DriveContext,
      auth = driveIdentity(drive);
    if (!(await first(c.env, `SELECT 1 WHERE ${auth.sql}`, ...auth.args))) {
      result.push({ id: value.id, unavailable: true });
      continue;
    }
    try {
      const item = await requireItem(drive, value.drive_item_id!);
      result.push({
        id: value.id,
        title: item.name,
        mime_type: value.mime_type,
        drive_item_id: item.id,
        content_path: `/api/drive/items/${item.id}/content`,
        version: value.version,
        unavailable: false,
      });
    } catch {
      result.push({ id: value.id, unavailable: true });
    }
  }
  return result;
}
const routes = new Hono<AppEnv>();
const root = "/calendars/:calendarId/events/:eventId";
async function target(c: CalendarContext, edit = false) {
  const cal = await requireCalendar(
      c,
      identifier(c.req.param("calendarId")),
      edit ? 3 : 1,
    ),
    event = await requireEvent(
      c,
      cal,
      identifier(c.req.param("eventId")),
      edit,
    );
  if (!canSeeDetails(event, cal))
    fail(404, "EVENT_NOT_FOUND", "Event not found");
  return { cal, event };
}
routes.get(root + "/attachments", async (c) => {
  const { event, cal } = await target(c);
  await attendanceDetails(c, cal, event, c.req.query("occurrence_key") ?? "");
  return c.json({
    attachments: await readableAttachments(
      c,
      event,
      c.req.query("occurrence_key") ?? "",
    ),
  });
});
routes.post(root + "/attachments", async (c) => {
  const data = await body(c, [
      "version",
      "drive_item_id",
      "url",
      "title",
      "mime_type",
      "occurrence_key",
    ]),
    { cal, event } = await target(c, true),
    version = expectedVersion(c, data),
    key =
      data.occurrence_key === undefined
        ? ""
        : text(data.occurrence_key, "occurrence_key", 64),
    selected = await scope(c, event, key),
    id = uuid();
  await attendanceDetails(c, cal, event, key);
  if ((data.drive_item_id === undefined) === (data.url === undefined))
    fail(400, "INVALID_ATTACHMENT", "Choose Drive item or URL");
  const item =
    data.drive_item_id === undefined
      ? null
      : await requireItem(
          c as unknown as DriveContext,
          identifier(data.drive_item_id),
        );
  if (item && item.kind !== "file")
    fail(400, "INVALID_ATTACHMENT", "Only files can be attached");
  if ((await attachmentRows(c, event, key)).length >= 20)
    fail(422, "TOO_MANY_ATTACHMENTS", "At most 20 attachments are allowed");
  const value = {
      id,
      scope_id: selected.id,
      drive_item_id: item?.id ?? null,
      url: item ? null : webUrl(data.url),
      title:
        data.title === undefined
          ? (item?.name ?? "Attachment")
          : text(data.title, "title", 255),
      mime_type:
        data.mime_type === undefined
          ? "application/octet-stream"
          : text(data.mime_type, "mime_type", 100),
      version: 1,
    },
    updated = {
      ...event,
      version: version + 1,
      sequence: event.sequence + 1,
      updated_at: now(),
    },
    notices = await prepareDeliveries(
      c,
      cal,
      updated,
      await allAttendees(c, event.id),
      "update",
    );
  const result = await mutate(c, {
    action: "calendar.events.update",
    operation: `attachment.add:${event.id}:${key}`,
    idempotent: true,
    request: data,
    result: { attachment: value, event_version: version + 1 },
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, version),
      ...(item
        ? [
            driveIdentity(c as unknown as DriveContext),
            driveCondition(
              c as unknown as DriveContext,
              item.id,
              item.version,
              "read",
            ),
          ]
        : []),
    ],
    build: (proof, operation) => [
      ...selected.build(proof),
      insert(c, "calendar_event_attachments", value, proof),
      update(
        c,
        "calendar_events",
        {
          version: version + 1,
          sequence: event.sequence + 1,
          updated_at: now(),
        },
        "id=?",
        [event.id],
        proof,
      ),
      change(c, proof, cal.id, "event", event.id, version + 1),
      ...notices(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.json(result, 201);
});
routes.delete(root + "/attachments/:attachmentId", async (c) => {
  const { cal, event } = await target(c, true),
    id = identifier(c.req.param("attachmentId")),
    version = expectedVersion(c),
    value = (
      await attachmentRows(c, event, c.req.query("occurrence_key") ?? "")
    ).find((value) => value.id === id);
  if (!value) fail(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
  await attendanceDetails(c, cal, event, c.req.query("occurrence_key") ?? "");
  const notices = await prepareDeliveries(
    c,
    cal,
    { ...event, sequence: event.sequence + 1, version: event.version + 1 },
    await allAttendees(c, event.id),
    "update",
  );
  await mutate(c, {
    action: "calendar.events.update",
    operation: "attachment.remove",
    request: { id, version },
    result: null,
    calendar: cal.id,
    event: event.id,
    checks: [
      eventCondition(c, cal, event, event.version),
      condition(
        "EXISTS(SELECT 1 FROM calendar_event_attachments WHERE id=? AND version=? AND removed_at IS NULL)",
        id,
        version,
      ),
    ],
    build: (proof, operation) => [
      update(
        c,
        "calendar_event_attachments",
        { removed_at: now(), version: version + 1 },
        "id=?",
        [id],
        proof,
      ),
      update(
        c,
        "calendar_events",
        {
          version: event.version + 1,
          sequence: event.sequence + 1,
          updated_at: now(),
        },
        "id=?",
        [event.id],
        proof,
      ),
      change(c, proof, cal.id, "event", event.id, event.version + 1),
      ...notices(proof, operation),
    ],
  });
  wakeCalendar(c);
  return c.body(null, 204);
});
export default routes;

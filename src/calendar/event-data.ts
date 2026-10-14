import sanitizeHtml from "sanitize-html";
import { now, uuid } from "../auth/types";
import type {
  Bind,
  Calendar,
  CalendarContext,
  Copy,
  Event,
  Occurrence,
  Override,
} from "./types";
import { canSeeDetails, first, rows } from "./access";
import {
  choice,
  color,
  fail,
  fields,
  flag,
  identifier,
  jsonObject,
  object,
  text,
} from "./input";
import { endpoint, times } from "./time";
import { validateRecurrence } from "./recurrence";
import { insert } from "./mutations";
export const eventFields = [
  "title",
  "description_html",
  "location",
  "start",
  "end",
  "recurrence",
  "visibility",
  "transparency",
  "guest_permissions",
  "shared_properties",
  "send_updates",
] as const;
export const createFields = [
  ...eventFields,
  "event_type",
  "copy_preferences",
] as const;
export function writeEvent(
  data: Record<string, unknown>,
  cal: Calendar,
  existing?: Event,
): Event {
  const stamp = now(),
    result: Event = existing
      ? { ...existing }
      : {
          id: uuid(),
          organizer_calendar_id: cal.id,
          organizer_user_id: cal.data_owner_user_id,
          organizer_email: "",
          creator_user_id: null,
          authority: "native",
          i_cal_uid: `${uuid()}@officeflare`,
          sequence: 0,
          event_type: "default",
          status: "confirmed",
          title: "",
          description_html: "",
          location_json: "{}",
          time_kind: "all_day",
          start_at: null,
          end_at: null,
          start_date: null,
          end_date: null,
          start_local: null,
          end_local: null,
          start_time_zone: null,
          end_time_zone: null,
          recurrence_json: "[]",
          recurrence_until_at: null,
          visibility: "default",
          transparency: "busy",
          guest_permissions_json: "{}",
          type_properties_json: "{}",
          shared_properties_json: "{}",
          source_json: "{}",
          version: 1,
          created_at: stamp,
          updated_at: stamp,
          trashed_at: null,
        };
  if ("event_type" in data && data.event_type !== "default")
    fail(422, "FEATURE_UNAVAILABLE", "This event type is not available yet");
  if ("title" in data) result.title = text(data.title, "title", 1024, true);
  if ("description_html" in data)
    result.description_html =
      data.description_html === null
        ? ""
        : sanitizeHtml(
            text(data.description_html, "description_html", 20000, true),
            {
              allowedTags: [
                "p",
                "br",
                "b",
                "strong",
                "em",
                "i",
                "u",
                "s",
                "ul",
                "ol",
                "li",
                "a",
                "blockquote",
                "code",
                "pre",
              ],
              allowedAttributes: { a: ["href", "title"] },
              allowedSchemes: ["http", "https", "mailto"],
            },
          );
  if ("location" in data) {
    const value =
      data.location === null
        ? {}
        : typeof data.location === "string"
          ? { label: text(data.location, "location", 1024, true) }
          : jsonObject(data.location, "location", 4096);
    fields(value, ["label", "address", "url", "latitude", "longitude"]);
    for (const key of ["label", "address", "url"])
      if (key in value)
        text((value as Record<string, unknown>)[key], key, 2048, true);
    for (const [key, min, max] of [
      ["latitude", -90, 90],
      ["longitude", -180, 180],
    ] as const)
      if (key in value) {
        const n = (value as Record<string, unknown>)[key];
        if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
          fail(400, "INVALID_INPUT", `Invalid ${key}`);
      }
    result.location_json = JSON.stringify(value);
  }
  if ("start" in data || "end" in data || !existing) {
    if (!("start" in data) || !("end" in data))
      fail(400, "INVALID_INPUT", "start and end must be supplied together");
    Object.assign(result, times(data.start, data.end, cal.time_zone));
  }
  if ("visibility" in data)
    result.visibility = choice(data.visibility, "visibility", [
      "default",
      "private",
      "public",
    ]);
  if ("transparency" in data)
    result.transparency = choice(data.transparency, "transparency", [
      "busy",
      "free",
    ]);
  if ("guest_permissions" in data) {
    const value = object(data.guest_permissions, "guest_permissions");
    fields(value, ["can_modify", "can_invite_others", "can_see_other_guests"]);
    for (const [key, item] of Object.entries(value)) flag(item, key);
    result.guest_permissions_json = JSON.stringify(value);
  }
  if ("shared_properties" in data) {
    const value =
      data.shared_properties === null
        ? {}
        : jsonObject(data.shared_properties, "shared_properties");
    for (const [key, item] of Object.entries(value)) {
      text(key, "property key", 128);
      text(item, "property value", 1024, true);
    }
    result.shared_properties_json = JSON.stringify(value);
  }
  if ("send_updates" in data)
    choice(data.send_updates, "send_updates", ["external_only", "none"]);
  result.recurrence_json = JSON.stringify(
    validateRecurrence(
      "recurrence" in data
        ? (data.recurrence ?? [])
        : JSON.parse(result.recurrence_json),
      result,
    ),
  );
  result.recurrence_until_at = null;
  return result;
}
export function overridePatch(
  data: Record<string, unknown>,
  effective: Event,
  cal: Calendar,
) {
  if ("recurrence" in data)
    fail(400, "INVALID_INPUT", "A single occurrence cannot change recurrence");
  const parsed = writeEvent(data, cal, effective),
    patch: Record<string, Bind> = {};
  const map: Record<string, string> = {
    title: "title",
    description_html: "description_html",
    location: "location_json",
    visibility: "visibility",
    transparency: "transparency",
    guest_permissions: "guest_permissions_json",
    shared_properties: "shared_properties_json",
  };
  for (const [key, column] of Object.entries(map))
    if (key in data)
      patch[column] = (parsed as unknown as Record<string, Bind>)[column]!;
  if ("start" in data || "end" in data)
    for (const key of [
      "time_kind",
      "start_at",
      "end_at",
      "start_date",
      "end_date",
      "start_local",
      "end_local",
      "start_time_zone",
      "end_time_zone",
    ] as const)
      patch[key] = parsed[key];
  return { patch, parsed };
}
export async function loadOverrides(c: CalendarContext, ids: string[]) {
  if (!ids.length) return [];
  return rows<Override>(
    c.env,
    `SELECT o.*,s.event_id,s.occurrence_key FROM calendar_event_overrides o JOIN calendar_event_scopes s ON s.id=o.scope_id WHERE s.event_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  );
}
export const getCopy = (c: CalendarContext, event: Event) =>
  first<Copy>(
    c.env,
    "SELECT * FROM calendar_event_copies WHERE event_id=? AND calendar_id=?",
    event.id,
    event.organizer_calendar_id,
  );
export function copyDto(value: Copy) {
  const { private_properties_json, ...rest } = value;
  return {
    ...rest,
    use_default_reminders: !!value.use_default_reminders,
    private_properties: JSON.parse(private_properties_json),
  };
}
export function eventDto(
  event: Event,
  cal: Calendar,
  occurrence?: Occurrence,
  copy?: Copy,
) {
  const details = canSeeDetails(event, cal),
    base = {
      id: event.id,
      calendar_id: cal.id,
      event_type: event.event_type,
      status: event.status,
      title: details ? event.title : "Busy",
      start: endpoint(event, "start"),
      end: endpoint(event, "end"),
      version: event.version,
      transparency: event.transparency,
      is_redacted: !details,
    };
  const extra = details
    ? {
        organizer: {
          user_id: event.organizer_user_id,
          email_address: event.organizer_email,
        },
        creator_user_id: event.creator_user_id,
        i_cal_uid: event.i_cal_uid,
        sequence: event.sequence,
        description_html: event.description_html,
        location: JSON.parse(event.location_json),
        recurrence: JSON.parse(event.recurrence_json),
        visibility: event.visibility,
        guest_permissions: JSON.parse(event.guest_permissions_json),
        shared_properties: JSON.parse(event.shared_properties_json),
        created_at: event.created_at,
        updated_at: event.updated_at,
        trashed_at: event.trashed_at,
      }
    : {};
  return {
    ...base,
    ...extra,
    ...(occurrence
      ? {
          event_id: event.id,
          occurrence_key: occurrence.key,
          original_start: endpoint(occurrence.original, "start"),
          is_exception: !!occurrence.override,
        }
      : {}),
    ...(copy
      ? {
          copy_id: copy.id,
          color: copy.color_override,
          label_id: copy.label_id,
          private_properties: JSON.parse(copy.private_properties_json),
          hidden: !!copy.hidden_at,
        }
      : {}),
  };
}
export function makeCopy(event: Event, input?: unknown): Copy {
  const value = input === undefined ? {} : object(input, "copy_preferences");
  fields(value, [
    "color",
    "label_id",
    "private_properties",
    "use_default_reminders",
  ]);
  return {
    id: uuid(),
    event_id: event.id,
    calendar_id: event.organizer_calendar_id,
    copy_kind: "organizer",
    color_override: "color" in value ? color(value.color) : null,
    label_id:
      value.label_id == null ? null : identifier(value.label_id, "label_id"),
    use_default_reminders:
      "use_default_reminders" in value
        ? flag(value.use_default_reminders, "use_default_reminders")
        : 1,
    private_properties_json: JSON.stringify(
      value.private_properties === undefined
        ? {}
        : jsonObject(value.private_properties, "private_properties"),
    ),
    hidden_at: null,
    removed_at: null,
    version: 1,
    created_at: now(),
    updated_at: now(),
  };
}
export function insertEvent(
  c: CalendarContext,
  event: Event,
  copy: Copy,
  proof: string,
) {
  return [
    insert(
      c,
      "calendar_events",
      event as unknown as Record<string, Bind>,
      proof,
    ),
    insert(
      c,
      "calendar_event_scopes",
      { id: uuid(), event_id: event.id, occurrence_key: "" },
      proof,
    ),
    insert(
      c,
      "calendar_event_copies",
      copy as unknown as Record<string, Bind>,
      proof,
    ),
  ];
}

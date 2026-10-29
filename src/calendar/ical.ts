import { Temporal } from "@js-temporal/polyfill";
import { Parser } from "htmlparser2";
import type { Event } from "./types";
import type { Attendee, DeliveryPayload } from "./collaboration-types";
export const plainText = (html: string) => {
  let value = "";
  const parser = new Parser(
    {
      ontext: (text) => {
        value += text;
      },
      onclosetag: (tag) => {
        if (["p", "li", "br"].includes(tag)) value += "\n";
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return value.trim();
};
const escape = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
const parameter = (value: string) =>
  `"${value
    .replaceAll("^", "^^")
    .replaceAll('"', "^'")
    .replace(/\r\n|\r|\n/g, "^n")}"`;
const compact = (value: string) =>
  value
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.000Z$/, "Z");
const utc = (at: number) => compact(new Date(at * 1000).toISOString());
export function fold(line: string) {
  const encoder = new TextEncoder();
  let length = 0,
    out = "",
    segment = "";
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (length + size > 75) {
      out += segment + "\r\n";
      segment = " ";
      length = 1;
    }
    segment += ch;
    length += size;
  }
  return out + segment;
}
const zoneCache = new Map<string, string[]>();
function timeZone(name: string) {
  const cached = zoneCache.get(name);
  if (cached) return cached;
  let point = Temporal.Instant.from("1969-01-01T00:00:00Z").toZonedDateTimeISO(name);
  const offset = (n: string) => n.replaceAll(":", "");
  const groups = new Map<string, { from: string; to: string; kind: string; dates: string[] }>();
  groups.set("initial", {
    from: offset(point.offset),
    to: offset(point.offset),
    kind: "STANDARD",
    dates: [compact(point.toPlainDateTime().toString({ fractionalSecondDigits: 0 }))],
  });
  for (let count = 0; count < 1000; count++) {
    const next = point.getTimeZoneTransition("next");
    if (!next || next.year > 2101) break;
    const old = next.subtract({ seconds: 1 }),
      from = offset(old.offset),
      to = offset(next.offset),
      kind = next.offsetNanoseconds > old.offsetNanoseconds ? "DAYLIGHT" : "STANDARD",
      key = from + to + kind;
    const local = compact(
      new Date(next.epochMilliseconds + old.offsetNanoseconds / 1e6).toISOString().slice(0, 19),
    );
    const group = groups.get(key) ?? { from, to, kind, dates: [] };
    group.dates.push(local);
    groups.set(key, group);
    point = next;
  }
  const lines = ["BEGIN:VTIMEZONE", `TZID:${name}`];
  for (const value of groups.values())
    lines.push(
      `BEGIN:${value.kind}`,
      `DTSTART:${value.dates[0]}`,
      `TZOFFSETFROM:${value.from}`,
      `TZOFFSETTO:${value.to}`,
      ...(value.dates.length > 1 ? [`RDATE:${value.dates.slice(1).join(",")}`] : []),
      `END:${value.kind}`,
    );
  lines.push("END:VTIMEZONE");
  zoneCache.set(name, lines);
  return lines;
}
function recurrence(lines: string[], event: Event) {
  return lines.flatMap((line) => {
    if (line.startsWith("RRULE:")) return [line];
    const [head, ...body] = line.split(":"),
      raw = body.join(":").split(",");
    if (event.time_kind === "all_day")
      return [`${head!.split(";")[0]};VALUE=DATE:${raw.join(",")}`];
    const z = raw.filter((value) => value.endsWith("Z")),
      local = raw.filter((value) => !value.endsWith("Z"));
    return [
      ...(z.length ? [`${head!.split(";")[0]}:${z.join(",")}`] : []),
      ...(local.length
        ? [`${head!.split(";")[0]};TZID=${event.start_time_zone}:${local.join(",")}`]
        : []),
    ];
  });
}
function component(
  event: Event,
  attendee?: Attendee,
  options: {
    method: string;
    occurrence_key?: string;
    url?: string;
    sender?: string;
    stamp: number;
    organizer?: boolean;
  } = { method: "PUBLISH", stamp: 0 },
) {
  const recurring = event.recurrence_json !== "[]",
    lines = [
      "BEGIN:VEVENT",
      `UID:${escape(event.i_cal_uid)}`,
      `DTSTAMP:${utc(options.stamp)}`,
      `SEQUENCE:${event.sequence}`,
    ];
  if (options.occurrence_key)
    lines.push(
      options.occurrence_key.startsWith("d:")
        ? `RECURRENCE-ID;VALUE=DATE:${compact(options.occurrence_key.slice(2))}`
        : `RECURRENCE-ID:${compact(options.occurrence_key.slice(2))}`,
    );
  if (event.time_kind === "all_day")
    lines.push(
      `DTSTART;VALUE=DATE:${compact(event.start_date!)}`,
      `DTEND;VALUE=DATE:${compact(event.end_date!)}`,
    );
  else if (recurring)
    lines.push(
      `DTSTART;TZID=${event.start_time_zone}:${compact(event.start_local!)}`,
      `DTEND;TZID=${event.end_time_zone}:${compact(event.end_local!)}`,
    );
  else lines.push(`DTSTART:${utc(event.start_at!)}`, `DTEND:${utc(event.end_at!)}`);
  lines.push(
    `SUMMARY:${escape(event.title)}`,
    `STATUS:${options.method === "CANCEL" || event.status === "cancelled" ? "CANCELLED" : event.status.toUpperCase()}`,
    `TRANSP:${event.transparency === "free" ? "TRANSPARENT" : "OPAQUE"}`,
  );
  if (event.description_html)
    lines.push(`DESCRIPTION:${escape(plainText(event.description_html))}`);
  const location = JSON.parse(event.location_json);
  if (location.label || location.address)
    lines.push(`LOCATION:${escape(location.label || location.address)}`);
  if (options.organizer !== false && event.organizer_email)
    lines.push(
      `ORGANIZER${options.sender && options.sender !== event.organizer_email ? `;SENT-BY=${parameter(`mailto:${options.sender}`)}` : ""}:mailto:${event.organizer_email}`,
    );
  if (attendee)
    lines.push(
      `ATTENDEE;CN=${parameter(attendee.display_name || attendee.email_address)};ROLE=${attendee.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"};PARTSTAT=${attendee.response_status.toUpperCase().replaceAll("_", "-")};RSVP=TRUE:mailto:${attendee.email_address}`,
    );
  if (options.url) lines.push(`URL:${options.url}`);
  if (recurring) lines.push(...recurrence(JSON.parse(event.recurrence_json), event));
  lines.push("END:VEVENT");
  return lines;
}
export function calendarFile(payload: DeliveryPayload, sender?: string, stamp?: number) {
  const event = payload.event!;
  const method =
    payload.action === "cancel" ? "CANCEL" : payload.action === "export" ? "PUBLISH" : "REQUEST";
  const entries = [
    { event, key: payload.occurrence_key || undefined },
    ...(payload.overrides ?? []).map((value) => ({
      event: value.event,
      key: value.original_key,
    })),
  ];
  const zones = [
    ...new Set(
      entries
        .filter(
          (value) => value.event.time_kind === "timed" && value.event.recurrence_json !== "[]",
        )
        .map((value) => value.event.start_time_zone!),
    ),
  ];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Officeflare//Calendar//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    ...zones.flatMap(timeZone),
    ...entries.flatMap((value) =>
      component(value.event, payload.attendee, {
        method,
        occurrence_key: value.key,
        url: payload.url,
        sender,
        stamp: stamp ?? event.updated_at,
        organizer: payload.action !== "export" || !!event.organizer_email,
      }),
    ),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
export function exportCalendar(values: { event: Event; key?: string }[], stamp: number) {
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Officeflare//Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      ...values.flatMap((value) =>
        component({ ...value.event, recurrence_json: "[]" }, undefined, {
          method: "PUBLISH",
          occurrence_key: value.key,
          stamp,
          organizer: !!value.event.organizer_email,
        }),
      ),
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}

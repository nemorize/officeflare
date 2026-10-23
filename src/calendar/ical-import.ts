import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { HTTPException } from "hono/http-exception";
import { writeEvent, overridePatch } from "./event-data";
import { date, zone } from "./time";
import { applyOverride, originalOccurrence } from "./recurrence";
import { text } from "./input";
import type { Bind, Calendar, Event } from "./types";

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 200;
export interface ImportEntry {
  index: number;
  uid: string;
  title: string;
  status: "ready" | "imported" | "skipped" | "error";
  message: string;
  warnings: string[];
  event_id?: string;
}
export interface ImportPlan {
  event: Event;
  entries: ImportEntry[];
  overrides: { key: string; patch: Record<string, Bind>; cancelled: number; event: Event }[];
}
const invalid = (message: string): never => { throw new Error(message); };
const message = (error: unknown) => (error instanceof HTTPException || error instanceof Error ? error.message : "Invalid iCalendar entry.").slice(0, 512);
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replace(/\r\n|\r|\n/g, "<br>");
type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;

// Split only at component boundaries, so one malformed property does not prevent
// otherwise valid events from being imported. Folded lines remain intact.
function components(content: string) {
  if (!content.trim() || new TextEncoder().encode(content).length > MAX_IMPORT_BYTES)
    invalid("Choose a non-empty iCalendar file of up to 1 MiB.");
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").trim().split("\n");
  const stack: string[] = [], header: string[] = [], parts: { name: string; raw: string }[] = [];
  let block: string[] = [], ended = false;
  for (const line of lines) {
    if (!line) continue;
    const begin = /^BEGIN:([A-Z0-9-]+)$/i.exec(line), end = /^END:([A-Z0-9-]+)$/i.exec(line);
    if (ended) invalid("The file must contain exactly one VCALENDAR.");
    if (begin) {
      if (!stack.length && begin[1]!.toUpperCase() !== "VCALENDAR") invalid("Expected a VCALENDAR file.");
      if (stack.length) block.push(line);
      else header.push(line);
      stack.push(begin[1]!.toUpperCase());
      if (stack.length > 8) invalid("Calendar components are nested too deeply.");
    } else if (end) {
      if (stack.pop() !== end[1]!.toUpperCase()) invalid("Mismatched calendar component boundaries.");
      if (stack.length) block.push(line);
      else { header.push(line); ended = true; }
      if (stack.length === 1) {
        parts.push({ name: end[1]!.toLowerCase(), raw: block.join("\r\n") });
        block = [];
        if (parts.length > MAX_IMPORT_ENTRIES + 100) invalid("Too many calendar components.");
      }
    } else if (stack.length === 1) header.push(line);
    else if (stack.length > 1) block.push(line);
    else invalid("Expected a VCALENDAR file.");
  }
  if (stack.length || !ended) invalid("The calendar file is incomplete.");
  const root = new ICAL.Component(ICAL.parse(header.join("\r\n")));
  if (value(root, "version") !== "2.0") invalid("Only iCalendar version 2.0 is supported.");
  const scale = root.getFirstPropertyValue("calscale");
  if (scale && String(scale).toUpperCase() !== "GREGORIAN") invalid("Only Gregorian calendars are supported.");
  const entries = parts.filter(part => part.name !== "vtimezone");
  if (!entries.length) invalid("No calendar entries were found.");
  if (entries.length > MAX_IMPORT_ENTRIES) invalid(`Import at most ${MAX_IMPORT_ENTRIES} entries at a time.`);
  return { parts, entries };
}
function one(component: Component, name: string) {
  const values = component.getAllProperties(name);
  if (values.length > 1) invalid(`Repeated ${name.toUpperCase()} property.`);
  return values[0];
}
const value = (component: Component, name: string) => {
  const property = one(component, name);
  return property ? String(property.getFirstValue() ?? "") : "";
};
function timeValue(property: Property, raw: string, defaultZone: string, aliases: Map<string, string>) {
  const tzid = property.getParameter("tzid");
  if (property.type === "date") {
    if (!/^\d{8}$/.test(raw) || tzid) invalid("Invalid DATE value.");
    return { date: date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`).toString() };
  }
  if (property.type !== "date-time" || !/^\d{8}T\d{6}Z?$/.test(raw)) invalid("Invalid DATE-TIME value.");
  if (raw.endsWith("Z") && tzid) invalid("A UTC date cannot also specify TZID.");
  const name = raw.endsWith("Z") ? "UTC" : tzid ? aliases.get(String(tzid)) ?? String(tzid) : defaultZone;
  let timeZone = "";
  try { timeZone = zone(name); } catch { invalid(`Unsupported time zone: ${name}. Use an IANA time zone such as Asia/Seoul.`); }
  const local = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
  // Temporal rejects invalid dates rather than normalizing them as ICAL.Time does.
  if (Number(raw.slice(13, 15)) > 59) invalid("Leap seconds are not supported.");
  const plain = (() => {
    try { return Temporal.PlainDateTime.from(local, { overflow: "reject" }); }
    catch { return invalid(`Invalid date or time: ${raw}. Check the day, month and time values.`); }
  })();
  const zoned = plain.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  if (!plain.equals(zoned.toPlainDateTime())) invalid("The event time falls in a daylight-saving gap.");
  return { date_time: zoned.toInstant().toString({ fractionalSecondDigits: 0 }), time_zone: timeZone };
}
function rawValue(property: Property) {
  const line = property.toICALString();
  // Quoted TZID parameters can contain colons.
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ":" && !quoted) return line.slice(i + 1);
  }
  return invalid("Invalid calendar property.");
}
function readTime(property: Property, cal: Calendar, aliases: Map<string, string>) {
  return timeValue(property, rawValue(property), cal.time_zone, aliases);
}
function fields(component: Component, cal: Calendar, aliases: Map<string, string>, existing?: Event) {
  const data: Record<string, unknown> = {};
  for (const [property, field] of [["summary", "title"], ["location", "location"]] as const)
    if (one(component, property)) data[field] = value(component, property);
  const geo = one(component, "geo");
  if (geo) {
    const coordinates = rawValue(geo).split(";");
    if (coordinates.length !== 2 || coordinates.some(value => !/^[+-]?\d+(?:\.\d+)?$/.test(value))) invalid("Invalid GEO coordinates.");
    data.location = { ...(typeof data.location === "string" ? { label: data.location } : existing ? JSON.parse(existing.location_json) : {}), latitude: Number(coordinates[0]), longitude: Number(coordinates[1]) };
  }
  if (one(component, "description")) data.description_html = `<p>${escapeHtml(value(component, "description"))}</p>`;
  const privacy = value(component, "class").toUpperCase();
  if (privacy) {
    if (!["PUBLIC", "PRIVATE", "CONFIDENTIAL"].includes(privacy)) invalid("Unsupported CLASS value.");
    data.visibility = privacy === "PUBLIC" ? "public" : "private";
  }
  const transparency = value(component, "transp").toUpperCase();
  if (transparency) {
    if (!["TRANSPARENT", "OPAQUE"].includes(transparency)) invalid("Unsupported TRANSP value.");
    data.transparency = transparency === "TRANSPARENT" ? "free" : "busy";
  }
  const start = one(component, "dtstart"), end = one(component, "dtend"), duration = one(component, "duration");
  if (end && duration) invalid("Specify DTEND or DURATION, not both.");
  if (!start && (end || duration || !existing)) invalid("DTSTART is required.");
  if (start) {
    const from = readTime(start, cal, aliases);
    data.start = from;
    if (end) data.end = readTime(end, cal, aliases);
    else if (duration) {
      const raw = rawValue(duration);
      if (!/^P(?=\d|T\d)(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(raw)) invalid("Invalid or unsupported DURATION.");
      const amount = Temporal.Duration.from(raw);
      if (from.date) {
        if (amount.hours || amount.minutes || amount.seconds) invalid("All-day durations must use days or weeks.");
        data.end = { date: Temporal.PlainDate.from(from.date).add(amount).toString() };
      } else {
        const to = Temporal.Instant.from(from.date_time!).toZonedDateTimeISO(from.time_zone!).add(amount);
        data.end = { date_time: to.toInstant().toString({ fractionalSecondDigits: 0 }), time_zone: from.time_zone };
      }
    } else if (from.date) data.end = { date: Temporal.PlainDate.from(from.date).add({ days: 1 }).toString() };
    else invalid("Timed events need DTEND or a positive DURATION; zero-duration events are not supported.");
  }
  return data;
}
function recurrence(component: Component, event: Event, cal: Calendar, aliases: Map<string, string>) {
  const lines: string[] = [];
  // Preserve the original rule text so unsupported parts cannot be silently dropped.
  for (const property of component.getAllProperties("rrule")) {
    let rule = rawValue(property).toUpperCase();
    const start = one(component, "dtstart")!;
    if (start.type === "date-time" && !start.getParameter("tzid") && !rawValue(start).endsWith("Z")) {
      rule = rule.replace(/(^|;)UNTIL=(\d{8}T\d{6})(?=;|$)/, (_, prefix, raw) => {
        const until = timeValue(start, raw, cal.time_zone, aliases);
        return `${prefix}UNTIL=${until.date_time!.replaceAll("-", "").replaceAll(":", "")}`;
      });
    }
    lines.push(`RRULE:${rule}`);
  }
  for (const kind of ["rdate", "exdate"])
    for (const property of component.getAllProperties(kind)) {
      const dates = rawValue(property).split(",").map(raw => {
        const result = timeValue(property, raw, cal.time_zone, aliases);
        if (!!result.date !== (event.time_kind === "all_day")) invalid("Recurrence dates must match DTSTART's value type.");
        return result.date ? result.date.replaceAll("-", "") : result.date_time!.replaceAll("-", "").replaceAll(":", "");
      });
      lines.push(`${kind.toUpperCase()}${event.time_kind === "all_day" ? ";VALUE=DATE" : ""}:${dates.join(",")}`);
    }
  return lines;
}
const warningsFor = (component: Component) => {
  const warnings: string[] = [];
  if (component.hasProperty("attendee") || component.hasProperty("organizer")) warnings.push("Imported as a personal copy. Organizer and guests are not imported; no invitations are sent.");
  if (component.getAllSubcomponents("valarm").length) warnings.push("Reminders are not supported and were not imported.");
  const names = ["attach", "url", "categories", "resources", "contact", "related-to", "comment", "priority"];
  const ignored = names.filter(name => component.hasProperty(name));
  if (ignored.length) warnings.push(`These properties are not imported: ${ignored.map(name => name.toUpperCase()).join(", ")}.`);
  if (component.getAllProperties("dtstart").some(p => p.type === "date-time" && !p.getParameter("tzid") && !rawValue(p).endsWith("Z"))) warnings.push("Floating times use the destination calendar's time zone.");
  return warnings;
};
function status(component: Component) {
  const result = value(component, "status").toLowerCase() || "confirmed";
  if (!["confirmed", "tentative", "cancelled"].includes(result)) invalid("Unsupported event STATUS.");
  return result;
}
export function parseCalendarImport(content: string, cal: Calendar) {
  const { parts, entries } = components(content), aliases = new Map<string, string>();
  for (const part of parts.filter(part => part.name === "vtimezone")) {
    try {
      const component = new ICAL.Component(ICAL.parse(part.raw)), id = value(component, "tzid"), location = value(component, "x-lic-location");
      if (id && location) {
        try { zone(id); }
        catch { aliases.set(id, zone(location)); }
      }
    } catch { /* Referencing events report unknown time zones individually. */ }
  }
  const reports: ImportEntry[] = [], groups = new Map<string, { component: Component; report: ImportEntry }[]>(), broken = new Set<string>();
  for (const [index, part] of entries.entries()) {
    const report: ImportEntry = { index: index + 1, uid: "", title: "", status: "ready", message: "Ready to import.", warnings: [] };
    reports.push(report);
    if (part.name !== "vevent") { report.status = "skipped"; report.message = `Unsupported component: ${part.name.toUpperCase()}.`; continue; }
    try {
      // Recover the UID before parsing other properties, so a malformed exception
      // cannot leave its master imported with an incorrect recurrence set.
      const uidLine = part.raw.split("\r\n").find(line => /^UID[:;]/i.test(line));
      if (uidLine) report.uid = String(ICAL.Property.fromString(uidLine).getFirstValue() ?? "");
      const component = new ICAL.Component(ICAL.parse(part.raw));
      report.uid = text(value(component, "uid"), "UID", 1024);
      report.title = value(component, "summary");
      report.warnings = warningsFor(component);
      const group = groups.get(report.uid) ?? [];
      group.push({ component, report }); groups.set(report.uid, group);
    } catch (error) { report.status = "error"; report.message = message(error); if (report.uid) broken.add(report.uid); }
  }
  const plans: ImportPlan[] = [];
  for (const group of groups.values()) {
    try {
      if (broken.has(group[0]!.report.uid)) invalid("Another entry with this UID is invalid; the entire series was skipped.");
      const masters = group.filter(item => !item.component.hasProperty("recurrence-id"));
      if (masters.length !== 1) invalid(masters.length ? "Repeated UID: multiple master events in this file." : "The recurring event's master is missing.");
      const master = masters[0]!, component = master.component;
      for (const item of group)
        if (item.component.getAllSubcomponents().some(child => child.name !== "valarm")) invalid("Unsupported nested event component.");
      if (component.hasProperty("exrule")) invalid("EXRULE is not supported; use EXDATE.");
      let event = writeEvent(fields(component, cal, aliases), cal);
      event = writeEvent({ recurrence: recurrence(component, event, cal, aliases) }, cal, event);
      event.i_cal_uid = master.report.uid;
      event.status = status(component);
      event.source_json = JSON.stringify({ type: "ical_import" });
      const plan: ImportPlan = { event, entries: group.map(item => item.report), overrides: [] }, keys = new Set<string>();
      for (const item of group.filter(item => item !== master)) {
        const id = one(item.component, "recurrence-id")!;
        if (id.getParameter("range")) invalid("RECURRENCE-ID RANGE is not supported.");
        if (["rrule", "rdate", "exdate", "exrule"].some(name => item.component.hasProperty(name))) invalid("An occurrence exception cannot define recurrence.");
        const start = readTime(id, cal, aliases);
        const key = start.date ? `d:${start.date}` : `t:${start.date_time}`;
        if (keys.has(key)) invalid("Repeated RECURRENCE-ID in this series.");
        keys.add(key);
        const original = originalOccurrence(event, key), effective = applyOverride(event, original);
        const data = fields(item.component, cal, aliases, effective);
        const { patch, parsed } = overridePatch(data, effective, cal);
        const effectiveStatus = item.component.hasProperty("status") ? status(item.component) : event.status;
        patch.status = effectiveStatus;
        plan.overrides.push({ key, patch, cancelled: +(effectiveStatus === "cancelled"), event: { ...parsed, status: effectiveStatus } });
      }
      plans.push(plan);
    } catch (error) {
      for (const { report } of group) { report.status = "error"; report.message = message(error); }
    }
  }
  return { plans, entries: reports };
}

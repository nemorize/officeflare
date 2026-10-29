import { RRule, RRuleSet } from "rrule";
import { Temporal } from "@js-temporal/polyfill";
import type { Options } from "rrule";
import type { Event, EventTimes, Occurrence, Override } from "./types";
import { fail, text } from "./input";
import { date, endpoint, floating, instant, interval, localAt, times, zone } from "./time";
export const MAX_OCCURRENCES = 5000,
  MAX_COUNT = 1000;
const allowed = [
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
];
const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const keyOf = (value: EventTimes) =>
  value.time_kind === "all_day"
    ? `d:${value.start_date}`
    : `t:${new Date(value.start_at! * 1000).toISOString().replace(".000Z", "Z")}`;
const compact = (value: string) => value.replaceAll("-", "").replaceAll(":", "");
const fromCompact = (value: string) =>
  value.length === 8
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${value.endsWith("Z") ? "Z" : ""}`;
const startFloat = (event: EventTimes) =>
  floating(event.time_kind === "all_day" ? event.start_date! : event.start_local!);
export function occurrenceTimes(
  event: EventTimes,
  candidate: Date,
  fixedAt?: number,
): EventTimes | null {
  const local = candidate.toISOString().slice(0, 19);
  if (event.time_kind === "all_day") {
    const from = Temporal.PlainDate.from(local.slice(0, 10)),
      days = Temporal.PlainDate.from(event.start_date!).until(
        Temporal.PlainDate.from(event.end_date!),
      ).days;
    return {
      ...event,
      start_date: from.toString(),
      end_date: from.add({ days }).toString(),
    };
  }
  const plain = Temporal.PlainDateTime.from(local),
    timeZone = event.start_time_zone!;
  const start =
    fixedAt === undefined
      ? plain.toZonedDateTime(timeZone, { disambiguation: "earlier" })
      : Temporal.Instant.fromEpochMilliseconds(fixedAt * 1000).toZonedDateTimeISO(timeZone);
  // Nonexistent DST wall times are excluded; overlaps use the first offset.
  if (!plain.equals(start.toPlainDateTime())) return null;
  const duration = floating(event.end_local!).getTime() - startFloat(event).getTime();
  if (duration <= 0)
    fail(400, "INVALID_RECURRENCE", "Recurring events must have a positive local duration");
  if (fixedAt === event.start_at) return { ...event };
  const endPlain = plain.add({ seconds: duration / 1000 });
  let end = endPlain.toZonedDateTime(timeZone, {
    disambiguation: "compatible",
  });
  // An explicit RDATE can select the second offset of an overlap. Its end
  // must use that offset too when the earlier interpretation precedes start.
  if (end.epochMilliseconds <= start.epochMilliseconds)
    end = endPlain.toZonedDateTime(timeZone, { disambiguation: "later" });
  return {
    ...event,
    start_at: start.epochMilliseconds / 1000,
    end_at: end.epochMilliseconds / 1000,
    start_local: plain.toString({ fractionalSecondDigits: 0 }),
    end_local: end.toPlainDateTime().toString({ fractionalSecondDigits: 0 }),
  };
}
function parts(line: string, event: EventTimes): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of line.slice(6).split(";")) {
    const [key, value, extra] = item.split("=");
    if (!key || !value || extra || !allowed.includes(key) || result[key])
      fail(400, "INVALID_RECURRENCE", "Unsupported or repeated RRULE part");
    result[key] = value;
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(result.FREQ ?? ""))
    fail(400, "INVALID_RECURRENCE", "Supported frequencies are DAILY, WEEKLY, MONTHLY, YEARLY");
  if (result.COUNT && result.UNTIL)
    fail(400, "INVALID_RECURRENCE", "COUNT and UNTIL are mutually exclusive");
  for (const [key, max] of [
    ["INTERVAL", 1000],
    ["COUNT", MAX_COUNT],
  ] as const)
    if (result[key] && (!/^[1-9]\d*$/.test(result[key]!) || Number(result[key]) > max))
      fail(400, "INVALID_RECURRENCE", `Invalid ${key}`);
  for (const [key, min, max, zero] of [
    ["BYMONTH", 1, 12, false],
    ["BYMONTHDAY", -31, 31, true],
    ["BYSETPOS", -366, 366, true],
  ] as const) {
    if (
      result[key] &&
      result[key]!.split(",").some(
        (item) =>
          !/^-?\d+$/.test(item) ||
          Number(item) < min ||
          Number(item) > max ||
          (zero && Number(item) === 0),
      )
    )
      fail(400, "INVALID_RECURRENCE", `Invalid ${key}`);
  }
  if (
    result.BYDAY &&
    result.BYDAY.split(",").some((item) => {
      const match = item.match(/^(-?[1-9]\d*)?(MO|TU|WE|TH|FR|SA|SU)$/);
      return (
        !match ||
        (match[1] &&
          (Math.abs(Number(match[1])) > 53 || ["DAILY", "WEEKLY"].includes(result.FREQ!)))
      );
    })
  )
    fail(400, "INVALID_RECURRENCE", "Invalid BYDAY");
  if (result.WKST && !weekdays.includes(result.WKST))
    fail(400, "INVALID_RECURRENCE", "Invalid WKST");
  if (result.BYSETPOS && !result.BYDAY && !result.BYMONTHDAY && !result.BYMONTH)
    fail(400, "INVALID_RECURRENCE", "BYSETPOS requires another BY part");
  if (result.UNTIL) {
    const correct =
      event.time_kind === "all_day"
        ? /^\d{8}$/.test(result.UNTIL)
        : /^\d{8}T\d{6}Z$/.test(result.UNTIL);
    if (!correct)
      fail(400, "INVALID_RECURRENCE", "UNTIL must match the event type (UTC for timed events)");
    const until = fromCompact(result.UNTIL),
      end =
        event.time_kind === "all_day"
          ? date(until).toString()
          : instant(until).epochMilliseconds / 1000;
    if (typeof end === "string" ? end < event.start_date! : end < event.start_at!)
      fail(400, "INVALID_RECURRENCE", "UNTIL precedes DTSTART");
  }
  return result;
}
function extraDates(line: string, event: EventTimes): { float: Date; at?: number; key: string }[] {
  const match = line.match(/^(RDATE|EXDATE)(?:;(VALUE=DATE|TZID=([^:;]+)))?:(.+)$/);
  if (!match) fail(400, "INVALID_RECURRENCE", "Invalid RDATE or EXDATE");
  const tz = match[3] ? zone(match[3]) : event.start_time_zone;
  if (match[3] && (event.time_kind === "all_day" || tz !== event.start_time_zone))
    fail(400, "INVALID_RECURRENCE", "RDATE/EXDATE TZID must match the series time zone");
  if (match[2] === "VALUE=DATE" && event.time_kind !== "all_day")
    fail(400, "INVALID_RECURRENCE", "DATE exclusions require an all-day event");
  const items = match[4]!.split(",");
  if (items.length > MAX_COUNT) fail(400, "INVALID_RECURRENCE", "Too many recurrence dates");
  return items.map((raw) => {
    if (event.time_kind === "all_day") {
      if (!/^\d{8}$/.test(raw)) fail(400, "INVALID_RECURRENCE", "Invalid recurrence DATE");
      const parsed = date(fromCompact(raw)).toString();
      return { float: floating(parsed), key: `d:${parsed}` };
    }
    if (!/^\d{8}T\d{6}Z?$/.test(raw))
      fail(400, "INVALID_RECURRENCE", "Invalid recurrence DATE-TIME");
    let at: number, local: string;
    if (raw.endsWith("Z")) {
      at = instant(fromCompact(raw)).epochMilliseconds / 1000;
      local = localAt(at, event.start_time_zone!).toString({
        fractionalSecondDigits: 0,
      });
    } else {
      const plain = Temporal.PlainDateTime.from(fromCompact(raw));
      date(plain.toPlainDate().toString());
      const zoned = plain.toZonedDateTime(event.start_time_zone!, {
        disambiguation: "earlier",
      });
      if (!plain.equals(zoned.toPlainDateTime()))
        fail(400, "INVALID_RECURRENCE", "Recurrence date falls in a DST gap");
      at = zoned.epochMilliseconds / 1000;
      local = plain.toString({ fractionalSecondDigits: 0 });
    }
    return {
      float: floating(local),
      at,
      key: `t:${new Date(at * 1000).toISOString().replace(".000Z", "Z")}`,
    };
  });
}
function ruleFor(line: string, event: EventTimes) {
  const values = parts(line, event),
    options = RRule.parseString(line.slice(6)) as Partial<Options>;
  options.dtstart = startFloat(event);
  options.tzid = null;
  // Widen the floating cutoff and enforce the true UTC cutoff after conversion.
  // During a fall overlap, local ordering can differ from instant ordering.
  if (values.UNTIL && event.time_kind === "timed")
    options.until = floating(
      localAt(instant(fromCompact(values.UNTIL)).epochMilliseconds / 1000, event.start_time_zone!)
        .add({ days: 2 })
        .toString({ fractionalSecondDigits: 0 }),
    );
  const requestedCount = values.COUNT ? Number(values.COUNT) : undefined;
  if (!requestedCount || event.time_kind === "all_day")
    return {
      rule: new RRule(options, false),
      dates: null as Date[] | null,
      values,
    };
  const dates: Date[] = [];
  // COUNT excludes DST gaps. rrule generates floating dates; Temporal decides validity.
  const unbounded = new RRule(
    { ...options, count: null, until: floating("2100-12-31T23:59:59") },
    false,
  );
  unbounded.all((candidate) => {
    if (occurrenceTimes(event, candidate)) dates.push(candidate);
    return dates.length < requestedCount;
  });
  if (dates.length < requestedCount)
    fail(400, "INVALID_RECURRENCE", "COUNT extends beyond the supported calendar range");
  return { rule: new RRule(options, false), dates, values };
}
interface RecurrenceSet {
  set: RRuleSet;
  fixed: Map<number, number>;
  until: number | null;
  extras: { float: Date; at?: number; key: string }[];
  excluded: Set<string>;
}
const setCache = new WeakMap<Event, { signature: string; value: RecurrenceSet }>();
function buildSet(event: Event): RecurrenceSet {
  const signature = JSON.stringify([
    event.recurrence_json,
    event.start_at,
    event.start_date,
    event.end_at,
    event.end_date,
    event.start_local,
    event.end_local,
    event.start_time_zone,
  ]);
  const cached = setCache.get(event);
  if (cached?.signature === signature) return cached.value;
  const lines = JSON.parse(event.recurrence_json) as string[],
    set = new RRuleSet(false),
    fixed = new Map<number, number>(),
    extras: RecurrenceSet["extras"] = [],
    excluded = new Set<string>();
  let until: number | null = null;
  set.rdate(startFloat(event));
  if (event.time_kind === "timed") fixed.set(startFloat(event).getTime(), event.start_at!);
  for (const line of lines) {
    if (line.startsWith("RRULE:")) {
      const value = ruleFor(line, event);
      if (value.dates) value.dates.forEach((item) => set.rdate(item));
      else set.rrule(value.rule);
      if (value.values.UNTIL && event.time_kind === "timed")
        until = instant(fromCompact(value.values.UNTIL)).epochMilliseconds / 1000;
    } else
      for (const item of extraDates(line, event)) {
        if (line.startsWith("RDATE")) {
          if (event.time_kind === "timed") extras.push(item);
          else set.rdate(item.float);
        } else {
          excluded.add(item.key);
          if (event.time_kind === "all_day") set.exdate(item.float);
        }
      }
  }
  const value = { set, fixed, until, extras, excluded };
  setCache.set(event, { signature, value });
  return value;
}
export function validateRecurrence(value: unknown, event: EventTimes): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string"))
    fail(400, "INVALID_RECURRENCE", "recurrence must be an array of RRULE/RDATE/EXDATE strings");
  const lines = value.map((item) => text(item, "recurrence", 8192));
  if (
    lines.filter((item) => item.startsWith("RRULE:")).length > 1 ||
    lines.some((line) => !/^(RRULE:|RDATE[:;]|EXDATE[:;])/.test(line))
  )
    fail(400, "INVALID_RECURRENCE", "At most one RRULE is supported");
  if (!lines.length) return [];
  if (event.time_kind === "timed" && event.start_time_zone !== event.end_time_zone)
    fail(400, "INVALID_RECURRENCE", "Recurring endpoints must share a time zone");
  if (
    event.time_kind === "timed" &&
    floating(event.end_local!).getTime() <= floating(event.start_local!).getTime()
  )
    fail(400, "INVALID_RECURRENCE", "Recurring events must have a positive local duration");
  const dummy = { ...event, recurrence_json: JSON.stringify(lines) } as Event;
  buildSet(dummy);
  return lines;
}
export function originalOccurrence(event: Event, key: string): EventTimes {
  if (event.recurrence_json === "[]") {
    if (key !== keyOf(event)) fail(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
    return event;
  }
  let candidate: Date;
  try {
    candidate =
      key.startsWith("d:") && event.time_kind === "all_day"
        ? floating(date(key.slice(2)).toString())
        : key.startsWith("t:") && event.time_kind === "timed"
          ? floating(
              localAt(
                instant(key.slice(2)).epochMilliseconds / 1000,
                event.start_time_zone!,
              ).toString({ fractionalSecondDigits: 0 }),
            )
          : new Date(NaN);
  } catch {
    fail(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
  }
  if (!Number.isFinite(candidate.getTime()))
    fail(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
  const data = buildSet(event);
  if (data.excluded.has(key)) fail(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
  const extra = data.extras.find((value) => value.key === key);
  if (extra) {
    const result = occurrenceTimes(event, extra.float, extra.at);
    if (result) return result;
  }
  const values = data.set.between(candidate, candidate, true),
    result = values[0]
      ? occurrenceTimes(event, values[0], data.fixed.get(values[0].getTime()))
      : null;
  if (!result || keyOf(result) !== key || (data.until !== null && result.start_at! > data.until))
    fail(404, "OCCURRENCE_NOT_FOUND", "Occurrence not found");
  return result;
}
export function applyOverride(event: Event, original: EventTimes, override?: Override): Event {
  const result = { ...event, ...original, recurrence_json: "[]" };
  if (!override) return result;
  Object.assign(result, JSON.parse(override.patch_json));
  if (override.cancelled) result.status = "cancelled";
  return result;
}
export function expand(
  event: Event,
  overrides: Override[],
  min: number,
  max: number,
  calendarZone: string,
  showDeleted = false,
): Occurrence[] {
  const output = new Map<string, Occurrence>(),
    byKey = new Map(overrides.map((value) => [value.occurrence_key, value]));
  const add = (original: EventTimes) => {
    const key = keyOf(original),
      override = byKey.get(key),
      effective = applyOverride(event, original, override),
      range = interval(effective, calendarZone);
    if (range.min < max && range.max > min && (showDeleted || effective.status !== "cancelled"))
      output.set(key, { key, original, event: effective, override });
    if (output.size > MAX_OCCURRENCES)
      fail(422, "TOO_MANY_OCCURRENCES", "Too many occurrences; narrow the time range");
  };
  if (event.recurrence_json === "[]") {
    add(event);
    return [...output.values()];
  }
  const data = buildSet(event),
    timeZone = event.start_time_zone ?? calendarZone;
  const duration =
    event.time_kind === "all_day"
      ? (floating(event.end_date!).getTime() - floating(event.start_date!).getTime()) / 1000
      : (floating(event.end_local!).getTime() - floating(event.start_local!).getTime()) / 1000;
  const from = floating(
      localAt(min - duration - 172800, timeZone).toString({
        fractionalSecondDigits: 0,
      }),
    ),
    to = floating(localAt(max + 172800, timeZone).toString({ fractionalSecondDigits: 0 }));
  let examined = 0;
  data.set.between(from, to, true, (candidate) => {
    if (++examined > MAX_OCCURRENCES * 2)
      fail(422, "TOO_MANY_OCCURRENCES", "Too many occurrences; narrow the time range");
    const original = occurrenceTimes(event, candidate, data.fixed.get(candidate.getTime()));
    if (
      original &&
      !data.excluded.has(keyOf(original)) &&
      (data.until === null || original.start_at! <= data.until)
    )
      add(original);
    return true;
  });
  for (const extra of data.extras) {
    const original = occurrenceTimes(event, extra.float, extra.at);
    if (original && !data.excluded.has(extra.key)) add(original);
  }
  // An exception moved into the window can originate outside the expansion window.
  for (const override of overrides)
    if (!output.has(override.occurrence_key)) {
      try {
        add(originalOccurrence(event, override.occurrence_key));
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
      }
    }
  return [...output.values()].sort(
    (a, b) =>
      interval(a.event, calendarZone).min - interval(b.event, calendarZone).min ||
      a.key.localeCompare(b.key),
  );
}
export function splitRecurrence(
  event: Event,
  boundary: EventTimes,
): { before: string[]; after: string[] } {
  const before: string[] = [],
    after: string[] = [],
    boundaryFloat = startFloat(boundary),
    boundaryKey = keyOf(boundary);
  for (const line of JSON.parse(event.recurrence_json) as string[]) {
    if (line.startsWith("RRULE:")) {
      const parsed = ruleFor(line, event),
        values = { ...parsed.values },
        old = { ...values };
      const cutoff =
        event.time_kind === "all_day"
          ? compact(Temporal.PlainDate.from(boundary.start_date!).subtract({ days: 1 }).toString())
          : compact(new Date((boundary.start_at! - 1) * 1000).toISOString().replace(".000Z", "Z"));
      // Never extend a finite rule when splitting at an RDATE after its end.
      if (old.UNTIL === undefined || old.UNTIL > cutoff) old.UNTIL = cutoff;
      if (values.COUNT) {
        const used = (
          parsed.dates ?? parsed.rule.between(startFloat(event), boundaryFloat, true)
        ).filter((value) => {
          const original = occurrenceTimes(
            event,
            value,
            value.getTime() === startFloat(event).getTime()
              ? (event.start_at ?? undefined)
              : undefined,
          );
          return original !== null && keyOf(original) < boundaryKey;
        }).length;
        delete old.UNTIL;
        old.COUNT = String(used);
        if (used > 0)
          before.push(
            "RRULE:" +
              Object.entries(old)
                .map(([key, value]) => `${key}=${value}`)
                .join(";"),
          );
        const remaining = Number(values.COUNT) - used;
        if (remaining > 0) values.COUNT = String(remaining);
        else continue;
      } else {
        before.push(
          "RRULE:" +
            Object.entries(old)
              .map(([key, value]) => `${key}=${value}`)
              .join(";"),
        );
        const boundaryEnd =
          event.time_kind === "all_day"
            ? compact(boundary.start_date!)
            : compact(new Date(boundary.start_at! * 1000).toISOString().replace(".000Z", "Z"));
        if (values.UNTIL && values.UNTIL < boundaryEnd) continue;
      }
      after.push(
        "RRULE:" +
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join(";"),
      );
    } else {
      const header = line.slice(0, line.indexOf(":") + 1),
        raw = line.slice(line.indexOf(":") + 1).split(","),
        parsed = extraDates(line, event);
      const old = raw.filter((_, index) => parsed[index]!.key < boundaryKey),
        next = raw.filter((_, index) => parsed[index]!.key >= boundaryKey);
      if (old.length) before.push(header + old.join(","));
      if (next.length) after.push(header + next.join(","));
    }
  }
  return { before, after };
}
export function ruleContains(event: Event, boundary: EventTimes) {
  const line = (JSON.parse(event.recurrence_json) as string[]).find((value) =>
    value.startsWith("RRULE:"),
  );
  if (!line) return true;
  const parsed = ruleFor(line, event),
    candidate = startFloat(boundary),
    dates = parsed.dates ?? parsed.rule.between(candidate, candidate, true);
  return dates.some((value) => {
    if (value.getTime() !== candidate.getTime()) return false;
    const original = occurrenceTimes(
      event,
      value,
      value.getTime() === startFloat(event).getTime() ? (event.start_at ?? undefined) : undefined,
    );
    return original !== null && keyOf(original) === keyOf(boundary);
  });
}
export function shiftedStart(event: Event, start: EventTimes) {
  return { start: endpoint(start, "start"), end: endpoint(start, "end") };
}

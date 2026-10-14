import { Temporal } from "@js-temporal/polyfill";
import { fail, fields, object, text } from "./input";
import type { EventTimes } from "./types";
export const MAX_DAYS = 366;
export function zone(value: unknown): string {
  const name = text(value, "time_zone", 100);
  try {
    if (/^[+-]/.test(name)) throw new Error();
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions()
      .timeZone;
  } catch {
    fail(400, "INVALID_TIME_ZONE", "Invalid IANA time zone");
  }
}
export function date(value: unknown) {
  const raw = text(value, "date", 10);
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error();
    const result = Temporal.PlainDate.from(raw);
    if (result.year < 1970 || result.year > 2100) throw new Error();
    return result;
  } catch {
    fail(
      400,
      "INVALID_DATE",
      "Dates must be valid YYYY-MM-DD between 1970 and 2100",
    );
  }
}
export function instant(value: unknown) {
  const raw = text(value, "date_time", 40);
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    )
      throw new Error();
    const result = Temporal.Instant.from(raw);
    const year = result.toZonedDateTimeISO("UTC").year;
    if (year < 1970 || year > 2100) throw new Error();
    return result;
  } catch {
    fail(
      400,
      "INVALID_DATE_TIME",
      "date_time must be RFC 3339 with seconds and an offset, between 1970 and 2100",
    );
  }
}
export function epoch(value: string) {
  return instant(value).epochMilliseconds / 1000;
}
export function localDateTime(value: unknown, timeZone: string) {
  const parsed = instant(value),
    zoned = parsed.toZonedDateTimeISO(timeZone);
  if (typeof value === "string" && !value.endsWith("Z")) {
    const plain = Temporal.PlainDateTime.from(value.slice(0, 19));
    if (!plain.equals(zoned.toPlainDateTime()))
      fail(
        400,
        "INVALID_DATE_TIME",
        "Offset does not match the IANA time zone",
      );
  }
  return {
    at: parsed.epochMilliseconds / 1000,
    local: zoned.toPlainDateTime().toString({ fractionalSecondDigits: 0 }),
    zone: timeZone,
  };
}
export function times(
  startValue: unknown,
  endValue: unknown,
  defaultZone: string,
): EventTimes {
  const start = object(startValue, "start"),
    end = object(endValue, "end");
  fields(start, ["date", "date_time", "time_zone"]);
  fields(end, ["date", "date_time", "time_zone"]);
  if ("date" in start || "date" in end) {
    if (
      Object.keys(start).length !== 1 ||
      Object.keys(end).length !== 1 ||
      !("date" in start) ||
      !("date" in end)
    )
      fail(
        400,
        "INVALID_INPUT",
        "All-day start and end must contain only date",
      );
    const from = date(start.date),
      to = date(end.date),
      days = from.until(to).days;
    if (days < 1 || days > MAX_DAYS)
      fail(400, "INVALID_RANGE", `All-day duration must be 1-${MAX_DAYS} days`);
    return {
      time_kind: "all_day",
      start_date: from.toString(),
      end_date: to.toString(),
      start_at: null,
      end_at: null,
      start_local: null,
      end_local: null,
      start_time_zone: null,
      end_time_zone: null,
    };
  }
  const from = localDateTime(
      start.date_time,
      zone(start.time_zone ?? defaultZone),
    ),
    to = localDateTime(end.date_time, zone(end.time_zone ?? defaultZone));
  if (to.at <= from.at || to.at - from.at > MAX_DAYS * 86400)
    fail(400, "INVALID_RANGE", "Event end must follow start, within 366 days");
  return {
    time_kind: "timed",
    start_at: from.at,
    end_at: to.at,
    start_local: from.local,
    end_local: to.local,
    start_time_zone: from.zone,
    end_time_zone: to.zone,
    start_date: null,
    end_date: null,
  };
}
export function endpoint(event: EventTimes, which: "start" | "end") {
  if (event.time_kind === "all_day") return { date: event[`${which}_date`]! };
  const at = event[`${which}_at`]!,
    timeZone = event[`${which}_time_zone`]!;
  return {
    date_time: Temporal.Instant.fromEpochMilliseconds(at * 1000)
      .toZonedDateTimeISO(timeZone)
      .toString({ timeZoneName: "never", fractionalSecondDigits: 0 }),
    time_zone: timeZone,
  };
}
export function floating(value: string) {
  return new Date((value.length === 10 ? `${value}T00:00:00` : value) + "Z");
}
export function localAt(at: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(at * 1000)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime();
}
export function queryRange(from: unknown, to: unknown) {
  const min = instant(from).epochMilliseconds / 1000,
    max = instant(to).epochMilliseconds / 1000;
  if (max <= min || max - min > MAX_DAYS * 86400)
    fail(
      400,
      "INVALID_RANGE",
      "Query range must be positive and at most 366 days",
    );
  return { min, max };
}
export function interval(value: EventTimes, timeZone: string) {
  if (value.time_kind === "timed")
    return { min: value.start_at!, max: value.end_at! };
  return {
    min:
      Temporal.PlainDate.from(value.start_date!).toZonedDateTime(timeZone)
        .epochMilliseconds / 1000,
    max:
      Temporal.PlainDate.from(value.end_date!).toZonedDateTime(timeZone)
        .epochMilliseconds / 1000,
  };
}

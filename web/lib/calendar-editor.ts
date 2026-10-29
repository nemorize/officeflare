import type { CalendarEndpoint, CalendarEvent, CalendarScope } from "./calendar";
import {
  addDays,
  civilDate,
  endpointLocal,
  localEndpoint,
  minuteTime,
  Temporal,
  timeMinute,
} from "./calendar-date";
import { descriptionHtml, plainDescription } from "./calendar-format";

export interface EventDraft {
  title: string;
  calendarId: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  zone: string;
  location: string;
  description: string;
  visibility: string;
  transparency: string;
  frequency: string;
  interval: number;
  weekdays: string[];
  ends: "never" | "until" | "count";
  until: string;
  count: number;
}
export function draftForEvent(event: CalendarEvent, fallbackZone: string): EventDraft {
  const zone = event.start.time_zone ?? fallbackZone,
    start = endpointLocal(event.start, zone),
    end = endpointLocal(event.end, zone);
  const rule = event.recurrence?.find((value) => value.startsWith("RRULE:"))?.slice(6) ?? "";
  const parts = Object.fromEntries(
    rule
      .split(";")
      .filter(Boolean)
      .map((value) => value.split("=")),
  );
  return {
    title: event.title === "(Untitled)" ? "" : event.title,
    calendarId: event.calendar_id,
    startDate: start.date,
    endDate: event.start.date ? addDays(end.date, -1) : end.date,
    startTime: event.start.date ? "09:00" : start.time,
    endTime: event.start.date ? "10:00" : end.time,
    allDay: !!event.start.date,
    zone,
    location: event.location?.label ?? "",
    description: plainDescription(event.description_html),
    visibility: event.visibility ?? "default",
    transparency: event.transparency,
    frequency: parts.FREQ ?? "",
    interval: Number(parts.INTERVAL ?? 1),
    weekdays: parts.BYDAY?.split(",") ?? [],
    ends: parts.COUNT ? "count" : parts.UNTIL ? "until" : "never",
    count: Number(parts.COUNT ?? 10),
    until: parts.UNTIL
      ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
      : addDays(start.date, 30),
  };
}
export function draftTimes(draft: EventDraft) {
  if (draft.allDay) {
    if (draft.endDate < draft.startDate)
      throw new Error("The end date must be on or after the start date.");
    return {
      start: { date: draft.startDate } as CalendarEndpoint,
      end: { date: addDays(draft.endDate, 1) } as CalendarEndpoint,
    };
  }
  const start = localEndpoint(draft.startDate, draft.startTime, draft.zone),
    end = localEndpoint(draft.endDate, draft.endTime, draft.zone);
  if (Temporal.Instant.compare(start.date_time!, end.date_time!) >= 0)
    throw new Error("The end time must be after the start time.");
  return { start, end };
}
export function draftRecurrence(draft: EventDraft, existing?: string[]) {
  if (!draft.frequency) return [];
  const parts = [
    `FREQ=${draft.frequency}`,
    ...(existing
      ?.find((value) => value.startsWith("RRULE:"))
      ?.slice(6)
      .split(";")
      .filter(
        (value) =>
          !/^(FREQ|INTERVAL|COUNT|UNTIL)=/.test(value) &&
          !(draft.frequency === "WEEKLY" && value.startsWith("BYDAY=")),
      ) ?? []),
  ];
  if (draft.interval !== 1) parts.push(`INTERVAL=${draft.interval}`);
  if (draft.frequency === "WEEKLY" && draft.weekdays.length)
    parts.push(`BYDAY=${draft.weekdays.join(",")}`);
  if (draft.ends === "count") parts.push(`COUNT=${draft.count}`);
  if (draft.ends === "until") {
    if (draft.until < draft.startDate)
      throw new Error("Repeat end must not be before the event starts.");
    const end = draft.allDay
      ? draft.until.replaceAll("-", "")
      : Temporal.Instant.from(localEndpoint(draft.until, "23:59:59", draft.zone).date_time!)
          .toString({ smallestUnit: "second" })
          .replaceAll("-", "")
          .replaceAll(":", "");
    parts.push(`UNTIL=${end}`);
  }
  return [
    `RRULE:${parts.join(";")}`,
    ...(existing?.filter((value) => !value.startsWith("RRULE:")) ?? []),
  ];
}
export const recurrenceChanged = (a: EventDraft, b: EventDraft) =>
  a.frequency !== b.frequency ||
  (!!a.frequency &&
    (a.interval !== b.interval ||
      a.ends !== b.ends ||
      (a.frequency === "WEEKLY" &&
        [...a.weekdays].sort().join() !== [...b.weekdays].sort().join()) ||
      (a.ends === "until" && a.until !== b.until) ||
      (a.ends === "count" && a.count !== b.count)));
export function eventChanges(
  draft: EventDraft,
  initial: EventDraft | null,
  master?: CalendarEvent,
  scope: CalendarScope = "all",
) {
  const fields: Record<string, unknown> = {};
  if (!initial || draft.title !== initial.title) fields.title = draft.title.trim() || "(Untitled)";
  if (!initial || draft.location !== initial.location)
    fields.location = draft.location ? { label: draft.location } : {};
  if (!initial || draft.description !== initial.description)
    fields.description_html = descriptionHtml(draft.description);
  if (!initial || draft.visibility !== initial.visibility) fields.visibility = draft.visibility;
  if (!initial || draft.transparency !== initial.transparency)
    fields.transparency = draft.transparency;
  if (!initial || recurrenceChanged(draft, initial))
    fields.recurrence = draftRecurrence(
      draft,
      initial?.frequency === draft.frequency ? master?.recurrence : undefined,
    );
  const timeKeys = ["startDate", "endDate", "startTime", "endTime", "allDay", "zone"] as const;
  if (!initial || timeKeys.some((key) => draft[key] !== initial[key])) {
    let times = draftTimes(draft);
    if (initial && master?.recurrence?.length && scope === "all") {
      const delta = civilDate(initial.startDate).until(civilDate(draft.startDate)).days;
      const baseDate = endpointLocal(master.start, draft.zone).date;
      const startDate = addDays(baseDate, delta),
        endDate = addDays(
          startDate,
          civilDate(draft.startDate).until(civilDate(draft.endDate)).days,
        );
      times = draftTimes({ ...draft, startDate, endDate });
    }
    Object.assign(fields, times);
  }
  return fields;
}
export function initialNewEvent(
  date: string,
  zone: string,
  duration = 30,
  minute = 9 * 60,
  allDay = false,
  endDate?: string,
  endMinute?: number,
): CalendarEvent {
  const end = endMinute ?? minute + duration;
  const compatible = (day: string, value: number) => {
    const time = civilDate(day)
      .toPlainDateTime(Temporal.PlainTime.from(minuteTime(value)))
      .toZonedDateTime(zone);
    return { date_time: time.toInstant().toString(), time_zone: zone };
  };
  const start: CalendarEndpoint = allDay ? { date } : compatible(date, Math.min(1439, minute));
  let finish: CalendarEndpoint = allDay
    ? { date: addDays(endDate ?? date, 1) }
    : compatible(addDays(date, Math.floor(end / 1440)), end % 1440);
  if (!allDay && Temporal.Instant.compare(start.date_time!, finish.date_time!) >= 0)
    finish = {
      date_time: Temporal.Instant.from(start.date_time!)
        .add({ minutes: Math.max(15, end - minute) })
        .toString(),
      time_zone: zone,
    };
  return {
    id: "",
    calendar_id: "",
    title: "",
    version: 0,
    status: "confirmed",
    transparency: "busy",
    is_redacted: false,
    start,
    end: finish,
    recurrence: [],
    visibility: "default",
  };
}
export function preserveWallTimeEdit(
  event: CalendarEvent,
  newStart: CalendarEndpoint,
  newEnd: CalendarEndpoint,
  zone: string,
): EventDraft {
  return draftForEvent({ ...event, start: newStart, end: newEnd }, zone);
}

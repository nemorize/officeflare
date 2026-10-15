import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEndpoint, CalendarEvent, CalendarView } from "./calendar";

export { Temporal };
export const HOUR_HEIGHT = 56;
export const civilDate = (value: string) => Temporal.PlainDate.from(value);
export const validDate = (value: string | null): string | null => {
  try { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && civilDate(value).year >= 1970 && civilDate(value).year <= 2100 ? civilDate(value).toString() : null; } catch { return null; }
};
export const todayIn = (zone: string) => Temporal.Now.plainDateISO(zone).toString();
export const addDays = (date: string, days: number) => civilDate(date).add({ days }).toString();
export const dateDays = (date: string, count: number) => Array.from({ length: count }, (_, index) => addDays(date, index));
export const startOfWeek = (date: string, weekStart: number) => addDays(date, -((civilDate(date).dayOfWeek % 7 - weekStart + 7) % 7));
export const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" }, locale = "en") =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
export const timeLabel = (minute: number, locale = "en") => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: minute % 60 ? "2-digit" : undefined, timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
export const minuteTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const timeMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export function viewRange(date: string, view: CalendarView, weekStart: number) {
  const current = civilDate(date);
  if (view === "month") {
    const start = startOfWeek(current.with({ day: 1 }).toString(), weekStart);
    const monthEnd = current.add({ months: 1 }).with({ day: 1 });
    const count = Math.max(35, Math.ceil(civilDate(start).until(monthEnd).days / 7) * 7);
    return { start, end: addDays(start, count), days: dateDays(start, count) };
  }
  const start = view === "week" ? startOfWeek(date, weekStart) : date;
  const count = view === "day" ? 1 : view === "week" ? 7 : 30;
  return { start, end: addDays(start, count), days: dateDays(start, count) };
}
export function navigateDate(date: string, view: CalendarView, direction: number) {
  return civilDate(date).add(view === "month" ? { months: direction } : { days: direction * (view === "week" ? 7 : view === "agenda" ? 30 : 1) }).toString();
}
export const dateInstant = (date: string, zone: string) => civilDate(date).toZonedDateTime(zone).toInstant().toString();
export function endpointLocal(endpoint: CalendarEndpoint, zone: string) {
  if (endpoint.date) return { date: endpoint.date, time: "00:00", minute: 0 };
  const value = Temporal.Instant.from(endpoint.date_time!).toZonedDateTimeISO(zone);
  return { date: value.toPlainDate().toString(), time: value.toPlainTime().toString({ smallestUnit: "minute" }), minute: value.hour * 60 + value.minute };
}
export function localEndpoint(date: string, time: string, zone: string): CalendarEndpoint {
  const plain = civilDate(date).toPlainDateTime(Temporal.PlainTime.from(time));
  // A typed DST gap is a validation error; a repeated clock time uses its first offset.
  const value = plain.toZonedDateTime(zone, { disambiguation: "compatible" });
  if (!value.toPlainDateTime().equals(plain)) throw new Error("This time does not exist because the clocks change. Choose another time.");
  return { date_time: value.toInstant().toString(), time_zone: zone };
}
export function eventDayBounds(event: CalendarEvent, zone: string) {
  if (event.start.date) return { start: event.start.date, end: event.end.date! };
  const start = endpointLocal(event.start, zone).date;
  const end = Temporal.Instant.from(event.end.date_time!).subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone).toPlainDate().add({ days: 1 }).toString();
  return { start, end };
}
export const occursOn = (event: CalendarEvent, date: string, zone: string) => { const value = eventDayBounds(event, zone); return value.start <= date && value.end > date; };
export const multiDay = (event: CalendarEvent, zone: string) => { const value = eventDayBounds(event, zone); return civilDate(value.start).until(civilDate(value.end)).days > 1; };
export function eventTimeLabel(event: CalendarEvent, zone: string, locale = "en") {
  if (event.start.date) return "All day";
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone });
  return `${format.format(new Date(event.start.date_time!))} – ${format.format(new Date(event.end.date_time!))}`;
}
export function eventDateLabel(event: CalendarEvent, zone: string, locale = "en") {
  const bounds = eventDayBounds(event, zone), last = addDays(bounds.end, -1);
  return `${dateLabel(bounds.start, { weekday: "long", month: "long", day: "numeric" }, locale)}${last !== bounds.start ? ` – ${dateLabel(last, { month: "long", day: "numeric" }, locale)}` : ""}`;
}
export function monthPlacements(events: CalendarEvent[], dates: string[], zone: string) {
  const occupied: number[] = [];
  return events.map(event => {
    const cols = dates.map((date, index) => occursOn(event, date, zone) ? index : -1).filter(index => index >= 0);
    return cols.length ? { event, start: cols[0]!, end: cols.at(-1)! + 1, row: 0 } : null;
  }).filter(value => value !== null).sort((a, b) =>
    Number(!!b.event.start.date || multiDay(b.event, zone)) - Number(!!a.event.start.date || multiDay(a.event, zone)) ||
    a.start - b.start || (b.end - b.start) - (a.end - a.start) ||
    (a.event.start.date_time ?? a.event.start.date!).localeCompare(b.event.start.date_time ?? b.event.start.date!) || a.event.id.localeCompare(b.event.id)
  ).map(value => {
    const mask = ((1 << (value.end - value.start)) - 1) << value.start;
    let row = 0;
    while ((occupied[row] ?? 0) & mask) row++;
    occupied[row] = (occupied[row] ?? 0) | mask;
    return { ...value, row };
  });
}
export function timedPlacements(events: CalendarEvent[], date: string, zone: string) {
  const values = events.filter(event => !event.start.date && occursOn(event, date, zone)).map(event => {
    const start = endpointLocal(event.start, zone), end = endpointLocal(event.end, zone);
    const from = start.date < date ? 0 : start.minute, to = end.date > date ? 1440 : end.minute;
    return { event, start: from, end: Math.min(1440, Math.max(from + 20, to)), column: 0, columns: 1, span: 1 };
  }).sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id));
  let group: typeof values = [], groupEnd = -1;
  const finish = () => {
    const columns: number[] = [];
    for (const value of group) {
      let col = columns.findIndex(end => end <= value.start);
      if (col < 0) col = columns.length;
      columns[col] = value.end; value.column = col;
    }
    for (const value of group) {
      value.columns = columns.length;
      for (let col = value.column + 1; col < columns.length; col++) {
        if (group.some(other => other.column === col && other.start < value.end && other.end > value.start)) break;
        value.span++;
      }
    }
  };
  for (const value of values) {
    if (value.start >= groupEnd) { finish(); group = []; groupEnd = -1; }
    group.push(value); groupEnd = Math.max(value.end, groupEnd);
  }
  finish(); return values;
}
export function shiftedEventTimes(event: CalendarEvent, date: string, zone: string, minute?: number) {
  if (event.start.date) {
    const days = civilDate(event.start.date).until(civilDate(event.end.date!)).days;
    return { start: { date }, end: { date: addDays(date, days) } };
  }
  const original = endpointLocal(event.start, zone);
  const start = localEndpoint(date, minuteTime(minute ?? original.minute), zone);
  const duration = Temporal.Instant.from(event.end.date_time!).epochMilliseconds - Temporal.Instant.from(event.start.date_time!).epochMilliseconds;
  return { start: { date_time: start.date_time!, time_zone: event.start.time_zone! }, end: { date_time: Temporal.Instant.from(start.date_time!).add({ milliseconds: duration }).toString(), time_zone: event.end.time_zone! } };
}

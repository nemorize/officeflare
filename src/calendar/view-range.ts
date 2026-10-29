import { Temporal } from "@js-temporal/polyfill";
type CalendarView = "day" | "week" | "month" | "agenda";
const civilDate = (date: string) => Temporal.PlainDate.from(date);
const addDays = (date: string, count: number) => civilDate(date).add({ days: count }).toString();
const dateDays = (date: string, count: number) =>
  Array.from({ length: count }, (_, index) => addDays(date, index));
const startOfWeek = (date: string, weekStart: number) =>
  addDays(date, -(((civilDate(date).dayOfWeek % 7) - weekStart + 7) % 7));
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

import type { CalendarView } from "./calendar";
export { calendarStartView } from "../../src/calendar/view-preferences.ts";
export { validCalendarView as calendarView } from "../../src/calendar/view-preferences.ts";
import { validCalendarView as calendarView } from "../../src/calendar/view-preferences.ts";

const storageKey = (account: string) => `officeflare.calendar.view:${account.trim().toLowerCase()}`;

export function readCalendarView(account: string): CalendarView | null {
  if (!account) return null;
  try { return calendarView(localStorage.getItem(storageKey(account))); }
  catch { return null; }
}

export function saveCalendarView(account: string, view: CalendarView) {
  if (!account) return;
  try { localStorage.setItem(storageKey(account), view); }
  catch { /* View navigation still works when browser storage is unavailable. */ }
}

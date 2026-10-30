import { t } from "../../shared/i18n/index.ts";
import { api, ApiError, errorMessage } from "./api";
import type { ApiOptions } from "./api-client";
import { MailOperation } from "./mail-helpers";

export type CalendarView = "day" | "week" | "month" | "agenda";
export type CalendarScope = "single" | "following" | "all";
export interface CalendarRecord {
  id: string;
  data_owner_user_id: string;
  name: string;
  description: string;
  location: string;
  time_zone: string;
  default_visibility: "private" | "public";
  version: number;
  effective_role:
    "free_busy" | "reader" | "writer_without_private" | "writer" | "manager" | "data_owner";
  is_primary: boolean;
  kind: string;
}
export interface CalendarSubscription {
  calendar_id: string;
  selected: boolean;
  hidden: boolean;
  color: string | null;
  name_override: string | null;
  version: number;
  sort_order: number;
}
export interface CalendarPreferences {
  time_zone: string;
  locale: string;
  week_start: number;
  default_view: CalendarView;
  default_duration_minutes: number;
  invitation_policy: string;
  version: number;
  remember_view: boolean;
  last_view: CalendarView | null;
  default_calendar_id: string | null;
  display_options: {
    show_weekends?: boolean;
    show_declined?: boolean;
    show_week_numbers?: boolean;
  };
}
export type CalendarEndpoint =
  | { date: string; date_time?: never; time_zone?: never }
  | { date?: never; date_time: string; time_zone: string };
export interface CalendarEvent {
  id: string;
  calendar_id: string;
  title: string;
  start: CalendarEndpoint;
  end: CalendarEndpoint;
  version: number;
  status: string;
  transparency: "busy" | "free";
  is_redacted: boolean;
  recurrence?: string[];
  description_html?: string;
  location?: { label?: string; address?: string; url?: string };
  visibility?: "default" | "private" | "public";
  organizer?: { user_id: string | null; email_address: string };
  occurrence_key?: string;
  original_start?: CalendarEndpoint;
  is_exception?: boolean;
  invitation_id?: string;
  response_status?: string;
  copy_id?: string;
  color?: string | null;
  guest_permissions?: { can_see_other_guests?: boolean };
}
export interface CalendarAttendee {
  id: string;
  user_id: string | null;
  email_address: string;
  display_name: string | null;
  response_status: string;
  optional: boolean;
  version: number;
  occurrence_key?: string;
}
export interface CalendarAttachment {
  id: string;
  title?: string;
  url?: string;
  drive_item_id?: string;
  content_path?: string;
  mime_type?: string;
  unavailable: boolean;
  version?: number;
}
export interface CalendarBootstrap {
  initial_events?: {
    query: string;
    events: CalendarEvent[];
    next_cursor: string | null;
    error?: { status: number; message: string };
  };
  primary_calendar_id: string;
  calendars: CalendarRecord[];
  subscriptions: CalendarSubscription[];
  preferences: CalendarPreferences;
  capabilities: Record<string, unknown>;
}
export const calendarColors = [
  { value: "#68747d", label: t("libCalendar.graphite") },
  { value: "#648678", label: t("libCalendar.sage") },
  { value: "#887d72", label: t("libCalendar.stone") },
  { value: "#747992", label: t("libCalendar.slate") },
  { value: "#a17670", label: t("libCalendar.clay") },
  { value: "#897a95", label: t("libCalendar.mauve") },
];
export const calendarViews: { value: CalendarView; label: string }[] = [
  { value: "day", label: t("libCalendar.day") },
  { value: "week", label: t("libCalendar.week") },
  { value: "month", label: t("libCalendar.month") },
  { value: "agenda", label: t("libCalendar.schedule") },
];
export const calendarRank = (cal?: CalendarRecord) =>
  cal
    ? ["free_busy", "reader", "writer_without_private", "writer", "manager", "data_owner"].indexOf(
        cal.effective_role,
      ) + 1
    : 0;
export const calendarWritable = (cal?: CalendarRecord) =>
  !!cal && cal.kind !== "external" && calendarRank(cal) >= 3;
export const eventKey = (event: CalendarEvent) =>
  `${event.calendar_id}:${event.id}:${event.occurrence_key ?? ""}`;
export const eventPath = (event: Pick<CalendarEvent, "calendar_id" | "id">) =>
  `/calendars/${encodeURIComponent(event.calendar_id)}/events/${encodeURIComponent(event.id)}`;
export const calendarFailure = (error: unknown) =>
  error instanceof ApiError && error.status === 412
    ? t("libCalendar.thisItemChangedWhileYouWereEditingReloadThe")
    : error instanceof Error && !(error instanceof ApiError) && error.name !== "TypeError"
      ? error.message
      : errorMessage(error);
export function calendarApi<T>(path: string, options: ApiOptions = {}) {
  return api<T>(`/api/calendar${path}`, {
    ...options,
    headers: {
      ...(options.method === "POST" ? new MailOperation().headers(options.body ?? {}) : {}),
      ...options.headers,
    },
  });
}
export async function loadCalendarEvents(
  query: URLSearchParams,
  signal: AbortSignal,
  onPage?: (events: CalendarEvent[]) => void,
  initial?: {
    events: CalendarEvent[];
    next_cursor: string | null;
    error?: { status: number; message: string };
  },
) {
  const events: CalendarEvent[] = [];
  let cursor: string | null = null;
  if (initial?.error) throw new ApiError(initial.error.status, initial.error.message);
  if (initial) {
    signal.throwIfAborted();
    events.push(...initial.events);
    cursor = initial.next_cursor;
    onPage?.([...events]);
    if (!cursor) return events;
  }
  do {
    const page = new URLSearchParams(query);
    page.set("limit", "500");
    if (cursor) page.set("cursor", cursor);
    const result = await calendarApi<{ events: CalendarEvent[]; next_cursor: string | null }>(
      `/events?${page}`,
      { signal },
    );
    signal.throwIfAborted();
    events.push(...result.events);
    cursor = result.next_cursor;
    onPage?.([...events]);
  } while (cursor && !signal.aborted);
  return events;
}
export { plainDescription, descriptionHtml } from "./calendar-format";

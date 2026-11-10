import { t } from "../../shared/i18n/index.ts";
export const calendarSettingsPages = [
  { path: "/calendar/settings", name: t("libCalendarSettings.general") },
  { path: "/calendar/settings/events", name: t("libCalendarSettings.eventsInvitations") },
  { path: "/calendar/settings/calendars", name: t("libCalendarSettings.calendars") },
  { path: "/calendar/settings/working-hours", name: t("libCalendarSettings.workingHours") },
  { path: "/calendar/settings/data", name: t("libCalendarSettings.integrationsData") },
] as const;

import { t } from "../../shared/i18n/index.ts";
export const calendarSettingsPages = [
  { path: "/calendar/settings", name: t("libCalendarSettings.general") },
  { path: "/calendar/settings/events", name: t("libCalendarSettings.eventsInvitations") },
  { path: "/calendar/settings/calendars", name: t("libCalendarSettings.calendars") },
  { path: "/calendar/settings/working-hours", name: t("libCalendarSettings.workingHours") },
  { path: "/calendar/settings/data", name: t("libCalendarSettings.integrationsData") },
] as const;

const regionalFormats = [
  { value: "en-US", label: t("libCalendarSettings.englishUnitedStates") },
  { value: "en-GB", label: t("libCalendarSettings.englishUnitedKingdom") },
  { value: "ko-KR", label: t("libCalendarSettings.text") },
  { value: "ja-JP", label: t("libCalendarSettings.text2") },
  { value: "en", label: t("libCalendarSettings.english") },
] as const;

export function calendarRegionalFormatOptions(savedLocale: string) {
  // Keep the legacy English value mounted while another format is selected.
  // Removing a selected item during the popup transition clears the Select value.
  return !savedLocale || regionalFormats.some((format) => format.value === savedLocale)
    ? regionalFormats
    : [...regionalFormats, { value: savedLocale, label: savedLocale }];
}

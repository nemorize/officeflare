export const calendarSettingsPages = [
  { path: "/calendar/settings", name: "General" },
  { path: "/calendar/settings/events", name: "Events & invitations" },
  { path: "/calendar/settings/calendars", name: "Calendars" },
  { path: "/calendar/settings/working-hours", name: "Working hours" },
  { path: "/calendar/settings/data", name: "Integrations & data" },
] as const;

const regionalFormats = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "ko-KR", label: "한국어 (대한민국)" },
  { value: "ja-JP", label: "日本語 (日本)" },
  { value: "en", label: "English" },
] as const;

export function calendarRegionalFormatOptions(savedLocale: string) {
  // Keep the legacy English value mounted while another format is selected.
  // Removing a selected item during the popup transition clears the Select value.
  return !savedLocale || regionalFormats.some((format) => format.value === savedLocale)
    ? regionalFormats
    : [...regionalFormats, { value: savedLocale, label: savedLocale }];
}

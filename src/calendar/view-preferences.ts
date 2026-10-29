type View = "day" | "week" | "month" | "agenda";
export function validCalendarView(value: unknown): View | null {
  return value === "day" || value === "week" || value === "month" || value === "agenda"
    ? value
    : null;
}
export function calendarStartView(
  requested: unknown,
  preferences?: {
    default_view: string;
    remember_view?: boolean | number;
    last_view?: string | null;
  },
  cached?: View | null,
): View {
  return (
    validCalendarView(requested) ??
    (preferences
      ? ((preferences.remember_view !== false && preferences.remember_view !== 0
          ? (validCalendarView(preferences.last_view) ?? cached)
          : null) ?? validCalendarView(preferences.default_view))
      : cached) ??
    "week"
  );
}

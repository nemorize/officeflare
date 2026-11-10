import { getLocale } from "../../shared/i18n/index.ts";
import type { RegionalPreferences } from "../../shared/regional.ts";

let preferences: RegionalPreferences | null = null;

export function setRegionalPreferences(next: RegionalPreferences | null): boolean {
  const changed =
    !!preferences &&
    !!next &&
    (preferences.time_zone !== next.time_zone ||
      preferences.regional_format !== next.regional_format);
  preferences = next ? { time_zone: next.time_zone, regional_format: next.regional_format } : null;
  return changed;
}

export const getRegionalLocale = () => preferences?.regional_format ?? getLocale();
export const getTimeZone = () => preferences?.time_zone;

export function formatDateTime(
  timestamp: number,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(getRegionalLocale(), {
    timeZone: getTimeZone(),
    ...options,
  }).format(new Date(timestamp * 1000));
}

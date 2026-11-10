import { getLocale } from "../../shared/i18n/index.ts";
import type { LanguagePreference } from "../../shared/i18n/locale.ts";
import type { RegionalPreferences } from "../../shared/regional.ts";
import { browserLanguage } from "./browser-language";
import { setRegionalPreferences } from "./regional";

export function applyAccountPreferences(
  user: Partial<RegionalPreferences> & { language?: LanguagePreference },
) {
  const previousLocale = getLocale();
  const regionalChanged = setRegionalPreferences(
    user.time_zone && user.regional_format
      ? { time_zone: user.time_zone, regional_format: user.regional_format }
      : null,
  );
  browserLanguage.setPreference(user.language);
  // Refresh cached labels and calendar ranges together when the format or zone changes.
  if (regionalChanged && getLocale() === previousLocale) window.location.reload();
}

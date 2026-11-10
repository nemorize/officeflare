import { t } from "../../shared/i18n/index.ts";

export const timeZones = [
  ...new Set([
    "UTC",
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...Intl.supportedValuesOf("timeZone"),
  ]),
];

export function regionalFormatOptions(savedLocale: string) {
  const formats = [
    { value: "en-US", label: t("libCalendarSettings.englishUnitedStates") },
    { value: "en-GB", label: t("libCalendarSettings.englishUnitedKingdom") },
    { value: "ko-KR", label: t("libCalendarSettings.text") },
    { value: "ja-JP", label: t("libCalendarSettings.text2") },
    { value: "en", label: t("libCalendarSettings.english") },
  ];
  // Preserve any existing custom locale while the select popup is open.
  return !savedLocale || formats.some((format) => format.value === savedLocale)
    ? formats
    : [...formats, { value: savedLocale, label: savedLocale }];
}

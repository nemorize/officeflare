export const supportedLocales = ["en", "ko", "ja"] as const;
export type Locale = (typeof supportedLocales)[number];
export type LanguagePreference = "system" | Locale;
export const defaultLocale: Locale = "en";

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && supportedLocales.some((locale) => locale === value);
export const isLanguagePreference = (value: unknown): value is LanguagePreference =>
  value === "system" || isLocale(value);

/** Match regional variants in preference order, then fall back to English. */
export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[] = [],
): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.trim().toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}

export function acceptedLanguages(header: string | null): string[] {
  return (header ?? "")
    .split(",")
    .map((entry, order) => {
      const [language = "", ...parameters] = entry.trim().split(";");
      const parameter = parameters.find((value) => /^\s*q\s*=/i.test(value));
      const quality = parameter === undefined ? 1 : Number(parameter.split("=")[1]);
      return { language, quality, order };
    })
    .filter(
      ({ language, quality }) =>
        /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(language) &&
        Number.isFinite(quality) &&
        quality > 0 &&
        quality <= 1,
    )
    .sort((left, right) => right.quality - left.quality || left.order - right.order)
    .map(({ language }) => language);
}

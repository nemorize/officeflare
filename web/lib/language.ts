import {
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type Locale,
} from "../../shared/i18n/locale.ts";

export function createLanguageStore(environment: {
  languages: () => readonly string[];
  apply: (locale: Locale) => void;
  reload: () => void;
}) {
  let preference: LanguagePreference = "system";
  let locale = resolveLocale(preference, environment.languages());
  let ready = false;
  environment.apply(locale);
  return {
    getPreference: () => preference,
    start: () => {
      ready = true;
    },
    setPreference(value: unknown) {
      preference = isLanguagePreference(value) ? value : "system";
      const next = resolveLocale(preference, environment.languages());
      if (locale === next) return;
      locale = next;
      environment.apply(locale);
      // Reload module-level navigation and editor labels as well as visible components.
      if (ready) environment.reload();
    },
    systemChanged() {
      if (preference === "system") this.setPreference("system");
    },
  };
}

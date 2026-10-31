import { setLocaleResolver, t } from "../../shared/i18n/index.ts";
import { defaultLocale } from "../../shared/i18n/locale.ts";
import { createLanguageStore } from "./language";

let activeLocale = defaultLocale;
setLocaleResolver(() => activeLocale);
export const browserLanguage = createLanguageStore({
  languages: () => (navigator.languages?.length ? navigator.languages : [navigator.language]),
  apply: (locale) => {
    activeLocale = locale;
    document.documentElement.lang = locale;
    document.title = t("shell.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t("shell.description"));
    const fallback = document.querySelector("noscript");
    if (fallback) fallback.textContent = t("shell.enableJavaScript");
  },
  reload: () => window.location.reload(),
});

const systemChanged = () => browserLanguage.systemChanged();
window.addEventListener("languagechange", systemChanged);
if (import.meta.hot)
  import.meta.hot.dispose(() => window.removeEventListener("languagechange", systemChanged));

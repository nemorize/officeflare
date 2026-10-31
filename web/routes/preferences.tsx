import { t } from "../../shared/i18n/index.ts";
import { LanguageSettings } from "../components/language-settings";

export function PreferencesPage() {
  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{t("routesWorkspace.preferences")}</h1>
        <p>{t("routesPreferences.description")}</p>
      </header>
      <LanguageSettings />
    </section>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { t } from "../../shared/i18n/index.ts";
import { isLanguagePreference, type LanguagePreference } from "../../shared/i18n/locale.ts";
import { useAccount } from "./account-context";
import { api, errorMessage, type AccountUser } from "../lib/api";
import { Button, Field, Form, Select, SelectPopup } from "./ui";

export function LanguageSettings() {
  const { user, update } = useAccount();
  const [value, setValue] = useState<LanguagePreference>(user?.language ?? "system");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    setValue(user?.language ?? "system");
  }, [user?.id, user?.language]);
  const items = [
    { value: "system", label: t("language.system") },
    { value: "en", label: t("language.english") },
    { value: "ko", label: t("language.korean") },
    { value: "ja", label: t("language.japanese") },
  ];
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: AccountUser }>("/api/me/language", {
        method: "PUT",
        body: { language: value },
      });
      update(result.user);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Form onSubmit={save} aria-busy={busy}>
      <section className="account-panel">
        <div className="account-panel-header">
          <h2>{t("language.title")}</h2>
        </div>
        <Field.Root name="language">
          <Select.Root
            items={items}
            value={value}
            disabled={!user || busy}
            onValueChange={(next) => {
              if (isLanguagePreference(next)) setValue(next);
            }}
          >
            <Select.Label>{t("language.title")}</Select.Label>
            <Select.Trigger aria-label={t("language.title")}>
              <Select.Value />
            </Select.Trigger>
            <SelectPopup>
              <Select.List>
                {items.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    <Select.ItemText>{item.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </SelectPopup>
          </Select.Root>
          <Field.Description>{t("language.description")}</Field.Description>
        </Field.Root>
        <p className="account-notice">{t("language.applyHint")}</p>
        {error && (
          <p className="account-notice" data-error role="alert">
            {error}
          </p>
        )}
        <div className="account-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={!user || busy || value === user.language}
          >
            {busy ? t("common.saving") : t("common.saveChanges")}
          </Button>
        </div>
      </section>
    </Form>
  );
}

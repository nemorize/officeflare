import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { t } from "../../shared/i18n/index.ts";
import { isLanguagePreference, type LanguagePreference } from "../../shared/i18n/locale.ts";
import { defaultRegionalPreferences } from "../../shared/regional.ts";
import { regionalFormatOptions, timeZones } from "../lib/regional-settings";
import { useAccount } from "./account-context";
import { api, errorMessage, type AccountUser } from "../lib/api";
import { Button, Field, Fieldset, Form, Input, Select, SelectControl, SelectPopup } from "./ui";

export function LanguageSettings() {
  const { user, update } = useAccount();
  const [value, setValue] = useState<LanguagePreference>(user?.language ?? "system");
  const [timeZone, setTimeZone] = useState(user?.time_zone ?? defaultRegionalPreferences.time_zone);
  const [regionalFormat, setRegionalFormat] = useState(
    user?.regional_format ?? defaultRegionalPreferences.regional_format,
  );
  const timeZoneList = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    setValue(user?.language ?? "system");
    setTimeZone(user?.time_zone ?? defaultRegionalPreferences.time_zone);
    setRegionalFormat(user?.regional_format ?? defaultRegionalPreferences.regional_format);
  }, [user?.id, user?.language, user?.time_zone, user?.regional_format]);
  const formats = regionalFormatOptions(
    user?.regional_format ?? defaultRegionalPreferences.regional_format,
  );
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
      const result = await api<{ user: AccountUser }>("/api/me/preferences", {
        method: "PUT",
        body: { language: value, time_zone: timeZone, regional_format: regionalFormat },
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
          <h2>{t("language.sectionTitle")}</h2>
        </div>
        <Fieldset.Root>
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
          </Field.Root>
          <Field.Root name="time_zone">
            <Field.Label>{t("preferences.timeZone")}</Field.Label>
            <Input
              aria-label={t("preferences.timeZone")}
              value={timeZone}
              disabled={!user || busy}
              list={timeZoneList}
              onChange={(event) => setTimeZone(event.target.value)}
              required
            />
            <datalist id={timeZoneList}>
              {timeZones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field.Root>
          <Field.Root name="regional_format">
            <Field.Label>{t("preferences.regionalFormat")}</Field.Label>
            <SelectControl
              aria-label={t("preferences.regionalFormat")}
              value={regionalFormat}
              disabled={!user || busy}
              options={formats}
              onValueChange={(next) => {
                if (formats.some((format) => format.value === next)) setRegionalFormat(next);
              }}
            />
          </Field.Root>
        </Fieldset.Root>
        {error && (
          <p className="account-notice" data-error role="alert">
            {error}
          </p>
        )}
        <div className="account-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={
              !user ||
              busy ||
              (value === user.language &&
                timeZone === user.time_zone &&
                regionalFormat === user.regional_format)
            }
          >
            {busy ? t("common.saving") : t("common.saveChanges")}
          </Button>
        </div>
      </section>
    </Form>
  );
}

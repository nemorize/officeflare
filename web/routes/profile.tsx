import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CheckboxLabel,
  Button,
  Checkbox,
  CheckboxGroup,
  Field,
  Fieldset,
  Form,
  Icon,
  Select,
  SelectPopup,
  TextField,
  useNotifications,
} from "@/components/ui";
import { useAccount } from "../components/account-context";
import { api, errorMessage } from "../lib/api";
import { label, profileChanges, type ProfileField, type ProfileValue } from "../lib/profile";
import { useSession } from "../lib/session";
import { ProfileImageSettings } from "../components/profile-image-settings";

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ProfileField;
  value: ProfileValue;
  onChange: (value: ProfileValue) => void;
}) {
  const title = `${label(field.label, field.key)}${field.required ? " *" : ""}`;
  if (field.editable_by !== "user") {
    const display = Array.isArray(value)
      ? value
          .map((item) => label(field.options?.find((option) => option.value === item)?.label, item))
          .join(", ")
      : typeof value === "boolean"
        ? value
          ? t("common.yes")
          : t("common.no")
        : field.value_type === "select" && typeof value === "string"
          ? label(field.options?.find((option) => option.value === value)?.label, value)
          : String(value ?? t("routesProfile.notSet"));
    return (
      <div className="account-readonly">
        <span className="account-readonly-label">{title}</span>
        <span className="account-readonly-value">{display || t("routesProfile.notSet")}</span>
        <span className="account-readonly-value">
          {t("routesProfile.managedByYourOrganization")}
        </span>
      </div>
    );
  }
  if (field.value_type === "multiselect")
    return (
      <Fieldset.Root>
        <Fieldset.Legend>{title}</Fieldset.Legend>
        <CheckboxGroup
          className="account-field-options"
          value={Array.isArray(value) ? value : []}
          onValueChange={onChange}
          aria-label={label(field.label, field.key)}
        >
          {(field.options ?? []).map((option) => (
            <CheckboxLabel key={option.value}>
              <Checkbox.Root value={option.value}>
                <Checkbox.Indicator>
                  <Icon name="check" width="12" height="12" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {label(option.label, option.value)}
            </CheckboxLabel>
          ))}
        </CheckboxGroup>
      </Fieldset.Root>
    );
  if (field.value_type === "select" || field.value_type === "boolean") {
    const items = [
      ...(!field.required ? [{ value: "", label: t("routesProfile.notSet") }] : []),
      ...(field.value_type === "boolean"
        ? [
            { value: "true", label: t("common.yes") },
            { value: "false", label: t("common.no") },
          ]
        : (field.options ?? []).map((option) => ({
            value: option.value,
            label: label(option.label, option.value),
          }))),
    ];
    return (
      <Field.Root name={field.key}>
        <Select.Root
          items={items}
          value={value === null ? "" : String(value)}
          required={field.required}
          onValueChange={(next) =>
            onChange(!next ? null : field.value_type === "boolean" ? next === "true" : next)
          }
        >
          <Select.Label>{title}</Select.Label>
          <Select.Trigger>
            <Select.Value placeholder={t("routesProfile.selectAnOption")} />
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
    );
  }
  return (
    <TextField
      label={title}
      name={field.key}
      type={
        field.value_type === "number"
          ? "number"
          : field.value_type === "date"
            ? "date"
            : field.value_type === "url"
              ? "url"
              : "text"
      }
      step={field.value_type === "number" ? "any" : undefined}
      required={field.required}
      maxLength={field.value_type === "url" ? 2048 : 4096}
      value={String(value ?? "")}
      onValueChange={onChange}
    />
  );
}

export function ProfilePage() {
  const notify = useNotifications();
  const { user, reload } = useAccount();
  const auth = useSession();
  const [name, setName] = useState("");
  const [definitions, setDefinitions] = useState<ProfileField[]>([]);
  const [values, setValues] = useState<Record<string, ProfileValue>>({});
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const email = user?.email_address ?? auth.session?.email ?? "";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReady(false);
    setError("");
    void Promise.all([
      api<{ display_name: string | null; fields: Record<string, ProfileValue> }>(
        "/api/me/profile",
        { signal: controller.signal },
      ),
      api<{ fields: ProfileField[] }>("/api/me/profile-fields", { signal: controller.signal }),
    ])
      .then(([profile, policies]) => {
        if (controller.signal.aborted) return;
        setName(profile.display_name ?? "");
        setValues(profile.fields);
        setDefinitions(policies.fields);
        setReady(true);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    let fields;
    try {
      if ([...name.trim()].length > 200)
        throw new Error(t("routesProfile.yourDisplayNameMustContainAtMost200Characters"));
      fields = profileChanges(definitions, values);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t("routesProfile.checkYourProfileInformation"),
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await api("/api/me/profile", {
        method: "PATCH",
        body: { display_name: name.trim() || null, fields },
      });
      notify.success(t("routesProfile.yourProfileHasBeenSaved"));
      await reload().catch(() => {});
    } catch (failure) {
      notify.error(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{t("routesProfile.profile")}</h1>
        <p>{t("routesProfile.manageYourPersonalInformation")}</p>
      </header>
      <ProfileImageSettings />
      {loading ? (
        <p className="account-loading" role="status">
          {t("routesProfile.loadingYourProfile")}
        </p>
      ) : !ready ? (
        <section className="account-panel">
          <p className="account-notice" data-error role="alert">
            {error}
          </p>
        </section>
      ) : (
        <>
          <Form onSubmit={save} aria-busy={busy}>
            <section className="account-panel">
              <div className="account-panel-header">
                <h2>{t("routesProfile.personalInformation")}</h2>
              </div>
              <Fieldset.Root disabled={busy}>
                <TextField
                  label={t("routesProfile.displayName")}
                  name="display_name"
                  autoComplete="name"
                  value={name}
                  onValueChange={setName}
                  description={t("routesProfile.theNameShownInYourWorkspace")}
                />
                <TextField
                  label={t("common.email")}
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  readOnly
                  description={t("routesProfile.contactYourAdministratorToChangeYourEmailAddress")}
                />
                {definitions.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? null}
                    onChange={(value) =>
                      setValues((current) => ({ ...current, [field.key]: value }))
                    }
                  />
                ))}
              </Fieldset.Root>
              {error && (
                <p className="account-notice" data-error role="alert">
                  <Icon name="info" />
                  {error}
                </p>
              )}
              <div className="account-actions">
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? t("common.saving") : t("common.saveChanges")}
                </Button>
              </div>
            </section>
          </Form>
        </>
      )}
    </section>
  );
}

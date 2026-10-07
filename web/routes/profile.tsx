import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Checkbox, CheckboxGroup, Field, Fieldset, Form, Icon, Select, SelectPopup, TextField } from "@/components/ui";
import { useAccount } from "../components/account-context";
import { api, errorMessage } from "../lib/api";
import { label, profileChanges, type ProfileField, type ProfileValue } from "../lib/profile";
import { useSession } from "../lib/session";
import { ProfileImageSettings } from "../components/profile-image-settings";

function FieldControl({ field, value, onChange }: { field: ProfileField; value: ProfileValue; onChange: (value: ProfileValue) => void }) {
  const title = `${label(field.label, field.key)}${field.required ? " *" : ""}`;
  if (field.editable_by !== "user") {
    const display = Array.isArray(value) ? value.map((item) => label(field.options?.find((option) => option.value === item)?.label, item)).join(", ") :
      typeof value === "boolean" ? (value ? "Yes" : "No") : field.value_type === "select" && typeof value === "string"
        ? label(field.options?.find((option) => option.value === value)?.label, value) : String(value ?? "Not set");
    return <div className="account-readonly"><span className="account-readonly-label">{title}</span><span className="account-readonly-value">{display || "Not set"}</span>
      <span className="account-readonly-value">Managed by your organization</span></div>;
  }
  if (field.value_type === "multiselect") return <Fieldset.Root>
    <Fieldset.Legend>{title}</Fieldset.Legend>
    <CheckboxGroup className="account-field-options" value={Array.isArray(value) ? value : []} onValueChange={onChange} aria-label={label(field.label, field.key)}>
      {(field.options ?? []).map((option) => <label key={option.value}><Checkbox.Root value={option.value}><Checkbox.Indicator><Icon name="check" width="12" height="12" /></Checkbox.Indicator></Checkbox.Root>{label(option.label, option.value)}</label>)}
    </CheckboxGroup>
  </Fieldset.Root>;
  if (field.value_type === "select" || field.value_type === "boolean") {
    const items = [
      ...(!field.required ? [{ value: "", label: "Not set" }] : []),
      ...(field.value_type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] :
        (field.options ?? []).map((option) => ({ value: option.value, label: label(option.label, option.value) }))),
    ];
    return <Field.Root name={field.key}><Select.Root items={items} value={value === null ? "" : String(value)} required={field.required}
      onValueChange={(next) => onChange(!next ? null : field.value_type === "boolean" ? next === "true" : next)}>
      <Select.Label>{title}</Select.Label><Select.Trigger><Select.Value placeholder="Select an option" /></Select.Trigger>
      <SelectPopup><Select.List>{items.map((item) => <Select.Item key={item.value} value={item.value}><Select.ItemText>{item.label}</Select.ItemText></Select.Item>)}</Select.List></SelectPopup>
    </Select.Root></Field.Root>;
  }
  return <TextField label={title} name={field.key} type={field.value_type === "number" ? "number" : field.value_type === "date" ? "date" : field.value_type === "url" ? "url" : "text"}
    step={field.value_type === "number" ? "any" : undefined} required={field.required} maxLength={field.value_type === "url" ? 2048 : 4096}
    value={String(value ?? "")} onValueChange={onChange} />;
}

export function ProfilePage() {
  const { user, reload } = useAccount();
  const auth = useSession();
  const [name, setName] = useState("");
  const [definitions, setDefinitions] = useState<ProfileField[]>([]);
  const [values, setValues] = useState<Record<string, ProfileValue>>({});
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const email = user?.email_address ?? auth.session?.email ?? "";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReady(false); setError(""); setSuccess("");
    void Promise.all([
      api<{ display_name: string | null; fields: Record<string, ProfileValue> }>("/api/me/profile", { signal: controller.signal }),
      api<{ fields: ProfileField[] }>("/api/me/profile-fields", { signal: controller.signal }),
    ]).then(([profile, policies]) => {
      if (controller.signal.aborted) return;
      setName(profile.display_name ?? ""); setValues(profile.fields); setDefinitions(policies.fields);
      setReady(true);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(""); setSuccess("");
    let fields;
    try {
      if ([...name.trim()].length > 200) throw new Error("Your display name must contain at most 200 characters.");
      fields = profileChanges(definitions, values);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Check your profile information."); return; }
    inFlight.current = true; setBusy(true);
    try {
      await api("/api/me/profile", { method: "PATCH", body: { display_name: name.trim() || null, fields } });
      setSuccess("Your profile has been saved.");
      await reload().catch(() => {});
    } catch (failure) { setError(errorMessage(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="account-page">
    <header className="account-page-header"><h1>Profile</h1><p>Manage your personal information.</p></header>
    <ProfileImageSettings />
    {loading ? <p className="account-loading" role="status">Loading your profile…</p> : !ready ? <section className="account-panel">
      <p className="account-notice" data-error role="alert">{error}</p><Button onClick={() => setRevision((current) => current + 1)}>Try again</Button>
    </section> : <>
      <Form onSubmit={save} aria-busy={busy}>
        <section className="account-panel">
          <div className="account-panel-header"><h2>Personal information</h2></div>
          <Fieldset.Root disabled={busy}>
            <TextField label="Display name" name="display_name" autoComplete="name" value={name} onValueChange={setName} description="The name shown in your workspace." />
            <TextField label="Email" name="email" type="email" autoComplete="email" value={email} readOnly description="Contact your administrator to change your email address." />
            {definitions.map((field) => <FieldControl key={field.key} field={field} value={values[field.key] ?? null}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />)}
          </Fieldset.Root>
          {error && <p className="account-notice" data-error role="alert"><Icon name="info" />{error}</p>}
          {success && <p className="account-notice" data-success role="status"><Icon name="check" />{success}</p>}
          <div className="account-actions"><Button type="button" disabled={busy} onClick={() => setRevision((current) => current + 1)}>Reload</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button></div>
        </section>
      </Form>
    </>}
  </section>;
}

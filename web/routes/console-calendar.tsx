import { useRef, useState } from "react";
import { t } from "../../shared/i18n/index.ts";
import { ApiError, api, errorMessage } from "../lib/api";
import type { CalendarAdminSettings, CalendarWorkspaceSettings } from "../lib/calendar-admin";
import { useAccess } from "../components/console-access";
import { Check, Notice, useResource } from "../components/console-shared";
import {
  ConsoleFieldset,
  ConsoleForm,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleSection,
  ConsoleSelectField,
  ConsoleSettingsHeader,
  ConsoleState,
} from "../components/console-settings";
import { Button, useNotifications } from "../components/ui";

const endpoint = "/api/calendar/admin/settings";

export function CalendarConsolePage() {
  const resource = useResource<CalendarAdminSettings>(endpoint);
  return (
    <section className="account-page console-page console-settings" data-ui-theme="neutral">
      <ConsoleSettingsHeader
        title={t("libWorkspaceNavigation.calendar")}
        description={t("consoleCalendar.description")}
      />
      <ConsoleState loading={resource.loading} error={resource.error} kind="form" />
      {resource.data && (
        <CalendarWorkspaceForm
          key={resource.data.settings.version}
          data={resource.data}
          onSaved={(settings) => resource.update({ ...resource.data!, settings })}
        />
      )}
    </section>
  );
}

function CalendarWorkspaceForm({
  data,
  onSaved,
}: {
  data: CalendarAdminSettings;
  onSaved: (settings: CalendarWorkspaceSettings) => void;
}) {
  const access = useAccess(),
    notify = useNotifications(),
    inFlight = useRef(false);
  const [value, setValue] = useState(data.settings),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editable = access.permissions.includes("admin.calendar.settings.manage"),
    disabled = busy || !editable,
    dirty = JSON.stringify(value) !== JSON.stringify(data.settings);
  const update = <K extends keyof CalendarWorkspaceSettings>(
    key: K,
    next: CalendarWorkspaceSettings[K],
  ) => setValue((current) => ({ ...current, [key]: next }));
  return (
    <ConsoleForm
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!editable || !dirty || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError("");
        try {
          const result = await api<{ settings: CalendarWorkspaceSettings }>(endpoint, {
            method: "PATCH",
            body: {
              version: value.version,
              internal_sharing_enabled: !!value.internal_sharing_enabled,
              external_sharing_enabled: !!value.external_sharing_enabled,
              public_link_password_required: !!value.public_link_password_required,
              public_link_max_days: value.public_link_max_days,
              ...(value.system_address_id !== data.settings.system_address_id
                ? { system_address_id: value.system_address_id }
                : {}),
            },
          });
          onSaved(result.settings);
          notify.success(t("consoleCalendar.saved"));
        } catch (failure) {
          setError(errorMessage(failure));
          if (failure instanceof ApiError && failure.status === 403) access.refresh();
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      <Notice error={error} />
      <ConsoleFieldset disabled={disabled} sections>
        <ConsoleSection title={t("consoleCalendar.sharing")}>
          <div className="console-form-fields">
            <Check
              disabled={disabled}
              checked={!!value.internal_sharing_enabled}
              onChange={(checked) => update("internal_sharing_enabled", Number(checked))}
            >
              {t("consoleCalendar.internalSharing")}
            </Check>
            <Check
              disabled={disabled}
              checked={!!value.external_sharing_enabled}
              onChange={(checked) => update("external_sharing_enabled", Number(checked))}
            >
              {t("consoleCalendar.externalSharing")}
            </Check>
            <Check
              disabled={disabled}
              checked={!!value.public_link_password_required}
              onChange={(checked) => update("public_link_password_required", Number(checked))}
            >
              {t("consoleCalendar.passwordRequired")}
            </Check>
            <ConsoleInput
              disabled={disabled}
              label={t("consoleCalendar.maxLinkDays")}
              type="number"
              min={1}
              max={365}
              step={1}
              required
              value={value.public_link_max_days}
              onValueChange={(next) => update("public_link_max_days", Number(next))}
            />
          </div>
        </ConsoleSection>
        <ConsoleSection
          title={t("consoleCalendar.sender")}
          description={t("consoleCalendar.senderHint")}
        >
          <ConsoleSelectField
            disabled={disabled}
            label={t("consoleCalendar.senderAddress")}
            value={value.system_address_id ?? ""}
            onChange={(next) => update("system_address_id", next || null)}
            options={[
              { value: "", label: t("consoleCalendar.noSender") },
              ...data.sending_addresses.map((address) => ({
                value: address.id,
                label: address.email_address,
              })),
              ...(value.system_address_id &&
              !data.sending_addresses.some((address) => address.id === value.system_address_id)
                ? [
                    {
                      value: value.system_address_id,
                      label: t("consoleCalendar.unavailableSender"),
                    },
                  ]
                : []),
            ]}
          />
        </ConsoleSection>
      </ConsoleFieldset>
      {editable && (
        <ConsoleFormActions>
          <Button disabled={busy || !dirty} onClick={() => setValue(data.settings)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? t("common.saving") : t("common.saveChanges")}
          </Button>
        </ConsoleFormActions>
      )}
    </ConsoleForm>
  );
}

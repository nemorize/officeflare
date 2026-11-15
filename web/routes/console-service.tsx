import { useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { enumLabel } from "../../shared/i18n/labels.ts";
import type { ConsoleService, ServiceSettings, SettingValue } from "../../shared/console-settings";
import { api, errorMessage, ApiError } from "../lib/api";
import {
  metricLabels,
  serviceTabs,
  serviceTitle,
  settingsReadPermission,
  settingsWritePermission,
  type AdminField,
  type AdminTab,
} from "../lib/service-admin";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, adminDate, useResource } from "../components/console-shared";
import {
  ConsoleFilters,
  ConsoleForm,
  ConsoleFieldset,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleMetrics,
  ConsoleSection,
  ConsoleSelectField,
  ConsoleSettingsHeader,
  ConsoleSettingsLayout,
  ConsoleState,
  ConsoleTable,
} from "../components/console-settings";
import { Button, Icon, useNotifications } from "../components/ui";
import { NotificationSettingsPanel } from "./console-notifications";

export function ServiceConsolePage({ service }: { service: ConsoleService }) {
  const { page } = useParams(),
    navigate = useNavigate(),
    { permissions } = useAccess();
  const tabs = serviceTabs[service].filter((tab) =>
    tab.permissions.some((permission) => permissions.includes(permission)),
  );
  if (!page)
    return tabs[0] ? (
      <Navigate to={`/console/${service}/${tabs[0].page}`} replace />
    ) : (
      <AccessDenied />
    );
  const current = tabs.find((tab) => tab.page === page);
  if (!current) return <AccessDenied />;
  return (
    <ConsoleSettingsLayout
      title={serviceTitle(service)}
      description={
        service === "general"
          ? t("consoleAdmin.generalHint")
          : service === "calendar"
            ? t("consoleAdmin.calendarHint")
            : service === "contacts"
              ? t("consoleAdmin.contactsPrivacy")
              : t("consoleAdmin.wikiPrivacy")
      }
      pages={tabs.map((tab) => ({ path: tab.page, name: t(tab.label) }))}
      selected={page}
      onNavigate={(next) => navigate(`/console/${service}/${next}`)}
      navigationLabel={t("consoleAdmin.navigation")}
    >
      <AdminContents key={`${service}/${page}`} service={service} tab={current} />
    </ConsoleSettingsLayout>
  );
}
function AdminContents({ service, tab }: { service: ConsoleService; tab: AdminTab }) {
  const { permissions } = useAccess();
  if (service === "general" && tab.page === "notifications") return <NotificationSettingsPanel />;
  return (
    <>
      <ConsoleSettingsHeader title={t(tab.label)} description={t(tab.description)} />
      {tab.page === "overview" && <Overview service={service} />}
      {tab.fields && permissions.includes(settingsReadPermission(service)) && (
        <PolicySettings service={service} fields={tab.fields} />
      )}
      {tab.records && permissions.includes(tab.records.permission) && (
        <Records service={service} tab={tab} />
      )}
    </>
  );
}
function Overview({ service }: { service: ConsoleService }) {
  const resource = useResource<{ summary: Record<string, number> }>(
    `/api/console/${service}/overview`,
  );
  return (
    <>
      <ConsoleState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {resource.data && (
        <ConsoleMetrics
          items={Object.entries(resource.data.summary).map(([key, value]) => ({
            label: metricLabels[key] ? t(metricLabels[key]) : key,
            value: value.toLocaleString(),
          }))}
        />
      )}
    </>
  );
}
type SettingResponse = {
  settings:
    | ServiceSettings
    | (Record<string, SettingValue> & { version: number; updated_at: number | null });
  sending_addresses?: { id: string; email_address: string }[];
};
function PolicySettings({ service, fields }: { service: ConsoleService; fields: AdminField[] }) {
  const resource = useResource<SettingResponse>(
    service === "calendar" ? "/api/calendar/admin/settings" : `/api/console/${service}/settings`,
  );
  const data = resource.data;
  const settings = data
    ? service === "calendar"
      ? {
          values: data.settings as Record<string, SettingValue>,
          version: data.settings.version,
          updated_at: data.settings.updated_at,
        }
      : (data.settings as ServiceSettings)
    : null;
  return (
    <>
      <ConsoleState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
        kind="form"
      />
      {settings && data && (
        <SettingsForm
          key={settings.version}
          service={service}
          fields={fields}
          settings={settings}
          addresses={data.sending_addresses ?? []}
          onSaved={resource.reload}
        />
      )}
    </>
  );
}
function SettingsForm({
  service,
  fields,
  settings,
  addresses,
  onSaved,
}: {
  service: ConsoleService;
  fields: AdminField[];
  settings: ServiceSettings;
  addresses: { id: string; email_address: string }[];
  onSaved: () => void;
}) {
  const access = useAccess(),
    notify = useNotifications(),
    running = useRef(false);
  const initial = Object.fromEntries(
    fields.map((field) => [
      field.key,
      field.kind === "checkbox" ? !!settings.values[field.key] : (settings.values[field.key] ?? ""),
    ]),
  );
  const [value, setValue] = useState<Record<string, SettingValue>>(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editable = access.permissions.includes(settingsWritePermission(service)),
    disabled = busy || !editable,
    dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const update = (key: string, next: SettingValue) => setValue((old) => ({ ...old, [key]: next }));
  return (
    <ConsoleForm
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!editable || !dirty || running.current) return;
        running.current = true;
        setBusy(true);
        setError("");
        try {
          const changed = Object.fromEntries(
            Object.entries(value)
              .filter(([key, next]) => next !== initial[key])
              .map(([key, next]) => [key, key === "system_address_id" && !next ? null : next]),
          );
          await api(
            service === "calendar"
              ? "/api/calendar/admin/settings"
              : `/api/console/${service}/settings`,
            { method: "PATCH", body: { version: settings.version, ...changed } },
          );
          notify.success(t("consoleAdmin.saved"));
          onSaved();
          if (service === "general")
            window.dispatchEvent(new Event("workspace-configuration-changed"));
        } catch (failure) {
          setError(errorMessage(failure));
          if (failure instanceof ApiError && failure.status === 403) access.refresh();
        } finally {
          running.current = false;
          setBusy(false);
        }
      }}
    >
      <ConsoleFieldset sections disabled={disabled}>
        <ConsoleSection title={t("consoleAdmin.policySettings")}>
          <div className="console-form-fields">
            {fields.map((field) => {
              if (field.kind === "checkbox")
                return (
                  <Check
                    key={field.key}
                    checked={!!value[field.key]}
                    disabled={disabled}
                    onChange={(next) => update(field.key, next)}
                  >
                    {t(field.label)}
                  </Check>
                );
              if (field.kind === "select") {
                const options =
                  field.key === "system_address_id"
                    ? [
                        { value: "", label: t("consoleCalendar.noSender") },
                        ...addresses.map((address) => ({
                          value: address.id,
                          label: address.email_address,
                        })),
                      ]
                    : [...(field.options ?? [])];
                const selected = String(value[field.key] ?? "");
                if (selected && !options.some((option) => option.value === selected))
                  options.push({
                    value: selected,
                    label:
                      field.key === "system_address_id"
                        ? t("consoleCalendar.unavailableSender")
                        : selected,
                  });
                return (
                  <div key={field.key} className="console-form-fields">
                    <ConsoleSelectField
                      label={t(field.label)}
                      value={selected}
                      disabled={disabled}
                      onChange={(next) => update(field.key, next)}
                      options={options}
                    />
                    {field.hint && <p className="console-subtext">{t(field.hint)}</p>}
                  </div>
                );
              }
              return (
                <ConsoleInput
                  key={field.key}
                  label={t(field.label)}
                  hint={field.hint ? t(field.hint) : undefined}
                  type={field.kind === "number" ? "number" : field.kind === "url" ? "url" : "text"}
                  required={field.key !== "support_url"}
                  disabled={disabled}
                  min={field.min}
                  max={field.max}
                  step={field.kind === "number" ? 1 : undefined}
                  value={String(value[field.key] ?? "")}
                  onValueChange={(next) =>
                    update(field.key, field.kind === "number" ? Number(next) : next)
                  }
                />
              );
            })}
          </div>
        </ConsoleSection>
      </ConsoleFieldset>
      <ConsoleState loading={false} error={error} retry={onSaved} />
      <ConsoleFormActions
        meta={
          settings.updated_at
            ? t("consoleSettings.lastUpdated", { date: adminDate(settings.updated_at) })
            : undefined
        }
      >
        {editable && (
          <>
            <Button disabled={busy || !dirty} onClick={() => setValue(initial)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !dirty}>
              {busy ? t("common.saving") : t("common.saveChanges")}
            </Button>
          </>
        )}
      </ConsoleFormActions>
    </ConsoleForm>
  );
}
function Records({ service, tab }: { service: ConsoleService; tab: AdminTab }) {
  const [query, setQuery] = useState(""),
    [cursors, setCursors] = useState<(string | null)[]>([null]);
  const resource = useResource<{ items: Record<string, unknown>[]; next_cursor: string | null }>(
    `/api/console/${service}/${tab.page}?q=${encodeURIComponent(query)}${cursors.at(-1) ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ""}`,
  );
  const columns = tab.records!.columns;
  return (
    <div className="console-records-section">
      <ConsoleFilters>
        <ConsoleInput
          type="search"
          label={t("consoleSettings.search")}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setCursors([null]);
          }}
        />
        <Button variant="ghost" onClick={resource.reload}>
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleFilters>
      <ConsoleTable
        headings={columns.map((column) => t(column.label))}
        resource={{
          ...resource,
          page: cursors.length,
          previous: () => setCursors((old) => old.slice(0, -1)),
          next: () => {
            if (resource.data?.next_cursor)
              setCursors((old) => [...old, resource.data!.next_cursor]);
          },
        }}
      >
        {resource.data?.items.map((item, index) => (
          <tr key={String(item.id ?? index)}>
            {columns.map((column) => (
              <td key={column.key}>
                {column.kind === "date" ? (
                  adminDate(
                    typeof item[column.key] === "number" ? (item[column.key] as number) : null,
                  )
                ) : column.kind === "status" ? (
                  <span className="console-badge" data-muted={item[column.key] !== "active"}>
                    {enumLabel(String(item[column.key] ?? ""))}
                  </span>
                ) : tab.page === "activity" && column.key === "name" ? (
                  enumLabel(String(item[column.key] ?? "").split(":")[0])
                ) : typeof item[column.key] === "number" ? (
                  (item[column.key] as number).toLocaleString()
                ) : (
                  String(item[column.key] ?? "—")
                )}
              </td>
            ))}
          </tr>
        ))}
      </ConsoleTable>
    </div>
  );
}

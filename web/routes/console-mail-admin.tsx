import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { enumLabel } from "../../shared/i18n/labels.ts";
import { api } from "../lib/api";
import { formatBytes } from "../lib/drive";
import type { DomainProvider } from "../lib/mail";
import type {
  AdminMailbox,
  MailAdminActivity,
  MailFlow,
  MailPolicy,
  ProviderConnection,
} from "../lib/mail-admin";
import { useAccess } from "../components/console-access";
import { Check, ConsolePageHeader, adminDate } from "../components/console-shared";
import { Button, useNotifications } from "../components/ui";
import {
  MailField,
  MailFieldset,
  MailForm,
  MailInput,
  MailModal,
  MailNotice,
  MailSection,
  MailSelect,
  MailState,
  useMailAction,
  useMailResource,
} from "../components/mail-common";

interface Page<T> {
  items: T[];
  next_cursor: string | null;
  tracking_since?: number;
}
function useAdminPage<T>(path: string, filters: Record<string, string>) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const signature = JSON.stringify(filters),
    [previous, setPrevious] = useState(signature);
  if (signature !== previous) {
    setPrevious(signature);
    setCursors([null]);
  }
  const params = new URLSearchParams({
    ...filters,
    limit: "25",
    ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}),
  });
  const resource = useMailResource<Page<T>>(
    `/api/mail/admin/${path}?${params}`,
    0,
    path === "flow",
  );
  return {
    ...resource,
    page: cursors.length,
    previous: () => setCursors((current) => current.slice(0, -1)),
    next: () => {
      if (resource.data?.next_cursor)
        setCursors((current) => [...current, resource.data!.next_cursor]);
    },
  };
}
function AdminTable<T>({
  resource,
  headings,
  children,
}: {
  resource: ReturnType<typeof useAdminPage<T>>;
  headings: string[];
  children: ReactNode;
}) {
  return (
    <>
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
        kind="list"
      />
      {resource.data && (
        <section className="account-panel console-list-panel">
          <div className="console-table-scroll">
            <table className="console-table">
              <thead>
                <tr>
                  {headings.map((heading, index) => (
                    <th key={index} scope="col">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{children}</tbody>
            </table>
            {!resource.data.items.length && (
              <p className="console-empty">{t("mailAdmin.noRecords")}</p>
            )}
          </div>
          <div className="console-pagination">
            <span>{t("mailAdmin.page", { page: resource.page })}</span>
            <div>
              <Button
                size="sm"
                disabled={resource.page === 1 || resource.loading}
                onClick={resource.previous}
              >
                {t("common.previous")}
              </Button>
              <Button
                size="sm"
                disabled={!resource.data.next_cursor || resource.loading}
                onClick={resource.next}
              >
                {t("common.next")}
              </Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <MailField label={label}>
      <MailSelect value={value} onValueChange={onChange} options={options} />
    </MailField>
  );
}
function Reload({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button size="sm" onClick={onClick} disabled={disabled}>
      {t("mailAdmin.refresh")}
    </Button>
  );
}
function DateFilters({
  after,
  before,
  onAfter,
  onBefore,
}: {
  after: string;
  before: string;
  onAfter: (value: string) => void;
  onBefore: (value: string) => void;
}) {
  return (
    <>
      <MailInput
        label={t("mailAdmin.fromDate")}
        type="date"
        value={after}
        max={before || undefined}
        onChange={(event) => onAfter(event.target.value)}
      />
      <MailInput
        label={t("mailAdmin.toDate")}
        type="date"
        value={before}
        min={after || undefined}
        onChange={(event) => onBefore(event.target.value)}
      />
    </>
  );
}
const timestamp = (value: string, end = false) =>
  value
    ? String(Math.floor(new Date(`${value}T00:00:00`).getTime() / 1000) + (end ? 86400 : 0))
    : "";
const dateParams = (after: string, before: string) => ({
  ...(after ? { after: timestamp(after) } : {}),
  ...(before ? { before: timestamp(before, true) } : {}),
});

export function MailOverview() {
  const resource = useMailResource<{
    summary: Record<
      | "domains"
      | "mailboxes"
      | "shared_mailboxes"
      | "disabled_mailboxes"
      | "enabled_providers"
      | "measured_mailboxes"
      | "database_bytes"
      | "attachment_bytes",
      number
    >;
    flow: Record<string, number>;
    tracking_since: number;
  }>("/api/mail/admin/overview");
  const data = resource.data;
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.overview")}
        description={t("mailAdmin.overviewDescription")}
      >
        <Reload onClick={resource.reload} disabled={resource.loading} />
      </ConsolePageHeader>
      <MailState
        loading={resource.loading && !data}
        error={resource.error}
        retry={resource.reload}
      />
      {data && (
        <>
          <div className="console-drive-summary-grid">
            {[
              [t("mailAdmin.domains"), data.summary.domains],
              [t("mailAdmin.mailboxes"), data.summary.mailboxes],
              [t("mailAdmin.shared"), data.summary.shared_mailboxes],
              [t("mailAdmin.disabled"), data.summary.disabled_mailboxes],
              [t("mailAdmin.enabledProviders"), data.summary.enabled_providers],
            ].map(([label, value]) => (
              <section className="account-panel" key={label}>
                <div className="account-panel-header">
                  <h3>{label}</h3>
                </div>
                <p className="console-mail-metric">{value}</p>
              </section>
            ))}
          </div>
          <MailSection
            title={t("mailAdmin.last24Hours")}
            description={t("mailAdmin.trackingSince", { date: adminDate(data.tracking_since) })}
          >
            <div className="console-mail-totals">
              {[
                [t("mailAdmin.received"), data.flow.received],
                [t("mailAdmin.sent"), data.flow.sent],
                [t("mailAdmin.pending"), data.flow.pending],
                [t("mailAdmin.failed"), data.flow.failed],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </MailSection>
          <MailSection
            title={t("mailAdmin.storage")}
            description={t("mailAdmin.storageCoverage", {
              measured: data.summary.measured_mailboxes,
              total: data.summary.mailboxes,
            })}
          >
            <div className="console-mail-totals">
              <div>
                <span>{t("mailAdmin.databaseBytes")}</span>
                <strong>{formatBytes(data.summary.database_bytes)}</strong>
              </div>
              <div>
                <span>{t("mailAdmin.attachmentBytes")}</span>
                <strong>{formatBytes(data.summary.attachment_bytes)}</strong>
              </div>
            </div>
          </MailSection>
        </>
      )}
    </>
  );
}

export function MailboxDirectory() {
  const { permissions } = useAccess(),
    [search, setSearch] = useState(""),
    [kind, setKind] = useState(""),
    [status, setStatus] = useState("");
  const resource = useAdminPage<AdminMailbox>("mailboxes", { q: search, kind, status });
  const [measuring, setMeasuring] = useState<string | null>(null),
    action = useMailAction();
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.mailboxes")}
        description={t("mailAdmin.mailboxesDescription")}
      >
        {permissions.includes("admin.mail.mailboxes.manage") && (
          <Button
            nativeButton={false}
            render={<Link to="/console/mail/mailboxes/new" />}
            variant="primary"
          >
            {t("routesConsoleSharedMailboxes.newSharedMailbox")}
          </Button>
        )}
      </ConsolePageHeader>
      <div className="console-mail-filters">
        <MailInput
          label={t("mailAdmin.searchMailboxes")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <SelectFilter
          label={t("mailAdmin.kind")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "", label: t("mailAdmin.allMailboxes") },
            { value: "personal", label: t("mailAdmin.personal") },
            { value: "shared", label: t("mailAdmin.shared") },
          ]}
        />
        <SelectFilter
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("mailAdmin.allStatuses") },
            ...["active", "disabled", "provisioning"].map((value) => ({
              value,
              label: enumLabel(value),
            })),
          ]}
        />
        <Reload onClick={resource.reload} disabled={resource.loading} />
      </div>
      <MailNotice error={action.error} />
      <AdminTable
        resource={resource}
        headings={[
          t("mailAdmin.mailbox"),
          t("mailAdmin.owner"),
          t("common.status"),
          t("mailAdmin.storage"),
          t("common.actions"),
        ]}
      >
        {resource.data?.items.map((box) => (
          <tr key={box.id}>
            <td>
              <Link to={`/console/mail/mailboxes/${box.id}`}>
                <strong>{box.name}</strong>
                <small className="console-subtext">
                  {box.email_address || t("routesConsoleSharedMailboxes.addressNotSet")}
                </small>
              </Link>
              <small className="console-subtext">
                {box.kind === "shared" ? t("mailAdmin.shared") : t("mailAdmin.personal")}
              </small>
            </td>
            <td>
              {box.owner_name || box.owner_email}
              <small className="console-subtext">{box.owner_name && box.owner_email}</small>
              {box.kind === "shared" && (
                <small className="console-subtext">
                  {t("mailAdmin.members", { count: box.member_count })}
                </small>
              )}
            </td>
            <td>{enumLabel(box.status)}</td>
            <td>
              {box.database_bytes === null ? (
                t("mailAdmin.notMeasured")
              ) : (
                <>
                  <span>
                    {t("mailAdmin.databaseSize", { size: formatBytes(box.database_bytes) })}
                  </span>
                  <small className="console-subtext">
                    {t("mailAdmin.messageCount", { count: box.message_count ?? 0 })}
                  </small>
                  <small className="console-subtext">{adminDate(box.storage_updated_at)}</small>
                </>
              )}
            </td>
            <td>
              <div className="console-mail-row-actions">
                <Button
                  nativeButton={false}
                  render={<Link to={`/console/mail/mailboxes/${box.id}`} />}
                  size="sm"
                >
                  {t("routesConsoleSharedMailboxes.view")}
                </Button>
                <Button
                  size="sm"
                  disabled={!!measuring || box.status === "provisioning"}
                  aria-label={t("mailAdmin.measureMailbox", { name: box.name })}
                  onClick={() => {
                    setMeasuring(box.id);
                    void action.run(async () => {
                      try {
                        await api(`/api/mail/admin/mailboxes/${box.id}/storage`);
                        resource.reload();
                      } finally {
                        setMeasuring(null);
                      }
                    });
                  }}
                >
                  {measuring === box.id ? t("common.loading") : t("mailAdmin.measure")}
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}

export function MailProviders() {
  const { permissions } = useAccess(),
    manage = permissions.includes("admin.mail.providers.manage");
  const resource = useMailResource<{ connections: ProviderConnection[] }>(
    "/api/mail/provider-connections",
  );
  const catalog = useMailResource<{ providers: DomainProvider[] }>("/api/mail/provider-catalog");
  const [editing, setEditing] = useState<ProviderConnection | "new" | null>(null);
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.providers")}
        description={t("mailAdmin.providersDescription")}
      >
        {manage && (
          <Button variant="primary" disabled={!catalog.data} onClick={() => setEditing("new")}>
            {t("mailAdmin.addProvider")}
          </Button>
        )}
      </ConsolePageHeader>
      <MailState
        loading={(resource.loading && !resource.data) || (catalog.loading && !catalog.data)}
        error={resource.error || catalog.error}
        retry={() => {
          resource.reload();
          catalog.reload();
        }}
      />
      <div className="mail-domain-grid">
        {resource.data?.connections.map((connection) => (
          <article className="mail-domain-card" key={connection.id}>
            <h3>{connection.name}</h3>
            <p className="mail-hint">
              {catalog.data?.providers.find((entry) => entry.provider === connection.provider)
                ?.label ?? connection.provider}
            </p>
            <div className="mail-actions">
              <span className="mail-badge">
                {connection.enabled ? t("common.enabled") : t("common.disabled")}
              </span>
              <span className="mail-badge">
                {connection.provider === "cloudflare"
                  ? t("mailAdmin.platformConnection")
                  : connection.secret_configured
                    ? t("mailAdmin.credentialsConfigured")
                    : t("mailAdmin.credentialsMissing")}
              </span>
            </div>
            {manage && (
              <Button size="sm" disabled={!catalog.data} onClick={() => setEditing(connection)}>
                {t("common.edit")}
              </Button>
            )}
          </article>
        ))}
      </div>
      {resource.data && !resource.data.connections.length && (
        <p className="console-empty">{t("mailAdmin.noRecords")}</p>
      )}
      {editing && catalog.data && (
        <ProviderEditor
          key={editing === "new" ? "new" : editing.id}
          existing={editing === "new" ? undefined : editing}
          providers={catalog.data.providers}
          onClose={() => setEditing(null)}
          onSaved={resource.reload}
        />
      )}
    </>
  );
}
function ProviderEditor({
  existing,
  providers,
  onClose,
  onSaved,
}: {
  existing?: ProviderConnection;
  providers: DomainProvider[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState(existing?.provider ?? providers[0]?.provider ?? ""),
    [name, setName] = useState(existing?.name ?? ""),
    [enabled, setEnabled] = useState(existing ? !!existing.enabled : true);
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {}),
    [secrets, setSecrets] = useState<Record<string, string>>({});
  const selected = providers.find((entry) => entry.provider === providerId),
    action = useMailAction(),
    notify = useNotifications();
  return (
    <MailModal
      open
      title={existing ? t("mailAdmin.editProvider") : t("mailAdmin.addProvider")}
      description={t("mailAdmin.providerEditorDescription")}
      onClose={onClose}
    >
      <MailForm
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const updates = Object.fromEntries(
              Object.entries(secrets).filter(([, value]) => value.trim()),
            );
            const values = Object.fromEntries(
              (selected?.config_fields ?? []).map((field) => [
                field.key,
                config[field.key] ?? field.options?.[0] ?? "",
              ]),
            );
            await api(`/api/mail/provider-connections${existing ? `/${existing.id}` : ""}`, {
              method: existing ? "PATCH" : "POST",
              body: {
                name: name.trim(),
                enabled,
                config: values,
                ...(existing ? { version: existing.version } : { provider: providerId }),
                ...(!existing || Object.keys(updates).length ? { secrets: updates } : {}),
              },
            });
            setSecrets({});
            onSaved();
            onClose();
            notify.success(t("mailAdmin.providerSaved"));
          });
        }}
      >
        <MailFieldset disabled={action.busy}>
          <MailInput
            label={t("mailAdmin.connectionName")}
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <MailField label={t("mailAdmin.provider")}>
            <MailSelect
              value={providerId}
              disabled={!!existing}
              onValueChange={(value) => {
                setProviderId(value);
                setConfig({});
                setSecrets({});
              }}
              options={providers.map((entry) => ({
                value: entry.provider,
                label: entry.label ?? entry.provider,
              }))}
            />
          </MailField>
          {selected?.config_fields.map((field) =>
            field.options ? (
              <MailField key={field.key} label={field.label} hint={field.help}>
                <MailSelect
                  value={config[field.key] ?? field.options[0] ?? ""}
                  onValueChange={(value) =>
                    setConfig((current) => ({ ...current, [field.key]: value }))
                  }
                  options={field.options.map((value) => ({ value, label: value }))}
                />
              </MailField>
            ) : (
              <MailInput
                key={field.key}
                label={field.label}
                hint={field.help}
                required={!!field.required}
                value={config[field.key] ?? ""}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            ),
          )}
          {selected?.secret_fields.map((field) => (
            <MailInput
              key={field.key}
              label={field.label}
              hint={existing?.secret_configured ? t("mailAdmin.keepCredential") : field.help}
              required={!!field.required && !existing?.secret_configured}
              type="password"
              autoComplete="new-password"
              value={secrets[field.key] ?? ""}
              onChange={(event) =>
                setSecrets((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          ))}
          <Check checked={enabled} onChange={setEnabled}>
            {t("mailAdmin.enableConnection")}
          </Check>
        </MailFieldset>
        <MailNotice error={action.error} />
        <div className="mail-actions">
          <Button disabled={action.busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.busy || !selected}>
            {action.busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </MailForm>
    </MailModal>
  );
}

export function MailFlowPage() {
  const [search, setSearch] = useState(""),
    [direction, setDirection] = useState(""),
    [status, setStatus] = useState(""),
    [after, setAfter] = useState(""),
    [before, setBefore] = useState("");
  const resource = useAdminPage<MailFlow>("flow", {
    q: search,
    direction,
    status,
    ...dateParams(after, before),
  });
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.flow")}
        description={t("mailAdmin.flowDescription")}
      >
        <Reload onClick={resource.reload} disabled={resource.loading} />
      </ConsolePageHeader>
      <div className="console-mail-filters">
        <MailInput
          label={t("mailAdmin.searchFlow")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <SelectFilter
          label={t("mailAdmin.direction")}
          value={direction}
          onChange={setDirection}
          options={[
            { value: "", label: t("mailAdmin.allDirections") },
            { value: "inbound", label: t("mailAdmin.inbound") },
            { value: "outbound", label: t("mailAdmin.outbound") },
          ]}
        />
        <SelectFilter
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("mailAdmin.allStatuses") },
            ...[
              "received",
              "forwarded",
              "queued",
              "scheduled",
              "processing",
              "retry_wait",
              "accepted",
              "delivered",
              "failed",
              "rejected",
              "unknown",
              "canceled",
              "complained",
            ].map((value) => ({ value, label: enumLabel(value) })),
          ]}
        />
        <DateFilters after={after} before={before} onAfter={setAfter} onBefore={setBefore} />
      </div>
      {resource.data?.tracking_since && (
        <p className="mail-hint console-mail-record-note">
          {t("mailAdmin.flowRetention", { date: adminDate(resource.data.tracking_since) })}
        </p>
      )}
      <AdminTable
        resource={resource}
        headings={[
          t("mailAdmin.time"),
          t("mailAdmin.mailbox"),
          t("mailAdmin.direction"),
          t("mailAdmin.provider"),
          t("common.status"),
          t("mailAdmin.attempts"),
        ]}
      >
        {resource.data?.items.map((entry) => (
          <tr key={entry.id}>
            <td>{adminDate(entry.created_at)}</td>
            <td>
              <strong>{entry.mailbox_name ?? t("mailAdmin.unassigned")}</strong>
              <small className="console-subtext">{entry.email_address}</small>
              <small className="console-subtext console-mail-id">{entry.id}</small>
            </td>
            <td>
              {entry.direction === "inbound" ? t("mailAdmin.inbound") : t("mailAdmin.outbound")}
            </td>
            <td>{entry.provider ?? t("routesConsoleMail.noProvider")}</td>
            <td>
              <span className="mail-badge">{enumLabel(entry.status)}</span>
              {entry.error_code && <small className="console-subtext">{entry.error_code}</small>}
              {["scheduled", "retry_wait"].includes(entry.status) && entry.scheduled_at && (
                <small className="console-subtext">{adminDate(entry.scheduled_at)}</small>
              )}
            </td>
            <td>{entry.attempt_count}</td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}

export function MailPolicies() {
  const resource = useMailResource<{ settings: MailPolicy; max_send_bytes: number }>(
    "/api/mail/admin/settings",
  );
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.policies")}
        description={t("mailAdmin.policiesDescription")}
      />
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data && (
        <PolicyForm
          key={resource.data.settings.version}
          initial={resource.data.settings}
          maximum={resource.data.max_send_bytes}
          onSaved={resource.reload}
        />
      )}
    </>
  );
}
function PolicyForm({
  initial,
  maximum,
  onSaved,
}: {
  initial: MailPolicy;
  maximum: number;
  onSaved: () => void;
}) {
  const { permissions } = useAccess(),
    manage = permissions.includes("admin.mail.settings.manage"),
    action = useMailAction(),
    notify = useNotifications();
  const [retention, setRetention] = useState(initial.default_retention_days?.toString() ?? ""),
    [limit, setLimit] = useState(
      initial.max_send_bytes ? String(initial.max_send_bytes / 1024 ** 2) : "",
    ),
    [forwarding, setForwarding] = useState(!!initial.external_forwarding_enabled);
  return (
    <MailForm
      className="mail-form"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api("/api/mail/admin/settings", {
            method: "PATCH",
            body: {
              version: initial.version,
              default_retention_days: retention === "" ? null : Number(retention),
              max_send_bytes: limit === "" ? null : Math.round(Number(limit) * 1024 ** 2),
              external_forwarding_enabled: forwarding,
            },
          });
          onSaved();
          notify.success(t("mailAdmin.policiesSaved"));
        });
      }}
    >
      <MailFieldset disabled={action.busy || !manage}>
        <MailSection
          title={t("mailAdmin.retention")}
          description={t("mailAdmin.retentionDescription")}
        >
          <MailInput
            label={t("mailAdmin.retentionDays")}
            type="number"
            min={1}
            max={3650}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            hint={t("mailAdmin.retentionHint")}
          />
        </MailSection>
        <MailSection
          title={t("mailAdmin.sendingLimits")}
          description={t("mailAdmin.sendingLimitsDescription")}
        >
          <MailInput
            label={t("routesConsoleMail.maximumMessageSizeMib")}
            type="number"
            min={0.001}
            step="any"
            max={maximum / 1024 ** 2}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            hint={t("mailAdmin.sendingLimitsHint")}
          />
        </MailSection>
        <MailSection
          title={t("mailAdmin.forwarding")}
          description={t("mailAdmin.forwardingDescription")}
        >
          <Check checked={forwarding} onChange={setForwarding}>
            {t("mailAdmin.allowExternalForwarding")}
          </Check>
        </MailSection>
      </MailFieldset>
      <MailNotice error={action.error} />
      <div className="mail-actions">
        <span className="mail-hint">
          {t("mailAdmin.lastUpdated", { date: adminDate(initial.updated_at) })}
        </span>
        {manage && (
          <Button type="submit" variant="primary" disabled={action.busy}>
            {action.busy ? t("common.saving") : t("common.save")}
          </Button>
        )}
      </div>
    </MailForm>
  );
}

export function MailAuditLog() {
  const [search, setSearch] = useState(""),
    [operation, setOperation] = useState(""),
    [after, setAfter] = useState(""),
    [before, setBefore] = useState("");
  const resource = useAdminPage<MailAdminActivity>("activity", {
    q: search,
    operation,
    ...dateParams(after, before),
  });
  const operationLabel = (value: string) =>
    value === "POST"
      ? t("mailAdmin.created")
      : value === "DELETE"
        ? t("common.delete")
        : t("mailAdmin.updated");
  const resourceLabel = (path: string) =>
    path.includes("/admin/settings")
      ? t("mailAdmin.policies")
      : path.includes("/provider-connections")
        ? t("mailAdmin.providers")
        : path.includes("/domains")
          ? t("mailAdmin.domains")
          : path.includes("/addresses")
            ? t("mailAdmin.addresses")
            : path.includes("/members")
              ? t("mailAdmin.mailboxAccess")
              : t("mailAdmin.mailbox");
  return (
    <>
      <ConsolePageHeader
        level={2}
        title={t("mailAdmin.audit")}
        description={t("mailAdmin.activityDescription")}
      >
        <Reload onClick={resource.reload} disabled={resource.loading} />
      </ConsolePageHeader>
      <div className="console-mail-filters">
        <MailInput
          label={t("mailAdmin.searchActivity")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <SelectFilter
          label={t("mailAdmin.operation")}
          value={operation}
          onChange={setOperation}
          options={[
            { value: "", label: t("mailAdmin.allOperations") },
            ...["POST", "PATCH", "DELETE"].map((value) => ({
              value,
              label: operationLabel(value),
            })),
          ]}
        />
        <DateFilters after={after} before={before} onAfter={setAfter} onBefore={setBefore} />
      </div>
      <p className="mail-hint console-mail-record-note">{t("mailAdmin.auditRetention")}</p>
      <AdminTable
        resource={resource}
        headings={[
          t("mailAdmin.time"),
          t("mailAdmin.actor"),
          t("mailAdmin.operation"),
          t("mailAdmin.resource"),
        ]}
      >
        {resource.data?.items.map((entry) => (
          <tr key={entry.sequence}>
            <td>{adminDate(entry.created_at)}</td>
            <td>
              {entry.actor_name || entry.actor_email || t("mailAdmin.unassigned")}
              <small className="console-subtext">{entry.actor_name && entry.actor_email}</small>
            </td>
            <td>{operationLabel(entry.operation)}</td>
            <td>
              <strong>{entry.resource_name || resourceLabel(entry.resource_path)}</strong>
              {entry.resource_name && (
                <small className="console-subtext">{resourceLabel(entry.resource_path)}</small>
              )}
              <small className="console-subtext console-mail-id">{entry.resource_id}</small>
            </td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}

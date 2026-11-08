import {
  ConsoleSelectField,
  ConsoleInput,
  ConsoleSection,
  ConsoleState,
  ConsoleSettingsHeader,
  ConsoleFilters,
  ConsoleTable,
  ConsoleMetrics,
  ConsoleFormActions,
  ConsoleForm,
  ConsoleFieldset,
  ConsoleDateFilters,
} from "../components/console-settings";
import { Notice } from "../components/console-shared";
import { useState } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { enumLabel } from "../../shared/i18n/labels.ts";
import { api } from "../lib/api";
import { formatBytes } from "../lib/drive";
import type { AdminMailbox, MailAdminActivity, MailFlow, MailPolicy } from "../lib/mail-admin";
import { useAccess } from "../components/console-access";
import { Check, adminDate } from "../components/console-shared";
import { Button, useNotifications } from "../components/ui";
import { useMailAction, useMailResource } from "../components/mail-common";

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
      | "active_domains"
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
      <ConsoleSettingsHeader
        title={t("consoleSettings.overview")}
        description={t("mailAdmin.overviewDescription")}
      />
      <ConsoleState
        loading={resource.loading && !data}
        error={resource.error}
        retry={resource.reload}
      />
      {data && (
        <>
          <ConsoleMetrics
            items={[
              [t("mailAdmin.domains"), data.summary.domains],
              [t("mailAdmin.mailboxes"), data.summary.mailboxes],
              [t("mailAdmin.shared"), data.summary.shared_mailboxes],
              [t("mailAdmin.disabled"), data.summary.disabled_mailboxes],
              [t("domainProviders.activeDomains"), data.summary.active_domains],
            ].map(([label, value]) => ({ label: String(label), value }))}
          />
          <ConsoleSection
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
          </ConsoleSection>
          <ConsoleSection
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
          </ConsoleSection>
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
      <ConsoleSettingsHeader
        title={t("mailAdmin.mailboxes")}
        description={t("mailAdmin.mailboxesDescription")}
      >
        {permissions.includes("admin.mail.mailboxes.manage") && (
          <Button
            nativeButton={false}
            render={<Link to="/console/mail/mailboxes/new" />}
            variant="primary"
          >
            {t("consoleSettings.addSharedMailbox")}
          </Button>
        )}
      </ConsoleSettingsHeader>
      <ConsoleFilters>
        <ConsoleInput
          label={t("consoleSettings.search")}
          placeholder={t("mailAdmin.searchMailboxes")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ConsoleSelectField
          label={t("mailAdmin.kind")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "", label: t("mailAdmin.allMailboxes") },
            { value: "personal", label: t("mailAdmin.personal") },
            { value: "shared", label: t("mailAdmin.shared") },
          ]}
        />
        <ConsoleSelectField
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
      </ConsoleFilters>
      <Notice error={action.error} />
      <ConsoleTable
        resource={resource}
        headings={[
          t("mailAdmin.mailbox"),
          t("consoleSettings.owner"),
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
              <div className="console-row-actions">
                <Button
                  nativeButton={false}
                  render={<Link to={`/console/mail/mailboxes/${box.id}`} />}
                  size="sm"
                >
                  {t("consoleSettings.manage")}
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
      </ConsoleTable>
    </>
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
      <ConsoleSettingsHeader
        title={t("mailAdmin.flow")}
        description={t("mailAdmin.flowDescription")}
      />
      <ConsoleFilters>
        <ConsoleInput
          label={t("consoleSettings.search")}
          placeholder={t("mailAdmin.searchFlow")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ConsoleSelectField
          label={t("mailAdmin.direction")}
          value={direction}
          onChange={setDirection}
          options={[
            { value: "", label: t("mailAdmin.allDirections") },
            { value: "inbound", label: t("mailAdmin.inbound") },
            { value: "outbound", label: t("mailAdmin.outbound") },
          ]}
        />
        <ConsoleSelectField
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
        <ConsoleDateFilters after={after} before={before} onAfter={setAfter} onBefore={setBefore} />
      </ConsoleFilters>
      {resource.data?.tracking_since && (
        <p className="mail-hint console-mail-record-note">
          {t("mailAdmin.flowRetention", { date: adminDate(resource.data.tracking_since) })}
        </p>
      )}
      <ConsoleTable
        resource={resource}
        headings={[
          t("consoleSettings.time"),
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
      </ConsoleTable>
    </>
  );
}

export function MailPolicies() {
  const resource = useMailResource<{ settings: MailPolicy; max_send_bytes: number }>(
    "/api/mail/admin/settings",
  );
  return (
    <>
      <ConsoleSettingsHeader
        title={t("consoleSettings.policies")}
        description={t("mailAdmin.policiesDescription")}
      />
      <ConsoleState
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
    <ConsoleForm
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
      <ConsoleFieldset sections disabled={action.busy || !manage}>
        <ConsoleSection
          title={t("mailAdmin.retention")}
          description={t("mailAdmin.retentionDescription")}
        >
          <ConsoleInput
            label={t("mailAdmin.retentionDays")}
            type="number"
            min={1}
            max={3650}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            hint={t("mailAdmin.retentionHint")}
          />
        </ConsoleSection>
        <ConsoleSection
          title={t("mailAdmin.sendingLimits")}
          description={t("mailAdmin.sendingLimitsDescription")}
        >
          <ConsoleInput
            label={t("routesConsoleMail.maximumMessageSizeMib")}
            type="number"
            min={0.001}
            step="any"
            max={maximum / 1024 ** 2}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            hint={t("mailAdmin.sendingLimitsHint")}
          />
        </ConsoleSection>
        <ConsoleSection
          title={t("mailAdmin.forwarding")}
          description={t("mailAdmin.forwardingDescription")}
        >
          <Check checked={forwarding} onChange={setForwarding}>
            {t("mailAdmin.allowExternalForwarding")}
          </Check>
        </ConsoleSection>
      </ConsoleFieldset>
      <Notice error={action.error} />
      <ConsoleFormActions
        meta={t("consoleSettings.lastUpdated", { date: adminDate(initial.updated_at) })}
      >
        {manage && (
          <Button type="submit" variant="primary" disabled={action.busy}>
            {action.busy ? t("common.saving") : t("common.saveChanges")}
          </Button>
        )}
      </ConsoleFormActions>
    </ConsoleForm>
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
        ? t("consoleSettings.deletion")
        : t("mailAdmin.updated");
  const resourceLabel = (path: string) =>
    path.includes("/admin/settings")
      ? t("consoleSettings.policies")
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
      <ConsoleSettingsHeader
        title={t("consoleSettings.audit")}
        description={t("mailAdmin.activityDescription")}
      />
      <ConsoleFilters>
        <ConsoleInput
          label={t("consoleSettings.search")}
          placeholder={t("mailAdmin.searchActivity")}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ConsoleSelectField
          label={t("consoleSettings.action")}
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
        <ConsoleDateFilters after={after} before={before} onAfter={setAfter} onBefore={setBefore} />
      </ConsoleFilters>
      <p className="mail-hint console-mail-record-note">{t("mailAdmin.auditRetention")}</p>
      <ConsoleTable
        resource={resource}
        headings={[
          t("consoleSettings.time"),
          t("consoleSettings.actor"),
          t("consoleSettings.action"),
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
      </ConsoleTable>
    </>
  );
}

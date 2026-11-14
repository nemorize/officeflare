import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { api, errorMessage } from "../lib/api";
import {
  aiAdminSpecs,
  aiConsolePages,
  aiResourcePayload,
  readAIField,
  recordLabel,
  type AIAdminField,
  type AIAdminSpec,
} from "../lib/ai-admin";
import {
  aiMetric,
  aiMoney,
  aiStatus,
  aiWindow,
  jsonObject,
  useAIResource,
  type AIQuotaRule,
  type AIRecord,
} from "../lib/ai";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, Notice, adminDate } from "../components/console-shared";
import { Button, Icon } from "../components/ui";
import {
  ConsoleDialog,
  ConsoleField,
  ConsoleFilters,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleMetrics,
  ConsoleSection,
  ConsoleSelectField,
  ConsoleSettingsHeader,
  ConsoleSettingsLayout,
  ConsoleState,
} from "../components/console-settings";
import "./console.css";
import "./ai.css";
const endpoint = "/api/ai/admin";
const options = (items: AIRecord[] = [], blank = true) => [
  ...(blank ? [{ value: "", label: t("aiui.choose") }] : []),
  ...items.map((item) => ({ value: String(item.id ?? item.key), label: recordLabel(item) })),
];
const choice = (value: string): string => {
  const values: Record<string, string> = {
    owner: t("aiui.personal"),
    workspace: t("aiui.workspace"),
    owner_only: t("aiui.ownerOnly"),
    provider_permitted: t("aiui.providerPermitted"),
    priority: t("aiui.byPriority"),
    weighted: t("aiui.weighted"),
    least_recently_used: t("aiui.leastRecent"),
    api_key: t("aiui.apiKey"),
    oauth: t("aiui.oauth"),
    active: t("aiui.active"),
    disabled: t("aiui.disabled"),
    builtin: t("aiui.builtin"),
    streamable_http: t("aiui.remote"),
    catalog: t("aiui.catalogPrice"),
    internal_rate: t("aiui.internalPrice"),
    unknown: t("aiui.unpriced"),
    openai_responses: t("aiui.protocolName.responses"),
    openai_chat: t("aiui.protocolName.chat"),
    anthropic_messages: t("aiui.protocolName.anthropic"),
    google_generate_content: t("aiui.protocolName.gemini"),
    cloudflare_run: t("aiui.protocolName.cloudflare"),
    api: t("aiui.apiBilling"),
    chatgpt_plan: t("aiui.subscription"),
    platform: t("aiui.platformBilling"),
  };
  return values[value] ?? value;
};
function can(permission: string, write = false, permissions: string[]) {
  return permissions.includes(`admin.ai.${permission}.${write ? "manage" : "read"}`);
}
export function AIConsolePage() {
  const { page } = useParams(),
    { permissions } = useAccess(),
    navigate = useNavigate();
  const pages = aiConsolePages.filter((item) => permissions.includes(item.permission));
  const current = pages.find((item) => item.page === page);
  if (!page)
    return pages[0] ? <Navigate to={`/console/ai/${pages[0].page}`} replace /> : <AccessDenied />;
  if (!current) return <AccessDenied />;
  const spec = aiAdminSpecs.find((item) => item.key === page);
  const groups = [
    { id: "settings", label: t("aiui.settings"), members: ["settings"] },
    {
      id: "providers",
      label: t("aiui.providers"),
      members: ["providers", "accounts", "gateways", "pools"],
    },
    { id: "models", label: t("aiui.models"), members: ["models", "deployments"] },
    { id: "profiles", label: t("aiui.profiles"), members: ["profiles", "routes", "consumers"] },
    { id: "mcp", label: t("aiui.mcpServers"), members: ["mcp-servers"] },
    { id: "quotas", label: t("aiui.userLimits"), members: ["quotas", "quota-plans"] },
    { id: "usage", label: t("aiui.usage"), members: ["usage", "activity", "reconciliation"] },
  ]
    .map((group) => ({
      ...group,
      pages: pages.filter((item) => group.members.includes(item.page)),
    }))
    .filter((group) => group.pages.length);
  const group = groups.find((item) => item.members.includes(page))!;
  return (
    <ConsoleSettingsLayout
      title={t("aiui.administration")}
      description={t("aiui.adminHint")}
      pages={groups.map((item) => ({ path: item.id, name: item.label }))}
      selected={group.id}
      onNavigate={(next) =>
        navigate(`/console/ai/${groups.find((item) => item.id === next)!.pages[0]!.page}`)
      }
      navigationLabel={t("aiui.adminNavigation")}
    >
      <div key={page}>
        {group.pages.length > 1 && (
          <nav className="ai-subnav" aria-label={group.label}>
            {group.pages.map((item) => (
              <Link
                key={item.page}
                to={`/console/ai/${item.page}`}
                aria-current={item.page === page ? "page" : undefined}
              >
                {t(item.titleKey)}
              </Link>
            ))}
          </nav>
        )}
        {spec ? (
          <ResourcePage spec={spec} />
        ) : page === "settings" ? (
          <SettingsPage />
        ) : page === "quotas" ? (
          <UserQuotas />
        ) : page === "reconciliation" ? (
          <ReconciliationPage />
        ) : (
          <UsageAudit page={page} />
        )}
      </div>
    </ConsoleSettingsLayout>
  );
}
function ResourcePage({ spec }: { spec: AIAdminSpec }) {
  const { permissions } = useAccess(),
    writable = can(spec.permission, true, permissions);
  const resource = useAIResource<{ items: AIRecord[] }>(`${endpoint}/${spec.key}`);
  const [editing, setEditing] = useState<AIRecord | "new" | null>(null),
    [relationship, setRelationship] = useState<AIRecord | null>(null),
    [query, setQuery] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const relational = ["pools", "consumers", "quota-plans"].includes(spec.key);
  const profiles = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" ? `${endpoint}/profiles` : null,
  );
  const deployments = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" && can("providers", false, permissions)
      ? `${endpoint}/deployments`
      : null,
  );
  const name = (record: AIRecord) =>
    spec.key === "routes"
      ? `${profiles.data?.items.find((item) => item.id === record.profile_id)?.name ?? record.profile_id} → ${deployments.data?.items.find((item) => item.id === record.deployment_id)?.provider_model_id ?? record.deployment_id}`
      : recordLabel(record);
  return (
    <>
      <ConsoleSettingsHeader
        title={t(spec.titleKey)}
        description={
          spec.key === "deployments"
            ? t("aiui.deploymentHint")
            : spec.key === "routes"
              ? t("aiui.routesHint")
              : spec.key === "consumers"
                ? t("aiui.consumerHint")
                : spec.key === "accounts"
                  ? t("aiui.accountsHint")
                  : t("aiui.resourceHint")
        }
      >
        {writable && spec.key !== "consumers" && (
          <Button onClick={() => setEditing("new")}>
            <Icon name="plus" />
            {t("common.create")}
          </Button>
        )}
      </ConsoleSettingsHeader>
      <Notice error={error} />
      <ConsoleFilters>
        <ConsoleInput
          label={t("aiui.search")}
          type="search"
          value={query}
          onValueChange={setQuery}
        />
        <Button variant="ghost" onClick={resource.reload}>
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleFilters>
      <ConsoleState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {resource.data && (
        <div className="console-table-wrap ai-admin-table">
          <table>
            <thead>
              <tr>
                <th>{t("common.name")}</th>
                <th>{t("aiui.configuration")}</th>
                <th>{t("common.status")}</th>
                <th>
                  <span className="visually-hidden">{t("aiui.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {resource.data.items
                .filter((item) =>
                  name(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                )
                .map((item) => (
                  <tr key={String(item.id ?? item.key)}>
                    <td>
                      <strong>{name(item)}</strong>
                      {item.key && <small className="console-subtext">{item.key}</small>}
                    </td>
                    <td>
                      {String(
                        item.adapter_key ??
                          item.protocol ??
                          item.strategy ??
                          item.transport ??
                          item.auth_kind ??
                          item.provider_model_id ??
                          (item.share_scope ? choice(String(item.share_scope)) : ""),
                      )}
                      {item.has_secret === true && (
                        <small className="ai-secret-ready">
                          <Icon name="shield" />
                          {t("aiui.credentialSaved")}
                        </small>
                      )}
                    </td>
                    <td>
                      <span
                        className="ai-badge"
                        data-enabled={item.enabled ?? (item.status === "active" ? 1 : 0)}
                      >
                        {item.status
                          ? aiStatus(item.status)
                          : item.enabled
                            ? t("common.enabled")
                            : t("aiui.disabled")}
                      </span>
                    </td>
                    <td>
                      <div className="ai-row-actions">
                        {relational && (
                          <Button size="sm" variant="ghost" onClick={() => setRelationship(item)}>
                            {spec.key === "pools"
                              ? t("aiui.members")
                              : spec.key === "consumers"
                                ? t("aiui.profiles")
                                : t("aiui.rules")}
                          </Button>
                        )}
                        {writable && (
                          <Button size="sm" onClick={() => setEditing(item)}>
                            {t("common.edit")}
                          </Button>
                        )}
                        {writable && spec.key === "accounts" && item.auth_kind === "oauth" && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setError("");
                              try {
                                const result = await api<{ authorization_url: string }>(
                                  `/api/ai/accounts/${item.id}/oauth/start`,
                                  { method: "POST", body: {} },
                                );
                                window.location.assign(result.authorization_url);
                              } catch (failure) {
                                setError(errorMessage(failure));
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {t("aiui.connect")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!resource.data.items.length && (
            <div className="ai-admin-empty">
              <Icon name="layers" width={28} height={28} />
              <p>{t("aiui.emptyResources")}</p>
              {writable && spec.key !== "consumers" && (
                <Button onClick={() => setEditing("new")}>{t("common.create")}</Button>
              )}
            </div>
          )}
        </div>
      )}
      {!!editing && (
        <ResourceEditor
          spec={spec}
          record={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={resource.reload}
        />
      )}
      {relationship &&
        (spec.key === "quota-plans" ? (
          <PlanRules
            plan={relationship}
            writable={writable}
            onClose={() => setRelationship(null)}
            onSaved={resource.reload}
          />
        ) : (
          <Relationships
            spec={spec}
            record={relationship}
            writable={writable}
            onClose={() => setRelationship(null)}
            onSaved={resource.reload}
          />
        ))}
    </>
  );
}
function ResourceEditor({
  spec,
  record,
  onClose,
  onSaved,
}: {
  spec: AIAdminSpec;
  record: AIRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { permissions } = useAccess();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(spec.fields.map((field) => [field.path, readAIField(record, field)])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const providerData = useAIResource<{ items: AIRecord[] }>(
    can("providers", false, permissions) ? `${endpoint}/providers` : null,
  );
  const modelData = useAIResource<{ items: AIRecord[] }>(
    spec.key === "deployments" ? `${endpoint}/models` : null,
  );
  const poolData = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" && can("providers", false, permissions) ? `${endpoint}/pools` : null,
  );
  const deploymentData = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" && can("providers", false, permissions)
      ? `${endpoint}/deployments`
      : null,
  );
  const gatewayData = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" && can("providers", false, permissions) ? `${endpoint}/gateways` : null,
  );
  const profileData = useAIResource<{ items: AIRecord[] }>(
    spec.key === "routes" ? `${endpoint}/profiles` : null,
  );
  const references: Record<string, AIRecord[]> = {
    providers: providerData.data?.items ?? [],
    models: modelData.data?.items ?? [],
    pools: poolData.data?.items ?? [],
    deployments: deploymentData.data?.items ?? [],
    gateways: gatewayData.data?.items ?? [],
    profiles: profileData.data?.items ?? [],
  };
  function change(path: string, value: string | boolean) {
    setValues((old) => ({
      ...old,
      [path]: value,
      ...(path === "provider_id" && spec.key === "routes"
        ? { pool_id: "", deployment_id: "" }
        : {}),
      ...(path === "auth_kind" && value === "oauth" && !record ? { status: "disabled" } : {}),
    }));
  }
  function render(field: AIAdminField): ReactNode {
    if (field.path.startsWith("config_json.oauth.") && !values.oauth_enabled) return null;
    if (
      spec.key === "mcp-servers" &&
      field.path === "builtin_key" &&
      values.transport !== "builtin"
    )
      return null;
    if (
      spec.key === "mcp-servers" &&
      field.path === "endpoint_url" &&
      values.transport === "builtin"
    )
      return null;
    const label = t(field.label),
      value = values[field.path];
    if (field.kind === "boolean")
      return (
        <Check
          key={field.path}
          checked={!!value}
          disabled={busy}
          onChange={(checked) => change(field.path, checked)}
        >
          {label}
        </Check>
      );
    if (field.kind === "select" || field.kind === "ref") {
      const candidates = references[field.ref ?? ""] ?? [];
      const filtered = ["pool_id", "deployment_id"].includes(field.path)
        ? candidates.filter((candidate) => candidate.provider_id === values.provider_id)
        : candidates;
      const choices =
        field.kind === "ref"
          ? options(filtered)
          : (field.options ?? []).map((option) => ({
              value: option,
              label: option ? choice(option) : t("aiui.none"),
            }));
      if (value && !choices.some((option) => option.value === value))
        choices.push({ value: String(value), label: String(value) });
      return (
        <ConsoleSelectField
          key={field.path}
          label={label}
          value={String(value ?? "")}
          onChange={(next) => change(field.path, next)}
          options={choices}
          disabled={busy}
        />
      );
    }
    return (
      <ConsoleInput
        key={field.path}
        label={label}
        type={
          field.kind === "number"
            ? "number"
            : field.kind === "password"
              ? "password"
              : field.kind === "url"
                ? "url"
                : "text"
        }
        autoComplete={field.kind === "password" ? "new-password" : "off"}
        hint={
          field.kind === "password"
            ? record?.has_secret
              ? t("aiui.secretUnchanged")
              : t("aiui.secretHint")
            : undefined
        }
        required={
          field.required ||
          (field.path.startsWith("config_json.oauth.") &&
            !!values.oauth_enabled &&
            !["revocation_endpoint", "resource"].includes(field.path.split(".").at(-1)!) &&
            (field.path !== "config_json.oauth.jwks_uri" || spec.key === "providers"))
        }
        min={field.min}
        step={field.step ?? (field.kind === "number" ? "1" : undefined)}
        value={String(value ?? "")}
        onValueChange={(next) => change(field.path, next)}
        disabled={busy || (!!record && field.path === "key")}
      />
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = aiResourcePayload(spec, values, record);
      await api(
        `${endpoint}/${spec.key}${record ? "/" + encodeURIComponent(String(record.id ?? record.key)) : ""}`,
        { method: record ? "PATCH" : "POST", body },
      );
      onSaved();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && !("status" in failure)
          ? failure.message
          : errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleDialog open title={t(spec.titleKey)} onClose={onClose} busy={busy} wide>
      <form className="ai-settings-form" onSubmit={(event) => void save(event)}>
        <Notice error={error} />
        <div className="ai-form-grid">
          {spec.fields.filter((field) => !field.advanced).map(render)}
        </div>
        {spec.fields.some((field) => field.advanced) && (
          <details className="ai-advanced">
            <summary>{t("aiui.advanced")}</summary>
            <div className="ai-form-grid">
              {spec.fields.filter((field) => field.advanced).map(render)}
            </div>
          </details>
        )}
        {spec.key === "accounts" && <p className="ai-form-hint">{t("aiui.sharingHint")}</p>}
        {spec.key === "deployments" && <p className="ai-form-hint">{t("aiui.verifyBoundsHint")}</p>}
        <ConsoleFormActions>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}

function Relationships({
  spec,
  record,
  writable,
  onClose,
  onSaved,
}: {
  spec: AIAdminSpec;
  record: AIRecord;
  writable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pool = spec.key === "pools",
    id = String(record.id ?? record.key),
    path = `${endpoint}/${spec.key}/${encodeURIComponent(id)}/${pool ? "members" : "profiles"}`;
  const current = useAIResource<{
    pool?: AIRecord;
    consumer?: AIRecord;
    members?: { account_id: string; priority: number; weight: number; enabled: number }[];
    profiles?: { profile_id: string; is_default: number }[];
  }>(path);
  const available = useAIResource<{ items: AIRecord[] }>(
    `${endpoint}/${pool ? "accounts" : "profiles"}`,
  );
  const [selected, setSelected] = useState<Record<string, { priority: number; weight: number }>>(
      {},
    ),
    [defaultId, setDefaultId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!current.data) return;
    if (pool)
      setSelected(
        Object.fromEntries(
          (current.data.members ?? [])
            .filter((member) => member.enabled)
            .map((member) => [
              member.account_id,
              { priority: member.priority, weight: member.weight },
            ]),
        ),
      );
    else {
      setSelected(
        Object.fromEntries(
          (current.data.profiles ?? []).map((profile) => [
            profile.profile_id,
            { priority: 0, weight: 1 },
          ]),
        ),
      );
      setDefaultId(current.data.profiles?.find((profile) => profile.is_default)?.profile_id ?? "");
    }
  }, [current.data, pool]);
  const candidates =
    available.data?.items.filter((item) => !pool || item.provider_id === record.provider_id) ?? [];
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current.data || busy) return;
    setBusy(true);
    setError("");
    try {
      const version = (current.data.pool ?? current.data.consumer)!.version;
      await api(path, {
        method: "PUT",
        body: {
          version,
          ...(pool
            ? {
                members: Object.entries(selected).map(([account_id, value]) => ({
                  account_id,
                  ...value,
                  enabled: true,
                })),
              }
            : {
                profiles: Object.keys(selected).map((profile_id) => ({
                  profile_id,
                  is_default: profile_id === defaultId,
                })),
              }),
        },
      });
      onSaved();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleDialog
      open
      title={recordLabel(record)}
      description={pool ? t("aiui.poolHint") : t("aiui.consumerProfileHint")}
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="ai-settings-form" onSubmit={(event) => void save(event)}>
        <ConsoleState
          loading={current.loading || available.loading}
          error={current.error || available.error}
        />
        <Notice error={error} />
        {candidates.map((item) => (
          <div className="ai-member-row" key={item.id}>
            <Check
              checked={!!selected[item.id]}
              disabled={!writable || busy}
              onChange={(checked) =>
                setSelected((old) => {
                  const next = { ...old };
                  if (checked) next[item.id] = { priority: Object.keys(old).length, weight: 1 };
                  else delete next[item.id];
                  return next;
                })
              }
            >
              {recordLabel(item)}
            </Check>
            {pool && selected[item.id] && (
              <>
                <ConsoleInput
                  label={t("aiui.priorityNamed", { name: recordLabel(item) })}
                  type="number"
                  min={0}
                  value={String(selected[item.id]!.priority)}
                  disabled={!writable || busy}
                  onValueChange={(value) =>
                    setSelected((old) => ({
                      ...old,
                      [item.id]: { ...old[item.id]!, priority: Number(value) },
                    }))
                  }
                />
                <ConsoleInput
                  label={t("aiui.weightNamed", { name: recordLabel(item) })}
                  type="number"
                  min={1}
                  max={10000}
                  value={String(selected[item.id]!.weight)}
                  disabled={!writable || busy}
                  onValueChange={(value) =>
                    setSelected((old) => ({
                      ...old,
                      [item.id]: { ...old[item.id]!, weight: Number(value) },
                    }))
                  }
                />
              </>
            )}
          </div>
        ))}
        {!pool && (
          <ConsoleSelectField
            label={t("aiui.defaultProfile")}
            value={defaultId}
            disabled={!writable || busy}
            onChange={setDefaultId}
            options={options(candidates.filter((item) => selected[item.id]))}
          />
        )}
        {!candidates.length && !available.loading && <p>{t("aiui.emptyResources")}</p>}
        <ConsoleFormActions>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {writable && (
            <Button
              type="submit"
              variant="primary"
              disabled={busy || current.loading || available.loading || !!current.error}
            >
              {t("common.save")}
            </Button>
          )}
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}
interface Settings {
  enabled: number;
  version: number;
  default_user_plan_id: string;
  quota_time_zone: string;
  payload_retention_days: number;
}
function SettingsPage() {
  const { permissions } = useAccess(),
    writable = can("settings", true, permissions);
  const resource = useAIResource<{ settings: Settings; encryption_ready: boolean }>(
      `${endpoint}/settings`,
    ),
    plans = useAIResource<{ items: AIRecord[] }>(
      can("quotas", false, permissions) ? `${endpoint}/quota-plans` : null,
    );
  const [enabled, setEnabled] = useState(false),
    [plan, setPlan] = useState(""),
    [zone, setZone] = useState(""),
    [retention, setRetention] = useState("30"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!resource.data) return;
    const value = resource.data.settings;
    setEnabled(!!value.enabled);
    setPlan(value.default_user_plan_id);
    setZone(value.quota_time_zone);
    setRetention(String(value.payload_retention_days));
  }, [resource.data]);
  return (
    <>
      <ConsoleSettingsHeader title={t("aiui.settings")} description={t("aiui.settingsHint")} />
      <ConsoleState loading={resource.loading} error={resource.error} retry={resource.reload} />
      {resource.data && (
        <form
          className="ai-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setSaved(false);
            setError("");
            try {
              await api(`${endpoint}/settings`, {
                method: "PATCH",
                body: {
                  version: resource.data!.settings.version,
                  enabled,
                  default_user_plan_id: plan,
                  quota_time_zone: zone,
                  payload_retention_days: Number(retention),
                },
              });
              resource.reload();
              setSaved(true);
            } catch (failure) {
              setError(errorMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Notice error={error} />
          <ConsoleSection title={t("aiui.availability")} description={t("aiui.availabilityHint")}>
            <Check
              checked={enabled}
              disabled={!writable || busy || !resource.data.encryption_ready}
              onChange={setEnabled}
            >
              {t("aiui.enableHub")}
            </Check>
            <p className="ai-form-hint">
              {resource.data.encryption_ready
                ? t("aiui.encryptionReady")
                : t("aiui.encryptionMissing")}
            </p>
          </ConsoleSection>
          <ConsoleSection title={t("aiui.defaults")}>
            <div className="ai-form-grid">
              <ConsoleSelectField
                label={t("aiui.defaultPlan")}
                value={plan}
                onChange={setPlan}
                disabled={!writable || busy || !plans.data}
                options={
                  plans.data ? options(plans.data.items, false) : [{ value: plan, label: plan }]
                }
              />
              <ConsoleInput
                label={t("aiui.quotaTimeZone")}
                hint={t("aiui.timeZoneHint")}
                value={zone}
                onValueChange={setZone}
                disabled={!writable || busy}
                required
              />
              <ConsoleInput
                label={t("aiui.retentionDays")}
                value={retention}
                onValueChange={setRetention}
                type="number"
                min={1}
                max={3650}
                required
                disabled={!writable || busy}
              />
            </div>
          </ConsoleSection>
          {saved && <p role="status">{t("aiui.saved")}</p>}
          <ConsoleFormActions>
            {writable && (
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("common.saving") : t("common.saveChanges")}
              </Button>
            )}
          </ConsoleFormActions>
        </form>
      )}
      <ConsoleSection title={t("aiui.setupTitle")} description={t("aiui.setupHint")}>
        <ol className="ai-setup-steps">
          <li>
            <Link to="/console/ai/providers">{t("aiui.setupProvider")}</Link>
          </li>
          <li>
            <Link to="/console/ai/accounts">{t("aiui.setupAccounts")}</Link>
          </li>
          <li>
            <Link to="/console/ai/deployments">{t("aiui.setupModels")}</Link>
          </li>
          <li>
            <Link to="/console/ai/routes">{t("aiui.setupRouting")}</Link>
          </li>
          <li>
            <Link to="/console/ai/consumers">{t("aiui.setupConsumer")}</Link>
          </li>
        </ol>
      </ConsoleSection>
    </>
  );
}
const metrics = [
  "invocations",
  "chat_runs",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cost_micro_usd",
  "tool_calls",
  "concurrent_invocations",
  "concurrent_runs",
];
function Rules({
  values,
  onChange,
  disabled,
}: {
  values: AIQuotaRule[];
  onChange: (rules: AIQuotaRule[]) => void;
  disabled: boolean;
}) {
  const edit = (index: number, change: Partial<AIQuotaRule>) =>
    onChange(values.map((rule, i) => (i === index ? { ...rule, ...change } : rule)));
  return (
    <div className="ai-rule-list">
      <p className="ai-form-hint">{t("aiui.ruleHint")}</p>
      {values.map((rule, index) => (
        <div className="ai-rule-row" key={index}>
          <ConsoleSelectField
            label={t("aiui.metric")}
            disabled={disabled}
            value={rule.metric}
            options={metrics.map((metric) => ({ value: metric, label: aiMetric(metric) }))}
            onChange={(metric) =>
              edit(index, {
                metric,
                window_kind: metric.startsWith("concurrent_")
                  ? "concurrent"
                  : rule.window_kind === "concurrent"
                    ? "day"
                    : rule.window_kind,
              })
            }
          />
          <ConsoleSelectField
            label={t("aiui.window")}
            disabled={disabled}
            value={rule.window_kind}
            options={(rule.metric.startsWith("concurrent_")
              ? ["concurrent"]
              : ["minute", "day", "month", "lifetime"]
            ).map((value) => ({ value, label: aiWindow(value) }))}
            onChange={(window_kind) => edit(index, { window_kind })}
          />
          <ConsoleInput
            label={rule.metric === "cost_micro_usd" ? t("aiui.limitUSD") : t("aiui.limit")}
            disabled={disabled || rule.limit_value === null}
            type="number"
            min={0}
            step={rule.metric === "cost_micro_usd" ? "0.000001" : "1"}
            value={
              rule.limit_value === null
                ? ""
                : String(
                    rule.metric === "cost_micro_usd"
                      ? rule.limit_value / 1_000_000
                      : rule.limit_value,
                  )
            }
            onValueChange={(value) =>
              edit(index, {
                limit_value:
                  rule.metric === "cost_micro_usd"
                    ? Math.round(Number(value) * 1_000_000)
                    : Number(value),
              })
            }
          />
          <div className="ai-rule-options">
            <Check
              checked={rule.limit_value === null}
              disabled={disabled}
              onChange={(unlimited) => edit(index, { limit_value: unlimited ? null : 0 })}
            >
              {t("aiui.unlimited")}
            </Check>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("aiui.removeRule")}
              disabled={disabled}
              onClick={() => onChange(values.filter((_, i) => index !== i))}
            >
              <Icon name="trash" />
            </Button>
          </div>
          <details>
            <summary>{t("aiui.scope")}</summary>
            <ConsoleInput
              label={t("aiui.scope")}
              value={rule.scope_key}
              disabled={disabled}
              onValueChange={(scope_key) => edit(index, { scope_key })}
              hint={t("aiui.scopeHint")}
            />
          </details>
        </div>
      ))}
      {!disabled && (
        <Button
          onClick={() =>
            onChange([
              ...values,
              { metric: "invocations", window_kind: "day", scope_key: "*", limit_value: 100 },
            ])
          }
        >
          <Icon name="plus" />
          {t("aiui.addRule")}
        </Button>
      )}
    </div>
  );
}
function PlanRules({
  plan,
  writable,
  onClose,
  onSaved,
}: {
  plan: AIRecord;
  writable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useAIResource<{ plan: AIRecord; rules: AIQuotaRule[] }>(
      `${endpoint}/quota-plans/${plan.id}/rules`,
    ),
    [rules, setRules] = useState<AIQuotaRule[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (resource.data) setRules(resource.data.rules);
  }, [resource.data]);
  return (
    <ConsoleDialog open title={recordLabel(plan)} onClose={onClose} busy={busy} wide>
      <form
        className="ai-settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`${endpoint}/quota-plans/${plan.id}/rules`, {
              method: "PUT",
              body: { version: resource.data!.plan.version, rules },
            });
            onSaved();
            onClose();
          } catch (failure) {
            setError(errorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ConsoleState loading={resource.loading} error={resource.error} />
        <Notice error={error} />
        {resource.data && <Rules values={rules} onChange={setRules} disabled={!writable || busy} />}
        <ConsoleFormActions>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {writable && (
            <Button type="submit" variant="primary" disabled={busy || !resource.data}>
              {t("common.save")}
            </Button>
          )}
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}
function UserQuotas() {
  const { permissions } = useAccess(),
    writable = can("quotas", true, permissions);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [userId, setUserId] = useState("");
  const users = useAIResource<{
      users: { id: string; display_name: string | null; email_address: string }[];
    }>(`${endpoint}/users?q=${encodeURIComponent(search)}`),
    plans = useAIResource<{ items: AIRecord[] }>(`${endpoint}/quota-plans`);
  const current = useAIResource<{
    subject: AIRecord & { plan_id: string | null; status: string };
    overrides: AIQuotaRule[];
    rules: AIQuotaRule[];
  }>(userId ? `${endpoint}/users/${encodeURIComponent(userId)}/quota` : null);
  const [rules, setRules] = useState<AIQuotaRule[]>([]),
    [plan, setPlan] = useState(""),
    [suspended, setSuspended] = useState(false),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!current.data) return;
    setRules(current.data.overrides);
    setPlan(current.data.subject.plan_id ?? "");
    setSuspended(current.data.subject.status === "suspended");
  }, [current.data]);
  return (
    <>
      <ConsoleSettingsHeader title={t("aiui.userLimits")} description={t("aiui.userLimitsHint")} />
      <form
        className="ai-user-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query);
          setUserId("");
        }}
      >
        <ConsoleInput
          label={t("aiui.searchUsers")}
          type="search"
          value={query}
          onValueChange={setQuery}
        />
        <Button type="submit">{t("aiui.search")}</Button>
      </form>
      <ConsoleSelectField
        label={t("aiui.user")}
        value={userId}
        onChange={(value) => {
          setUserId(value);
          setError("");
        }}
        options={[
          { value: "", label: t("aiui.chooseUser") },
          ...(users.data?.users ?? []).map((user) => ({
            value: user.id,
            label: `${user.display_name ? user.display_name + " · " : ""}${user.email_address}`,
          })),
        ]}
      />
      <ConsoleState
        loading={users.loading || current.loading}
        error={users.error || current.error || plans.error}
      />
      {current.data && (
        <form
          className="ai-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              await api(`${endpoint}/users/${encodeURIComponent(userId)}/quota`, {
                method: "PUT",
                body: {
                  version: current.data!.subject.version,
                  plan_id: plan || null,
                  status: suspended ? "suspended" : "active",
                  overrides: rules,
                },
              });
              current.reload();
              setSaved(true);
            } catch (failure) {
              setError(errorMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Notice error={error} />
          <ConsoleSection title={t("aiui.plan")}>
            <ConsoleSelectField
              label={t("aiui.plan")}
              value={plan}
              onChange={setPlan}
              disabled={!writable || busy}
              options={[
                { value: "", label: t("aiui.inheritPlan") },
                ...options(plans.data?.items, false),
              ]}
            />
            <Check checked={suspended} onChange={setSuspended} disabled={!writable || busy}>
              {t("aiui.suspendAI")}
            </Check>
          </ConsoleSection>
          <ConsoleSection title={t("aiui.userOverrides")} description={t("aiui.overridesHint")}>
            <Rules values={rules} onChange={setRules} disabled={!writable || busy} />
          </ConsoleSection>
          <details className="ai-effective-rules">
            <summary>{t("aiui.effectiveLimits")}</summary>
            {current.data.rules.map((rule, index) => (
              <p key={index}>
                {aiMetric(rule.metric)} · {aiWindow(rule.window_kind)} ·{" "}
                {rule.limit_value === null
                  ? t("aiui.unlimited")
                  : rule.metric === "cost_micro_usd"
                    ? aiMoney(rule.limit_value)
                    : rule.limit_value.toLocaleString()}
              </p>
            ))}
          </details>
          {saved && <p role="status">{t("aiui.saved")}</p>}
          <ConsoleFormActions>
            {writable && (
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("common.saving") : t("common.saveChanges")}
              </Button>
            )}
          </ConsoleFormActions>
        </form>
      )}
    </>
  );
}
function UsageAudit({ page }: { page: string }) {
  const [after, setAfter] = useState(0);
  const resource = useAIResource<{
    usage?: (Record<string, unknown> & {
      invocations: number;
      input_tokens: number;
      output_tokens: number;
      cost_micro_usd: number | null;
    })[];
    events?: (AIRecord & {
      seq: number;
      actor_key: string;
      action: string;
      target_type: string;
      target_id: string | null;
      created_at: number;
    })[];
  }>(
    `${endpoint}/${page === "usage" ? "usage" : "audit?before=" + (after || Number.MAX_SAFE_INTEGER)}`,
  );
  return (
    <>
      <ConsoleSettingsHeader
        title={page === "usage" ? t("aiui.usage") : t("aiui.audit")}
        description={page === "usage" ? t("aiui.workspaceUsageHint") : t("aiui.auditHint")}
      >
        <Button variant="ghost" onClick={resource.reload}>
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleSettingsHeader>
      <ConsoleState loading={resource.loading} error={resource.error} />
      {resource.data && (
        <div className="console-table-wrap ai-admin-table">
          {page === "usage" ? (
            <table>
              <thead>
                <tr>
                  <th>{t("aiui.subject")}</th>
                  <th>{t("aiui.feature")}</th>
                  <th>{t("aiui.requests")}</th>
                  <th>{t("aiui.totalTokens")}</th>
                  <th>{t("aiui.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.usage?.map((row, index) => (
                  <tr key={index}>
                    <td>{String(row.billing_subject_id)}</td>
                    <td>{String(row.consumer_key)}</td>
                    <td>{row.invocations.toLocaleString()}</td>
                    <td>{(row.input_tokens + row.output_tokens).toLocaleString()}</td>
                    <td>
                      {aiMoney(row.cost_micro_usd)}
                      {!!row.unknown_cost_events && <small>{t("aiui.unpricedHint")}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("aiui.when")}</th>
                  <th>{t("aiui.actor")}</th>
                  <th>{t("aiui.action")}</th>
                  <th>{t("aiui.target")}</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.events?.map((event) => (
                  <tr key={event.seq}>
                    <td>{adminDate(event.created_at)}</td>
                    <td>{event.actor_key}</td>
                    <td>{event.action}</td>
                    <td>
                      {event.target_type}
                      <small className="console-subtext">{event.target_id}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!(resource.data.usage ?? resource.data.events)?.length && (
            <p className="ai-empty-inline">{t("aiui.noActivity")}</p>
          )}
        </div>
      )}
      {page !== "usage" && (
        <div className="ai-pagination">
          <Button disabled={!after} onClick={() => setAfter(0)}>
            {t("aiui.firstPage")}
          </Button>
          <Button
            disabled={!resource.data?.events || resource.data.events.length < 100}
            onClick={() => setAfter(resource.data?.events?.at(-1)?.seq ?? 0)}
          >
            {t("aiui.nextPage")}
          </Button>
        </div>
      )}
    </>
  );
}
function ReconciliationPage() {
  const { permissions } = useAccess(),
    writable = can("quotas", true, permissions);
  const resource = useAIResource<{
    invocations: (AIRecord & { created_at: number })[];
    tool_calls: (AIRecord & { run_id: string; created_at: number })[];
    external_operations: (AIRecord & { tool_name: string; created_at: number })[];
  }>(`${endpoint}/reconciliation`);
  const [selected, setSelected] = useState<{ path: string; id: string } | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const groups = [
    { title: t("aiui.requests"), key: "invocations" as const, path: "invocations" },
    { title: t("aiui.toolCalls"), key: "tool_calls" as const, path: "tool-calls" },
    { title: t("aiui.externalOperations"), key: "external_operations" as const, path: null },
  ];
  return (
    <>
      <ConsoleSettingsHeader
        title={t("aiui.reconciliation")}
        description={t("aiui.reconciliationHint")}
      >
        <Button onClick={resource.reload}>
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleSettingsHeader>
      <ConsoleState loading={resource.loading} error={resource.error} />
      {groups.map((group) => (
        <ConsoleSection key={group.key} title={group.title}>
          {resource.data?.[group.key].map((item) => (
            <div className="ai-connection-row" key={item.id}>
              <Icon name="info" />
              <div>
                <strong>{String(item.tool_name ?? item.id)}</strong>
                <small>{adminDate(item.created_at)}</small>
              </div>
              {writable && group.path && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setSelected({ path: group.path!, id: item.id });
                    setReason("");
                    setError("");
                  }}
                >
                  {t("aiui.reconcile")}
                </Button>
              )}
            </div>
          ))}
          {!resource.loading && !resource.data?.[group.key].length && (
            <p className="ai-empty-inline">{t("aiui.noReconciliation")}</p>
          )}
        </ConsoleSection>
      ))}
      <ConsoleDialog
        open={!!selected}
        title={t("aiui.reconcile")}
        description={t("aiui.reconcileConfirm")}
        onClose={() => setSelected(null)}
        busy={busy}
      >
        <form
          className="ai-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!selected) return;
            setBusy(true);
            setError("");
            try {
              await api(`${endpoint}/${selected.path}/${selected.id}/reconcile`, {
                method: "POST",
                body: { reason },
              });
              resource.reload();
              setSelected(null);
            } catch (failure) {
              setError(errorMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Notice error={error} />
          <ConsoleInput
            label={t("aiui.reason")}
            required
            value={reason}
            onValueChange={setReason}
            maxLength={1000}
          />
          <ConsoleFormActions>
            <Button onClick={() => setSelected(null)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>
              {t("aiui.reconcile")}
            </Button>
          </ConsoleFormActions>
        </form>
      </ConsoleDialog>
    </>
  );
}

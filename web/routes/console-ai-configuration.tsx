import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { t, type StaticMessageKey } from "../../shared/i18n/index.ts";
import {
  aiAdapters,
  aiProtocols,
  aiReasoningLevels,
  defaultAIProtocol,
  isAIReasoningLevel,
  reasoningLevelsFor,
  type AIConfiguredAccount,
  type AIModelConfiguration,
  type AIModelProvider,
  type AIProviderConfiguration,
  type AIProviderModel,
} from "../../shared/ai-configuration.ts";
import { api, errorMessage } from "../lib/api";
import { aiStatus, useAIResource } from "../lib/ai";
import { AccessDenied, useAccess } from "../components/console-access";
import { Check, Notice } from "../components/console-shared";
import { Button, Icon, useNotifications } from "../components/ui";
import {
  ConsoleDataTable,
  ConsoleDetail,
  ConsoleFieldset,
  ConsoleFilters,
  ConsoleForm,
  ConsoleFormActions,
  ConsoleInput,
  ConsoleSection,
  ConsoleSelectField,
  ConsoleSettingsHeader,
  ConsoleState,
} from "../components/console-settings";

const endpoint = "/api/ai/admin";
type ConfigurationKind = "providers" | "models";
const configurationPath = (kind: ConfigurationKind) => `/console/ai/${kind}`;
const configurationEndpoint = (kind: ConfigurationKind) =>
  `${endpoint}/${kind === "providers" ? "provider-configs" : "model-configs"}`;
const addLabel = (kind: ConfigurationKind) =>
  t(kind === "providers" ? "aiConfig.addProvider" : "aiConfig.addModel");
const blankAccount = (): AIConfiguredAccount => ({
  name: "",
  auth_kind: "api_key",
  share_scope: "workspace",
  status: "active",
  concurrency_limit: 10,
});
const providerDefaults: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  cloudflare: "",
  openai_compatible: "",
};
const blankProvider = (): AIProviderConfiguration => ({
  key: "",
  name: "",
  adapter_key: "openai",
  base_url: providerDefaults.openai!,
  enabled: true,
  accounts: [blankAccount()],
  oauth: null,
  gateway: null,
});
const blankSource = (): AIModelProvider => ({
  provider_id: "",
  provider_model_id: "",
  protocol: "openai_responses",
  auth_mode: "api",
  enabled: true,
  reasoning_levels: [],
  capabilities: {
    schema_version: 1,
    streaming: true,
    tool_calls: true,
    json_schema: true,
    input_token_bound: "utf8_bytes",
    input_overhead_tokens: 1024,
    bounded_usage: false,
    enforces_output_limit: true,
    context_tokens: 32768,
    max_output_tokens: 4096,
  },
  pricing: {
    schema_version: 1,
    source: "catalog",
    currency: "USD",
    unit: "micro_usd_per_million_tokens",
  },
});
const protocolLabel = (value: string) =>
  t(
    (
      {
        openai_responses: "aiui.protocolName.responses",
        openai_chat: "aiui.protocolName.chat",
        anthropic_messages: "aiui.protocolName.anthropic",
        google_generate_content: "aiui.protocolName.gemini",
        cloudflare_run: "aiui.protocolName.cloudflare",
      } as Record<string, StaticMessageKey>
    )[value]!,
  );

function providerPayload(value: AIProviderConfiguration) {
  const { id, ...provider } = value;
  return {
    ...provider,
    gateway: value.gateway
      ? {
          account_id: value.gateway.account_id,
          gateway_id: value.gateway.gateway_id,
          provider_slug: value.gateway.provider_slug,
          ...(value.gateway.api_key ? { api_key: value.gateway.api_key } : {}),
        }
      : null,
    accounts: value.accounts.map(({ has_secret, cooldown_until, ...account }) => ({
      ...account,
      name: account.name.trim() || value.name,
      ...(account.authorization_ref ? {} : { authorization_ref: undefined }),
    })),
  };
}
type ModelDraft = Omit<AIModelConfiguration, "providers"> & {
  providers: (AIModelProvider & { draftKey: string })[];
};
const modelSourceDraft = (source: AIModelProvider) => ({
  ...source,
  draftKey: source.id ?? crypto.randomUUID(),
});

function modelPayload(value: ModelDraft) {
  const { id, ...model } = value;
  return {
    ...model,
    providers: value.providers.map(({ cooldown_until, draftKey, ...source }) => source),
  };
}

export function AIProviderSettings() {
  return <ConfigurationList kind="providers" />;
}
export function AIModelSettings() {
  return <ConfigurationList kind="models" />;
}
function ConfigurationList({ kind }: { kind: ConfigurationKind }) {
  const provider = kind === "providers";
  const path = configurationPath(kind);
  const { permissions } = useAccess();
  const writable = permissions.includes("admin.ai.providers.manage");
  const resource = useAIResource<{ items: (AIProviderConfiguration | AIModelConfiguration)[] }>(
    configurationEndpoint(kind),
  );
  const providers = useAIResource<{ items: AIProviderConfiguration[] }>(
    !provider ? `${endpoint}/provider-configs` : null,
  );
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const title = t(provider ? "aiui.providers" : "aiui.models");
  const items =
    resource.data?.items.filter((item) =>
      `${item.name} ${item.key}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  async function connect(account: AIConfiguredAccount) {
    setBusy(true);
    setError("");
    try {
      const value = await api<{ authorization_url: string }>(
        `/api/ai/accounts/${account.id}/oauth/start`,
        { method: "POST", body: {} },
      );
      window.location.assign(value.authorization_url);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }
  async function retryProvider(item: AIProviderConfiguration) {
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}/provider-configs/${item.id}/reset`, {
        method: "POST",
        body: { version: item.version },
      });
      resource.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ConsoleSettingsHeader
        title={title}
        description={t(provider ? "aiConfig.providerHint" : "aiConfig.modelHint")}
      >
        {writable && (
          <Button variant="primary" nativeButton={false} render={<Link to={`${path}/new`} />}>
            <Icon name="plus" />
            {addLabel(kind)}
          </Button>
        )}
      </ConsoleSettingsHeader>
      <Notice error={error || providers.error} />
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
      <ConsoleState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
        kind="list"
      />
      {resource.data && (
        <ConsoleDataTable
          caption={title}
          headings={[
            t("common.name"),
            t(provider ? "aiConfig.credentials" : "aiConfig.providerOrder"),
            t("common.status"),
            <span className="console-sr-only">{t("common.actions")}</span>,
          ]}
          actions
          isEmpty={!items.length}
          loading={resource.loading}
          empty={<p>{t("consoleSettings.noRecords")}</p>}
        >
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.name}</strong>
                <small className="console-subtext">
                  {provider ? (item as AIProviderConfiguration).base_url : item.key}
                </small>
              </td>
              <td>
                {provider ? (
                  <div className="ai-config-credentials">
                    {(item as AIProviderConfiguration).accounts.map((account, index) => (
                      <div key={account.id ?? index}>
                        <span>
                          {account.name} ·{" "}
                          {account.auth_kind === "oauth" ? t("aiui.oauth") : t("aiui.apiKey")} ·{" "}
                          {account.cooldown_until && account.cooldown_until > Date.now() / 1000
                            ? t("aiConfig.quotaExhausted")
                            : aiStatus(account.status)}
                        </span>
                        {writable && account.auth_kind === "oauth" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void connect(account)}
                          >
                            {t("aiui.connect")}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <ol className="ai-config-order">
                    {(item as AIModelConfiguration).providers.map((source, index) => (
                      <li key={source.id ?? index}>
                        {providers.data?.items.find((entry) => entry.id === source.provider_id)
                          ?.name ?? source.provider_id}
                        <span className="console-subtext"> · {source.provider_model_id}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </td>
              <td>
                <span className="console-badge" data-muted={!item.enabled}>
                  {aiStatus(item.enabled ? "active" : "disabled")}
                </span>
              </td>
              <td>
                <div className="console-row-actions">
                  {provider &&
                    writable &&
                    (item as AIProviderConfiguration).accounts.some(
                      (account) => (account.cooldown_until ?? 0) > Date.now() / 1000,
                    ) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void retryProvider(item as AIProviderConfiguration)}
                      >
                        {t("aiConfig.retryProvider")}
                      </Button>
                    )}
                  {writable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      nativeButton={false}
                      render={<Link to={`${path}/${encodeURIComponent(item.id!)}`} />}
                    >
                      {t("common.edit")}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </ConsoleDataTable>
      )}
    </>
  );
}

export function AIConfigurationEditorPage({ kind, id }: { kind: ConfigurationKind; id: string }) {
  const { permissions } = useAccess();
  const writable = permissions.includes("admin.ai.providers.manage");
  const creating = id === "new";
  const provider = kind === "providers";
  const path = configurationPath(kind);
  const title = t(provider ? "aiui.providers" : "aiui.models");
  const resource = useAIResource<{ item: AIProviderConfiguration | AIModelConfiguration }>(
    writable && !creating ? `${configurationEndpoint(kind)}/${encodeURIComponent(id)}` : null,
  );
  const providers = useAIResource<{ items: AIProviderConfiguration[] }>(
    writable && !provider ? configurationEndpoint("providers") : null,
  );
  const item = resource.data?.item;
  const navigate = useNavigate();
  const notify = useNotifications();
  if (!writable) return <AccessDenied />;
  function saved(item: AIProviderConfiguration | AIModelConfiguration) {
    notify.success(t("aiui.saved"));
    if (creating) navigate(`${path}/${encodeURIComponent(item.id!)}`, { replace: true });
    else resource.update({ item });
  }
  return (
    <ConsoleDetail backTo={path} backLabel={title}>
      <ConsoleSettingsHeader title={creating ? addLabel(kind) : (item?.name ?? title)} />
      <ConsoleState
        loading={resource.loading || providers.loading}
        error={resource.error || providers.error}
        retry={resource.error ? resource.reload : providers.reload}
        kind="form"
      />
      {(creating || item) &&
        (provider ? (
          <ProviderEditor
            key={item?.version}
            initial={item ? (item as AIProviderConfiguration) : blankProvider()}
            onSaved={saved}
          />
        ) : (
          providers.data && (
            <ModelEditor
              key={item?.version}
              initial={
                item
                  ? (item as AIModelConfiguration)
                  : {
                      key: "",
                      name: "",
                      vendor: "",
                      enabled: true,
                      capabilities: {},
                      providers: [blankSource()],
                    }
              }
              providers={providers.data.items}
              onSaved={saved}
            />
          )
        ))}
    </ConsoleDetail>
  );
}

function ProviderEditor({
  initial,
  onSaved,
}: {
  initial: AIProviderConfiguration;
  onSaved: (item: AIProviderConfiguration) => void;
}) {
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (patch: Partial<AIProviderConfiguration>) =>
    setValue((old) => ({ ...old, ...patch }));
  const changeAccount = (index: number, patch: Partial<AIConfiguredAccount>) =>
    change({
      accounts: value.accounts.map((account, i) =>
        i === index ? { ...account, ...patch } : account,
      ),
    });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { item } = await api<{ item: AIProviderConfiguration }>(
        `${endpoint}/provider-configs${initial.id ? "/" + initial.id : ""}`,
        {
          method: initial.id ? "PATCH" : "POST",
          body: providerPayload(value),
        },
      );
      onSaved(item);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleForm onSubmit={(event) => void save(event)}>
      <ConsoleSection title={t("aiui.configuration")}>
        <ConsoleFieldset disabled={busy}>
          <ConsoleInput
            label={t("common.name")}
            required
            value={value.name}
            onValueChange={(name) => change({ name })}
          />
          <ConsoleInput
            label={t("aiui.key")}
            required
            value={value.key}
            disabled={!!initial.id}
            onValueChange={(key) => change({ key })}
          />
          <ConsoleSelectField
            label={t("aiui.adapter")}
            value={value.adapter_key}
            options={aiAdapters.map((adapter) => ({ value: adapter, label: adapter }))}
            onChange={(adapter) =>
              change({
                adapter_key: adapter as AIProviderConfiguration["adapter_key"],
                ...(!initial.id ? { base_url: providerDefaults[adapter] ?? "" } : {}),
              })
            }
          />
          <ConsoleInput
            label={t("aiui.baseURL")}
            type="url"
            required
            value={value.base_url}
            onValueChange={(base_url) => change({ base_url })}
          />
          <Check checked={value.enabled} onChange={(enabled) => change({ enabled })}>
            {t("common.enabled")}
          </Check>
        </ConsoleFieldset>
      </ConsoleSection>
      <ConsoleSection
        title={t("aiConfig.credentials")}
        action={
          <Button
            disabled={busy || value.accounts.length >= 16}
            onClick={() => change({ accounts: [...value.accounts, blankAccount()] })}
          >
            <Icon name="plus" />
            {t("aiConfig.addAccount")}
          </Button>
        }
      >
        <div className="console-record-list">
          {value.accounts.map((account, index) => (
            <div key={account.id ?? index} className="ai-config-record">
              {value.accounts.length > 1 && (
                <div className="console-record">
                  <div>
                    <strong>
                      {account.name.trim() || t("aiConfig.accountNumber", { number: index + 1 })}
                    </strong>
                  </div>
                  <div className="console-row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        change({ accounts: value.accounts.filter((_, i) => index !== i) })
                      }
                    >
                      {t("common.remove")}
                    </Button>
                  </div>
                </div>
              )}
              <ConsoleFieldset disabled={busy}>
                <div className="console-form-grid">
                  <ConsoleInput
                    label={t("aiConfig.accountName")}
                    value={account.name}
                    onValueChange={(name) => changeAccount(index, { name })}
                  />
                  <ConsoleSelectField
                    label={t("aiui.authKind")}
                    value={account.auth_kind}
                    options={[
                      { value: "api_key", label: t("aiui.apiKey") },
                      { value: "oauth", label: t("aiui.oauth") },
                    ]}
                    onChange={(kind) =>
                      changeAccount(index, {
                        auth_kind: kind as "api_key" | "oauth",
                        ...(kind !== account.auth_kind
                          ? { has_secret: false, credentials: {} }
                          : {}),
                      })
                    }
                  />
                  {account.auth_kind === "api_key" && (
                    <ConsoleInput
                      label={t("aiui.apiKey")}
                      type="password"
                      autoComplete="new-password"
                      required={!account.has_secret}
                      hint={account.has_secret ? t("aiui.secretUnchanged") : undefined}
                      value={account.credentials?.api_key ?? ""}
                      onValueChange={(api_key) =>
                        changeAccount(index, {
                          credentials: {
                            ...account.credentials,
                            ...(api_key ? { api_key } : { api_key: undefined }),
                          },
                        })
                      }
                    />
                  )}
                  <ConsoleSelectField
                    label={t("common.status")}
                    value={account.status}
                    options={[
                      { value: "active", label: t("aiui.active") },
                      { value: "disabled", label: t("aiui.disabled") },
                      ...(account.status === "reauth_required"
                        ? [{ value: "reauth_required", label: aiStatus("reauth_required") }]
                        : []),
                    ]}
                    onChange={(status) => changeAccount(index, { status })}
                  />
                </div>
                <Check
                  checked={account.share_scope === "workspace"}
                  onChange={(shared) =>
                    changeAccount(index, { share_scope: shared ? "workspace" : "owner" })
                  }
                >
                  {t("aiConfig.workspaceAccount")}
                </Check>
                <details
                  className="console-role-summary"
                  onInvalidCapture={(event) => {
                    event.currentTarget.open = true;
                  }}
                >
                  <summary>{t("aiui.advanced")}</summary>
                  <div className="console-form-grid">
                    <ConsoleInput
                      label={t("aiui.concurrency")}
                      type="number"
                      min={1}
                      max={10000}
                      required
                      value={String(account.concurrency_limit)}
                      onValueChange={(value) =>
                        changeAccount(index, { concurrency_limit: Number(value) })
                      }
                    />
                    <ConsoleInput
                      label={t("aiui.quotaGroup")}
                      value={account.quota_group_key ?? ""}
                      onValueChange={(quota_group_key) =>
                        changeAccount(index, { quota_group_key: quota_group_key || null })
                      }
                    />
                    <ConsoleInput
                      label={t("aiui.authorizationRef")}
                      value={account.authorization_ref ?? ""}
                      onValueChange={(authorization_ref) =>
                        changeAccount(index, { authorization_ref: authorization_ref || null })
                      }
                    />
                    {account.share_scope === "owner" && (
                      <ConsoleInput
                        label={t("aiui.ownerID")}
                        value={account.owner_user_id ?? ""}
                        onValueChange={(owner_user_id) =>
                          changeAccount(index, { owner_user_id: owner_user_id || null })
                        }
                      />
                    )}
                    {account.auth_kind === "oauth" && (
                      <ConsoleInput
                        label={t("aiui.clientSecret")}
                        type="password"
                        autoComplete="new-password"
                        value={account.credentials?.client_secret ?? ""}
                        onValueChange={(client_secret) =>
                          changeAccount(index, {
                            credentials: {
                              ...account.credentials,
                              client_secret: client_secret || undefined,
                            },
                          })
                        }
                      />
                    )}
                  </div>
                </details>
              </ConsoleFieldset>
            </div>
          ))}
        </div>
      </ConsoleSection>
      {(value.accounts.some((account) => account.auth_kind === "oauth") || value.oauth) && (
        <ConsoleSection title={t("aiui.oauth")} description={t("aiConfig.oauthHint")}>
          <div className="console-form-grid">
            {[
              "issuer",
              "authorization_endpoint",
              "token_endpoint",
              "jwks_uri",
              "revocation_endpoint",
              "client_id",
              "scope",
              "resource",
              "hosted_authorization_ref",
            ].map((key) => (
              <ConsoleInput
                key={key}
                label={t(`aiui.oauth.${key}` as StaticMessageKey)}
                value={String(value.oauth?.[key] ?? "")}
                required={!["resource", "revocation_endpoint"].includes(key)}
                onValueChange={(next) => change({ oauth: { ...value.oauth, [key]: next } })}
                disabled={busy}
              />
            ))}
          </div>
        </ConsoleSection>
      )}
      <ConsoleSection title={t("aiui.gateway")}>
        <ConsoleFieldset disabled={busy}>
          <Check
            checked={!!value.gateway}
            disabled={busy}
            onChange={(enabled) =>
              change({
                gateway: enabled
                  ? {
                      account_id: "",
                      gateway_id: "",
                      provider_slug:
                        value.adapter_key === "openai_compatible" ? "openai" : value.adapter_key,
                    }
                  : null,
              })
            }
          >
            {t("aiConfig.useGateway")}
          </Check>
          {value.gateway && (
            <div className="console-form-grid">
              {(["account_id", "gateway_id", "provider_slug", "api_key"] as const).map((key) => (
                <ConsoleInput
                  key={key}
                  label={t(
                    (
                      {
                        account_id: "aiui.cloudflareAccount",
                        gateway_id: "aiui.gatewayID",
                        provider_slug: "aiui.providerSlug",
                        api_key: "aiui.gatewayKey",
                      } as const
                    )[key],
                  )}
                  type={key === "api_key" ? "password" : "text"}
                  autoComplete={key === "api_key" ? "new-password" : "off"}
                  hint={
                    key === "api_key" && value.gateway?.has_secret
                      ? t("aiui.secretUnchanged")
                      : undefined
                  }
                  required={key !== "api_key" || !value.gateway?.has_secret}
                  disabled={busy}
                  value={value.gateway?.[key] ?? ""}
                  onValueChange={(next) => change({ gateway: { ...value.gateway!, [key]: next } })}
                />
              ))}
            </div>
          )}
        </ConsoleFieldset>
      </ConsoleSection>
      <Notice error={error} />
      <ConsoleFormActions>
        <Button
          nativeButton={false}
          render={<Link to={configurationPath("providers")} />}
          disabled={busy}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("common.saving") : initial.id ? t("common.saveChanges") : addLabel("providers")}
        </Button>
      </ConsoleFormActions>
    </ConsoleForm>
  );
}

function ModelEditor({
  initial,
  providers,
  onSaved,
}: {
  initial: AIModelConfiguration;
  providers: AIProviderConfiguration[];
  onSaved: (item: AIModelConfiguration) => void;
}) {
  const [value, setValue] = useState<ModelDraft>(() => ({
      ...initial,
      providers: initial.providers.map(modelSourceDraft),
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (patch: Partial<ModelDraft>) => setValue((old) => ({ ...old, ...patch }));
  const changeSource = (index: number, patch: Partial<AIModelProvider>) => {
    change({
      providers: value.providers.map((source, i) => {
        if (i !== index) return source;
        const next = { ...source, ...patch };
        if (
          next.provider_id !== source.provider_id ||
          next.provider_model_id !== source.provider_model_id ||
          next.auth_mode !== source.auth_mode ||
          next.protocol !== source.protocol
        )
          next.reasoning_levels = [];
        return next;
      }),
    });
  };
  const { default_reasoning_effort: defaultEffort, ...tokenCapabilities } = value.capabilities;
  const availableEfforts = aiReasoningLevels.filter((level) =>
    value.providers.some(
      (source) =>
        source.enabled &&
        reasoningLevelsFor(source.protocol).includes(level) &&
        source.reasoning_levels?.includes(level),
    ),
  );
  const unsupportedDefault =
    defaultEffort !== undefined && !availableEfforts.includes(defaultEffort);
  function move(index: number, direction: number) {
    const next = [...value.providers];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    change({ providers: next });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || unsupportedDefault) return;
    setBusy(true);
    setError("");
    try {
      const { item } = await api<{ item: AIModelConfiguration }>(
        `${endpoint}/model-configs${initial.id ? "/" + initial.id : ""}`,
        {
          method: initial.id ? "PATCH" : "POST",
          body: modelPayload(value),
        },
      );
      onSaved(item);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConsoleForm onSubmit={(event) => void save(event)}>
      <ConsoleSection title={t("aiui.configuration")}>
        <ConsoleFieldset disabled={busy}>
          <ConsoleInput
            label={t("common.name")}
            required
            value={value.name}
            onValueChange={(name) => change({ name })}
          />
          <ConsoleInput
            label={t("aiui.key")}
            required
            value={value.key}
            disabled={!!initial.id}
            onValueChange={(key) => change({ key })}
          />
          <ConsoleInput
            label={t("aiui.vendor")}
            value={value.vendor}
            onValueChange={(vendor) => change({ vendor })}
          />
          <Check checked={value.enabled} onChange={(enabled) => change({ enabled })}>
            {t("common.enabled")}
          </Check>
        </ConsoleFieldset>
      </ConsoleSection>
      <ConsoleSection
        title={t("aiConfig.modelCapabilities")}
        description={t("aiConfig.modelLimitsHint")}
      >
        <ConsoleFieldset disabled={busy}>
          <div className="console-form-grid">
            <ConsoleInput
              label={t("aiConfig.maxContext")}
              type="number"
              min={1}
              value={String(value.capabilities.context_tokens ?? "")}
              onValueChange={(next) => {
                const { context_tokens, ...rest } = value.capabilities;
                change({
                  capabilities: next === "" ? rest : { ...rest, context_tokens: Number(next) },
                });
              }}
            />
            <ConsoleInput
              label={t("aiui.maxOutput")}
              type="number"
              min={1}
              max={
                value.capabilities.context_tokens === undefined
                  ? undefined
                  : value.capabilities.context_tokens - 1
              }
              value={String(value.capabilities.max_output_tokens ?? "")}
              onValueChange={(next) => {
                const { max_output_tokens, ...rest } = value.capabilities;
                change({
                  capabilities: next === "" ? rest : { ...rest, max_output_tokens: Number(next) },
                });
              }}
            />
          </div>
          <ConsoleSelectField
            label={t("aiConfig.defaultReasoning")}
            value={defaultEffort ?? ""}
            disabled={busy || (!availableEfforts.length && !unsupportedDefault)}
            options={[
              { value: "", label: t("aiConfig.automaticReasoning") },
              ...availableEfforts.map((level) => ({
                value: level,
                label: t(`aiConfig.reasoning.${level}`),
              })),
              ...(unsupportedDefault
                ? [{ value: defaultEffort, label: t(`aiConfig.reasoning.${defaultEffort}`) }]
                : []),
            ]}
            onChange={(level) =>
              change({
                capabilities: isAIReasoningLevel(level)
                  ? { ...tokenCapabilities, default_reasoning_effort: level }
                  : tokenCapabilities,
              })
            }
          />
          <p className="console-subtext">
            {t(
              unsupportedDefault
                ? "aiConfig.unsupportedReasoning"
                : "aiConfig.defaultReasoningHint",
            )}
          </p>
        </ConsoleFieldset>
      </ConsoleSection>
      <ConsoleSection
        title={t("aiConfig.providerOrder")}
        description={t("aiConfig.orderHint")}
        action={
          <Button
            onClick={() =>
              change({ providers: [...value.providers, modelSourceDraft(blankSource())] })
            }
            disabled={busy || value.providers.length >= 64}
          >
            <Icon name="plus" />
            {t("aiConfig.addProvider")}
          </Button>
        }
      >
        {!value.providers.length && (
          <p className="console-subtext">{t("aiConfig.noModelProviders")}</p>
        )}
        <div className="console-record-list">
          {value.providers.map((source, index) => (
            <div key={source.draftKey} className="ai-config-record">
              <div className="console-record">
                <div>
                  <strong>{t("aiConfig.providerNumber", { number: index + 1 })}</strong>
                </div>
                <div className="console-row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("aiConfig.moveUp")}
                    disabled={index === 0 || busy}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="chevron" style={{ transform: "rotate(-90deg)" }} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("aiConfig.moveDown")}
                    disabled={index === value.providers.length - 1 || busy}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="chevron" style={{ transform: "rotate(90deg)" }} />
                  </Button>
                  {value.providers.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        change({ providers: value.providers.filter((_, i) => i !== index) })
                      }
                    >
                      {t("common.remove")}
                    </Button>
                  )}
                </div>
              </div>
              <ConsoleFieldset disabled={busy}>
                <div className="console-form-grid">
                  <ConsoleSelectField
                    label={t("aiui.provider")}
                    required
                    value={source.provider_id}
                    disabled={busy}
                    options={[
                      { value: "", label: t("aiui.choose") },
                      ...providers.map((provider) => ({
                        value: provider.id!,
                        label: provider.name,
                      })),
                    ]}
                    onChange={(id) => {
                      const provider = providers.find((entry) => entry.id === id);
                      changeSource(index, {
                        provider_id: id,
                        provider_model_id: "",
                        protocol: provider
                          ? defaultAIProtocol(provider.adapter_key)
                          : "openai_responses",
                      });
                    }}
                  />
                  <ProviderModelInput
                    key={source.provider_id}
                    source={source}
                    onChange={(patch) => changeSource(index, patch)}
                    disabled={busy}
                  />
                </div>
                <details
                  className="console-role-summary"
                  open={
                    !source.id ||
                    !initial.providers.find((entry) => entry.id === source.id)?.capabilities
                      .bounded_usage
                  }
                  onInvalidCapture={(event) => {
                    event.currentTarget.open = true;
                  }}
                >
                  <summary>{t("aiConfig.usageAndPricing")}</summary>
                  <div className="console-form-grid">
                    <ConsoleInput
                      label={t("aiui.contextTokens")}
                      type="number"
                      required
                      min={1}
                      value={String(source.capabilities.context_tokens ?? "")}
                      onValueChange={(next) =>
                        changeSource(index, {
                          capabilities: { ...source.capabilities, context_tokens: Number(next) },
                        })
                      }
                    />
                    <ConsoleInput
                      label={t("aiui.maxOutput")}
                      type="number"
                      required
                      min={1}
                      value={String(source.capabilities.max_output_tokens ?? "")}
                      onValueChange={(next) =>
                        changeSource(index, {
                          capabilities: { ...source.capabilities, max_output_tokens: Number(next) },
                        })
                      }
                    />
                  </div>
                  <div className="console-form-grid">
                    <ModelPrices
                      source={source}
                      fields={["input", "output"]}
                      onChange={(patch) => changeSource(index, patch)}
                    />
                  </div>
                  <Check
                    checked={source.capabilities.bounded_usage === true}
                    onChange={(checked) =>
                      changeSource(index, {
                        capabilities: { ...source.capabilities, bounded_usage: checked },
                      })
                    }
                  >
                    {t("aiui.verifiedBounds")}
                  </Check>
                </details>
                <details
                  className="console-role-summary"
                  onInvalidCapture={(event) => {
                    event.currentTarget.open = true;
                  }}
                >
                  <summary>{t("aiui.advanced")}</summary>
                  <div className="console-form-grid">
                    <ConsoleSelectField
                      label={t("aiui.protocol")}
                      value={source.protocol}
                      options={aiProtocols.map((protocol) => ({
                        value: protocol,
                        label: protocolLabel(protocol),
                      }))}
                      onChange={(protocol) =>
                        changeSource(index, { protocol: protocol as AIModelProvider["protocol"] })
                      }
                    />
                    <ConsoleSelectField
                      label={t("aiui.authMode")}
                      value={source.auth_mode}
                      options={[
                        { value: "api", label: t("aiui.apiBilling") },
                        { value: "chatgpt_plan", label: t("aiui.subscription") },
                        { value: "platform", label: t("aiui.platformBilling") },
                      ]}
                      onChange={(auth_mode) =>
                        changeSource(index, {
                          auth_mode: auth_mode as AIModelProvider["auth_mode"],
                        })
                      }
                    />
                    <ConsoleSelectField
                      label={t("aiui.pricingSource")}
                      value={String(source.pricing.source ?? "unknown")}
                      options={[
                        { value: "unknown", label: t("aiui.unpriced") },
                        { value: "catalog", label: t("aiui.catalogPrice") },
                        { value: "internal_rate", label: t("aiui.internalPrice") },
                      ]}
                      onChange={(pricingSource) =>
                        changeSource(index, {
                          pricing: { ...source.pricing, source: pricingSource },
                        })
                      }
                    />
                    <ModelPrices
                      source={source}
                      fields={["cache_read", "cache_write"]}
                      onChange={(patch) => changeSource(index, patch)}
                    />
                  </div>
                  {source.provider_model_id && reasoningLevelsFor(source.protocol).length > 0 && (
                    <fieldset className="ai-config-reasoning">
                      <legend>{t("aiConfig.supportedReasoning")}</legend>
                      {reasoningLevelsFor(source.protocol).map((level) => (
                        <Check
                          key={level}
                          checked={source.reasoning_levels?.includes(level) ?? false}
                          onChange={(checked) => {
                            const levels = source.reasoning_levels ?? [];
                            changeSource(index, {
                              reasoning_levels: checked
                                ? [...levels, level]
                                : levels.filter((item) => item !== level),
                            });
                          }}
                        >
                          {t(`aiConfig.reasoning.${level}`)}
                        </Check>
                      ))}
                    </fieldset>
                  )}
                  <div className="ai-config-options">
                    <Check
                      checked={source.capabilities.tool_calls === true}
                      onChange={(checked) =>
                        changeSource(index, {
                          capabilities: { ...source.capabilities, tool_calls: checked },
                        })
                      }
                    >
                      {t("aiui.supportsTools")}
                    </Check>
                    <Check
                      checked={source.capabilities.json_schema === true}
                      onChange={(checked) =>
                        changeSource(index, {
                          capabilities: { ...source.capabilities, json_schema: checked },
                        })
                      }
                    >
                      {t("aiui.supportsJSON")}
                    </Check>
                    <Check
                      checked={source.enabled}
                      onChange={(enabled) => changeSource(index, { enabled })}
                    >
                      {t("common.enabled")}
                    </Check>
                  </div>
                </details>
              </ConsoleFieldset>
            </div>
          ))}
        </div>
      </ConsoleSection>
      <Notice error={error} />
      <ConsoleFormActions>
        <Button
          nativeButton={false}
          render={<Link to={configurationPath("models")} />}
          disabled={busy}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || unsupportedDefault || !value.providers.length}
        >
          {busy ? t("common.saving") : initial.id ? t("common.saveChanges") : addLabel("models")}
        </Button>
      </ConsoleFormActions>
    </ConsoleForm>
  );
}

function ModelPrices({
  source,
  fields,
  onChange,
}: {
  source: AIModelProvider;
  fields: string[];
  onChange: (patch: Partial<AIModelProvider>) => void;
}) {
  return fields.map((key) => (
    <ConsoleInput
      key={key}
      label={t(`aiui.price.${key}` as StaticMessageKey)}
      type="number"
      min={0}
      step="0.000001"
      required={
        source.enabled && source.pricing.source !== "unknown" && ["input", "output"].includes(key)
      }
      value={source.pricing[key] == null ? "" : String(Number(source.pricing[key]) / 1_000_000)}
      onValueChange={(next) => {
        const pricing = { ...source.pricing };
        if (next === "") delete pricing[key];
        else pricing[key] = Math.round(Number(next) * 1_000_000);
        onChange({ pricing });
      }}
    />
  ));
}

function ProviderModelInput({
  source,
  disabled,
  onChange,
}: {
  source: AIModelProvider;
  disabled: boolean;
  onChange: (patch: Partial<AIModelProvider>) => void;
}) {
  const [models, setModels] = useState<AIProviderModel[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [manual, setManual] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    if (!source.provider_id || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ models: AIProviderModel[]; next_cursor: string | null }>(
        `${endpoint}/provider-configs/${source.provider_id}/models${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      setModels((old) => [
        ...old,
        ...data.models.filter((model) => !old.some((entry) => entry.id === model.id)),
      ]);
      setCursor(data.next_cursor);
    } catch {
      setError(t("aiConfig.catalogUnavailable"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (source.provider_id) void load();
  }, [source.provider_id]);
  function select(id: string) {
    const model = models.find((entry) => entry.id === id);
    onChange({
      provider_model_id: id,
      ...(model?.pricing
        ? { pricing: { ...source.pricing, source: "catalog", ...model.pricing } }
        : {}),
      capabilities: {
        ...source.capabilities,
        ...(model?.context_tokens ? { context_tokens: model.context_tokens } : {}),
        ...(model?.max_output_tokens ? { max_output_tokens: model.max_output_tokens } : {}),
      },
    });
  }
  const useCatalog = !manual && models.length > 0;
  const modelId = source.provider_model_id;
  return (
    <div className="console-form-fields">
      {useCatalog ? (
        <ConsoleSelectField
          label={t("aiConfig.availableModels")}
          value={modelId ? `model:${modelId}` : ""}
          required
          disabled={disabled}
          options={[
            { value: "", label: t("aiui.choose") },
            ...(modelId && !models.some((model) => model.id === modelId)
              ? [{ value: `model:${modelId}`, label: modelId }]
              : []),
            ...models.map((model) => ({
              value: `model:${model.id}`,
              label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
            })),
            { value: "manual", label: t("aiConfig.enterModelId") },
          ]}
          onChange={(value) => {
            if (value === "manual") setManual(true);
            else select(value.slice("model:".length));
          }}
        />
      ) : (
        <ConsoleInput
          label={t("aiui.modelID")}
          required
          value={modelId}
          disabled={disabled}
          onValueChange={(provider_model_id) => {
            setManual(true);
            onChange({ provider_model_id });
          }}
        />
      )}
      {(!useCatalog && models.length > 0) || (useCatalog && cursor) || error ? (
        <div className="console-row-actions">
          {!useCatalog && models.length > 0 && (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setManual(false)}>
              {t("aiConfig.chooseFromCatalog")}
            </Button>
          )}
          {((useCatalog && cursor) || error) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => void load()}
            >
              {t(cursor && !error ? "aiConfig.moreModels" : "consoleSettings.retry")}
            </Button>
          )}
        </div>
      ) : null}
      {busy && (
        <p className="console-subtext" role="status">
          {t("common.loading")}
        </p>
      )}
      {error && (
        <p className="console-subtext" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

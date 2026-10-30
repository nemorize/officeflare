import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { type DomainProvider, type Domain, type Mailbox } from "../lib/mail";
import { useAccess } from "../components/console-access";
import {
  MailField,
  MailInput,
  MailNotice,
  MailSection,
  MailState,
  useMailAction,
  useMailResource,
  MailForm,
  MailSelect,
  MailFieldset,
} from "../components/mail-common";
import { MailRules } from "../components/mail-rules";
import { Button, useNotifications } from "../components/ui";
import { Check, ConsolePageHeader } from "../components/console-shared";
import { SharedMailboxes } from "./console-shared-mailboxes";
import "./console.css";
import "./mail.css";
export function MailConsolePage({ page }: { page: string }) {
  return (
    <section className="account-page console-page mail-console-page">
      {page === "mailboxes" ? <SharedMailboxes /> : <Domains />}
    </section>
  );
}
function useMailboxDirectory() {
  const permissions = useAccess().permissions;
  return useMailResource<{ mailboxes: Mailbox[] }>(
    permissions.includes("admin.mail.mailboxes.read")
      ? "/api/mail/mailboxes?all=true"
      : permissions.includes("mail.access")
        ? "/api/mail/mailboxes"
        : null,
  );
}
function Domains() {
  const permissions = useAccess().permissions,
    resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>(
      "/api/mail/domains",
    ),
    manage = permissions.includes("admin.mail.domains.manage");
  const providerName = (provider: string | null | undefined) =>
    provider
      ? (resource.data?.providers.find((entry) => entry.provider === provider)?.label ?? provider)
      : t("routesConsoleMail.noProvider");
  return (
    <>
      <ConsolePageHeader
        title={t("routesConsoleMail.mailDomains")}
        description={t(
          "routesConsoleMail.configureCommonDomainsDeliveryProvidersAndInboundRouting",
        )}
      >
        {manage && (
          <Button
            nativeButton={false}
            render={<Link to="/console/mail/domains/new" />}
            variant="primary"
          >
            {t("routesConsoleMail.registerDomain")}
          </Button>
        )}
      </ConsolePageHeader>
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      <div className="mail-domain-grid">
        {resource.data?.domains.map((domain) => (
          <article key={domain.id} className="mail-domain-card">
            <h2>
              <span>{domain.name}</span>
              {!!domain.is_default && (
                <span className="mail-badge mail-domain-default">
                  {t("routesConsoleMail.default")}
                </span>
              )}
            </h2>
            <p>
              <span className="mail-badge">
                <LocalizedMessage
                  id="routesConsoleMail.receive"
                  values={{
                    value1: domain.inbound_enabled ? t("common.enabled") : t("common.disabled"),
                  }}
                />
              </span>
              <span className="mail-badge">
                <LocalizedMessage
                  id="routesConsoleMail.send"
                  values={{
                    value1: domain.outbound_enabled ? t("common.enabled") : t("common.disabled"),
                  }}
                />
              </span>
            </p>
            <p className="mail-hint">
              <LocalizedMessage
                id="routesConsoleMail.receivingSending"
                values={{
                  providerName: providerName(domain.inbound_provider),
                  value2: providerName(domain.outbound_provider),
                }}
              />
            </p>
            <Button
              nativeButton={false}
              render={<Link to={`/console/mail/domains/${encodeURIComponent(domain.id)}`} />}
              size="sm"
            >
              {manage ? t("routesConsoleMail.configureDomain") : t("routesConsoleMail.viewDomain")}
            </Button>
          </article>
        ))}
      </div>
      {resource.data && !resource.data.domains.length && (
        <div className="mail-empty">
          <h2>{t("routesConsoleMail.noMailDomainsRegistered")}</h2>
          <p>{t("routesConsoleMail.registerADomainAndConfigureCloudflareDeliveryUserAnd")}</p>
        </div>
      )}
    </>
  );
}
type ProviderConnection = {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  version: number;
  config: Record<string, string>;
  secret_configured: boolean;
};
export function MailDomainEditorPage({ creating = false }: { creating?: boolean }) {
  const { id } = useParams(),
    navigate = useNavigate(),
    notify = useNotifications(),
    permissions = useAccess().permissions;
  const resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>(
      "/api/mail/domains",
    ),
    boxes = useMailboxDirectory(),
    domain = resource.data?.domains.find((entry) => entry.id === id),
    manage = permissions.includes("admin.mail.domains.manage");
  const canManageProviders = permissions.includes("admin.mail.providers.manage"),
    providerConnections = useMailResource<{ connections: ProviderConnection[] }>(
      permissions.includes("admin.mail.providers.read") ? "/api/mail/provider-connections" : null,
    );
  return (
    <section className="account-page console-page console-detail-page mail-console-page">
      <Link to="/console/mail/domains" className="console-back">
        {t("routesConsoleMail.mailDomains2")}
      </Link>
      <ConsolePageHeader
        title={
          creating
            ? t("routesConsoleMail.registerMailDomain")
            : (domain?.name ?? t("routesConsoleMail.mailDomain"))
        }
        description={t(
          "routesConsoleMail.configureTheSharedDomainDeliveryProvidersAndInboundRouting",
        )}
      />
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data && !creating && !domain && (
        <MailNotice error={t("routesConsoleMail.thisMailDomainCouldNotBeFound")} />
      )}
      {resource.data && (creating || domain) && (
        <>
          <DomainEditor
            key={creating ? "new" : domain!.id}
            existing={domain}
            providers={resource.data.providers}
            boxes={boxes.data?.mailboxes ?? []}
            providerConnections={providerConnections.data?.connections ?? []}
            providerConnectionsLoading={
              permissions.includes("admin.mail.providers.read") &&
              (providerConnections.loading ||
                (!providerConnections.data && !providerConnections.error))
            }
            providerConnectionsError={providerConnections.error}
            reloadProviderConnections={providerConnections.reload}
            canManage={manage}
            canManageProviders={canManageProviders}
            defaultDomain={
              creating
                ? !resource.data.domains.some((entry) => entry.is_default)
                : !!domain?.is_default
            }
            onSaved={(domainId) => {
              notify.success(
                creating
                  ? t("routesConsoleMail.domainRegistered")
                  : t("routesConsoleMail.domainSettingsSaved"),
              );
              if (creating) navigate(`/console/mail/domains/${encodeURIComponent(domainId)}`);
              else resource.reload();
              providerConnections.reload();
            }}
          />
          {domain && (
            <>
              <MailSection
                title={t("routesConsoleMail.addresses")}
                description={t(
                  "routesConsoleMail.managePersonalAddressesWithUsersAndTeamAddressesWith",
                )}
              >
                <div className="mail-actions">
                  {permissions.includes("admin.users.read") && (
                    <Button nativeButton={false} render={<Link to="/console/users" />}>
                      {t("routesConsoleMail.manageUsers")}
                    </Button>
                  )}
                  {permissions.includes("admin.mail.mailboxes.read") && (
                    <Button nativeButton={false} render={<Link to="/console/mail/mailboxes" />}>
                      {t("routesConsoleMail.sharedMailboxes")}
                    </Button>
                  )}
                </div>
              </MailSection>
              <details className="console-role-summary">
                <summary>{t("routesConsoleMail.advancedInboundRouting")}</summary>
                <MailRules
                  path={`/api/mail/domains/${domain.id}/rules`}
                  routing
                  canManage={manage}
                />
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
function DomainEditor({
  existing,
  providers,
  boxes,
  providerConnections,
  providerConnectionsLoading,
  providerConnectionsError,
  reloadProviderConnections,
  canManage,
  canManageProviders,
  defaultDomain,
  onSaved,
}: {
  existing?: Domain;
  providers: DomainProvider[];
  boxes: Mailbox[];
  providerConnections: ProviderConnection[];
  providerConnectionsLoading: boolean;
  providerConnectionsError: string;
  reloadProviderConnections: () => void;
  canManage: boolean;
  canManageProviders: boolean;
  defaultDomain: boolean;
  onSaved: (id: string) => void;
}) {
  const action = useMailAction();
  const initialProvider = (direction: "inbound" | "outbound") =>
    existing
      ? (existing[`${direction}_provider`] ??
        (existing[`${direction}_connection_id`] ? "cloudflare" : ""))
      : (providers[0]?.provider ?? "");
  const [isDefault, setDefault] = useState(defaultDomain);
  const [name, setName] = useState(existing?.name ?? ""),
    [inbound, setInbound] = useState(initialProvider("inbound")),
    [outbound, setOutbound] = useState(initialProvider("outbound"));
  const initialOutboundConnection =
    existing?.outbound_connection_id ??
    (initialProvider("outbound") === "cloudflare"
      ? (providers.find((provider) => provider.provider === "cloudflare")?.default_connection_id ??
        null)
      : null);
  const [outboundConnectionId, setOutboundConnectionId] = useState<string | null>(
      initialOutboundConnection,
    ),
    [providerConfig, setProviderConfig] = useState<Record<string, string>>({}),
    [providerSecrets, setProviderSecrets] = useState<Record<string, string>>({}),
    [providerSecretEdits, setProviderSecretEdits] = useState<Record<string, boolean>>({}),
    [providerConnectionEnabled, setProviderConnectionEnabled] = useState(true),
    [createdConnection, setCreatedConnection] = useState<ProviderConnection | null>(null);
  const [providerConfigDirty, setProviderConfigDirty] = useState(false);
  const [sendLimit, setSendLimit] = useState(
    existing?.max_send_bytes ? String(existing.max_send_bytes / 1024 ** 2) : "",
  );
  const selectedProvider = providers.find((provider) => provider.provider === outbound),
    selectedConnection =
      createdConnection?.id === outboundConnectionId && createdConnection.provider === outbound
        ? createdConnection
        : providerConnections.find(
            (connection) =>
              connection.id === outboundConnectionId && connection.provider === outbound,
          ),
    providerMaximum = selectedProvider?.capabilities.max_send_bytes ?? 0;
  const [receive, setReceive] = useState(!!existing?.inbound_enabled),
    [send, setSend] = useState(!!existing?.outbound_enabled),
    [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true),
    [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  useEffect(() => {
    if (providerConfigDirty) return;
    const saved =
      createdConnection?.id === outboundConnectionId && createdConnection.provider === outbound
        ? createdConnection
        : providerConnections.find(
            (connection) =>
              connection.id === outboundConnectionId && connection.provider === outbound,
          );
    const definition = providers.find((provider) => provider.provider === outbound);
    setProviderConfig(
      saved?.config ??
        Object.fromEntries(
          (definition?.config_fields ?? [])
            .filter((field) => field.options?.length)
            .map((field) => [field.key, field.options![0]!]),
        ),
    );
    setProviderConnectionEnabled(saved ? !!saved.enabled : true);
  }, [
    outboundConnectionId,
    outbound,
    providerConnections,
    providers,
    providerConfigDirty,
    createdConnection,
  ]);
  const providerName = (provider: string) =>
    providers.find((entry) => entry.provider === provider)?.label ??
    (provider === "cloudflare" ? t("routesConsoleMail.cloudflare") : provider);
  const providerOptions = (direction: "receive" | "send", selected: string) => [
    { value: "", label: t("routesConsoleMail.noProvider") },
    ...providers
      .filter((provider) => provider.capabilities[direction])
      .map((provider) => ({ value: provider.provider, label: providerName(provider.provider) })),
    ...(selected &&
    !providers.some(
      (provider) => provider.provider === selected && provider.capabilities[direction],
    )
      ? [
          {
            value: selected,
            label: t("routesConsoleMail.unsupported", { providerName: providerName(selected) }),
          },
        ]
      : []),
  ];
  const submit = async () => {
    const inboundId = !inbound
      ? null
      : existing && inbound === initialProvider("inbound")
        ? existing.inbound_connection_id
        : (providers.find((provider) => provider.provider === inbound)?.default_connection_id ??
          null);
    let outboundId = outbound
      ? (outboundConnectionId ??
        (outbound === "cloudflare" ? (selectedProvider?.default_connection_id ?? null) : null))
      : null;
    if (receive && !inboundId)
      throw new Error(t("routesConsoleMail.chooseAConfiguredProviderForEachEnabledDirection"));
    if (
      outbound &&
      selectedProvider &&
      canManageProviders &&
      (selectedProvider.config_fields.length || selectedProvider.secret_fields.length)
    ) {
      if (providerConnectionsLoading)
        throw new Error(t("routesConsoleMail.providerConnectionsAreStillLoadingTryAgainInA"));
      if (providerConnectionsError)
        throw new Error(t("routesConsoleMail.couldNotLoadProviderConnectionsReloadThePageBefore"));
      const secretUpdates = Object.fromEntries(
        selectedProvider.secret_fields
          .filter((field) => providerSecrets[field.key]?.trim())
          .map((field) => [field.key, providerSecrets[field.key]!.trim()]),
      );
      const secretsEntered = Object.keys(secretUpdates).length > 0;
      if (outboundId && !selectedConnection)
        throw new Error(
          t("routesConsoleMail.couldNotLoadTheSelectedSendingProviderConnectionReload"),
        );
      if (!outboundId) {
        if (send && !providerConnectionEnabled)
          throw new Error(
            t("routesConsoleMail.enableThisProviderConnectionBeforeEnablingSendingForThe"),
          );
        const result = await api<{ connection: ProviderConnection }>(
          "/api/mail/provider-connections",
          {
            method: "POST",
            body: {
              provider: selectedProvider.provider,
              name: `${name || t("routesConsoleMail.mailDomain")} · ${selectedProvider.label}`,
              enabled: providerConnectionEnabled,
              config: providerConfig,
              ...(secretsEntered ? { secrets: secretUpdates } : {}),
            },
          },
        );
        outboundId = result.connection.id;
        setOutboundConnectionId(outboundId);
        setCreatedConnection(result.connection);
        setProviderSecrets({});
        setProviderSecretEdits({});
        setProviderConfigDirty(false);
      } else if (selectedConnection) {
        if (send && !providerConnectionEnabled)
          throw new Error(
            t("routesConsoleMail.enableThisProviderConnectionBeforeEnablingSendingForThe"),
          );
        if (
          providerConfigDirty ||
          secretsEntered ||
          providerConnectionEnabled !== !!selectedConnection.enabled
        ) {
          const result = await api<{ connection: ProviderConnection }>(
            `/api/mail/provider-connections/${encodeURIComponent(selectedConnection.id)}`,
            {
              method: "PATCH",
              body: {
                version: selectedConnection.version,
                name: `${name || t("routesConsoleMail.mailDomain")} · ${providerName(selectedProvider.provider)}`,
                enabled: providerConnectionEnabled,
                config: providerConfig,
                ...(secretsEntered ? { secrets: secretUpdates } : {}),
              },
            },
          );
          setCreatedConnection(result.connection);
          setProviderSecrets({});
          setProviderSecretEdits({});
          setProviderConfigDirty(false);
        }
      }
    }
    if (outbound && !outboundId)
      throw new Error(t("routesConsoleMail.addCredentialsForThisSendingProviderBeforeAssigningIt"));
    if (send && !outboundId)
      throw new Error(t("routesConsoleMail.chooseAConfiguredProviderForEachEnabledDirection"));
    const result = await api<{ domain: Domain }>(
      `/api/mail/domains${existing ? `/${existing.id}` : ""}`,
      {
        method: existing ? "PATCH" : "POST",
        body: {
          ...(existing ? { catch_all_mailbox_id: catchAll || null } : { name }),
          ...(!existing || inboundId !== existing.inbound_connection_id
            ? { inbound_connection_id: inboundId }
            : {}),
          ...(!existing || outboundId !== existing.outbound_connection_id
            ? { outbound_connection_id: outboundId }
            : {}),
          inbound_enabled: receive,
          outbound_enabled: send,
          plus_addressing: plus,
          is_default: isDefault,
          max_send_bytes:
            outbound && sendLimit !== "" ? Math.round(Number(sendLimit) * 1024 ** 2) : null,
        },
      },
    );
    onSaved(result.domain.id);
  };
  return (
    <MailSection
      title={t("routesConsoleMail.domainSettings")}
      description={t("routesConsoleMail.providerConfigurationAndDeliverySettingsApplyToThisDomain")}
    >
      <MailForm
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(submit);
        }}
      >
        <MailFieldset disabled={action.busy || !canManage}>
          <MailInput
            label={t("routesConsoleMail.domain")}
            placeholder={t("routesConsoleMail.exampleCom")}
            required
            disabled={!!existing}
            value={name}
            maxLength={253}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="mail-form-grid">
            <MailField label={t("routesConsoleMail.receivingProvider")}>
              <MailSelect
                value={inbound}
                onValueChange={(value) => {
                  setInbound(value);
                  if (!value) setReceive(false);
                }}
                options={providerOptions("receive", inbound)}
              />
            </MailField>
            <MailField label={t("routesConsoleMail.sendingProvider")}>
              <MailSelect
                value={outbound}
                onValueChange={(value) => {
                  const next = providers.find((provider) => provider.provider === value),
                    current =
                      createdConnection?.provider === value
                        ? createdConnection
                        : existing?.outbound_provider === value
                          ? providerConnections.find(
                              (connection) => connection.id === existing.outbound_connection_id,
                            )
                          : undefined,
                    nextConnectionId =
                      current?.id ??
                      (value === "cloudflare" ? (next?.default_connection_id ?? null) : null);
                  setOutbound(value);
                  setOutboundConnectionId(nextConnectionId);
                  setProviderConfigDirty(false);
                  setProviderSecrets({});
                  setProviderSecretEdits({});
                  setProviderConnectionEnabled(current ? !!current.enabled : true);
                  if (!value) {
                    setSend(false);
                    setSendLimit("");
                  } else {
                    const maximum = next?.capabilities.max_send_bytes ?? 0;
                    if (sendLimit && Number(sendLimit) * 1024 ** 2 > maximum)
                      setSendLimit(String(maximum / 1024 ** 2));
                  }
                }}
                options={providerOptions("send", outbound)}
              />
            </MailField>
          </div>
          {outbound &&
            selectedProvider &&
            (selectedProvider.config_fields.length > 0 ||
              selectedProvider.secret_fields.length > 0) && (
              <>
                {!canManageProviders ? (
                  <p className="mail-hint">
                    {t("routesConsoleMail.yourRoleNeedsTheManageSendingProvidersPermissionTo")}
                  </p>
                ) : providerConnectionsLoading ? (
                  <MailState loading error="" kind="form" />
                ) : providerConnectionsError ? (
                  <MailState
                    loading={false}
                    error={providerConnectionsError}
                    retry={reloadProviderConnections}
                  />
                ) : (
                  <>
                    {selectedProvider.config_fields.map((field) =>
                      field.options ? (
                        <MailField key={field.key} label={field.label} hint={field.help}>
                          <MailSelect
                            value={providerConfig[field.key] ?? field.options[0] ?? ""}
                            onValueChange={(value) => {
                              setProviderConfig((current) => ({ ...current, [field.key]: value }));
                              setProviderConfigDirty(true);
                            }}
                            options={field.options.map((value) => ({
                              value,
                              label:
                                value === "tls"
                                  ? t("routesConsoleMail.tlsPort465")
                                  : value === "starttls"
                                    ? t("routesConsoleMail.starttlsPort587")
                                    : value,
                            }))}
                          />
                        </MailField>
                      ) : (
                        <MailInput
                          key={field.key}
                          label={field.label}
                          hint={field.help}
                          required={!!field.required}
                          value={providerConfig[field.key] ?? ""}
                          onChange={(event) => {
                            setProviderConfig((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }));
                            setProviderConfigDirty(true);
                          }}
                        />
                      ),
                    )}
                    {selectedProvider.secret_fields.map((field) => {
                      const saved = !!selectedConnection?.secret_configured,
                        enabled = !saved || !!providerSecretEdits[field.key];
                      return (
                        <div className="mail-secret-field-row" key={field.key}>
                          <MailInput
                            label={field.label}
                            hint={field.help}
                            required={!!field.required && !saved}
                            disabled={!enabled}
                            placeholder={saved ? t("routesConsoleMail.enterToChange") : ""}
                            type="password"
                            autoComplete="new-password"
                            value={providerSecrets[field.key] ?? ""}
                            onChange={(event) => {
                              const value = event.target.value;
                              setProviderSecrets((current) => ({ ...current, [field.key]: value }));
                              if (value)
                                setProviderSecretEdits((current) => ({
                                  ...current,
                                  [field.key]: true,
                                }));
                            }}
                          />
                          {saved && (
                            <div className="mail-secret-change">
                              <Check
                                checked={!!providerSecretEdits[field.key]}
                                onChange={(checked) => {
                                  setProviderSecretEdits((current) => ({
                                    ...current,
                                    [field.key]: checked,
                                  }));
                                  if (!checked)
                                    setProviderSecrets((current) => ({
                                      ...current,
                                      [field.key]: "",
                                    }));
                                }}
                              >
                                {t("routesConsoleMail.change")}
                              </Check>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {selectedConnection && (
                      <Check
                        checked={providerConnectionEnabled}
                        onChange={(checked) => {
                          setProviderConnectionEnabled(checked);
                          setProviderConfigDirty(true);
                        }}
                      >
                        {t("routesConsoleMail.sendingProviderConnectionEnabled")}
                      </Check>
                    )}
                  </>
                )}
              </>
            )}
          <MailInput
            label={t("routesConsoleMail.maximumMessageSizeMib")}
            hint={
              providerMaximum
                ? t("routesConsoleMail.providerMaximumMibLeaveEmptyToUseThatMaximum", {
                    value1: providerMaximum / 1024 ** 2,
                  })
                : t("routesConsoleMail.chooseASendingProviderToSetAMessageSize")
            }
            type="number"
            min={1 / 1024 ** 2}
            max={providerMaximum / 1024 ** 2}
            step="any"
            disabled={!providerMaximum}
            placeholder={providerMaximum ? String(providerMaximum / 1024 ** 2) : ""}
            value={sendLimit}
            onChange={(event) => setSendLimit(event.target.value)}
          />
          <Check checked={isDefault} onChange={setDefault}>
            {t("routesConsoleMail.useAsTheDefaultDomainForNewUserAddresses")}
          </Check>
          <Check checked={receive} onChange={setReceive} disabled={!inbound}>
            {t("routesConsoleMail.enableReceiving")}
          </Check>
          <Check checked={send} onChange={setSend} disabled={!outbound}>
            {t("routesConsoleMail.enableSending")}
          </Check>
          <Check checked={plus} onChange={setPlus}>
            {t("routesConsoleMail.enablePlusAddressingNameTagExampleCom")}
          </Check>
          {existing && (
            <MailField
              label={t("routesConsoleMail.catchAllMailbox")}
              hint={t("routesConsoleMail.unmatchedRecipientsInThisDomainAreDeliveredToThe")}
            >
              <MailSelect
                value={catchAll}
                onValueChange={setCatchAll}
                options={[
                  { value: "", label: t("routesConsoleMail.noCatchAll") },
                  ...(catchAll && !boxes.some((box) => box.id === catchAll)
                    ? [{ value: catchAll, label: catchAll }]
                    : []),
                  ...boxes
                    .filter((box) => box.status === "active")
                    .map((box) => ({ value: box.id, label: box.name })),
                ]}
              />
            </MailField>
          )}
        </MailFieldset>
        <MailNotice error={action.error} />
        {canManage && (
          <div className="mail-actions">
            <Button
              nativeButton={false}
              disabled={action.busy}
              render={<Link to="/console/mail/domains" />}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={action.busy || (canManageProviders && providerConnectionsLoading)}
            >
              {action.busy
                ? t("common.saving")
                : existing
                  ? t("routesConsoleMail.saveDomain")
                  : t("routesConsoleMail.registerDomain")}
            </Button>
          </div>
        )}
      </MailForm>
    </MailSection>
  );
}

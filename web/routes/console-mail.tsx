import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { mailConsolePages } from "../lib/console";
import { type DomainProvider, type Domain, type Mailbox } from "../lib/mail";
import { AccessDenied, useAccess } from "../components/console-access";
import {
  MailAuditLog,
  MailboxDirectory,
  MailFlowPage,
  MailOverview,
  MailPolicies,
  MailProviders,
} from "./console-mail-admin";
import type { ProviderConnection } from "../lib/mail-admin";
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
import { Button, Tabs, useNotifications } from "../components/ui";
import { Check, ConsolePageHeader } from "../components/console-shared";
import "./console.css";
import "./mail.css";
export function MailConsoleLayout() {
  const { permissions } = useAccess(),
    navigate = useNavigate(),
    location = useLocation();
  const pages = mailConsolePages.filter((page) => permissions.includes(page.permission));
  const requested = location.pathname.split("/")[3],
    selected = mailConsolePages.find((page) => page.page === requested)?.page ?? pages[0]?.page;
  return (
    <section className="account-page console-page mail-console-page" data-ui-theme="neutral">
      <ConsolePageHeader
        title={t("libConsole.mail")}
        description={t("mailAdmin.titleDescription")}
      />
      {selected && (
        <Tabs.Root value={selected} onValueChange={(value) => navigate(`/console/mail/${value}`)}>
          <div className="console-tabs">
            <Tabs.List aria-label={t("routesConsoleMail.mailNavigation")}>
              {pages.map((page) => (
                <Tabs.Tab key={page.page} value={page.page}>
                  {page.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>
          <Tabs.Panel value={selected}>
            <Outlet />
          </Tabs.Panel>
        </Tabs.Root>
      )}
    </section>
  );
}
export function MailConsolePage({ page }: { page: string }) {
  const { permissions } = useAccess();
  if (page === "home")
    return (
      <Navigate
        replace
        to={`/console/mail/${mailConsolePages.find((page) => permissions.includes(page.permission))?.page ?? "domains"}`}
      />
    );
  const config = mailConsolePages.find((entry) => entry.page === page);
  if (!config || !permissions.includes(config.permission)) return <AccessDenied />;
  return page === "overview" ? (
    <MailOverview />
  ) : page === "mailboxes" ? (
    <MailboxDirectory />
  ) : page === "providers" ? (
    <MailProviders />
  ) : page === "flow" ? (
    <MailFlowPage />
  ) : page === "settings" ? (
    <MailPolicies />
  ) : page === "activity" ? (
    <MailAuditLog />
  ) : (
    <Domains />
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
        level={2}
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
    <div className="console-detail-page">
      <Link to="/console/mail/domains" className="console-back">
        {t("routesConsoleMail.mailDomains2")}
      </Link>
      <ConsolePageHeader
        level={2}
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
    </div>
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
  const { permissions } = useAccess(),
    canReadProviders = permissions.includes("admin.mail.providers.read"),
    action = useMailAction();
  const initialProvider = (direction: "inbound" | "outbound") =>
    existing
      ? (existing[`${direction}_provider`] ??
        (existing[`${direction}_connection_id`] ? "cloudflare" : ""))
      : (providers[0]?.provider ?? "");
  const [name, setName] = useState(existing?.name ?? ""),
    [isDefault, setDefault] = useState(defaultDomain);
  const [inbound, setInbound] = useState(initialProvider("inbound")),
    [outbound, setOutbound] = useState(initialProvider("outbound"));
  const [outboundId, setOutboundId] = useState<string | null>(
    existing?.outbound_connection_id ??
      providers.find((provider) => provider.provider === initialProvider("outbound"))
        ?.default_connection_id ??
      null,
  );
  const [receive, setReceive] = useState(!!existing?.inbound_enabled),
    [send, setSend] = useState(!!existing?.outbound_enabled),
    [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true),
    [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  const [sendLimit, setSendLimit] = useState(
    existing?.max_send_bytes ? String(existing.max_send_bytes / 1024 ** 2) : "",
  );
  const selectedProvider = providers.find((provider) => provider.provider === outbound),
    providerMaximum = selectedProvider?.capabilities.max_send_bytes ?? 0;
  const available = (provider: string) =>
    providerConnections.filter(
      (connection) =>
        connection.provider === provider &&
        (provider === "cloudflare" ||
          !connection.domain_ids?.length ||
          connection.domain_ids.every((id) => id === existing?.id)),
    );
  const connections = available(outbound);
  const selectedConnection = providerConnections.find((connection) => connection.id === outboundId);
  const providerOptions = (direction: "receive" | "send", selected: string) => [
    { value: "", label: t("routesConsoleMail.noProvider") },
    ...providers
      .filter((provider) => provider.capabilities[direction])
      .map((provider) => ({
        value: provider.provider,
        label: provider.label ?? provider.provider,
      })),
    ...(selected &&
    !providers.some(
      (provider) => provider.provider === selected && provider.capabilities[direction],
    )
      ? [{ value: selected, label: t("routesConsoleMail.unsupported", { providerName: selected }) }]
      : []),
  ];
  const submit = async () => {
    const inboundId = !inbound
      ? null
      : existing && inbound === initialProvider("inbound")
        ? existing.inbound_connection_id
        : (providers.find((provider) => provider.provider === inbound)?.default_connection_id ??
          null);
    if (
      (receive && !inboundId) ||
      (outbound && !outboundId) ||
      (send && (!outboundId || selectedConnection?.enabled === 0))
    )
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
      description={t("mailAdmin.domainConnectionDescription")}
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
                  setOutbound(value);
                  const definition = providers.find((provider) => provider.provider === value);
                  setOutboundId(
                    existing && value === initialProvider("outbound")
                      ? existing.outbound_connection_id
                      : (available(value).find((connection) => connection.enabled)?.id ??
                          definition?.default_connection_id ??
                          null),
                  );
                  if (!value) {
                    setSend(false);
                    setSendLimit("");
                  } else if (
                    sendLimit &&
                    Number(sendLimit) * 1024 ** 2 > (definition?.capabilities.max_send_bytes ?? 0)
                  )
                    setSendLimit(
                      String((definition?.capabilities.max_send_bytes ?? 0) / 1024 ** 2),
                    );
                }}
                options={providerOptions("send", outbound)}
              />
            </MailField>
          </div>
          {outbound && (
            <MailField
              label={t("mailAdmin.sendingConnection")}
              hint={t("mailAdmin.sendingConnectionHint")}
            >
              <MailSelect
                value={outboundId ?? ""}
                disabled={
                  !canReadProviders || providerConnectionsLoading || !!providerConnectionsError
                }
                onValueChange={(value) => setOutboundId(value || null)}
                options={[
                  { value: "", label: t("mailAdmin.chooseConnection") },
                  ...(outboundId && !connections.some((connection) => connection.id === outboundId)
                    ? [{ value: outboundId, label: selectedProvider?.label ?? outbound }]
                    : []),
                  ...connections.map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                    disabled: !connection.enabled && connection.id !== outboundId,
                  })),
                ]}
              />
              {canManageProviders && (
                <Link to="/console/mail/providers">{t("mailAdmin.manageProviderConnections")}</Link>
              )}
              <MailState
                loading={providerConnectionsLoading}
                error={providerConnectionsError}
                retry={reloadProviderConnections}
              />
            </MailField>
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
              disabled={action.busy || providerConnectionsLoading}
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

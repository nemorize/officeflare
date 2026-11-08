import {
  ConsoleField,
  ConsoleInput,
  ConsoleSection,
  ConsoleState,
  ConsoleSelect,
  ConsoleSettingsHeader,
  ConsoleDetail,
  ConsoleSettingsLayout,
  ConsoleFormActions,
  ConsoleForm,
  ConsoleFieldset,
} from "../components/console-settings";
import { Notice } from "../components/console-shared";
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
} from "./console-mail-admin";
import { useMailAction, useMailResource } from "../components/mail-common";
import { MailRules } from "../components/mail-rules";
import { Button, useNotifications } from "../components/ui";
import { Check } from "../components/console-shared";
import "./console.css";
import "./mail.css";
export function MailConsoleLayout() {
  const { permissions } = useAccess(),
    navigate = useNavigate(),
    location = useLocation();
  const pages = mailConsolePages.filter((page) => permissions.includes(page.permission));
  const requested = location.pathname.split("/")[3];
  const selected = pages.find((page) => page.page === requested)?.page ?? pages[0]?.page ?? "";
  return (
    <ConsoleSettingsLayout
      title={t("libConsole.mail")}
      description={t("mailAdmin.titleDescription")}
      pages={pages.map((page) => ({ path: page.page, name: page.label }))}
      selected={selected}
      onNavigate={(page) => navigate(`/console/mail/${page}`)}
      navigationLabel={t("routesConsoleMail.mailNavigation")}
    >
      <Outlet />
    </ConsoleSettingsLayout>
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
      <ConsoleSettingsHeader
        title={t("mailAdmin.domains")}
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
            {t("consoleSettings.addDomain")}
          </Button>
        )}
      </ConsoleSettingsHeader>
      <ConsoleState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      <div className="console-card-grid">
        {resource.data?.domains.map((domain) => (
          <ConsoleSection
            key={domain.id}
            title={
              <>
                <span>{domain.name}</span>
                {!!domain.is_default && (
                  <span className="console-badge">{t("routesConsoleMail.default")}</span>
                )}
              </>
            }
          >
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
              {manage ? t("consoleSettings.manage") : t("consoleSettings.view")}
            </Button>
          </ConsoleSection>
        ))}
      </div>
      {resource.data && !resource.data.domains.length && (
        <ConsoleSection className="console-empty">
          <h3>{t("routesConsoleMail.noMailDomainsRegistered")}</h3>
          <p>{t("routesConsoleMail.registerADomainAndConfigureCloudflareDeliveryUserAnd")}</p>
        </ConsoleSection>
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
  const canManageProviders = permissions.includes("admin.mail.providers.manage");
  return (
    <ConsoleDetail backTo="/console/mail/domains" backLabel={t("mailAdmin.domains")}>
      <ConsoleSettingsHeader
        title={
          creating
            ? t("consoleSettings.addDomain")
            : (domain?.name ?? t("routesConsoleMail.mailDomain"))
        }
        description={t(
          "routesConsoleMail.configureTheSharedDomainDeliveryProvidersAndInboundRouting",
        )}
      />
      <ConsoleState
        loading={resource.loading && (!resource.data || (!creating && !domain))}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data && !resource.loading && !creating && !domain && (
        <Notice error={t("routesConsoleMail.thisMailDomainCouldNotBeFound")} />
      )}
      {resource.data && (creating || domain) && (
        <>
          <DomainEditor
            key={creating ? "new" : domain!.id}
            existing={domain}
            providers={resource.data.providers}
            boxes={boxes.data?.mailboxes ?? []}
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
              resource.reload();
              if (creating) navigate(`/console/mail/domains/${encodeURIComponent(domainId)}`);
            }}
          />
          {domain && (
            <>
              <ConsoleSection
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
              </ConsoleSection>
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
    </ConsoleDetail>
  );
}
type ProviderValues = {
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  editingSecrets: Record<string, boolean>;
};
type Direction = "inbound" | "outbound";
function DomainEditor({
  existing,
  providers,
  boxes,
  canManage,
  canManageProviders,
  defaultDomain,
  onSaved,
}: {
  existing?: Domain;
  providers: DomainProvider[];
  boxes: Mailbox[];
  canManage: boolean;
  canManageProviders: boolean;
  defaultDomain: boolean;
  onSaved: (id: string) => void;
}) {
  const action = useMailAction();
  const initial = (direction: Direction): ProviderValues => {
    const saved = existing?.provider_settings[direction];
    const selected = existing ? (saved?.provider ?? "") : (providers[0]?.provider ?? "");
    const definition = providers.find((entry) => entry.provider === selected);
    return {
      provider: selected,
      config:
        saved?.config ??
        Object.fromEntries(
          (definition?.config_fields ?? [])
            .filter((field) => field.options?.length)
            .map((field) => [field.key, field.options![0]!]),
        ),
      secrets: {},
      editingSecrets: {},
    };
  };
  const [settings, setSettings] = useState(() => ({
    inbound: initial("inbound"),
    outbound: initial("outbound"),
  }));
  const [providerDirty, setProviderDirty] = useState(false);
  const [name, setName] = useState(existing?.name ?? ""),
    [isDefault, setDefault] = useState(defaultDomain);
  const [receive, setReceive] = useState(!!existing?.inbound_enabled),
    [send, setSend] = useState(!!existing?.outbound_enabled),
    [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true),
    [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  const [sendLimit, setSendLimit] = useState(
    existing?.max_send_bytes ? String(existing.max_send_bytes / 1024 ** 2) : "",
  );
  const providerMaximum =
    providers.find((entry) => entry.provider === settings.outbound.provider)?.capabilities
      .max_send_bytes ?? 0;
  const update = (direction: Direction, values: Partial<ProviderValues>) => {
    setProviderDirty(true);
    setSettings((current) => ({ ...current, [direction]: { ...current[direction], ...values } }));
  };
  const choose = (direction: Direction, selected: string) => {
    const definition = providers.find((entry) => entry.provider === selected),
      saved = existing?.provider_settings[direction];
    update(direction, {
      provider: selected,
      config:
        saved?.provider === selected
          ? (saved.config ?? {})
          : Object.fromEntries(
              (definition?.config_fields ?? [])
                .filter((field) => field.options?.length)
                .map((field) => [field.key, field.options![0]!]),
            ),
      secrets: {},
      editingSecrets: {},
    });
    if (direction === "inbound" && !selected) setReceive(false);
    if (direction === "outbound") {
      if (!selected) {
        setSend(false);
        setSendLimit("");
      } else if (
        sendLimit &&
        Number(sendLimit) * 1024 ** 2 > (definition?.capabilities.max_send_bytes ?? 0)
      )
        setSendLimit(String((definition?.capabilities.max_send_bytes ?? 0) / 1024 ** 2));
    }
  };
  const submit = async () => {
    if ((receive && !settings.inbound.provider) || (send && !settings.outbound.provider))
      throw new Error(t("routesConsoleMail.chooseAConfiguredProviderForEachEnabledDirection"));
    const serialized = (value: ProviderValues) =>
      value.provider
        ? {
            provider: value.provider,
            config: value.config,
            secrets: Object.fromEntries(
              Object.entries(value.secrets).filter(([, secret]) => secret.trim()),
            ),
          }
        : null;
    const result = await api<{ domain: Domain }>(
      `/api/mail/domains${existing ? `/${existing.id}` : ""}`,
      {
        method: existing ? "PATCH" : "POST",
        body: {
          ...(existing
            ? { version: existing.version, catch_all_mailbox_id: catchAll || null }
            : { name }),
          ...(canManageProviders && (providerDirty || !existing)
            ? {
                provider_settings: {
                  inbound: serialized(settings.inbound),
                  outbound: serialized(settings.outbound),
                },
              }
            : {}),
          inbound_enabled: receive,
          outbound_enabled: send,
          plus_addressing: plus,
          is_default: isDefault,
          max_send_bytes:
            settings.outbound.provider && sendLimit !== ""
              ? Math.round(Number(sendLimit) * 1024 ** 2)
              : null,
        },
      },
    );
    setSettings((current) => ({
      inbound: { ...current.inbound, secrets: {}, editingSecrets: {} },
      outbound: { ...current.outbound, secrets: {}, editingSecrets: {} },
    }));
    setProviderDirty(false);
    onSaved(result.domain.id);
  };
  return (
    <ConsoleSection
      title={t("routesConsoleMail.domainSettings")}
      description={t("domainProviders.description")}
    >
      <ConsoleForm
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(submit);
        }}
      >
        <ConsoleFieldset disabled={action.busy || !canManage}>
          <ConsoleInput
            label={t("routesConsoleMail.domain")}
            placeholder={t("routesConsoleMail.exampleCom")}
            required
            disabled={!!existing}
            value={name}
            maxLength={253}
            onChange={(event) => setName(event.target.value)}
          />
          {(["inbound", "outbound"] as const).map((direction) => {
            const values = settings[direction],
              selected = providers.find((entry) => entry.provider === values.provider),
              saved = existing?.provider_settings[direction];
            const secretSaved = saved?.provider === values.provider && saved.secret_configured;
            return (
              <div className="console-form-fields" key={direction}>
                <ConsoleField
                  label={
                    direction === "inbound"
                      ? t("routesConsoleMail.receivingProvider")
                      : t("routesConsoleMail.sendingProvider")
                  }
                >
                  <ConsoleSelect
                    value={values.provider}
                    disabled={!canManageProviders}
                    onValueChange={(value) => choose(direction, value)}
                    options={[
                      { value: "", label: t("routesConsoleMail.noProvider") },
                      ...providers
                        .filter(
                          (entry) =>
                            entry.capabilities[direction === "inbound" ? "receive" : "send"],
                        )
                        .map((entry) => ({
                          value: entry.provider,
                          label: entry.label ?? entry.provider,
                        })),
                      ...(values.provider && !selected
                        ? [
                            {
                              value: values.provider,
                              label: t("routesConsoleMail.unsupported", {
                                providerName: values.provider,
                              }),
                            },
                          ]
                        : []),
                    ]}
                  />
                </ConsoleField>
                {!!(selected?.config_fields.length || selected?.secret_fields.length) && (
                  <ConsoleFieldset disabled={!canManageProviders}>
                    {selected?.config_fields.map((field) =>
                      field.options ? (
                        <ConsoleField key={field.key} label={field.label} hint={field.help}>
                          <ConsoleSelect
                            value={values.config[field.key] ?? field.options[0] ?? ""}
                            onValueChange={(value) =>
                              update(direction, {
                                config: { ...values.config, [field.key]: value },
                              })
                            }
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
                        </ConsoleField>
                      ) : (
                        <ConsoleInput
                          key={field.key}
                          label={field.label}
                          hint={field.help}
                          required={!!field.required}
                          value={values.config[field.key] ?? ""}
                          onChange={(event) =>
                            update(direction, {
                              config: { ...values.config, [field.key]: event.target.value },
                            })
                          }
                        />
                      ),
                    )}
                    {selected?.secret_fields.map((field) => {
                      const editing = !secretSaved || !!values.editingSecrets[field.key];
                      return (
                        <div className="mail-secret-field-row" key={field.key}>
                          <ConsoleInput
                            label={field.label}
                            hint={secretSaved ? t("mailAdmin.keepCredential") : field.help}
                            required={!!field.required && !secretSaved}
                            disabled={!editing}
                            placeholder={secretSaved ? t("routesConsoleMail.enterToChange") : ""}
                            type="password"
                            autoComplete="new-password"
                            value={values.secrets[field.key] ?? ""}
                            onChange={(event) =>
                              update(direction, {
                                secrets: { ...values.secrets, [field.key]: event.target.value },
                              })
                            }
                          />
                          {secretSaved && (
                            <div className="mail-secret-change">
                              <Check
                                checked={!!values.editingSecrets[field.key]}
                                onChange={(checked) =>
                                  update(direction, {
                                    editingSecrets: {
                                      ...values.editingSecrets,
                                      [field.key]: checked,
                                    },
                                    ...(!checked
                                      ? { secrets: { ...values.secrets, [field.key]: "" } }
                                      : {}),
                                  })
                                }
                              >
                                {t("routesConsoleMail.change")}
                              </Check>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </ConsoleFieldset>
                )}
              </div>
            );
          })}
          {!canManageProviders && (
            <p className="mail-hint">
              {t("routesConsoleMail.yourRoleNeedsTheManageSendingProvidersPermissionTo")}
            </p>
          )}
          <ConsoleInput
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
          <Check checked={receive} onChange={setReceive} disabled={!settings.inbound.provider}>
            {t("routesConsoleMail.enableReceiving")}
          </Check>
          <Check checked={send} onChange={setSend} disabled={!settings.outbound.provider}>
            {t("routesConsoleMail.enableSending")}
          </Check>
          <Check checked={plus} onChange={setPlus}>
            {t("routesConsoleMail.enablePlusAddressingNameTagExampleCom")}
          </Check>
          {existing && (
            <ConsoleField
              label={t("routesConsoleMail.catchAllMailbox")}
              hint={t("routesConsoleMail.unmatchedRecipientsInThisDomainAreDeliveredToThe")}
            >
              <ConsoleSelect
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
            </ConsoleField>
          )}
        </ConsoleFieldset>
        <Notice error={action.error} />
        {canManage && (
          <ConsoleFormActions>
            <Button
              nativeButton={false}
              disabled={action.busy}
              render={<Link to="/console/mail/domains" />}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={action.busy}>
              {action.busy
                ? t("common.saving")
                : existing
                  ? t("common.saveChanges")
                  : t("consoleSettings.addDomain")}
            </Button>
          </ConsoleFormActions>
        )}
      </ConsoleForm>
    </ConsoleSection>
  );
}

import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAccess } from "./console-access";
import { Check, Confirm } from "./console-shared";
import { Button, useNotifications } from "./ui";
import {
  MailField,
  MailFieldset,
  MailForm,
  MailInput,
  MailNotice,
  MailSection,
  MailSelect,
  MailState,
  useMailAction,
  useMailResource,
} from "./mail-common";
import { api } from "../lib/api";
import type { Address, Domain, Mailbox } from "../lib/mail";
import type { AdminUser } from "../lib/console";
import "../routes/mail.css";

export type UserMailDomain = Pick<
  Domain,
  "id" | "name" | "is_default" | "inbound_enabled" | "outbound_enabled"
>;
export interface UserMail {
  mailbox: Mailbox | null;
  addresses: Address[];
  mail_enabled: boolean;
  enable_role?: { id: string; label: string } | null;
}
export function preferredDomain(domains: UserMailDomain[], email = "") {
  return (
    domains.find((domain) => domain.name === email.split("@")[1]) ??
    domains.find((domain) => domain.is_default) ??
    domains[0]
  );
}
export function MailAddressField({
  domains,
  domainId,
  local,
  onDomainChange,
  onLocalChange,
  disabled,
  label = t("componentsUserMail.emailAddress"),
}: {
  domains: UserMailDomain[];
  domainId: string;
  local: string;
  onDomainChange: (value: string) => void;
  onLocalChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const domain = domains.find((entry) => entry.id === domainId);
  return (
    <div className="console-mail-address">
      <div className="mail-form-grid">
        <MailInput
          label={label}
          placeholder={t("componentsUserMail.name")}
          value={local}
          required
          maxLength={64}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onLocalChange(event.target.value)}
        />
        <MailField label={t("componentsUserMail.domain")}>
          <MailSelect
            required
            value={domainId}
            disabled={disabled}
            onValueChange={onDomainChange}
            options={[
              { value: "", label: t("componentsUserMail.selectDomain") },
              ...domains.map((entry) => ({
                value: entry.id,
                label: `@${entry.name}${entry.is_default ? t("componentsUserMail.default") : ""}`,
              })),
            ]}
          />
        </MailField>
      </div>
      {local && domain && (
        <p className="mail-hint">
          {local.trim()}
          {t("componentsUserMail.text")}
          {domain.name}
        </p>
      )}
    </div>
  );
}
export function DomainSetupLink() {
  const permissions = useAccess().permissions;
  return (
    <p className="mail-hint">
      <LocalizedMessage
        id="componentsUserMail.registerAMailDomainToAssignWorkspaceAddresses"
        values={{
          value1: permissions.includes("admin.mail.domains.manage") && (
            <>
              {" "}
              <Link to="/console/mail/domains/new">{t("componentsUserMail.registerDomain")}</Link>
            </>
          ),
        }}
      />
    </p>
  );
}
export function UserMailPanel({ user }: { user: AdminUser }) {
  const permissions = useAccess().permissions,
    notify = useNotifications();
  const [revision, setRevision] = useState(0),
    resource = useMailResource<UserMail>(
      `/api/users/${encodeURIComponent(user.id)}/mailbox`,
      revision,
    );
  const domains = useMailResource<{ domains: UserMailDomain[] }>("/api/users/mail-options"),
    action = useMailAction();
  const [editing, setEditing] = useState(false),
    [domainId, setDomainId] = useState(""),
    [local, setLocal] = useState(""),
    [disable, setDisable] = useState(false);
  useEffect(() => {
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("officeflare:user-mail-changed", reload);
    return () => window.removeEventListener("officeflare:user-mail-changed", reload);
  }, []);
  const mail = resource.data,
    primary = mail?.addresses.find((entry) => entry.is_primary) ?? mail?.addresses[0],
    box = mail?.mailbox;
  const canManage = permissions.includes("admin.mail.mailboxes.manage"),
    canAddress = canManage && permissions.includes("admin.mail.domains.manage");
  const start = () => {
    setLocal(primary?.local_part ?? user.email_address.split("@")[0] ?? "");
    setDomainId(
      primary?.domain_id ??
        preferredDomain(domains.data?.domains ?? [], user.email_address)?.id ??
        "",
    );
    setEditing(true);
  };
  return (
    <MailSection
      title={t("componentsUserMail.personalMail")}
      description={t("componentsUserMail.thisUserSAddressMailboxAndAliasesAreManaged")}
    >
      <MailState
        loading={(resource.loading && !mail) || (domains.loading && !domains.data)}
        error={resource.error || domains.error}
        retry={() => {
          resource.reload();
          domains.reload();
        }}
      />
      {mail && (
        <>
          <div className="console-mail-summary">
            <div>
              <strong>
                {primary?.email_address ??
                  (mail.mail_enabled
                    ? t("componentsUserMail.mailAddressNotSet")
                    : t("componentsUserMail.mailIsNotEnabled"))}
              </strong>
              <p className="mail-hint">
                {!mail.mail_enabled
                  ? box
                    ? t("componentsUserMail.mailIsNotEnabledStoredMailIsRetained")
                    : t("componentsUserMail.enablePersonalMailToSetThisUserSAddress")
                  : box
                    ? `${box.status === "active" ? t("componentsUserMail.personalMailboxReady") : box.status === "provisioning" ? t("componentsUserMail.preparingPersonalMailbox") : t("componentsUserMail.personalMailboxDisabled")}${user.disabled_at ? t("componentsUserMail.accountDisabled") : user.password_reset_required ? t("componentsUserMail.waitingForFirstSignIn") : ""}`
                    : mail.mail_enabled
                      ? t("componentsUserMail.setAnAddressToPrepareThisUserSPersonal")
                      : t("componentsUserMail.assignARoleWithMailAccessToGiveThis")}
              </p>
            </div>
            {(mail.mail_enabled || mail.enable_role) &&
              canAddress &&
              !editing &&
              !!domains.data?.domains.length && (
                <Button onClick={start}>
                  {!mail.mail_enabled
                    ? t("componentsUserMail.enablePersonalMail")
                    : primary
                      ? t("componentsUserMail.changeAddress")
                      : t("componentsUserMail.setUpMail")}
                </Button>
              )}
          </div>
          {!mail.mail_enabled && permissions.includes("admin.users.roles.read") && (
            <p className="mail-hint">
              <a href="#user-roles">{t("componentsUserMail.manageThisUserSRoles")}</a>
            </p>
          )}
          {mail.mail_enabled && domains.data && !domains.data.domains.length && <DomainSetupLink />}
          {mail.mail_enabled && box?.status === "provisioning" && (
            <Button size="sm" disabled={resource.loading} onClick={resource.reload}>
              {t("componentsUserMail.retryPreparation")}
            </Button>
          )}
          {(mail.mail_enabled || mail.enable_role) && editing && (
            <MailForm
              className="mail-form"
              onSubmit={(event) => {
                event.preventDefault();
                void action.run(async () => {
                  await api(`/api/users/${encodeURIComponent(user.id)}/mailbox`, {
                    method: "POST",
                    body: {
                      domain_id: domainId,
                      local_part: local.trim().toLowerCase(),
                      ...(!mail.mail_enabled ? { enable_mail: true } : {}),
                    },
                  });
                  setEditing(false);
                  resource.reload();
                  notify.success(t("componentsUserMail.personalMailSaved"));
                  window.dispatchEvent(new Event("officeflare:mail-access-changed"));
                  window.dispatchEvent(new Event("officeflare:user-mail-changed"));
                });
              }}
            >
              <MailFieldset disabled={action.busy}>
                <MailAddressField
                  domains={domains.data?.domains ?? []}
                  local={local}
                  domainId={domainId}
                  onLocalChange={setLocal}
                  onDomainChange={setDomainId}
                />
                {!mail.mail_enabled && (
                  <p className="mail-hint">
                    <LocalizedMessage
                      id="componentsUserMail.savingAlsoAssignsTheRoleSoThisUserCan"
                      values={{ label: mail.enable_role?.label }}
                    />
                  </p>
                )}
                {primary && (
                  <p className="mail-hint">
                    {t("componentsUserMail.thePreviousAddressStaysAsAnAliasSignIn", {
                      email_address: user.email_address,
                    })}
                  </p>
                )}
                <div className="mail-actions">
                  <Button disabled={action.busy} onClick={() => setEditing(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" variant="primary" disabled={action.busy || !domainId}>
                    {action.busy ? t("common.saving") : t("componentsUserMail.savePersonalMail")}
                  </Button>
                </div>
              </MailFieldset>
            </MailForm>
          )}
          <MailNotice error={action.error} />
          {box && (
            <MailboxAliases
              mailbox={box}
              domains={domains.data?.domains ?? []}
              addresses={mail.addresses}
              canManage={permissions.includes("admin.mail.domains.manage")}
              onSaved={resource.reload}
            />
          )}
          {box && canManage && (
            <details className="console-role-summary console-mail-access">
              <summary>{t("componentsUserMail.mailboxAccess")}</summary>
              <p className="mail-hint">
                {t("componentsUserMail.disablingTheMailboxStopsAccessAndMailProcessingMessages")}
              </p>
              <Button
                size="sm"
                disabled={action.busy || box.status === "provisioning"}
                onClick={() => {
                  if (box.status === "active") setDisable(true);
                  else
                    void action.run(async () => {
                      await api(`/api/mail/mailboxes/${box.id}`, {
                        method: "PATCH",
                        body: { status: "active" },
                      });
                      resource.reload();
                    });
                }}
              >
                {box.status === "active"
                  ? t("componentsUserMail.disableMailbox")
                  : t("componentsUserMail.enableMailbox")}
              </Button>
            </details>
          )}
          <Confirm
            open={disable}
            title={t("componentsUserMail.disablePersonalMailbox")}
            description={t("componentsUserMail.theUserWillLoseMailboxAccessAndNewMessages")}
            label={t("componentsUserMail.disableMailbox")}
            onClose={() => setDisable(false)}
            onConfirm={async () => {
              await api(`/api/mail/mailboxes/${box!.id}`, {
                method: "PATCH",
                body: { status: "disabled" },
              });
              resource.reload();
            }}
          />
        </>
      )}
    </MailSection>
  );
}
export function MailboxAliases({
  mailbox,
  domains,
  addresses,
  canManage,
  onSaved,
}: {
  mailbox: Mailbox;
  domains: UserMailDomain[];
  addresses: Address[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [adding, setAdding] = useState(false),
    [domainId, setDomainId] = useState(""),
    [local, setLocal] = useState(""),
    [deleting, setDeleting] = useState<Address | null>(null),
    [editing, setEditing] = useState<Address | null>(null),
    [receive, setReceive] = useState(true),
    [send, setSend] = useState(true),
    action = useMailAction();
  const aliases = addresses.filter((entry) => !entry.is_primary),
    primary = addresses.find((entry) => entry.is_primary);
  return (
    <>
      {primary && canManage && <AddressDelivery address={primary} onSaved={onSaved} />}
      <div className="console-mail-aliases">
        <div className="console-mail-summary">
          <div>
            <h3>{t("componentsUserMail.aliases")}</h3>
            <p className="mail-hint">
              {t("componentsUserMail.additionalAddressesUseTheSameMailboxAndMessages")}
            </p>
          </div>
          {canManage && !adding && !!domains.length && (
            <Button
              size="sm"
              onClick={() => {
                setDomainId(preferredDomain(domains)?.id ?? "");
                setAdding(true);
              }}
            >
              {t("componentsUserMail.addAlias")}
            </Button>
          )}
        </div>
        {aliases.map((address) => (
          <div className="console-mail-alias" key={address.id}>
            <div className="mail-record">
              <div>
                <strong>{address.email_address}</strong>
                <p>
                  {address.receive_enabled
                    ? t("componentsUserMail.receiveEnabled")
                    : t("componentsUserMail.receiveDisabled")}
                  {t("componentsUserMail.text2")}{" "}
                  {address.send_enabled
                    ? t("componentsUserMail.sendEnabled")
                    : t("componentsUserMail.sendDisabled")}
                </p>
              </div>
              {canManage && (
                <div className="mail-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    aria-expanded={editing?.id === address.id}
                    onClick={() => {
                      action.setError("");
                      setEditing(address);
                      setReceive(!!address.receive_enabled);
                      setSend(!!address.send_enabled);
                    }}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => setDeleting(address)}
                  >
                    {t("common.remove")}
                  </Button>
                </div>
              )}
            </div>
            {canManage && editing?.id === address.id && (
              <MailForm
                className="mail-form"
                aria-label={t("componentsUserMail.edit", { email_address: address.email_address })}
                onSubmit={(event) => {
                  event.preventDefault();
                  void action.run(async () => {
                    await api(`/api/mail/addresses/${address.id}`, {
                      method: "PATCH",
                      body: { receive_enabled: receive, send_enabled: send },
                    });
                    setEditing(null);
                    onSaved();
                  });
                }}
              >
                <MailFieldset disabled={action.busy}>
                  <Check checked={receive} onChange={setReceive}>
                    {t("componentsUserMail.receiveMail")}
                  </Check>
                  <Check checked={send} onChange={setSend}>
                    {t("componentsUserMail.sendMail")}
                  </Check>
                  <div className="mail-actions">
                    <Button
                      disabled={action.busy}
                      onClick={() => {
                        action.setError("");
                        setEditing(null);
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={action.busy} variant="primary">
                      {t("componentsUserMail.saveAlias")}
                    </Button>
                  </div>
                </MailFieldset>
                <MailNotice error={action.error} />
              </MailForm>
            )}
          </div>
        ))}
        {!aliases.length && <p className="mail-hint">{t("componentsUserMail.noAliases")}</p>}
        {adding && (
          <MailForm
            className="mail-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                await api("/api/mail/addresses", {
                  method: "POST",
                  body: {
                    mailbox_id: mailbox.id,
                    domain_id: domainId,
                    local_part: local.trim().toLowerCase(),
                    is_primary: false,
                    receive_enabled: true,
                    send_enabled: true,
                  },
                });
                setAdding(false);
                setLocal("");
                onSaved();
              });
            }}
          >
            <MailFieldset disabled={action.busy}>
              <MailAddressField
                label={t("componentsUserMail.aliasAddress")}
                domains={domains}
                local={local}
                domainId={domainId}
                onLocalChange={setLocal}
                onDomainChange={setDomainId}
              />
              <div className="mail-actions">
                <Button disabled={action.busy} onClick={() => setAdding(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={action.busy || !domainId} variant="primary">
                  {t("componentsUserMail.addAlias")}
                </Button>
              </div>
            </MailFieldset>
            <MailNotice error={action.error} />
          </MailForm>
        )}
        <Confirm
          open={!!deleting}
          title={t("componentsUserMail.removeAlias")}
          description={t("componentsUserMail.willStopReceivingAndSendingMailMessagesRemainIn", {
            value1: deleting?.email_address ?? t("componentsUserMail.thisAddress"),
          })}
          label={t("componentsUserMail.removeAlias2")}
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/api/mail/addresses/${deleting!.id}`, { method: "DELETE" });
            onSaved();
          }}
        />
      </div>
    </>
  );
}

function AddressDelivery({ address, onSaved }: { address: Address; onSaved: () => void }) {
  const [receive, setReceive] = useState(!!address.receive_enabled),
    [send, setSend] = useState(!!address.send_enabled),
    action = useMailAction();
  useEffect(() => {
    setReceive(!!address.receive_enabled);
    setSend(!!address.send_enabled);
  }, [address.id, address.receive_enabled, address.send_enabled]);
  return (
    <details className="console-mail-primary-delivery">
      <summary>
        <LocalizedMessage
          id="componentsUserMail.primaryAddressDelivery"
          values={{
            value1:
              !address.receive_enabled || !address.send_enabled
                ? t("componentsUserMail.restricted")
                : "",
          }}
        />
      </summary>
      <MailForm
        className="mail-form console-mail-delivery"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await api(`/api/mail/addresses/${address.id}`, {
              method: "PATCH",
              body: { receive_enabled: receive, send_enabled: send },
            });
            onSaved();
          });
        }}
      >
        <p className="mail-hint">
          <LocalizedMessage
            id="componentsUserMail.domainSettingsMustAlsoAllowDelivery"
            values={{ email_address: address.email_address }}
          />
        </p>
        <MailFieldset disabled={action.busy}>
          <Check checked={receive} onChange={setReceive}>
            {t("componentsUserMail.receiveMailAtThisAddress")}
          </Check>
          <Check checked={send} onChange={setSend}>
            {t("componentsUserMail.sendMailFromThisAddress")}
          </Check>
          <Button
            type="submit"
            disabled={
              action.busy ||
              (receive === !!address.receive_enabled && send === !!address.send_enabled)
            }
          >
            {t("componentsUserMail.saveDeliverySettings")}
          </Button>
        </MailFieldset>
        <MailNotice error={action.error} />
      </MailForm>
    </details>
  );
}

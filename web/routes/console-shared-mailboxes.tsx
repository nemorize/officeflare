import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "../components/i18n";
import { t, plural } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAccess } from "../components/console-access";
import { useAccount } from "../components/account-context";
import { Check, ConsolePageHeader } from "../components/console-shared";
import { Button, Input, useNotifications } from "../components/ui";
import {
  MailAddressField,
  MailboxAliases,
  DomainSetupLink,
  preferredDomain,
} from "../components/user-mail";
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
} from "../components/mail-common";
import { api, ApiError } from "../lib/api";
import { MailOperation, type Address, type Domain, type Mailbox } from "../lib/mail";
import "./console.css";
import "./mail.css";

type Person = { id: string; email_address: string; display_name: string | null };
const rights = ["can_read", "can_write", "can_send", "can_manage"] as const;
type Rights = Record<(typeof rights)[number], boolean>;
type Member = Person & { user_id: string } & Record<(typeof rights)[number], number>;
type Assignment = {
  user_id: string;
  role: "viewer" | "member" | "manager" | "custom";
  permissions?: Rights;
};
interface Configuration {
  mailbox: Mailbox;
  owner: Person | null;
  addresses: Address[];
  members: Member[];
}
const roleOptions = [
  { value: "viewer", label: t("routesConsoleSharedMailboxes.readOnly") },
  { value: "member", label: t("routesConsoleSharedMailboxes.readWriteSend") },
  { value: "manager", label: t("routesConsoleSharedMailboxes.mailboxManager") },
  { value: "custom", label: t("routesConsoleSharedMailboxes.customAccess") },
];
function assignment(member: Member): Assignment {
  const permissions = Object.fromEntries(rights.map((key) => [key, !!member[key]])) as Rights;
  const role =
    member.can_read && !member.can_write && !member.can_send && !member.can_manage
      ? "viewer"
      : member.can_read && member.can_write && member.can_send
        ? member.can_manage
          ? "manager"
          : "member"
        : "custom";
  return { user_id: member.user_id, role, ...(role === "custom" ? { permissions } : {}) };
}
export function SharedMailboxes() {
  const permissions = useAccess().permissions,
    resource = useMailResource<{ mailboxes: Mailbox[] }>(
      "/api/mail/mailboxes?all=true&kind=shared",
    ),
    [search, setSearch] = useState("");
  const boxes =
    resource.data?.mailboxes.filter(
      (box) =>
        box.kind === "shared" &&
        `${box.name} ${box.email_address ?? ""}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <ConsolePageHeader
        title={t("routesConsoleSharedMailboxes.sharedMailboxes")}
        description={t("routesConsoleSharedMailboxes.manageTeamAddressesAndThePeopleWhoUseThem")}
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
      <div className="mail-field">
        <Input
          aria-label={t("routesConsoleSharedMailboxes.findSharedMailboxes")}
          placeholder={t("routesConsoleSharedMailboxes.nameOrEmailAddress")}
          value={search}
          onValueChange={setSearch}
        />
      </div>
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      {resource.data && (
        <div className="mail-table-wrap">
          <table className="mail-table">
            <caption className="console-sr-only">
              {t("routesConsoleSharedMailboxes.sharedMailboxes")}
            </caption>
            <thead>
              <tr>
                <th>{t("routesConsoleSharedMailboxes.mailbox")}</th>
                <th>{t("routesConsoleSharedMailboxes.members")}</th>
                <th>{t("common.status")}</th>
                <th>
                  <span className="console-sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((box) => (
                <tr key={box.id}>
                  <td>
                    <Link to={`/console/mail/mailboxes/${box.id}`}>
                      <strong>{box.name}</strong>
                      <small>
                        {box.email_address ?? t("routesConsoleSharedMailboxes.addressNotSet")}
                      </small>
                    </Link>
                  </td>
                  <td>{box.member_count ?? 0}</td>
                  <td>
                    <span className="mail-badge">{enumLabel(box.status)}</span>
                  </td>
                  <td>
                    <Button
                      nativeButton={false}
                      render={<Link to={`/console/mail/mailboxes/${box.id}`} />}
                      size="sm"
                    >
                      {permissions.includes("admin.mail.mailboxes.manage")
                        ? t("routesConsoleSharedMailboxes.manage")
                        : t("routesConsoleSharedMailboxes.view")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!boxes.length && (
            <p className="mail-empty">
              {search
                ? t("routesConsoleSharedMailboxes.noSharedMailboxesMatchYourSearch")
                : t("routesConsoleSharedMailboxes.noSharedMailboxesYetCreateATeamAddressAnd")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
export function SharedMailboxEditorPage({ creating = false }: { creating?: boolean }) {
  const { id = "" } = useParams(),
    permissions = useAccess().permissions,
    config = useMailResource<Configuration>(
      creating ? null : `/api/mail/mailboxes/${encodeURIComponent(id)}/configuration`,
    );
  const domains = useMailResource<{ domains: Domain[] }>(
      permissions.includes("admin.mail.domains.read") ? "/api/mail/domains" : null,
    ),
    directory = useMailResource<{ users: Person[] }>("/api/mail/mailbox-users");
  return (
    <section className="account-page console-page console-detail-page mail-console-page">
      <Link to="/console/mail/mailboxes" className="console-back">
        {t("routesConsoleSharedMailboxes.sharedMailboxes2")}
      </Link>
      <ConsolePageHeader
        title={
          creating
            ? t("routesConsoleSharedMailboxes.newSharedMailbox")
            : (config.data?.mailbox.name ?? t("routesConsoleSharedMailboxes.sharedMailbox"))
        }
        description={t("routesConsoleSharedMailboxes.setATeamAddressAndSharedAccessInOne")}
      />
      <MailState
        loading={
          (!creating && config.loading && !config.data) ||
          (directory.loading && !directory.data) ||
          (domains.loading && !domains.data)
        }
        error={config.error || directory.error || domains.error}
        retry={() => {
          config.reload();
          directory.reload();
          domains.reload();
        }}
      />
      {(creating || config.data) &&
        directory.data &&
        (!permissions.includes("admin.mail.domains.read") || domains.data) && (
          <SharedMailboxForm
            key={creating ? "new" : id}
            existing={config.data ?? undefined}
            domains={domains.data?.domains ?? []}
            users={directory.data.users}
            onSaved={config.reload}
          />
        )}
    </section>
  );
}
function SharedMailboxForm({
  existing,
  domains,
  users,
  onSaved,
}: {
  existing?: Configuration;
  domains: Domain[];
  users: Person[];
  onSaved: () => void;
}) {
  const { user } = useAccount(),
    permissions = useAccess().permissions,
    notify = useNotifications(),
    navigate = useNavigate(),
    action = useMailAction();
  const box = existing?.mailbox,
    primary = existing?.addresses.find((entry) => entry.is_primary) ?? existing?.addresses[0];
  const [name, setName] = useState(box?.name ?? ""),
    [local, setLocal] = useState(primary?.local_part ?? ""),
    [domainId, setDomainId] = useState(primary?.domain_id ?? preferredDomain(domains)?.id ?? ""),
    [status, setStatus] = useState(box?.status ?? "active");
  const [selected, setSelected] = useState<Assignment[]>(
      existing?.members.filter((entry) => entry.user_id !== box?.owner_user_id).map(assignment) ??
        [],
    ),
    [membersChanged, setMembersChanged] = useState(false),
    [search, setSearch] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const operation = useRef(new MailOperation()),
    pending = useRef<object | null>(null),
    manage = permissions.includes("admin.mail.mailboxes.manage"),
    addressManage = manage && permissions.includes("admin.mail.domains.manage");
  const ownerId = box?.owner_user_id ?? user?.id,
    owner = existing?.owner ?? user;
  const people = [
    ...new Map(
      [
        ...users,
        ...(existing?.members.map((entry) => ({ ...entry, id: entry.user_id })) ?? []),
      ].map((person) => [person.id, person]),
    ).values(),
  ].filter((person) => person.id !== ownerId);
  useEffect(() => {
    if (existing) {
      setName(existing.mailbox.name);
      setStatus(existing.mailbox.status);
      setSelected(
        existing.members
          .filter((entry) => entry.user_id !== existing.mailbox.owner_user_id)
          .map(assignment),
      );
      setMembersChanged(false);
      const address = existing.addresses.find((entry) => entry.is_primary) ?? existing.addresses[0];
      if (address) {
        setLocal(address.local_part);
        setDomainId(address.domain_id);
      }
    }
  }, [existing]);
  const changeMember = (next: Assignment) => {
    setMembersChanged(true);
    setSelected((current) =>
      current.map((entry) => (entry.user_id === next.user_id ? next : entry)),
    );
  };
  const submit = async () => {
    const addressChanged =
      !existing ||
      local.trim().toLowerCase() !== primary?.local_part ||
      domainId !== primary?.domain_id;
    const body = {
      name: name.trim(),
      ...(existing ? { status } : { kind: "shared" }),
      ...(addressManage && domainId && local.trim() && addressChanged
        ? { address: { domain_id: domainId, local_part: local.trim().toLowerCase() } }
        : {}),
      ...(!existing || membersChanged ? { members: selected } : {}),
    };
    if (existing) {
      await api(`/api/mail/mailboxes/${box!.id}/configuration`, { method: "PATCH", body });
      onSaved();
      notify.success(t("routesConsoleSharedMailboxes.sharedMailboxSaved"));
    } else {
      pending.current ??= body;
      let result: { mailbox: Mailbox };
      try {
        result = await api("/api/mail/mailboxes", {
          method: "POST",
          body: pending.current,
          headers: operation.current.headers(pending.current),
        });
      } catch (failure) {
        setUncertain(true);
        if (failure instanceof ApiError && failure.status < 500) {
          pending.current = null;
          operation.current.complete();
          setUncertain(false);
        }
        throw failure;
      }
      operation.current.complete();
      pending.current = null;
      notify.success(
        t("routesConsoleSharedMailboxes.sharedMailboxCreatedWithItsAddressAndMembers"),
      );
      navigate(`/console/mail/mailboxes/${result.mailbox.id}`);
    }
    window.dispatchEvent(new Event("officeflare:mail-access-changed"));
  };
  if (box?.kind === "personal")
    return (
      <MailSection
        title={t("routesConsoleSharedMailboxes.personalMailbox")}
        description={t("routesConsoleSharedMailboxes.personalMailBelongsWithTheUserAccount")}
      >
        <Button
          nativeButton={false}
          render={<Link to={`/console/users/${encodeURIComponent(box.owner_user_id)}`} />}
        >
          {t("routesConsoleSharedMailboxes.manageUser")}
        </Button>
      </MailSection>
    );
  return (
    <>
      <MailForm
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(submit);
        }}
      >
        <MailFieldset disabled={action.busy || uncertain || !manage}>
          <MailSection
            title={t("routesConsoleSharedMailboxes.teamAddress")}
            description={t(
              "routesConsoleSharedMailboxes.theAddressAndMailboxAreCreatedAndSavedTogether",
            )}
          >
            <div className="mail-form">
              <MailInput
                label={t("routesConsoleSharedMailboxes.mailboxName")}
                required
                maxLength={100}
                placeholder={t("routesConsoleSharedMailboxes.support")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {domains.length ? (
                <MailAddressField
                  domains={domains}
                  local={local}
                  domainId={domainId}
                  onLocalChange={setLocal}
                  onDomainChange={setDomainId}
                  disabled={!addressManage}
                />
              ) : (
                <DomainSetupLink />
              )}
              {existing && primary && (
                <p className="mail-hint">
                  {t("routesConsoleSharedMailboxes.changingTheAddressKeepsThePreviousAddressAsAn")}
                </p>
              )}
              {!addressManage && (
                <p className="mail-hint">
                  {t(
                    "routesConsoleSharedMailboxes.addressChangesRequireMailDomainManagementPermission",
                  )}
                </p>
              )}
              {existing && (
                <MailField label={t("routesConsoleSharedMailboxes.mailboxStatus")}>
                  <MailSelect
                    value={status}
                    onValueChange={setStatus}
                    options={[
                      { value: "active", label: t("common.active") },
                      { value: "disabled", label: t("common.disabled") },
                      ...(status === "provisioning"
                        ? [
                            {
                              value: "provisioning",
                              label: t("routesConsoleSharedMailboxes.preparingMailbox"),
                            },
                          ]
                        : []),
                    ]}
                  />
                </MailField>
              )}
            </div>
          </MailSection>
          <MailSection
            title={t("routesConsoleSharedMailboxes.peopleWithAccess")}
            description={t(
              "routesConsoleSharedMailboxes.membersFindThisSharedMailboxAlongsideTheirPersonalMail",
            )}
          >
            <div className="mail-record">
              <div>
                <strong>
                  {owner?.display_name ||
                    owner?.email_address ||
                    t("routesConsoleSharedMailboxes.mailboxOwner")}
                </strong>
                <p>
                  {owner?.email_address}
                  {!users.some((entry) => entry.id === ownerId)
                    ? t("routesConsoleSharedMailboxes.mailAccessIsNotEnabled")
                    : t("routesConsoleSharedMailboxes.fullMailboxAccess")}
                </p>
              </div>
              <span className="mail-badge">{t("routesConsoleSharedMailboxes.owner")}</span>
            </div>
            <MailInput
              label={t("routesConsoleSharedMailboxes.findPeople")}
              placeholder={t("routesConsoleSharedMailboxes.nameOrEmailAddress")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="console-mail-members">
              {people
                .filter((person) =>
                  `${person.display_name ?? ""} ${person.email_address}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((person) => {
                  const entry = selected.find((entry) => entry.user_id === person.id),
                    available = users.some((entry) => entry.id === person.id);
                  return (
                    <div className="console-mail-member" key={person.id}>
                      <Check
                        checked={!!entry}
                        disabled={(!available && !entry) || (!entry && selected.length >= 100)}
                        onChange={(checked) => {
                          setMembersChanged(true);
                          setSelected((current) =>
                            checked
                              ? [...current, { user_id: person.id, role: "member" }]
                              : current.filter((entry) => entry.user_id !== person.id),
                          );
                        }}
                      >
                        <strong>{person.display_name || person.email_address}</strong>
                        <small>
                          {person.display_name && person.email_address}
                          {!available && t("routesConsoleSharedMailboxes.mailAccessUnavailable")}
                        </small>
                      </Check>
                      {entry && (
                        <MailSelect
                          aria-label={t("routesConsoleSharedMailboxes.accessFor", {
                            email_address: person.email_address,
                          })}
                          value={entry.role}
                          options={roleOptions}
                          onValueChange={(role) =>
                            changeMember({
                              user_id: entry.user_id,
                              role: role as Assignment["role"],
                              ...(role === "custom"
                                ? {
                                    permissions: {
                                      can_read: true,
                                      can_write: true,
                                      can_send: true,
                                      can_manage: false,
                                    },
                                  }
                                : {}),
                            })
                          }
                        />
                      )}
                      {entry?.role === "custom" && (
                        <div className="console-mail-custom-rights">
                          {rights.map((key) => (
                            <Check
                              key={key}
                              checked={!!entry.permissions?.[key]}
                              onChange={(checked) =>
                                changeMember({
                                  ...entry,
                                  permissions: { ...entry.permissions!, [key]: checked },
                                })
                              }
                            >
                              {
                                {
                                  can_read: t("routesConsoleSharedMailboxes.readMail"),
                                  can_write: t("routesConsoleSharedMailboxes.changeMail"),
                                  can_send: t("routesConsoleSharedMailboxes.sendMail"),
                                  can_manage: t("routesConsoleSharedMailboxes.manageMailbox"),
                                }[key]
                              }
                            </Check>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
            {!people.length && (
              <p className="mail-hint">
                <LocalizedMessage
                  id="routesConsoleSharedMailboxes.noOtherUsersWithMailAccess"
                  values={{
                    value1: permissions.includes("admin.users.create") && (
                      <>
                        {" "}
                        <Link to="/console/users/new">
                          {t("routesConsoleSharedMailboxes.addAUser")}
                        </Link>
                      </>
                    ),
                  }}
                />
              </p>
            )}
            <p className="mail-hint">{plural("mail.sharedMembers", selected.length)}</p>
          </MailSection>
        </MailFieldset>
        <MailNotice error={action.error} />
        {uncertain && (
          <p className="mail-hint">
            {t("routesConsoleSharedMailboxes.retryToRecoverTheResultOfThisSameCreation")}
          </p>
        )}
        {manage && (
          <div className="mail-actions">
            <Button
              nativeButton={false}
              disabled={action.busy}
              render={<Link to="/console/mail/mailboxes" />}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={action.busy || (!existing && (!ownerId || (addressManage && !domainId)))}
            >
              {action.busy
                ? t("common.saving")
                : uncertain
                  ? t("routesConsoleSharedMailboxes.checkCreationResult")
                  : existing
                    ? t("routesConsoleSharedMailboxes.saveSharedMailbox")
                    : t("routesConsoleSharedMailboxes.createSharedMailbox")}
            </Button>
          </div>
        )}
      </MailForm>
      {box && (
        <MailSection
          title={t("routesConsoleSharedMailboxes.addressesAndDelivery")}
          description={t(
            "routesConsoleSharedMailboxes.manageAddressDeliveryAndAliasesForThisSameShared",
          )}
        >
          <MailboxAliases
            mailbox={box}
            domains={domains}
            addresses={existing!.addresses}
            canManage={permissions.includes("admin.mail.domains.manage")}
            onSaved={onSaved}
          />
        </MailSection>
      )}
    </>
  );
}

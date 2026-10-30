import { LocalizedMessage } from "../components/i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState } from "react";
import { Link, useBlocker } from "react-router";
import { api } from "../lib/api";
import { mailboxPath, type Address, type MailRight, type MailSettings } from "../lib/mail";
import { MailSettingsLayout } from "../components/mail-settings-nav";
import { MailPreferenceFields } from "../components/mail-chrome";
import { FolderManager } from "../components/mail-context";
import { useMail } from "../components/mail-context";
import { MailReady } from "./mail";
import {
  MailField,
  MailInput,
  MailModal,
  MailNotice,
  MailSection,
  MailState,
  useMailAction,
  useMailResource,
  MailForm,
  MailTextarea,
  MailFieldset,
  MailSelect,
} from "../components/mail-common";
import { useMailCache } from "../components/mail-resource-context";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { MailEditor } from "../components/mail-editor";
import { plainMailHtml } from "../lib/mail-editor";
import { MailRules } from "../components/mail-rules";
import { Button, useNotifications } from "../components/ui";
import { Check, Confirm } from "../components/console-shared";
import { useAccess } from "../components/console-access";
export function MailManagePage({ page }: { page: string }) {
  const mail = useMail();
  return (
    <MailReady read={page !== "settings"}>
      <div className="account-page mail-manage-page" key={mail.box?.id}>
        {page === "rules" ? <Rules /> : <Settings />}
      </div>
    </MailReady>
  );
}
function Rules() {
  const mail = useMail(),
    path = mailboxPath(mail.box!.id),
    resource = useMailResource<{ "blocked-senders": { email_address: string }[] }>(
      path + "/blocked-senders",
    ),
    action = useMailAction(),
    [email, setEmail] = useState(""),
    [test, setTest] = useState({ from: "", to: "", subject: "", body: "" }),
    [result, setResult] = useState<{
      folder_id: string;
      is_read: boolean;
      is_starred: boolean;
      is_spam: boolean;
      matched_rules: string[];
    } | null>(null);
  return (
    <MailSettingsLayout
      title={t("routesMailManage.rulesBlockedSenders")}
      description={t("routesMailManage.organizeIncomingMailAutomaticallyForThisMailbox")}
    >
      <MailRules
        path={path + "/rules"}
        folders={mail.folders}
        canManage={!!mail.box!.access?.manage}
      />
      <MailSection
        title={t("routesMailManage.blockedSenders")}
        description={t("routesMailManage.messagesFromBlockedSendersGoToSpam")}
      >
        <MailState
          loading={resource.loading && !resource.data}
          error={resource.error}
          retry={resource.reload}
        />
        {mail.box!.access?.write && (
          <MailForm
            className="mail-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                await api(path + "/blocked-senders", {
                  method: "PUT",
                  body: { email_address: email, blocked: true },
                });
                setEmail("");
                resource.reload();
              });
            }}
          >
            <MailInput
              label={t("routesMailManage.emailAddress")}
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" size="lg" disabled={action.busy}>
              {t("routesMailManage.blockSender")}
            </Button>
          </MailForm>
        )}
        <div className="mail-record-list">
          {resource.data?.["blocked-senders"].map((sender) => (
            <div key={sender.email_address} className="mail-record">
              <strong>{sender.email_address}</strong>
              {mail.box!.access?.write && (
                <Button
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    void action.run(async () => {
                      await api(path + "/blocked-senders", {
                        method: "PUT",
                        body: { ...sender, blocked: false },
                      });
                      resource.reload();
                    });
                  }}
                >
                  {t("routesMailManage.unblock")}
                </Button>
              )}
            </div>
          ))}
        </div>
        <MailNotice error={action.error} />
      </MailSection>
      {mail.box!.access?.manage && (
        <MailSection
          title={t("routesMailManage.testRules")}
          description={t("routesMailManage.previewTheResultForASampleMessageWithoutChanging")}
        >
          <MailForm
            className="mail-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                const data = await api<{ result: typeof result }>(path + "/rules/evaluate", {
                  method: "POST",
                  body: test,
                });
                setResult(data.result);
              });
            }}
          >
            <div className="mail-form-grid">
              {(["from", "to", "subject"] as const).map((field) => (
                <MailInput
                  key={field}
                  label={
                    field === "from"
                      ? t("routesMailManage.sender")
                      : field === "to"
                        ? t("routesMailManage.recipient")
                        : t("routesMailManage.subject")
                  }
                  value={test[field]}
                  onChange={(event) => setTest({ ...test, [field]: event.target.value })}
                />
              ))}
            </div>
            <MailField label={t("routesMailManage.body")}>
              <MailTextarea
                value={test.body}
                onChange={(event) => setTest({ ...test, body: event.target.value })}
              />
            </MailField>
            <Button type="submit" disabled={action.busy}>
              {t("routesMailManage.evaluateRules")}
            </Button>
            {result && (
              <p role="status">
                <LocalizedMessage
                  id="routesMailManage.folderRuleSMatched"
                  values={{
                    value1:
                      mail.folders.find((folder) => folder.id === result.folder_id)?.name ??
                      result.folder_id,
                    value2: result.is_read
                      ? t("routesMailManage.read")
                      : t("routesMailManage.unread"),
                    value3: result.is_starred ? t("routesMailManage.starred") : "",
                    value4: result.is_spam ? t("routesMailManage.spam") : "",
                    length: result.matched_rules.length,
                  }}
                />
              </p>
            )}
          </MailForm>
        </MailSection>
      )}
    </MailSettingsLayout>
  );
}
function Settings() {
  const mail = useMail(),
    permissions = useAccess().permissions,
    path = mailboxPath(mail.box!.id);
  const resource = useMailResource<{ settings: MailSettings }>(
    mail.box!.access?.read ? path + "/settings" : null,
  );
  const addresses = useMailResource<{
    addresses: Address[];
    limits?: { max_upload_bytes: number };
  }>(mail.box!.access?.read ? path + "/addresses" : null);
  return (
    <MailSettingsLayout
      title={t("routesMailManage.mailSettings")}
      description={t("routesMailManage.chooseYourPersonalPreferencesAndManageThisMailbox")}
    >
      <MailSection
        title={t("routesMailManage.yourExperience")}
        description={t("routesMailManage.personalPreferencesSavedAutomatically")}
      >
        <MailPreferenceFields />
      </MailSection>
      {mail.box!.access?.write && (
        <MailSection
          title={t("routesMailManage.folders")}
          description={t("routesMailManage.sharedByEveryoneUsingThisMailbox")}
          action={<FolderManager />}
        >
          <div className="mail-settings-folder-list">
            {mail.folders.map((folder) => (
              <span className="mail-badge" key={folder.id}>
                {folder.name}
              </span>
            ))}
          </div>
        </MailSection>
      )}
      {mail.box!.access?.read && (
        <>
          <MailNotice error={resource.error} />
          {resource.data ? (
            <SettingsForm
              key={mail.box!.id}
              initial={resource.data.settings}
              path={path}
              canManage={!!mail.box!.access?.manage}
              maxImageBytes={addresses.data?.limits?.max_upload_bytes}
            />
          ) : (
            <SettingsSkeleton />
          )}
          <MailSection
            title={t("routesMailManage.addresses")}
            description={t("routesMailManage.useTheseAddressesToReceiveAndSendMail")}
            action={
              permissions.includes("admin.mail.domains.read") && (
                <Button nativeButton={false} render={<Link to="/console/mail/domains" />}>
                  {t("routesMailManage.manageAddresses")}
                </Button>
              )
            }
          >
            <MailState
              loading={addresses.loading && !addresses.data}
              error={addresses.error}
              retry={addresses.reload}
            />
            <div className="mail-record-list">
              {addresses.data?.addresses.map((address) => (
                <div key={address.id} className="mail-record">
                  <div>
                    <strong>{address.email_address}</strong>
                    <p>
                      {address.is_primary ? t("routesMailManage.primary") : ""}
                      {address.receive_enabled
                        ? t("routesMailManage.receivesMail")
                        : t("routesMailManage.receiveDisabled")}
                      {t("routesMailManage.text")}{" "}
                      {address.send_enabled
                        ? t("routesMailManage.canSend")
                        : t("routesMailManage.sendDisabled")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {addresses.data && !addresses.data.addresses.length && (
              <p className="mail-hint">
                {t("routesMailManage.askAnAdministratorToAssignAnAddressToThis")}
              </p>
            )}
          </MailSection>
        </>
      )}
      {mail.box!.access?.manage ? (
        <Members path={path} />
      ) : (
        <MailSection title={t("routesMailManage.sharing")}>
          <p className="mail-hint">{t("routesMailManage.mailboxMembersAreManagedByTheOwner")}</p>
        </MailSection>
      )}
    </MailSettingsLayout>
  );
}
function SettingsSkeleton() {
  return (
    <div
      className="mail-settings-placeholder"
      role="status"
      aria-label={t("routesMailManage.loadingMailboxSettings")}
    >
      <div aria-hidden="true">
        <MailSection
          title={t("routesMailManage.signature")}
          description={t("routesMailManage.addedToNewMessagesAndRepliesSharedMailboxChanges")}
        >
          <LoadingSkeleton kind="form" rows={0} />
        </MailSection>
        <MailSection
          title={t("routesMailManage.automaticReplies")}
          description={t("routesMailManage.replyToIncomingMessagesWhileYouAreAway")}
        >
          <LoadingSkeleton rows={1} />
        </MailSection>
        <MailSection
          title={t("routesMailManage.trashSpam")}
          description={t("routesMailManage.chooseHowLongThisMailboxKeepsDeletedAndSpam")}
        >
          <LoadingSkeleton rows={2} />
        </MailSection>
        <div className="mail-settings-save">
          <span className="skeleton-line skeleton-short" />
        </div>
      </div>
    </div>
  );
}
function editableSettings(initial: MailSettings) {
  return {
    signature: initial.signature,
    signature_html: initial.signature_html || plainMailHtml(initial.signature),
    auto_reply_enabled: initial.auto_reply_enabled,
    auto_reply_subject: initial.auto_reply_subject,
    auto_reply_text: initial.auto_reply_text,
    retention_days: initial.retention_days,
  };
}
function SettingsForm({
  initial,
  path,
  canManage,
  maxImageBytes,
}: {
  initial: MailSettings;
  path: string;
  canManage: boolean;
  maxImageBytes?: number;
}) {
  const mail = useMail(),
    cache = useMailCache(),
    notify = useNotifications();
  const [values, setValues] = useState(() => editableSettings(initial)),
    [saved, setSaved] = useState(() => JSON.stringify(editableSettings(initial)));
  const [imageUploading, setImageUploading] = useState(false),
    action = useMailAction();
  const dirty = JSON.stringify(values) !== saved;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (dirty || imageUploading) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) {
      const next = editableSettings(initial);
      setValues(next);
      setSaved(JSON.stringify(next));
    }
  }, [initial]);
  useEffect(() => {
    if (!dirty && !imageUploading) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, imageUploading]);
  async function persist() {
    if (imageUploading) throw new Error(t("routesMailManage.waitForTheImageUploadToFinish"));
    if (
      values.retention_days !== null &&
      (!Number.isInteger(values.retention_days) ||
        values.retention_days < 1 ||
        values.retention_days > 3650)
    )
      throw new Error(t("routesMailManage.enterAWholeNumberBetween1And3650Days"));
    const result = await api<{ settings: MailSettings }>(path + "/settings", {
      method: "PATCH",
      body: { ...values, auto_reply_enabled: !!values.auto_reply_enabled },
    });
    const next = editableSettings(result.settings);
    setValues(next);
    setSaved(JSON.stringify(next));
    cache.replace(path + "/settings", result);
    notify.success(t("routesMailManage.mailboxSettingsSaved"));
  }
  return (
    <>
      <MailForm
        className="mail-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(persist);
        }}
      >
        <MailFieldset disabled={!canManage || action.busy}>
          <MailSection
            title={t("routesMailManage.signature")}
            description={
              canManage
                ? t("routesMailManage.addedToNewMessagesAndRepliesSharedMailboxChanges")
                : t("routesMailManage.managedByTheMailboxOwner")
            }
          >
            <fieldset className="mail-editor-field">
              <legend className="mail-sr-only">{t("routesMailManage.signatureEditor")}</legend>
              <MailEditor
                label={t("routesMailManage.signature")}
                value={values.signature_html}
                maxImageBytes={maxImageBytes}
                onUploadingChange={setImageUploading}
                mailboxId={mail.box!.id}
                disabled={!canManage || action.busy}
                onChange={(html, text) =>
                  setValues((old) => ({ ...old, signature: text, signature_html: html }))
                }
              />
            </fieldset>
          </MailSection>
          <MailSection
            title={t("routesMailManage.automaticReplies")}
            description={t("routesMailManage.replyToIncomingMessagesWhileYouAreAway")}
          >
            <Check
              checked={!!values.auto_reply_enabled}
              onChange={(value) =>
                setValues((old) => ({ ...old, auto_reply_enabled: Number(value) }))
              }
            >
              {t("routesMailManage.enableAutomaticReplies")}
            </Check>
            {!!values.auto_reply_enabled && (
              <div className="mail-form">
                <MailInput
                  label={t("routesMailManage.autoReplySubject")}
                  maxLength={998}
                  value={values.auto_reply_subject}
                  onChange={(event) =>
                    setValues((old) => ({ ...old, auto_reply_subject: event.target.value }))
                  }
                />
                <MailField label={t("routesMailManage.autoReplyMessage")}>
                  <MailTextarea
                    maxLength={10000}
                    value={values.auto_reply_text}
                    onChange={(event) =>
                      setValues((old) => ({ ...old, auto_reply_text: event.target.value }))
                    }
                  />
                </MailField>
              </div>
            )}
          </MailSection>
          <MailSection
            title={t("routesMailManage.trashSpam")}
            description={t("routesMailManage.chooseHowLongThisMailboxKeepsDeletedAndSpam")}
          >
            <MailInput
              label={t("routesMailManage.keepMessagesForDays")}
              hint={t("routesMailManage.leaveEmptyToKeepMessagesUntilYouDeleteThem")}
              type="number"
              min={1}
              max={3650}
              value={values.retention_days ?? ""}
              onChange={(event) =>
                setValues((old) => ({
                  ...old,
                  retention_days: event.target.value ? Number(event.target.value) : null,
                }))
              }
            />
          </MailSection>
        </MailFieldset>
        <MailNotice error={action.error} />
        {canManage && (
          <div className="mail-settings-save">
            <span role="status">
              {action.busy
                ? t("common.saving")
                : dirty
                  ? t("routesMailManage.unsavedChanges")
                  : t("routesMailManage.allChangesSaved")}
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={action.busy || imageUploading || !dirty}
            >
              {t("routesMailManage.saveMailboxSettings")}
            </Button>
          </div>
        )}
      </MailForm>
      <MailModal
        open={blocker.state === "blocked"}
        title={t("routesMailManage.saveChangesBeforeLeaving")}
        description={t("routesMailManage.yourMailboxSettingsHaveUnsavedChanges")}
        busy={action.busy}
        onClose={() => blocker.state === "blocked" && blocker.reset()}
      >
        <MailNotice error={action.error} />
        <div className="mail-actions">
          <Button
            variant="primary"
            disabled={action.busy || imageUploading}
            onClick={() => {
              void action.run(async () => {
                await persist();
                if (blocker.state === "blocked") blocker.proceed();
              });
            }}
          >
            {t("routesMailManage.saveAndContinue")}
          </Button>
          <Button
            disabled={action.busy || imageUploading}
            onClick={() => blocker.state === "blocked" && blocker.proceed()}
          >
            {t("routesMailManage.discardChanges")}
          </Button>
          <Button
            variant="ghost"
            disabled={action.busy}
            onClick={() => blocker.state === "blocked" && blocker.reset()}
          >
            {t("routesMailManage.keepEditing")}
          </Button>
        </div>
      </MailModal>
    </>
  );
}
interface Member {
  user_id: string;
  email_address: string;
  display_name: string | null;
  can_read: number;
  can_write: number;
  can_send: number;
  can_manage: number;
}
interface MemberDirectory {
  members: Member[];
  candidates: { id: string; email_address: string; display_name: string | null }[];
}
const rightLabels: Record<MailRight, string> = {
  read: t("routesMailManage.readMessages"),
  write: t("routesMailManage.editMailFolders"),
  send: t("routesMailManage.sendMail"),
  manage: t("routesMailManage.manageSettingsSharing"),
};
function Members({ path }: { path: string }) {
  const mail = useMail(),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    resource = useMailResource<MemberDirectory>(
      `${path}/members?search=${encodeURIComponent(query)}`,
    ),
    action = useMailAction(),
    [user, setUser] = useState(""),
    [grants, setGrants] = useState<Record<MailRight, boolean>>({
      read: true,
      write: false,
      send: false,
      manage: false,
    }),
    [deleting, setDeleting] = useState<Member | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  return (
    <MailSection
      title={t("routesMailManage.sharedAccess")}
      description={t("routesMailManage.theOwnerAlwaysHasFullAccessReadingEditingSending")}
    >
      <p className="mail-hint">
        <LocalizedMessage
          id="routesMailManage.owner"
          values={{
            value1:
              resource.data?.candidates.find(
                (candidate) => candidate.id === mail.box!.owner_user_id,
              )?.email_address ?? mail.box!.owner_user_id,
          }}
        />
      </p>
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      <div className="mail-record-list">
        {resource.data?.members.map((member) => (
          <div key={member.user_id} className="mail-record">
            <div>
              <strong>{member.display_name || member.email_address}</strong>
              <p>{member.email_address}</p>
              <p>
                {(Object.keys(rightLabels) as MailRight[])
                  .filter((right) => member[`can_${right}`])
                  .map((right) => rightLabels[right])
                  .join(" · ") || t("routesMailManage.noPermissions")}
              </p>
            </div>
            {member.user_id !== mail.box!.owner_user_id && (
              <div className="mail-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setUser(member.user_id);
                    setGrants(
                      Object.fromEntries(
                        (Object.keys(rightLabels) as MailRight[]).map((right) => [
                          right,
                          !!member[`can_${right}`],
                        ]),
                      ) as Record<MailRight, boolean>,
                    );
                  }}
                >
                  {t("common.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(member)}>
                  {t("common.remove")}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <MailForm
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            if (!user) throw new Error(t("routesMailManage.chooseAMember"));
            await api(`${path}/members/${user}`, { method: "PUT", body: grants });
            resource.reload();
            mail.refreshBoxes();
            setUser("");
          });
        }}
      >
        <MailInput
          label={t("routesMailManage.findAnAccount")}
          hint={t("routesMailManage.onlyActiveAccountsWithMailAccessAreListedSearch")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <MailField label={t("routesMailManage.member")}>
          <MailSelect
            required
            value={user}
            onValueChange={(nextValue) => setUser(nextValue)}
            options={[
              { value: "", label: t("routesMailManage.selectAnAccount") },
              ...((user &&
                !resource.data?.candidates.some((candidate) => candidate.id === user) && [
                  {
                    value: user,
                    label:
                      resource.data?.members.find((member) => member.user_id === user)
                        ?.email_address ?? user,
                  },
                ]) ||
                []),
              ...(resource.data?.candidates
                .filter((candidate) => candidate.id !== mail.box!.owner_user_id)
                .map((candidate) => ({
                  value: candidate.id,
                  label: (
                    <>
                      {candidate.display_name ? `${candidate.display_name} · ` : ""}
                      {candidate.email_address}
                    </>
                  ),
                })) || []),
            ]}
          />
        </MailField>
        <div className="mail-check-grid">
          {(Object.keys(rightLabels) as MailRight[]).map((right) => (
            <Check
              key={right}
              checked={grants[right]}
              onChange={(value) => setGrants({ ...grants, [right]: value })}
            >
              {rightLabels[right]}
            </Check>
          ))}
        </div>
        <MailNotice error={action.error} />
        <Button type="submit" disabled={action.busy || !user}>
          {t("routesMailManage.saveMemberAccess")}
        </Button>
      </MailForm>
      <Confirm
        open={!!deleting}
        title={t("routesMailManage.removeMailboxAccess")}
        description={t("routesMailManage.willLoseThePermissionsGrantedByThisMailbox", {
          value1: deleting?.email_address ?? t("routesMailManage.thisMember"),
        })}
        label={t("routesMailManage.removeMember")}
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await api(`${path}/members/${deleting!.user_id}`, { method: "DELETE" });
          resource.reload();
          mail.refreshBoxes();
        }}
      />
    </MailSection>
  );
}

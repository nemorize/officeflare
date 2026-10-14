import { useEffect, useState } from "react";
import { Link, useBlocker } from "react-router";
import { api } from "../lib/api";
import { mailboxPath, type Address, type MailRight, type MailSettings } from "../lib/mail";
import { MailSettingsLayout } from "../components/mail-settings-nav";
import { MailPreferenceFields } from "../components/mail-chrome";
import { FolderManager } from "../components/mail-context";
import { useMail } from "../components/mail-context";
import { MailReady } from "./mail";
import { MailField, MailInput, MailModal, MailNotice, MailSection, MailState, useMailAction, useMailResource, MailForm, MailTextarea, MailFieldset, MailSelect } from "../components/mail-common";
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
  return <MailReady read={page !== "settings"}><div className="account-page mail-manage-page" key={mail.box?.id}>{page === "rules" ? <Rules /> : <Settings />}</div></MailReady>;
}
function Rules() {
  const mail = useMail(), path = mailboxPath(mail.box!.id), resource = useMailResource<{ "blocked-senders": { email_address: string }[] }>(path + "/blocked-senders"), action = useMailAction(), [email, setEmail] = useState(""), [test, setTest] = useState({ from: "", to: "", subject: "", body: "" }), [result, setResult] = useState<{ folder_id: string; is_read: boolean; is_starred: boolean; is_spam: boolean; matched_rules: string[] } | null>(null);
  return <MailSettingsLayout title="Rules & blocked senders" description="Organize incoming mail automatically for this mailbox."><MailRules path={path + "/rules"} folders={mail.folders} canManage={!!mail.box!.access?.manage} /><MailSection title="Blocked senders" description="Messages from blocked senders go to Spam."><MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />{mail.box!.access?.write && <MailForm className="mail-inline-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api(path + "/blocked-senders", { method: "PUT", body: { email_address: email, blocked: true } }); setEmail(""); resource.reload(); }); }}><MailInput label="Email address" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /><Button type="submit" size="lg" disabled={action.busy}>Block sender</Button></MailForm>}<div className="mail-record-list">{resource.data?.["blocked-senders"].map((sender) => <div key={sender.email_address} className="mail-record"><strong>{sender.email_address}</strong>{mail.box!.access?.write && <Button size="sm" disabled={action.busy} onClick={() => { void action.run(async () => { await api(path + "/blocked-senders", { method: "PUT", body: { ...sender, blocked: false } }); resource.reload(); }); }}>Unblock</Button>}</div>)}</div><MailNotice error={action.error} /></MailSection>
    {mail.box!.access?.manage && <MailSection title="Test rules" description="Preview the result for a sample message without changing any mail."><MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { const data = await api<{ result: typeof result }>(path + "/rules/evaluate", { method: "POST", body: test }); setResult(data.result); }); }}><div className="mail-form-grid">{(["from", "to", "subject"] as const).map((field) => <MailInput key={field} label={field === "from" ? "Sender" : field === "to" ? "Recipient" : "Subject"} value={test[field]} onChange={(event) => setTest({ ...test, [field]: event.target.value })} />)}</div><MailField label="Body"><MailTextarea value={test.body} onChange={(event) => setTest({ ...test, body: event.target.value })} /></MailField><Button type="submit" disabled={action.busy}>Evaluate rules</Button>{result && <p role="status">Folder: {mail.folders.find((folder) => folder.id === result.folder_id)?.name ?? result.folder_id} · {result.is_read ? "Read" : "Unread"}{result.is_starred ? " · Starred" : ""}{result.is_spam ? " · Spam" : ""} · {result.matched_rules.length} rule(s) matched</p>}</MailForm></MailSection>}
  </MailSettingsLayout>;
}
function Settings() {
  const mail = useMail(), permissions = useAccess().permissions, path = mailboxPath(mail.box!.id);
  const resource = useMailResource<{ settings: MailSettings }>(mail.box!.access?.read ? path + "/settings" : null);
  const addresses = useMailResource<{ addresses: Address[]; limits?: { max_upload_bytes: number } }>(mail.box!.access?.read ? path + "/addresses" : null);
  return <MailSettingsLayout title="Mail settings" description="Choose your personal preferences and manage this mailbox.">
    <MailSection title="Your experience" description="Personal preferences · saved automatically."><MailPreferenceFields /></MailSection>
    {mail.box!.access?.write && <MailSection title="Folders" description="Shared by everyone using this mailbox." action={<FolderManager/>}><div className="mail-settings-folder-list">{mail.folders.map(folder => <span className="mail-badge" key={folder.id}>{folder.name}</span>)}</div></MailSection>}
    {mail.box!.access?.read && <>
      <MailNotice error={resource.error} />
      {resource.data ? <SettingsForm key={mail.box!.id} initial={resource.data.settings} path={path} canManage={!!mail.box!.access?.manage} maxImageBytes={addresses.data?.limits?.max_upload_bytes} /> : <SettingsSkeleton />}
      <MailSection title="Addresses" description="Use these addresses to receive and send mail." action={permissions.includes("admin.mail.domains.read") && <Button nativeButton={false} render={<Link to="/console/mail/domains" />}>Manage addresses</Button>}>
        <MailState loading={addresses.loading && !addresses.data} error={addresses.error} retry={addresses.reload} />
        <div className="mail-record-list">{addresses.data?.addresses.map(address => <div key={address.id} className="mail-record"><div><strong>{address.email_address}</strong><p>{address.is_primary ? "Primary · " : ""}{address.receive_enabled ? "Receives mail" : "Receive disabled"} · {address.send_enabled ? "Can send" : "Send disabled"}</p></div></div>)}</div>
        {addresses.data && !addresses.data.addresses.length && <p className="mail-hint">Ask an administrator to assign an address to this mailbox.</p>}
      </MailSection>
    </>}
    {mail.box!.access?.manage ? <Members path={path} /> : <MailSection title="Sharing"><p className="mail-hint">Mailbox members are managed by the owner.</p></MailSection>}
  </MailSettingsLayout>;
}
function SettingsSkeleton() {
  return <div className="mail-settings-placeholder" role="status" aria-label="Loading mailbox settings…"><div aria-hidden="true">
    <MailSection title="Signature" description="Added to new messages and replies. Shared mailbox changes apply to everyone."><LoadingSkeleton kind="form" rows={0} /></MailSection>
    <MailSection title="Automatic replies" description="Reply to incoming messages while you are away."><LoadingSkeleton rows={1} /></MailSection>
    <MailSection title="Trash & spam" description="Choose how long this mailbox keeps deleted and spam messages."><LoadingSkeleton rows={2} /></MailSection>
    <div className="mail-settings-save"><span className="skeleton-line skeleton-short" /></div>
  </div></div>;
}
function editableSettings(initial: MailSettings) {
  return { signature: initial.signature, signature_html: initial.signature_html || plainMailHtml(initial.signature), auto_reply_enabled: initial.auto_reply_enabled, auto_reply_subject: initial.auto_reply_subject, auto_reply_text: initial.auto_reply_text, retention_days: initial.retention_days };
}
function SettingsForm({ initial, path, canManage, maxImageBytes }: { initial: MailSettings; path: string; canManage: boolean; maxImageBytes?: number }) {
  const mail = useMail(), cache = useMailCache(), notify = useNotifications();
  const [values, setValues] = useState(() => editableSettings(initial)), [saved, setSaved] = useState(() => JSON.stringify(editableSettings(initial)));
  const [imageUploading, setImageUploading] = useState(false), action = useMailAction();
  const dirty = JSON.stringify(values) !== saved;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || imageUploading) && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (!dirty) {
      const next = editableSettings(initial);
      setValues(next); setSaved(JSON.stringify(next));
    }
  }, [initial]);
  useEffect(() => {
    if (!dirty && !imageUploading) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, imageUploading]);
  async function persist() {
    if (imageUploading) throw new Error("Wait for the image upload to finish.");
    if (values.retention_days !== null && (!Number.isInteger(values.retention_days) || values.retention_days < 1 || values.retention_days > 3650)) throw new Error("Enter a whole number between 1 and 3650 days.");
    const result = await api<{ settings: MailSettings }>(path + "/settings", { method: "PATCH", body: { ...values, auto_reply_enabled: !!values.auto_reply_enabled } });
    const next = editableSettings(result.settings);
    setValues(next); setSaved(JSON.stringify(next)); cache.replace(path + "/settings", result);
    notify.success("Mailbox settings saved.");
  }
  return <>
    <MailForm className="mail-settings-form" onSubmit={event => { event.preventDefault(); void action.run(persist); }}>
      <MailFieldset disabled={!canManage || action.busy}>
        <MailSection title="Signature" description={canManage ? "Added to new messages and replies. Shared mailbox changes apply to everyone." : "Managed by the mailbox owner."}>
          <fieldset className="mail-editor-field"><legend className="mail-sr-only">Signature editor</legend><MailEditor label="Signature" value={values.signature_html} maxImageBytes={maxImageBytes} onUploadingChange={setImageUploading} mailboxId={mail.box!.id} disabled={!canManage || action.busy} onChange={(html, text) => setValues(old => ({ ...old, signature: text, signature_html: html }))} /></fieldset>
        </MailSection>
        <MailSection title="Automatic replies" description="Reply to incoming messages while you are away.">
          <Check checked={!!values.auto_reply_enabled} onChange={value => setValues(old => ({ ...old, auto_reply_enabled: Number(value) }))}>Enable automatic replies</Check>
          {!!values.auto_reply_enabled && <div className="mail-form"><MailInput label="Auto-reply subject" maxLength={998} value={values.auto_reply_subject} onChange={event => setValues(old => ({ ...old, auto_reply_subject: event.target.value }))} /><MailField label="Auto-reply message"><MailTextarea maxLength={10000} value={values.auto_reply_text} onChange={event => setValues(old => ({ ...old, auto_reply_text: event.target.value }))} /></MailField></div>}
        </MailSection>
        <MailSection title="Trash & spam" description="Choose how long this mailbox keeps deleted and spam messages."><MailInput label="Keep messages for (days)" hint="Leave empty to keep messages until you delete them. Allowed range: 1–3650 days." type="number" min={1} max={3650} value={values.retention_days ?? ""} onChange={event => setValues(old => ({ ...old, retention_days: event.target.value ? Number(event.target.value) : null }))} /></MailSection>
      </MailFieldset>
      <MailNotice error={action.error} />
      {canManage && <div className="mail-settings-save"><span role="status">{action.busy ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span><Button type="submit" variant="primary" disabled={action.busy || imageUploading || !dirty}>Save mailbox settings</Button></div>}
    </MailForm>
    <MailModal open={blocker.state === "blocked"} title="Save changes before leaving?" description="Your mailbox settings have unsaved changes." busy={action.busy} onClose={() => blocker.state === "blocked" && blocker.reset()}>
      <MailNotice error={action.error} /><div className="mail-actions">
        <Button variant="primary" disabled={action.busy || imageUploading} onClick={() => { void action.run(async () => { await persist(); if (blocker.state === "blocked") blocker.proceed(); }); }}>Save and continue</Button>
        <Button disabled={action.busy || imageUploading} onClick={() => blocker.state === "blocked" && blocker.proceed()}>Discard changes</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => blocker.state === "blocked" && blocker.reset()}>Keep editing</Button>
      </div>
    </MailModal>
  </>;
}
interface Member { user_id: string; email_address: string; display_name: string | null; can_read: number; can_write: number; can_send: number; can_manage: number; }
interface MemberDirectory { members: Member[]; candidates: { id: string; email_address: string; display_name: string | null }[]; }
const rightLabels: Record<MailRight, string> = { read: "Read messages", write: "Edit mail & folders", send: "Send mail", manage: "Manage settings & sharing" };
function Members({ path }: { path: string }) {
  const mail = useMail(), [search, setSearch] = useState(""), [query, setQuery] = useState(""), resource = useMailResource<MemberDirectory>(`${path}/members?search=${encodeURIComponent(query)}`), action = useMailAction(), [user, setUser] = useState(""), [grants, setGrants] = useState<Record<MailRight, boolean>>({ read: true, write: false, send: false, manage: false }), [deleting, setDeleting] = useState<Member | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 300); return () => clearTimeout(timer); }, [search]);
  return <MailSection title="Shared access" description="The owner always has full access. Reading, editing, sending and managing are separate permissions."><p className="mail-hint">Owner: {resource.data?.candidates.find((candidate) => candidate.id === mail.box!.owner_user_id)?.email_address ?? mail.box!.owner_user_id}</p><MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    <div className="mail-record-list">{resource.data?.members.map((member) => <div key={member.user_id} className="mail-record"><div><strong>{member.display_name || member.email_address}</strong><p>{member.email_address}</p><p>{(Object.keys(rightLabels) as MailRight[]).filter((right) => member[`can_${right}`]).map((right) => rightLabels[right]).join(" · ") || "No permissions"}</p></div>{member.user_id !== mail.box!.owner_user_id && <div className="mail-actions"><Button size="sm" onClick={() => { setUser(member.user_id); setGrants(Object.fromEntries((Object.keys(rightLabels) as MailRight[]).map((right) => [right, !!member[`can_${right}`]])) as Record<MailRight, boolean>); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(member)}>Remove</Button></div>}</div>)}</div>
    <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { if (!user) throw new Error("Choose a member."); await api(`${path}/members/${user}`, { method: "PUT", body: grants }); resource.reload(); mail.refreshBoxes(); setUser(""); }); }}><MailInput label="Find an account" hint="Only active accounts with Mail access are listed. Search by name or sign-in email." value={search} onChange={(event) => setSearch(event.target.value)} /><MailField label="Member"><MailSelect required value={user} onValueChange={(nextValue) => setUser(nextValue)} options={[{ value: "", label: "Select an account" }, ...(user && !resource.data?.candidates.some((candidate) => candidate.id === user) && [{ value: user, label: resource.data?.members.find((member) => member.user_id === user)?.email_address ?? user }] || []), ...(resource.data?.candidates.filter((candidate) => candidate.id !== mail.box!.owner_user_id).map((candidate) => ({ value: candidate.id, label: <>{candidate.display_name ? `${candidate.display_name} · ` : ""}{candidate.email_address}</> })) || [])]} /></MailField><div className="mail-check-grid">{(Object.keys(rightLabels) as MailRight[]).map((right) => <Check key={right} checked={grants[right]} onChange={(value) => setGrants({ ...grants, [right]: value })}>{rightLabels[right]}</Check>)}</div><MailNotice error={action.error} /><Button type="submit" disabled={action.busy || !user}>Save member access</Button></MailForm>
    <Confirm open={!!deleting} title="Remove mailbox access?" description={`${deleting?.email_address ?? "This member"} will lose the permissions granted by this mailbox.`} label="Remove member" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`${path}/members/${deleting!.user_id}`, { method: "DELETE" }); resource.reload(); mail.refreshBoxes(); }} />
  </MailSection>;
}

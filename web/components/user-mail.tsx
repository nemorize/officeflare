import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAccess } from "./console-access";
import { Check, Confirm } from "./console-shared";
import { Button, useNotifications } from "./ui";
import { MailField, MailFieldset, MailForm, MailInput, MailNotice, MailSection, MailSelect, MailState, useMailAction, useMailResource } from "./mail-common";
import { api } from "../lib/api";
import type { Address, Domain, Mailbox } from "../lib/mail";
import type { AdminUser } from "../lib/console";
import "../routes/mail.css";

export type UserMailDomain = Pick<Domain, "id" | "name" | "is_default" | "inbound_enabled" | "outbound_enabled">;
export interface UserMail { mailbox: Mailbox | null; addresses: Address[]; mail_enabled: boolean; enable_role?: { id: string; label: string } | null; }
export function preferredDomain(domains: UserMailDomain[], email = "") {
  return domains.find((domain) => domain.name === email.split("@")[1]) ?? domains.find((domain) => domain.is_default) ?? domains[0];
}
export function MailAddressField({ domains, domainId, local, onDomainChange, onLocalChange, disabled, label = "Email address" }: {
  domains: UserMailDomain[]; domainId: string; local: string; onDomainChange: (value: string) => void; onLocalChange: (value: string) => void; disabled?: boolean; label?: string;
}) {
  const domain = domains.find((entry) => entry.id === domainId);
  return <div className="console-mail-address"><div className="mail-form-grid">
    <MailInput label={label} placeholder="name" value={local} required maxLength={64} autoComplete="off" disabled={disabled} onChange={(event) => onLocalChange(event.target.value)} />
    <MailField label="Domain"><MailSelect required value={domainId} disabled={disabled} onValueChange={onDomainChange} options={[{ value: "", label: "Select domain" }, ...domains.map((entry) => ({ value: entry.id, label: `@${entry.name}${entry.is_default ? " · Default" : ""}` }))]} /></MailField>
  </div>{local && domain && <p className="mail-hint">{local.trim()}@{domain.name}</p>}</div>;
}
export function DomainSetupLink() {
  const permissions = useAccess().permissions;
  return <p className="mail-hint">Register a mail domain to assign workspace addresses.{permissions.includes("admin.mail.domains.manage") && <> <Link to="/console/mail/domains/new">Register domain →</Link></>}</p>;
}
export function UserMailPanel({ user }: { user: AdminUser }) {
  const permissions = useAccess().permissions, notify = useNotifications();
  const [revision, setRevision] = useState(0), resource = useMailResource<UserMail>(`/api/users/${encodeURIComponent(user.id)}/mailbox`, revision);
  const domains = useMailResource<{ domains: UserMailDomain[] }>("/api/users/mail-options"), action = useMailAction();
  const [editing, setEditing] = useState(false), [domainId, setDomainId] = useState(""), [local, setLocal] = useState(""), [disable, setDisable] = useState(false);
  useEffect(() => { const reload = () => setRevision((value) => value + 1); window.addEventListener("officeflare:user-mail-changed", reload); return () => window.removeEventListener("officeflare:user-mail-changed", reload); }, []);
  const mail = resource.data, primary = mail?.addresses.find((entry) => entry.is_primary) ?? mail?.addresses[0], box = mail?.mailbox;
  const canManage = permissions.includes("admin.mail.mailboxes.manage"), canAddress = canManage && permissions.includes("admin.mail.domains.manage");
  const start = () => { setLocal(primary?.local_part ?? user.email_address.split("@")[0] ?? ""); setDomainId(primary?.domain_id ?? preferredDomain(domains.data?.domains ?? [], user.email_address)?.id ?? ""); setEditing(true); };
  return <MailSection title="Personal mail" description="This user's address, mailbox and aliases are managed together.">
    <MailState loading={resource.loading && !mail || domains.loading && !domains.data} error={resource.error || domains.error} retry={() => { resource.reload(); domains.reload(); }} />
    {mail && <>
      <div className="console-mail-summary"><div><strong>{primary?.email_address ?? (mail.mail_enabled ? "Mail address not set" : "Mail is not enabled")}</strong><p className="mail-hint">{!mail.mail_enabled ? box ? "Mail is not enabled. Stored mail is retained." : "Enable personal mail to set this user’s address and mailbox." : box ? `${box.status === "active" ? "Personal mailbox ready" : box.status === "provisioning" ? "Preparing personal mailbox…" : "Personal mailbox disabled"}${user.disabled_at ? " · Account disabled" : user.password_reset_required ? " · Waiting for first sign-in" : ""}` : mail.mail_enabled ? "Set an address to prepare this user's personal mailbox." : "Assign a role with Mail access to give this user a personal mailbox."}</p></div>
        {(mail.mail_enabled || mail.enable_role) && canAddress && !editing && !!domains.data?.domains.length && <Button onClick={start}>{!mail.mail_enabled ? "Enable personal mail" : primary ? "Change address" : "Set up mail"}</Button>}
      </div>
      {!mail.mail_enabled && permissions.includes("admin.users.roles.read") && <p className="mail-hint"><a href="#user-roles">Manage this user's roles →</a></p>}
      {mail.mail_enabled && domains.data && !domains.data.domains.length && <DomainSetupLink />}
      {mail.mail_enabled && box?.status === "provisioning" && <Button size="sm" disabled={resource.loading} onClick={resource.reload}>Retry preparation</Button>}
      {(mail.mail_enabled || mail.enable_role) && editing && <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => {
        await api(`/api/users/${encodeURIComponent(user.id)}/mailbox`, { method: "POST", body: { domain_id: domainId, local_part: local.trim().toLowerCase(), ...(!mail.mail_enabled ? { enable_mail: true } : {}) } });
        setEditing(false); resource.reload(); notify.success("Personal mail saved."); window.dispatchEvent(new Event("officeflare:mail-access-changed")); window.dispatchEvent(new Event("officeflare:user-mail-changed"));
      }); }}><MailFieldset disabled={action.busy}><MailAddressField domains={domains.data?.domains ?? []} local={local} domainId={domainId} onLocalChange={setLocal} onDomainChange={setDomainId} />
        {!mail.mail_enabled && <p className="mail-hint">Saving also assigns the {mail.enable_role?.label} role so this user can use their personal mail.</p>}
        {primary && <p className="mail-hint">The previous address stays as an alias. Sign-in email remains {user.email_address}.</p>}
        <div className="mail-actions"><Button disabled={action.busy} onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy || !domainId}>{action.busy ? "Saving…" : "Save personal mail"}</Button></div>
      </MailFieldset></MailForm>}
      <MailNotice error={action.error} />
      {primary && domains.data?.domains.find((domain) => domain.id === primary.domain_id && (!domain.inbound_enabled || !domain.outbound_enabled)) && <p className="mail-hint">Delivery follows the domain's receiving and sending settings.{permissions.includes("admin.mail.domains.read") && <> <Link to={`/console/mail/domains/${primary.domain_id}`}>View domain settings →</Link></>}</p>}
      {box && <MailboxAliases mailbox={box} domains={domains.data?.domains ?? []} addresses={mail.addresses} canManage={permissions.includes("admin.mail.domains.manage")} onSaved={resource.reload} />}
      {box && canManage && <details className="console-role-summary"><summary>Mailbox access</summary><p className="mail-hint">Disabling the mailbox stops access and mail processing. Messages remain stored.</p><Button size="sm" disabled={action.busy || box.status === "provisioning"} onClick={() => { if (box.status === "active") setDisable(true); else void action.run(async () => { await api(`/api/mail/mailboxes/${box.id}`, { method: "PATCH", body: { status: "active" } }); resource.reload(); }); }}>{box.status === "active" ? "Disable mailbox" : "Enable mailbox"}</Button></details>}
      <Confirm open={disable} title="Disable personal mailbox?" description="The user will lose mailbox access and new messages will stop being processed. Existing messages remain stored." label="Disable mailbox" onClose={() => setDisable(false)} onConfirm={async () => { await api(`/api/mail/mailboxes/${box!.id}`, { method: "PATCH", body: { status: "disabled" } }); resource.reload(); }} />
    </>}
  </MailSection>;
}
export function MailboxAliases({ mailbox, domains, addresses, canManage, onSaved }: { mailbox: Mailbox; domains: UserMailDomain[]; addresses: Address[]; canManage: boolean; onSaved: () => void }) {
  const [adding, setAdding] = useState(false), [domainId, setDomainId] = useState(""), [local, setLocal] = useState(""), [deleting, setDeleting] = useState<Address | null>(null), [editing, setEditing] = useState<Address | null>(null), [receive, setReceive] = useState(true), [send, setSend] = useState(true), action = useMailAction();
  const aliases = addresses.filter((entry) => !entry.is_primary), primary = addresses.find((entry) => entry.is_primary);
  return <>{primary && canManage && <AddressDelivery address={primary} onSaved={onSaved} />}<div className="console-mail-aliases"><div className="console-mail-summary"><div><h3>Aliases</h3><p className="mail-hint">Additional addresses use the same mailbox and messages.</p></div>{canManage && !adding && !!domains.length && <Button size="sm" onClick={() => { setDomainId(preferredDomain(domains)?.id ?? ""); setAdding(true); }}>Add alias</Button>}</div>
    {aliases.map((address) => <div className="mail-record" key={address.id}><div><strong>{address.email_address}</strong><p>{address.receive_enabled ? "Receive enabled" : "Receive disabled"} · {address.send_enabled ? "Send enabled" : "Send disabled"}</p></div>{canManage && <div className="mail-actions"><Button size="sm" variant="ghost" onClick={() => { setEditing(address); setReceive(!!address.receive_enabled); setSend(!!address.send_enabled); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(address)}>Remove</Button></div>}</div>)}
    {!aliases.length && <p className="mail-hint">No aliases.</p>}
    {adding && <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api("/api/mail/addresses", { method: "POST", body: { mailbox_id: mailbox.id, domain_id: domainId, local_part: local.trim().toLowerCase(), is_primary: false, receive_enabled: true, send_enabled: true } }); setAdding(false); setLocal(""); onSaved(); }); }}><MailFieldset disabled={action.busy}><MailAddressField label="Alias address" domains={domains} local={local} domainId={domainId} onLocalChange={setLocal} onDomainChange={setDomainId} /><div className="mail-actions"><Button disabled={action.busy} onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" disabled={action.busy || !domainId} variant="primary">Add alias</Button></div></MailFieldset><MailNotice error={action.error} /></MailForm>}
    {editing && <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api(`/api/mail/addresses/${editing.id}`, { method: "PATCH", body: { receive_enabled: receive, send_enabled: send } }); setEditing(null); onSaved(); }); }}><p>{editing.email_address}</p><MailFieldset disabled={action.busy}><Check checked={receive} onChange={setReceive}>Receive mail</Check><Check checked={send} onChange={setSend}>Send mail</Check><div className="mail-actions"><Button disabled={action.busy} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={action.busy} variant="primary">Save alias</Button></div></MailFieldset><MailNotice error={action.error} /></MailForm>}
    <Confirm open={!!deleting} title="Remove alias?" description={`${deleting?.email_address ?? "This address"} will stop receiving and sending mail. Messages remain in the mailbox.`} label="Remove alias" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`/api/mail/addresses/${deleting!.id}`, { method: "DELETE" }); onSaved(); }} />
  </div></>;
}

function AddressDelivery({ address, onSaved }: { address: Address; onSaved: () => void }) {
  const [receive, setReceive] = useState(!!address.receive_enabled), [send, setSend] = useState(!!address.send_enabled), action = useMailAction();
  useEffect(() => { setReceive(!!address.receive_enabled); setSend(!!address.send_enabled); }, [address.id, address.receive_enabled, address.send_enabled]);
  return <details className="console-role-summary"><summary>Primary address delivery{!address.receive_enabled || !address.send_enabled ? " · Restricted" : ""}</summary><MailForm className="mail-form console-mail-delivery" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api(`/api/mail/addresses/${address.id}`, { method: "PATCH", body: { receive_enabled: receive, send_enabled: send } }); onSaved(); }); }}>
    <p className="mail-hint">{address.email_address} · Domain settings must also allow delivery.</p><MailFieldset disabled={action.busy}><Check checked={receive} onChange={setReceive}>Receive mail at this address</Check><Check checked={send} onChange={setSend}>Send mail from this address</Check><Button type="submit" disabled={action.busy || receive === !!address.receive_enabled && send === !!address.send_enabled}>Save delivery settings</Button></MailFieldset><MailNotice error={action.error} />
  </MailForm></details>;
}

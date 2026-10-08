import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { mailboxPath, MailOperation, type Address, type DomainProvider, type Domain, type Mailbox } from "../lib/mail";
import { type AdminUser } from "../lib/console";
import { useAccess } from "../components/console-access";
import { useAccount } from "../components/account-context";
import { MailField, MailInput, MailModal, MailNotice, MailPageHeader, MailSection, MailState, useMailAction, useMailResource, MailForm, MailSelect, MailFieldset } from "../components/mail-common";
import { MailRules } from "../components/mail-rules";
import { Button, useNotifications } from "../components/ui";
import { Check, Confirm } from "../components/console-shared";
import "./console.css";
import "./mail.css";
export function MailConsolePage({ page }: { page: string }) { return <div className="mail-manage-page mail-console-page">{page === "mailboxes" ? <Mailboxes /> : <Domains />}</div>; }
function useMailboxDirectory() {
  const permissions = useAccess().permissions;
  return useMailResource<{ mailboxes: Mailbox[] }>(permissions.includes("admin.mail.mailboxes.read") ? "/api/mail/mailboxes?all=true" : permissions.includes("mail.access") ? "/api/mail/mailboxes" : null);
}
function Domains() {
  const permissions = useAccess().permissions, resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>("/api/mail/domains"), manage = permissions.includes("admin.mail.domains.manage");
  return <><MailPageHeader title="Mail domains" description="Configure receiving, sending, aliases and inbound routing for your domains.">
    {manage && <Button nativeButton={false} render={<Link to="/console/mail/domains/new" />} variant="primary">Register domain</Button>}
  </MailPageHeader><MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    <div className="mail-domain-grid">{resource.data?.domains.map((domain) => <article key={domain.id} className="mail-domain-card">
      <h2>{domain.name}</h2><p><span className="mail-badge">Receive {domain.inbound_enabled ? "enabled" : "disabled"}</span><span className="mail-badge">Send {domain.outbound_enabled ? "enabled" : "disabled"}</span></p>
      <p className="mail-hint">Receiving: {domain.inbound_provider ?? "No provider"} · Sending: {domain.outbound_provider ?? "No provider"}</p>
      <Button nativeButton={false} render={<Link to={`/console/mail/domains/${encodeURIComponent(domain.id)}`} />} size="sm">{manage ? "Configure domain" : "View domain"}</Button>
    </article>)}</div>
    {resource.data && !resource.data.domains.length && <div className="mail-empty"><h2>No mail domains registered</h2><p>Register a domain, configure it in Cloudflare, then assign mailbox addresses.</p></div>}
  </>;
}
export function MailDomainEditorPage({ creating = false }: { creating?: boolean }) {
  const { id } = useParams(), navigate = useNavigate(), notify = useNotifications(), permissions = useAccess().permissions;
  const resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>("/api/mail/domains"), boxes = useMailboxDirectory(), domain = resource.data?.domains.find((entry) => entry.id === id), manage = permissions.includes("admin.mail.domains.manage");
  return <div className="mail-manage-page mail-console-page"><Link to="/console/mail/domains" className="console-back">← Mail domains</Link>
    <MailPageHeader title={creating ? "Register mail domain" : domain?.name ?? "Mail domain"} description="Select providers and configure mail delivery, mailbox addresses and inbound routing for this domain." />
    <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    {resource.data && !creating && !domain && <MailNotice error="This mail domain could not be found." />}
    {resource.data && (creating || domain) && <><DomainEditor key={creating ? "new" : domain!.id} existing={domain} providers={resource.data.providers} boxes={boxes.data?.mailboxes ?? []} canManage={manage} onSaved={(domainId) => { notify.success(creating ? "Domain registered." : "Domain settings saved."); if (creating) navigate(`/console/mail/domains/${encodeURIComponent(domainId)}`); else resource.reload(); }} />
      {domain && <><AddressManager scopedDomain={domain} domains={[domain]} boxes={boxes.data?.mailboxes ?? []} canManage={manage} /><MailRules path={`/api/mail/domains/${domain.id}/rules`} routing canManage={manage} /></>}
    </>}
  </div>;
}
function DomainEditor({ existing, providers, boxes, canManage, onSaved }: { existing?: Domain; providers: DomainProvider[]; boxes: Mailbox[]; canManage: boolean; onSaved: (id: string) => void }) {
  const action = useMailAction(), setup = useMailResource<{ receive: { action: string }; send: { action: string }; verification: string }>(existing ? `/api/mail/domains/${existing.id}/setup` : null);
  const initialProvider = (direction: "inbound" | "outbound") => existing ? existing[`${direction}_provider`] ?? (existing[`${direction}_connection_id`] ? "cloudflare" : "") : providers[0]?.provider ?? "";
  const [name, setName] = useState(existing?.name ?? ""), [inbound, setInbound] = useState(initialProvider("inbound")), [outbound, setOutbound] = useState(initialProvider("outbound"));
  const [receive, setReceive] = useState(!!existing?.inbound_enabled), [send, setSend] = useState(!!existing?.outbound_enabled), [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true), [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  const providerName = (provider: string) => provider === "cloudflare" ? "Cloudflare" : provider;
  const providerOptions = (direction: "receive" | "send", selected: string) => [
    { value: "", label: "No provider" },
    ...providers.map((provider) => ({ value: provider.provider, label: providerName(provider.provider), disabled: !provider.capabilities[direction] })),
    ...(selected && !providers.some((provider) => provider.provider === selected) ? [{ value: selected, label: `${providerName(selected)} (unavailable)` }] : []),
  ];
  const connectionFor = (selected: string, direction: "inbound" | "outbound") => !selected ? null : existing && selected === initialProvider(direction) ? existing[`${direction}_connection_id`] : providers.find((provider) => provider.provider === selected)?.default_connection_id ?? null;
  const submit = async () => {
    const inboundId = connectionFor(inbound, "inbound"), outboundId = connectionFor(outbound, "outbound");
    if (receive && !inboundId || send && !outboundId) throw new Error("Choose a configured provider for each enabled direction.");
    const result = await api<{ domain: Domain }>(`/api/mail/domains${existing ? `/${existing.id}` : ""}`, {
      method: existing ? "PATCH" : "POST",
      body: {
        ...(existing ? { catch_all_mailbox_id: catchAll || null } : { name }),
        ...(!existing || inboundId !== existing.inbound_connection_id ? { inbound_connection_id: inboundId } : {}),
        ...(!existing || outboundId !== existing.outbound_connection_id ? { outbound_connection_id: outboundId } : {}),
        inbound_enabled: receive, outbound_enabled: send, plus_addressing: plus,
      },
    });
    onSaved(result.domain.id);
  };
  return <MailSection title="Domain settings" description="Provider configuration and delivery settings apply to this domain.">
    <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(submit); }}>
      <MailFieldset disabled={action.busy || !canManage}>
        <MailInput label="Domain" placeholder="example.com" required disabled={!!existing} value={name} maxLength={253} onChange={(event) => setName(event.target.value)} />
        <div className="mail-form-grid">
          <MailField label="Receiving provider"><MailSelect value={inbound} onValueChange={(value) => { setInbound(value); if (!value) setReceive(false); }} options={providerOptions("receive", inbound)} /></MailField>
          <MailField label="Sending provider"><MailSelect value={outbound} onValueChange={(value) => { setOutbound(value); if (!value) setSend(false); }} options={providerOptions("send", outbound)} /></MailField>
        </div>
        {(inbound === "cloudflare" || outbound === "cloudflare") && <MailSection title="Cloudflare setup" description="This provider uses the deployed Worker bindings; no separate API key or connection is required.">
          <MailState loading={setup.loading} error={setup.error} retry={setup.reload} /><ul className="mail-setup-steps">
            {inbound === "cloudflare" && <li>{setup.data?.receive.action ?? "Enable Email Routing in Cloudflare and route incoming mail to this Worker"} for {name || "this domain"}.</li>}
            {outbound === "cloudflare" && <li>{setup.data?.send.action ?? "Onboard and verify this sending domain in Cloudflare Email Service"}. Sending uses the Worker’s EMAIL binding.</li>}
            <li>Assign mailbox addresses after saving this domain, then enable the configured directions.</li>
          </ul>
          {setup.data && <p className="mail-hint">{setup.data.verification}.</p>}<Button nativeButton={false} render={<a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer" />}>Open Cloudflare ↗</Button>
        </MailSection>}
        <Check checked={receive} onChange={setReceive} disabled={!inbound}>Enable receiving</Check>
        <Check checked={send} onChange={setSend} disabled={!outbound}>Enable sending</Check>
        <Check checked={plus} onChange={setPlus}>Enable plus addressing (name+tag@example.com)</Check>
        {existing && <MailField label="Catch-all mailbox" hint="Unmatched recipients in this domain are delivered to the selected mailbox."><MailSelect value={catchAll} onValueChange={setCatchAll} options={[{ value: "", label: "No catch-all" }, ...(catchAll && !boxes.some((box) => box.id === catchAll) ? [{ value: catchAll, label: catchAll }] : []), ...boxes.filter((box) => box.status === "active").map((box) => ({ value: box.id, label: box.name }))]} /></MailField>}
      </MailFieldset>
      <MailNotice error={action.error} />{canManage && <div className="mail-actions"><Button nativeButton={false} disabled={action.busy} render={<Link to="/console/mail/domains" />}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy}>{action.busy ? "Saving…" : existing ? "Save domain" : "Register domain"}</Button></div>}
    </MailForm>
  </MailSection>;
}
function AddressManager({ domains, boxes, canManage, fixedMailbox, scopedDomain }: { domains: Domain[]; boxes: Mailbox[]; canManage: boolean; fixedMailbox?: Mailbox; scopedDomain?: Domain }) {
  const [mailboxId, setMailboxId] = useState(fixedMailbox?.id ?? ""), [domainId, setDomainId] = useState(scopedDomain?.id ?? ""), [local, setLocal] = useState(""), [primary, setPrimary] = useState(false), [receive, setReceive] = useState(true), [send, setSend] = useState(true), [deleting, setDeleting] = useState<Address | null>(null), action = useMailAction(), resource = useMailResource<{ addresses: Address[] }>(mailboxId ? mailboxPath(mailboxId) + "/addresses" : null);
  return <MailSection title="Mailbox addresses & aliases" description="Addresses connect a mailbox to a domain. Creating an address does not create Cloudflare DNS or routing configuration.">
    {!fixedMailbox && <MailField label="Mailbox"><MailSelect value={mailboxId} onValueChange={(nextValue) => setMailboxId(nextValue)} options={[{ value: "", label: "Select a mailbox" }, ...(boxes.map((box) => ({ value: box.id, label: <>{box.name}{box.status !== "active" ? ` (${box.status})` : ""}</> })) || [])]} />{!boxes.length && <small>Mailbox configuration read permission is needed to list workspace mailboxes.</small>}</MailField>}
    <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} /><div className="mail-record-list">{resource.data?.addresses.filter((address) => !scopedDomain || address.domain_id === scopedDomain.id).map((address) => <div key={address.id} className="mail-record"><div><strong>{address.email_address}</strong><p>{address.is_primary ? "Primary · " : ""}{address.receive_enabled ? "Receive enabled" : "Receive disabled"} · {address.send_enabled ? "Send enabled" : "Send disabled"}</p></div>{canManage && <Button size="sm" variant="ghost" onClick={() => setDeleting(address)}>Delete</Button>}</div>)}</div>
    {canManage && <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api("/api/mail/addresses", { method: "POST", body: { mailbox_id: mailboxId, domain_id: domainId, local_part: local, is_primary: primary, receive_enabled: receive, send_enabled: send } }); setLocal(""); setPrimary(false); resource.reload(); }); }}><MailFieldset disabled={!mailboxId || action.busy}><div className="mail-form-grid"><MailInput label="Local part" placeholder="hello" required value={local} maxLength={64} onChange={(event) => setLocal(event.target.value)} /><MailField label="Domain"><MailSelect value={domainId} disabled={!!scopedDomain} required onValueChange={(nextValue) => setDomainId(nextValue)} options={[{ value: "", label: "Select domain" }, ...(domains.map((domain) => ({ value: domain.id, label: domain.name })) || [])]} /></MailField></div><div className="mail-check-grid"><Check checked={primary} onChange={setPrimary}>Primary address</Check><Check checked={receive} onChange={setReceive}>Receive mail</Check><Check checked={send} onChange={setSend}>Send mail</Check></div><Button type="submit" disabled={action.busy || !mailboxId || !domainId}>Add address</Button></MailFieldset><MailNotice error={action.error} /></MailForm>}
    <Confirm open={!!deleting} title="Delete mailbox address?" description={`${deleting?.email_address ?? "This address"} will stop receiving and sending mail. Existing messages remain in the mailbox.`} label="Delete address" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`/api/mail/addresses/${deleting!.id}`, { method: "DELETE" }); resource.reload(); }} />
  </MailSection>;
}
function Mailboxes() {
  const permissions = useAccess().permissions, resource = useMailResource<{ mailboxes: Mailbox[] }>("/api/mail/mailboxes?all=true"), [editing, setEditing] = useState<Mailbox | "new" | null>(null), [search, setSearch] = useState(""), manage = permissions.includes("admin.mail.mailboxes.manage");
  return <><MailPageHeader title="Mailboxes" description="Provision personal and shared mailboxes. Administration does not grant access to mailbox contents.">{manage && <Button variant="primary" onClick={() => setEditing("new")}>Create mailbox</Button>}</MailPageHeader><MailInput label="Find mailboxes" value={search} placeholder="Name or owner ID" onChange={(event) => setSearch(event.target.value)} /><MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} /><div className="mail-table-wrap"><table className="mail-table"><thead><tr><th>Mailbox</th><th>Type</th><th>Owner</th><th>Status</th><th>Actions</th></tr></thead><tbody>{resource.data?.mailboxes.filter((box) => `${box.name} ${box.owner_user_id}`.toLowerCase().includes(search.toLowerCase())).map((box) => <tr key={box.id}><td><strong>{box.name}</strong><small>{box.id}</small></td><td>{box.kind}</td><td>{box.owner_user_id}</td><td><span className="mail-badge">{box.status}</span></td><td>{manage && <Button size="sm" onClick={() => setEditing(box)}>Configure</Button>}</td></tr>)}</tbody></table></div>{resource.data && !resource.data.mailboxes.length && <p className="mail-empty">No mailboxes provisioned.</p>}{editing && <MailboxEditor key={editing === "new" ? "new" : editing.id} existing={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={resource.reload} />}</>;
}
function MailboxEditor({ existing, onClose, onSaved }: { existing?: Mailbox; onClose: () => void; onSaved: () => void }) {
  const { user } = useAccount(), permissions = useAccess().permissions, action = useMailAction(), [name, setName] = useState(existing?.name ?? ""), [kind, setKind] = useState(existing?.kind ?? "personal"), [owner, setOwner] = useState(existing?.owner_user_id ?? user?.id ?? ""), [status, setStatus] = useState(existing?.status ?? "active"), [users, setUsers] = useState<AdminUser[]>([]), [cursor, setCursor] = useState<string | null>(null), [userCursor, setUserCursor] = useState<string | null>(null), [uncertain, setUncertain] = useState(false);
  const directory = useMailResource<{ users: AdminUser[]; next_cursor: string | null }>(!existing && permissions.includes("admin.users.read") ? `/api/users?limit=100${userCursor ? `&cursor=${encodeURIComponent(userCursor)}` : ""}` : null);
  const operation = useRef(new MailOperation()), pending = useRef<object | null>(null);
  useEffect(() => { if (directory.data) { setUsers((old) => [...new Map([...old, ...directory.data!.users].map((entry) => [entry.id, entry])).values()]); setCursor(directory.data.next_cursor); } }, [directory.data]);
  useEffect(() => { if (!owner && user) setOwner(user.id); }, [owner, user]);
  return <MailModal open title={existing ? `Configure ${existing.name}` : "Create mailbox"} description={existing ? "The owner and mailbox type are fixed after creation. Members manage their shared access from Mail settings." : "Create an isolated mailbox store and choose the account that owns it."} onClose={onClose} busy={action.busy} wide><MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { if (existing) await api(`/api/mail/mailboxes/${existing.id}`, { method: "PATCH", body: { name, status } }); else { pending.current ??= { name, kind, owner_user_id: owner }; try { await api("/api/mail/mailboxes", { method: "POST", body: pending.current, headers: operation.current.headers(pending.current) }); } catch (failure) { setUncertain(true); if (failure instanceof ApiError && failure.status < 500) { pending.current = null; operation.current.complete(); setUncertain(false); } throw failure; } operation.current.complete(); pending.current = null; } onSaved(); onClose(); }); }}><MailFieldset disabled={action.busy || uncertain}><MailInput label="Mailbox name" value={name} required maxLength={100} onChange={(event) => setName(event.target.value)} />{existing ? <><p className="mail-hint">{existing.kind} mailbox · Owner {existing.owner_user_id}</p><MailField label="Mailbox status"><MailSelect value={status} onValueChange={(nextValue) => setStatus(nextValue)} options={[{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }]} /></MailField><p className="mail-hint">Disabling stops mailbox access and new mail processing. Existing mail remains stored.</p></> : <><MailField label="Mailbox type"><MailSelect value={kind} onValueChange={(nextValue) => setKind(nextValue as Mailbox["kind"])} options={[{ value: "personal", label: "Personal" }, { value: "shared", label: "Shared" }]} /></MailField><MailField label="Owner"><MailSelect required value={owner} onValueChange={(nextValue) => setOwner(nextValue)} options={[{ value: "", label: "Select owner" }, ...(user && !users.some((entry) => entry.id === user.id) && [{ value: user.id, label: <>{user.display_name || user.email_address} (you)</> }] || []), ...(users.filter((entry) => !entry.deleted_at).map((entry) => ({ value: entry.id, label: <>{entry.display_name ? `${entry.display_name} · ` : ""}{entry.email_address}{entry.disabled_at ? " (disabled)" : ""}</> })) || [])]} /><small>The owner needs Mail service access to use this mailbox. Viewing other owners requires user administration read permission.</small></MailField><MailState loading={directory.loading && !directory.data} error={directory.error} retry={directory.reload} />{cursor && <Button size="sm" disabled={directory.loading} onClick={() => setUserCursor(cursor)}>Load more accounts</Button>}</>}</MailFieldset><MailNotice error={action.error} />{uncertain && <p className="mail-hint">Retry to recover the result of the same mailbox creation request.</p>}<Button variant="primary" type="submit" disabled={action.busy || !existing && !owner}>{uncertain ? "Check creation result" : existing ? "Save mailbox" : "Create mailbox"}</Button></MailForm>
    {existing && permissions.includes("admin.mail.domains.read") && <MailboxAddresses mailbox={existing} />}
    {existing && permissions.includes("mail.access") && <p className="mail-hint"><Link to={`/mail/settings?mailbox=${encodeURIComponent(existing.id)}`}>Open mailbox settings</Link> · Requires ownership or shared mailbox permissions.</p>}
  </MailModal>;
}
function MailboxAddresses({ mailbox }: { mailbox: Mailbox }) {
  const permissions = useAccess().permissions, domains = useMailResource<{ domains: Domain[] }>("/api/mail/domains");
  return <><MailState loading={domains.loading && !domains.data} error={domains.error} retry={domains.reload} /><AddressManager fixedMailbox={mailbox} domains={domains.data?.domains ?? []} boxes={[mailbox]} canManage={permissions.includes("admin.mail.domains.manage")} /></>;
}

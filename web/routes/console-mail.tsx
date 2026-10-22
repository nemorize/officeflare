import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { type DomainProvider, type Domain, type Mailbox } from "../lib/mail";
import { useAccess } from "../components/console-access";
import { MailField, MailInput, MailNotice, MailSection, MailState, useMailAction, useMailResource, MailForm, MailSelect, MailFieldset } from "../components/mail-common";
import { MailRules } from "../components/mail-rules";
import { Button, useNotifications } from "../components/ui";
import { Check, ConsolePageHeader } from "../components/console-shared";
import { SharedMailboxes } from "./console-shared-mailboxes";
import "./console.css";
import "./mail.css";
export function MailConsolePage({ page }: { page: string }) { return <section className="account-page console-page mail-console-page">{page === "mailboxes" ? <SharedMailboxes /> : page === "providers" ? <ProviderConnections /> : <Domains />}</section>; }
function useMailboxDirectory() {
  const permissions = useAccess().permissions;
  return useMailResource<{ mailboxes: Mailbox[] }>(permissions.includes("admin.mail.mailboxes.read") ? "/api/mail/mailboxes?all=true" : permissions.includes("mail.access") ? "/api/mail/mailboxes" : null);
}
function Domains() {
  const permissions = useAccess().permissions, resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>("/api/mail/domains"), manage = permissions.includes("admin.mail.domains.manage");
  const providerName = (provider: string | null | undefined) => provider ? resource.data?.providers.find((entry) => entry.provider === provider)?.label ?? provider : "No provider";
  return <><ConsolePageHeader title="Mail domains" description="Configure common domains, delivery providers and inbound routing.">
    {manage && <Button nativeButton={false} render={<Link to="/console/mail/domains/new" />} variant="primary">Register domain</Button>}
  </ConsolePageHeader><MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    <div className="mail-domain-grid">{resource.data?.domains.map((domain) => <article key={domain.id} className="mail-domain-card">
      <h2><span>{domain.name}</span>{!!domain.is_default && <span className="mail-badge mail-domain-default">Default</span>}</h2><p><span className="mail-badge">Receive {domain.inbound_enabled ? "enabled" : "disabled"}</span><span className="mail-badge">Send {domain.outbound_enabled ? "enabled" : "disabled"}</span></p>
      <p className="mail-hint">Receiving: {providerName(domain.inbound_provider)} · Sending: {providerName(domain.outbound_provider)}</p>
      <Button nativeButton={false} render={<Link to={`/console/mail/domains/${encodeURIComponent(domain.id)}`} />} size="sm">{manage ? "Configure domain" : "View domain"}</Button>
    </article>)}</div>
    {resource.data && !resource.data.domains.length && <div className="mail-empty"><h2>No mail domains registered</h2><p>Register a domain and configure Cloudflare delivery. User and shared addresses are managed with their accounts.</p></div>}
  </>;
}
type ProviderField = { key: string; label: string; required?: boolean; secret?: boolean; help?: string; options?: string[] };
type ProviderCatalogEntry = { provider: string; label: string; capabilities: { receive: boolean; send: boolean; max_send_bytes: number; max_recipients: number }; config_fields: ProviderField[]; secret_fields: ProviderField[]; default_connection_id: string | null };
type ProviderConnection = { id: string; provider: string; name: string; enabled: number; version: number; config: Record<string, string>; secret_configured: boolean };
function ProviderConnections() {
  const permissions = useAccess().permissions, resource = useMailResource<{ connections: ProviderConnection[] }>("/api/mail/provider-connections"), catalog = useMailResource<{ providers: ProviderCatalogEntry[] }>("/api/mail/provider-catalog"), notify = useNotifications();
  const [editing, setEditing] = useState<ProviderConnection | null>(null), [creating, setCreating] = useState(false), [revision, setRevision] = useState(0);
  const providerList = catalog.data?.providers ?? [];
  const reload = () => { resource.reload(); catalog.reload(); };
  return <><ConsolePageHeader title="Mail providers" description="Connect sending services and assign them to mail domains.">
    {permissions.includes("admin.mail.providers.manage") && <Button variant="primary" onClick={() => { setEditing(null); setCreating(true); setRevision((value) => value + 1); }}>Add provider</Button>}
  </ConsolePageHeader>
  <MailState loading={(resource.loading || catalog.loading) && !resource.data} error={resource.error || catalog.error} retry={reload} />
  {(creating || editing) && <ProviderConnectionForm key={`${editing?.id ?? "new"}:${revision}`} existing={editing ?? undefined} providers={providerList} canManage={permissions.includes("admin.mail.providers.manage")} onCancel={() => { setCreating(false); setEditing(null); }} onSaved={(message) => { setCreating(false); setEditing(null); notify.success(message); reload(); }} />}
  {resource.data && <div className="mail-provider-grid">{resource.data.connections.map((connection) => <article className="mail-domain-card" key={connection.id}>
    <h2><span>{connection.name}</span><span className="mail-badge">{connection.enabled ? "Enabled" : "Disabled"}</span></h2>
    <p className="mail-hint">{providerList.find((item) => item.provider === connection.provider)?.label ?? connection.provider}</p>
    <p className="mail-hint">{connection.secret_configured ? "Credentials saved" : "No credentials"}{connection.config && Object.keys(connection.config).length ? ` · ${Object.keys(connection.config).length} settings` : ""}</p>
    {permissions.includes("admin.mail.providers.manage") && providerList.some((item) => item.provider === connection.provider) && <Button size="sm" onClick={() => { setCreating(false); setEditing(connection); setRevision((value) => value + 1); }}>Configure</Button>}
    {!providerList.some((item) => item.provider === connection.provider) && <p className="mail-hint">This provider is no longer supported. Reassign any domains that use it to an available sender.</p>}
  </article>)}{!resource.data.connections.length && <div className="mail-empty"><h2>No provider connections</h2><p>Add a sending provider, then select it on a mail domain.</p></div>}</div>}
  </>;
}
function ProviderConnectionForm({ existing, providers, canManage, onCancel, onSaved }: { existing?: ProviderConnection; providers: ProviderCatalogEntry[]; canManage: boolean; onCancel: () => void; onSaved: (message: string) => void }) {
  const action = useMailAction(), [selected, setSelected] = useState(existing?.provider ?? "cloudflare-rest"), [name, setName] = useState(existing?.name ?? ""), [enabled, setEnabled] = useState(!!(existing?.enabled ?? 1));
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {}), [secrets, setSecrets] = useState<Record<string, string>>({});
  const definition = providers.find((entry) => entry.provider === selected);
  const save = async () => {
    if (!definition) throw new Error("Choose a supported provider.");
    const isNew = !existing;
    await api(`/api/mail/provider-connections${existing ? `/${encodeURIComponent(existing.id)}` : ""}`, {
      method: existing ? "PATCH" : "POST",
      body: {
        ...(existing ? { version: existing.version } : { provider: selected }),
        name,
        enabled,
        config,
        ...(Object.values(secrets).some(Boolean) ? { secrets } : {}),
      },
    });
    onSaved(isNew ? "Provider connection added." : "Provider connection saved.");
  };
  return <MailSection title={existing ? `Configure ${existing.name}` : "New provider connection"} description="Credentials are encrypted before they are saved. They are never returned by the API.">
    <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(save); }}><MailFieldset disabled={action.busy || !canManage}>
      {!existing && <MailField label="Provider"><MailSelect value={selected} onValueChange={(value) => { const next = providers.find((item) => item.provider === value); setSelected(value); setConfig(Object.fromEntries((next?.config_fields ?? []).filter((item) => item.options?.length).map((item) => [item.key, item.options![0]!] ))); setSecrets({}); }} options={providers.filter((item) => item.capabilities.send).map((item) => ({ value: item.provider, label: item.label }))} /></MailField>}
      <MailInput label="Connection name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
      {definition?.config_fields.map((item) => item.options
        ? <MailField key={item.key} label={item.label} hint={item.help}><MailSelect value={config[item.key] ?? item.options[0] ?? ""} onValueChange={(value) => setConfig((current) => ({ ...current, [item.key]: value }))} options={item.options.map((value) => ({ value, label: value === "tls" ? "TLS (port 465)" : value === "starttls" ? "STARTTLS (port 587)" : value }))} /></MailField>
        : <MailInput key={item.key} label={item.label} hint={item.help} required={!!item.required} value={config[item.key] ?? ""} onChange={(event) => setConfig((current) => ({ ...current, [item.key]: event.target.value }))} />)}
      {existing && definition?.secret_fields.length ? <p className="mail-hint">To rotate credentials, re-enter every required credential. Saved values are never returned.</p> : null}
      {definition?.secret_fields.map((item) => <MailInput key={item.key} label={item.label} hint={item.help} required={!existing && !!item.required} type="password" autoComplete="new-password" value={secrets[item.key] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [item.key]: event.target.value }))} />)}
      {definition?.provider === "cloudflare" && <p className="mail-hint">This connection uses the Worker EMAIL binding and does not need an API token.</p>}
      <Check checked={enabled} onChange={setEnabled}>Connection enabled</Check>
    </MailFieldset><MailNotice error={action.error} /><div className="mail-actions"><Button disabled={action.busy} onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy || !canManage}>{action.busy ? "Saving…" : existing ? "Save connection" : "Add connection"}</Button></div></MailForm>
  </MailSection>;
}
export function MailDomainEditorPage({ creating = false }: { creating?: boolean }) {
  const { id } = useParams(), navigate = useNavigate(), notify = useNotifications(), permissions = useAccess().permissions;
  const resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>("/api/mail/domains"), boxes = useMailboxDirectory(), domain = resource.data?.domains.find((entry) => entry.id === id), manage = permissions.includes("admin.mail.domains.manage");
  return <section className="account-page console-page console-detail-page mail-console-page"><Link to="/console/mail/domains" className="console-back">← Mail domains</Link>
    <ConsolePageHeader title={creating ? "Register mail domain" : domain?.name ?? "Mail domain"} description="Configure the shared domain, delivery providers and inbound routing." />
    <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    {resource.data && !creating && !domain && <MailNotice error="This mail domain could not be found." />}
    {resource.data && (creating || domain) && <><DomainEditor key={creating ? "new" : domain!.id} existing={domain} providers={resource.data.providers} boxes={boxes.data?.mailboxes ?? []} canManage={manage} defaultDomain={creating ? !resource.data.domains.some((entry) => entry.is_default) : !!domain?.is_default} onSaved={(domainId) => { notify.success(creating ? "Domain registered." : "Domain settings saved."); if (creating) navigate(`/console/mail/domains/${encodeURIComponent(domainId)}`); else resource.reload(); }} />
      {domain && <><MailSection title="Addresses" description="Manage personal addresses with users and team addresses with shared mailboxes."><div className="mail-actions">{permissions.includes("admin.users.read") && <Button nativeButton={false} render={<Link to="/console/users" />}>Manage users</Button>}{permissions.includes("admin.mail.mailboxes.read") && <Button nativeButton={false} render={<Link to="/console/mail/mailboxes" />}>Shared mailboxes</Button>}</div></MailSection><details className="console-role-summary"><summary>Advanced inbound routing</summary><MailRules path={`/api/mail/domains/${domain.id}/rules`} routing canManage={manage} /></details></>}
    </>}
  </section>;
}
function DomainEditor({ existing, providers, boxes, canManage, defaultDomain, onSaved }: { existing?: Domain; providers: DomainProvider[]; boxes: Mailbox[]; canManage: boolean; defaultDomain: boolean; onSaved: (id: string) => void }) {
  const action = useMailAction(), setup = useMailResource<{ receive: { action: string }; send: { action: string }; verification: string }>(existing ? `/api/mail/domains/${existing.id}/setup` : null);
  const initialProvider = (direction: "inbound" | "outbound") => existing ? existing[`${direction}_provider`] ?? (existing[`${direction}_connection_id`] ? "cloudflare" : "") : providers[0]?.provider ?? "";
  const [isDefault, setDefault] = useState(defaultDomain);
  const [name, setName] = useState(existing?.name ?? ""), [inbound, setInbound] = useState(initialProvider("inbound")), [outbound, setOutbound] = useState(initialProvider("outbound"));
  const [sendLimit, setSendLimit] = useState(existing?.max_send_bytes ? String(existing.max_send_bytes / 1024 ** 2) : "");
  const providerMaximum = providers.find((provider) => provider.provider === outbound)?.capabilities.max_send_bytes ?? 0;
  const [receive, setReceive] = useState(!!existing?.inbound_enabled), [send, setSend] = useState(!!existing?.outbound_enabled), [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true), [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  const providerName = (provider: string) => providers.find((entry) => entry.provider === provider)?.label ?? (provider === "cloudflare" ? "Cloudflare" : provider);
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
        inbound_enabled: receive, outbound_enabled: send, plus_addressing: plus, is_default: isDefault,
        max_send_bytes: outbound && sendLimit !== "" ? Math.round(Number(sendLimit) * 1024 ** 2) : null,
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
          <MailField label="Sending provider"><MailSelect value={outbound} onValueChange={(value) => { setOutbound(value); if (!value) { setSend(false); setSendLimit(""); } else { const maximum = providers.find((provider) => provider.provider === value)?.capabilities.max_send_bytes ?? 0; if (sendLimit && Number(sendLimit) * 1024 ** 2 > maximum) setSendLimit(String(maximum / 1024 ** 2)); } }} options={providerOptions("send", outbound)} /></MailField>
        </div>
        <MailInput label="Maximum message size (MiB)" hint={providerMaximum ? `Provider maximum: ${providerMaximum / 1024 ** 2} MiB. Leave empty to use that maximum. Includes the body, images and encoded attachments.` : "Choose a sending provider to set a message size limit."} type="number" min={1 / 1024 ** 2} max={providerMaximum / 1024 ** 2} step="any" disabled={!providerMaximum} placeholder={providerMaximum ? String(providerMaximum / 1024 ** 2) : ""} value={sendLimit} onChange={(event) => setSendLimit(event.target.value)} />
        {(inbound === "cloudflare" || outbound === "cloudflare") && <MailSection title="Cloudflare setup" description="This provider uses the deployed Worker bindings; no separate API key or connection is required.">
          <MailState loading={setup.loading} error={setup.error} retry={setup.reload} /><ul className="mail-setup-steps">
            {inbound === "cloudflare" && <li>{setup.data?.receive.action ?? "Enable Email Routing in Cloudflare and route incoming mail to this Worker"} for {name || "this domain"}.</li>}
            {outbound === "cloudflare" && <li>{setup.data?.send.action ?? "Onboard and verify this sending domain in Cloudflare Email Service"}. Sending uses the Worker’s EMAIL binding.</li>}
            <li>Save this domain, then add user or shared addresses from their respective pages.</li>
          </ul>
          {setup.data && <p className="mail-hint">{setup.data.verification}.</p>}<Button nativeButton={false} render={<a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer" />}>Open Cloudflare ↗</Button>
        </MailSection>}
        <Check checked={isDefault} onChange={setDefault}>Use as the default domain for new user addresses</Check>
        <Check checked={receive} onChange={setReceive} disabled={!inbound}>Enable receiving</Check>
        <Check checked={send} onChange={setSend} disabled={!outbound}>Enable sending</Check>
        <Check checked={plus} onChange={setPlus}>Enable plus addressing (name+tag@example.com)</Check>
        {existing && <MailField label="Catch-all mailbox" hint="Unmatched recipients in this domain are delivered to the selected mailbox."><MailSelect value={catchAll} onValueChange={setCatchAll} options={[{ value: "", label: "No catch-all" }, ...(catchAll && !boxes.some((box) => box.id === catchAll) ? [{ value: catchAll, label: catchAll }] : []), ...boxes.filter((box) => box.status === "active").map((box) => ({ value: box.id, label: box.name }))]} /></MailField>}
      </MailFieldset>
      <MailNotice error={action.error} />{canManage && <div className="mail-actions"><Button nativeButton={false} disabled={action.busy} render={<Link to="/console/mail/domains" />}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy}>{action.busy ? "Saving…" : existing ? "Save domain" : "Register domain"}</Button></div>}
    </MailForm>
  </MailSection>;
}

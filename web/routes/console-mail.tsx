import { useEffect, useState } from "react";
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
export function MailConsolePage({ page }: { page: string }) { return <section className="account-page console-page mail-console-page">{page === "mailboxes" ? <SharedMailboxes /> : <Domains />}</section>; }
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
type ProviderConnection = { id: string; provider: string; name: string; enabled: number; version: number; config: Record<string, string>; secret_configured: boolean };
export function MailDomainEditorPage({ creating = false }: { creating?: boolean }) {
  const { id } = useParams(), navigate = useNavigate(), notify = useNotifications(), permissions = useAccess().permissions;
  const resource = useMailResource<{ domains: Domain[]; providers: DomainProvider[] }>("/api/mail/domains"), boxes = useMailboxDirectory(), domain = resource.data?.domains.find((entry) => entry.id === id), manage = permissions.includes("admin.mail.domains.manage");
  const canManageProviders = permissions.includes("admin.mail.providers.manage"), providerConnections = useMailResource<{ connections: ProviderConnection[] }>(permissions.includes("admin.mail.providers.read") ? "/api/mail/provider-connections" : null);
  return <section className="account-page console-page console-detail-page mail-console-page"><Link to="/console/mail/domains" className="console-back">← Mail domains</Link>
    <ConsolePageHeader title={creating ? "Register mail domain" : domain?.name ?? "Mail domain"} description="Configure the shared domain, delivery providers and inbound routing." />
    <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
    {resource.data && !creating && !domain && <MailNotice error="This mail domain could not be found." />}
    {resource.data && (creating || domain) && <><DomainEditor key={creating ? "new" : domain!.id} existing={domain} providers={resource.data.providers} boxes={boxes.data?.mailboxes ?? []} providerConnections={providerConnections.data?.connections ?? []} providerConnectionsLoading={permissions.includes("admin.mail.providers.read") && (providerConnections.loading || !providerConnections.data && !providerConnections.error)} providerConnectionsError={providerConnections.error} reloadProviderConnections={providerConnections.reload} canManage={manage} canManageProviders={canManageProviders} defaultDomain={creating ? !resource.data.domains.some((entry) => entry.is_default) : !!domain?.is_default} onSaved={(domainId) => { notify.success(creating ? "Domain registered." : "Domain settings saved."); if (creating) navigate(`/console/mail/domains/${encodeURIComponent(domainId)}`); else resource.reload(); providerConnections.reload(); }} />
      {domain && <><MailSection title="Addresses" description="Manage personal addresses with users and team addresses with shared mailboxes."><div className="mail-actions">{permissions.includes("admin.users.read") && <Button nativeButton={false} render={<Link to="/console/users" />}>Manage users</Button>}{permissions.includes("admin.mail.mailboxes.read") && <Button nativeButton={false} render={<Link to="/console/mail/mailboxes" />}>Shared mailboxes</Button>}</div></MailSection><details className="console-role-summary"><summary>Advanced inbound routing</summary><MailRules path={`/api/mail/domains/${domain.id}/rules`} routing canManage={manage} /></details></>}
    </>}
  </section>;
}
function DomainEditor({ existing, providers, boxes, providerConnections, providerConnectionsLoading, providerConnectionsError, reloadProviderConnections, canManage, canManageProviders, defaultDomain, onSaved }: { existing?: Domain; providers: DomainProvider[]; boxes: Mailbox[]; providerConnections: ProviderConnection[]; providerConnectionsLoading: boolean; providerConnectionsError: string; reloadProviderConnections: () => void; canManage: boolean; canManageProviders: boolean; defaultDomain: boolean; onSaved: (id: string) => void }) {
  const action = useMailAction();
  const initialProvider = (direction: "inbound" | "outbound") => existing ? existing[`${direction}_provider`] ?? (existing[`${direction}_connection_id`] ? "cloudflare" : "") : providers[0]?.provider ?? "";
  const [isDefault, setDefault] = useState(defaultDomain);
  const [name, setName] = useState(existing?.name ?? ""), [inbound, setInbound] = useState(initialProvider("inbound")), [outbound, setOutbound] = useState(initialProvider("outbound"));
  const initialOutboundConnection = existing?.outbound_connection_id ?? (initialProvider("outbound") === "cloudflare" ? providers.find((provider) => provider.provider === "cloudflare")?.default_connection_id ?? null : null);
  const [outboundConnectionId, setOutboundConnectionId] = useState<string | null>(initialOutboundConnection), [providerConfig, setProviderConfig] = useState<Record<string, string>>({}), [providerSecrets, setProviderSecrets] = useState<Record<string, string>>({}), [providerConnectionEnabled, setProviderConnectionEnabled] = useState(true), [createdConnection, setCreatedConnection] = useState<ProviderConnection | null>(null);
  const [providerConfigDirty, setProviderConfigDirty] = useState(false);
  const [sendLimit, setSendLimit] = useState(existing?.max_send_bytes ? String(existing.max_send_bytes / 1024 ** 2) : "");
  const selectedProvider = providers.find((provider) => provider.provider === outbound), selectedConnection = createdConnection?.id === outboundConnectionId && createdConnection.provider === outbound ? createdConnection : providerConnections.find((connection) => connection.id === outboundConnectionId && connection.provider === outbound), providerMaximum = selectedProvider?.capabilities.max_send_bytes ?? 0;
  const [receive, setReceive] = useState(!!existing?.inbound_enabled), [send, setSend] = useState(!!existing?.outbound_enabled), [plus, setPlus] = useState(existing ? !!existing.plus_addressing : true), [catchAll, setCatchAll] = useState(existing?.catch_all_mailbox_id ?? "");
  useEffect(() => {
    if (providerConfigDirty) return;
    const saved = createdConnection?.id === outboundConnectionId && createdConnection.provider === outbound ? createdConnection : providerConnections.find((connection) => connection.id === outboundConnectionId && connection.provider === outbound);
    const definition = providers.find((provider) => provider.provider === outbound);
    setProviderConfig(saved?.config ?? Object.fromEntries((definition?.config_fields ?? []).filter((field) => field.options?.length).map((field) => [field.key, field.options![0]!])));
    setProviderConnectionEnabled(saved ? !!saved.enabled : true);
  }, [outboundConnectionId, outbound, providerConnections, providers, providerConfigDirty, createdConnection]);
  const providerName = (provider: string) => providers.find((entry) => entry.provider === provider)?.label ?? (provider === "cloudflare" ? "Cloudflare" : provider);
  const providerOptions = (direction: "receive" | "send", selected: string) => [
    { value: "", label: "No provider" },
    ...providers.filter((provider) => provider.capabilities[direction]).map((provider) => ({ value: provider.provider, label: providerName(provider.provider) })),
    ...(selected && !providers.some((provider) => provider.provider === selected && provider.capabilities[direction]) ? [{ value: selected, label: `${providerName(selected)} (unsupported)` }] : []),
  ];
  const submit = async () => {
    const inboundId = !inbound ? null : existing && inbound === initialProvider("inbound") ? existing.inbound_connection_id : providers.find((provider) => provider.provider === inbound)?.default_connection_id ?? null;
    let outboundId = outbound ? outboundConnectionId ?? (outbound === "cloudflare" ? selectedProvider?.default_connection_id ?? null : null) : null;
    if (receive && !inboundId) throw new Error("Choose a configured provider for each enabled direction.");
    if (outbound && selectedProvider && canManageProviders && (selectedProvider.config_fields.length || selectedProvider.secret_fields.length)) {
      if (providerConnectionsLoading) throw new Error("Provider connections are still loading. Try again in a moment.");
      if (providerConnectionsError) throw new Error("Could not load provider connections. Reload the page before saving provider settings.");
      const secretsEntered = Object.values(providerSecrets).some(Boolean);
      if (outboundId && !selectedConnection) throw new Error("Could not load the selected sending provider connection. Reload the page before saving.");
      if (!outboundId) {
        if (send && !providerConnectionEnabled) throw new Error("Enable this provider connection before enabling sending for the domain.");
        const result = await api<{ connection: ProviderConnection }>("/api/mail/provider-connections", { method: "POST", body: { provider: selectedProvider.provider, name: `${name || "Mail domain"} · ${selectedProvider.label}`, enabled: providerConnectionEnabled, config: providerConfig, ...(secretsEntered ? { secrets: providerSecrets } : {}) } });
        outboundId = result.connection.id;
        setOutboundConnectionId(outboundId);
        setCreatedConnection(result.connection);
        setProviderSecrets({});
        setProviderConfigDirty(false);
      } else if (selectedConnection) {
        if (send && !providerConnectionEnabled) throw new Error("Enable this provider connection before enabling sending for the domain.");
        if (providerConfigDirty || secretsEntered || providerConnectionEnabled !== !!selectedConnection.enabled) {
          const result = await api<{ connection: ProviderConnection }>(`/api/mail/provider-connections/${encodeURIComponent(selectedConnection.id)}`, { method: "PATCH", body: { version: selectedConnection.version, name: `${name || "Mail domain"} · ${providerName(selectedProvider.provider)}`, enabled: providerConnectionEnabled, config: providerConfig, ...(secretsEntered ? { secrets: providerSecrets } : {}) } });
          setCreatedConnection(result.connection);
          setProviderSecrets({});
          setProviderConfigDirty(false);
        }
      }
    }
    if (outbound && !outboundId) throw new Error("Add credentials for this sending provider before assigning it to the domain.");
    if (send && !outboundId) throw new Error("Choose a configured provider for each enabled direction.");
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
          <MailField label="Sending provider"><MailSelect value={outbound} onValueChange={(value) => { const next = providers.find((provider) => provider.provider === value), current = createdConnection?.provider === value ? createdConnection : existing?.outbound_provider === value ? providerConnections.find((connection) => connection.id === existing.outbound_connection_id) : undefined, nextConnectionId = current?.id ?? (value === "cloudflare" ? next?.default_connection_id ?? null : null); setOutbound(value); setOutboundConnectionId(nextConnectionId); setProviderConfigDirty(false); setProviderSecrets({}); setProviderConnectionEnabled(current ? !!current.enabled : true); if (!value) { setSend(false); setSendLimit(""); } else { const maximum = next?.capabilities.max_send_bytes ?? 0; if (sendLimit && Number(sendLimit) * 1024 ** 2 > maximum) setSendLimit(String(maximum / 1024 ** 2)); } }} options={providerOptions("send", outbound)} /></MailField>
        </div>
        {outbound && selectedProvider && (selectedProvider.config_fields.length > 0 || selectedProvider.secret_fields.length > 0) && <>
          {!canManageProviders ? <p className="mail-hint">Your role needs the “Manage sending providers” permission to configure this domain’s sender.</p> : providerConnectionsLoading ? <MailState loading error="" kind="form" /> : providerConnectionsError ? <MailState loading={false} error={providerConnectionsError} retry={reloadProviderConnections} /> : <>
            {selectedProvider.config_fields.map((field) => field.options
              ? <MailField key={field.key} label={field.label} hint={field.help}><MailSelect value={providerConfig[field.key] ?? field.options[0] ?? ""} onValueChange={(value) => { setProviderConfig((current) => ({ ...current, [field.key]: value })); setProviderConfigDirty(true); }} options={field.options.map((value) => ({ value, label: value === "tls" ? "TLS (port 465)" : value === "starttls" ? "STARTTLS (port 587)" : value }))} /></MailField>
              : <MailInput key={field.key} label={field.label} hint={field.help} required={!!field.required} value={providerConfig[field.key] ?? ""} onChange={(event) => { setProviderConfig((current) => ({ ...current, [field.key]: event.target.value })); setProviderConfigDirty(true); }} />)}
            {selectedProvider.secret_fields.length > 0 && selectedConnection?.secret_configured && <p className="mail-hint">Credentials are already saved and hidden. Leave these fields blank to keep them, or re-enter every required credential to replace them.</p>}
            {selectedProvider.secret_fields.map((field) => <MailInput key={field.key} label={field.label} hint={field.help} required={!!field.required && (!selectedConnection?.secret_configured || Object.values(providerSecrets).some(Boolean))} type="password" autoComplete="new-password" value={providerSecrets[field.key] ?? ""} onChange={(event) => setProviderSecrets((current) => ({ ...current, [field.key]: event.target.value }))} />)}
            {selectedConnection && <Check checked={providerConnectionEnabled} onChange={(checked) => { setProviderConnectionEnabled(checked); setProviderConfigDirty(true); }}>Sending provider connection enabled</Check>}
          </>}
        </>}
        <MailInput label="Maximum message size (MiB)" hint={providerMaximum ? `Provider maximum: ${providerMaximum / 1024 ** 2} MiB. Leave empty to use that maximum. Includes the body, images and encoded attachments.` : "Choose a sending provider to set a message size limit."} type="number" min={1 / 1024 ** 2} max={providerMaximum / 1024 ** 2} step="any" disabled={!providerMaximum} placeholder={providerMaximum ? String(providerMaximum / 1024 ** 2) : ""} value={sendLimit} onChange={(event) => setSendLimit(event.target.value)} />
        <Check checked={isDefault} onChange={setDefault}>Use as the default domain for new user addresses</Check>
        <Check checked={receive} onChange={setReceive} disabled={!inbound}>Enable receiving</Check>
        <Check checked={send} onChange={setSend} disabled={!outbound}>Enable sending</Check>
        <Check checked={plus} onChange={setPlus}>Enable plus addressing (name+tag@example.com)</Check>
        {existing && <MailField label="Catch-all mailbox" hint="Unmatched recipients in this domain are delivered to the selected mailbox."><MailSelect value={catchAll} onValueChange={setCatchAll} options={[{ value: "", label: "No catch-all" }, ...(catchAll && !boxes.some((box) => box.id === catchAll) ? [{ value: catchAll, label: catchAll }] : []), ...boxes.filter((box) => box.status === "active").map((box) => ({ value: box.id, label: box.name }))]} /></MailField>}
      </MailFieldset>
      <MailNotice error={action.error} />{canManage && <div className="mail-actions"><Button nativeButton={false} disabled={action.busy} render={<Link to="/console/mail/domains" />}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy || canManageProviders && providerConnectionsLoading}>{action.busy ? "Saving…" : existing ? "Save domain" : "Register domain"}</Button></div>}
    </MailForm>
  </MailSection>;
}

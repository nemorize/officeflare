import { MailSettingsLayout } from "../components/mail-settings-nav";
import { useId, useState } from "react";
import { api } from "../lib/api";
import { mailboxPath, mailDate, scheduledTime, type MailRight } from "../lib/mail";
import { useMail } from "../components/mail-context";
import { MailField, MailInput, MailModal, MailNotice, MailSection, MailState, useMailAction, useMailResource, MailForm, MailFieldset } from "../components/mail-common";
import { Check, Confirm } from "../components/console-shared";
import { Button, Icon } from "../components/ui";
const scopeLabels = { read: "Read", write: "Edit", send: "Send" };
interface ApiKey { id: string; name: string; expires_at: number; revoked_at: number | null; created_at: number; }
interface Scope { key_id?: string; mailbox_id: string; action: Exclude<MailRight, "manage">; }
export function MailIntegrationsPage() {
  const mail = useMail();
  return <div className="account-page mail-manage-page" key={mail.box?.id}><MailSettingsLayout title="Integrations" description="Connect scripts and mail tools with explicit mailbox permissions."><ApiKeys />{mail.capabilities?.features.webhooks && (mail.box ? <Webhooks /> : <p className="mail-hint">Choose an available mailbox to manage its webhooks.</p>)}<Jmap /><Mcp /></MailSettingsLayout></div>;
}
function Secret({ title, value, onClose }: { title: string; value: string; onClose: () => void }) {
  const action = useMailAction(), [copied, setCopied] = useState(false);
  return <MailModal open title={title} description="Copy this secret now. It is shown only once and is not stored in your browser." onClose={onClose}><div className="mail-secret"><code>{value}</code><Button disabled={action.busy} onClick={() => { void action.run(async () => { await navigator.clipboard.writeText(value); setCopied(true); }); }}>{copied ? "Copied" : "Copy secret"}</Button></div><MailNotice error={action.error} /><div className="mail-actions"><Button variant="primary" onClick={onClose}>Done</Button></div></MailModal>;
}
function ApiKeys() {
  const mail = useMail(), resource = useMailResource<{ keys: ApiKey[]; scopes: Scope[] }>("/api/mail/api-keys"), action = useMailAction(), [open, setOpen] = useState(false), [name, setName] = useState(""), [expires, setExpires] = useState(""), [scopes, setScopes] = useState<Scope[]>([]), [secret, setSecret] = useState<string | null>(null), [revoking, setRevoking] = useState<ApiKey | null>(null);
  function toggle(mailboxId: string, right: Scope["action"], checked: boolean) { setScopes(checked ? [...scopes, { mailbox_id: mailboxId, action: right }] : scopes.filter((scope) => scope.mailbox_id !== mailboxId || scope.action !== right)); }
  return <MailSection title="Mail API keys" description="Keys belong to your account, expire within 366 days and cannot grant permissions you do not hold." action={<Button onClick={() => { setName(""); setExpires(""); setScopes([]); action.setError(""); setOpen(true); }}>Create API key</Button>}>
    <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} /><div className="mail-record-list">{resource.data?.keys.map((key) => <div key={key.id} className="mail-record"><div><strong>{key.name}</strong><p>{key.revoked_at ? "Revoked" : key.expires_at <= Date.now() / 1000 ? "Expired" : "Active"} · Expires {mailDate(key.expires_at)}</p><p className="mail-hint">{resource.data!.scopes.filter((scope) => scope.key_id === key.id).map((scope) => `${mail.boxes.find((box) => box.id === scope.mailbox_id)?.name ?? "Unavailable mailbox"}: ${scopeLabels[scope.action]}`).join(" · ")}</p></div>{!key.revoked_at && <Button size="sm" onClick={() => setRevoking(key)}>Revoke</Button>}</div>)}</div>{resource.data && !resource.data.keys.length && <p className="mail-hint">No API keys created.</p>}
    <MailModal open={open} title="Create mail API key" description="Choose only the mailbox permissions this integration needs." onClose={() => setOpen(false)} busy={action.busy} wide><MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { const timestamp = scheduledTime(expires); if (!timestamp) throw new Error("Choose an expiration time."); if (!scopes.length || scopes.length > 100) throw new Error("Choose between 1 and 100 mailbox scopes."); const result = await api<{ key: { token: string } }>("/api/mail/api-keys", { method: "POST", body: { name, expires_at: timestamp, scopes } }); setSecret(result.key.token); setOpen(false); resource.reload(); }); }}><MailFieldset disabled={action.busy}><div className="mail-form-grid"><MailInput label="Key name" maxLength={100} value={name} required onChange={(event) => setName(event.target.value)} /><MailInput label="Expires at" type="datetime-local" value={expires} required onChange={(event) => setExpires(event.target.value)} /></div>{mail.boxes.map((box) => <fieldset key={box.id} className="mail-key-scope"><legend>{box.name}</legend><div className="mail-check-grid">{(Object.keys(scopeLabels) as Scope["action"][]).map((right) => <Check key={right} disabled={!box.access?.[right]} checked={scopes.some((scope) => scope.mailbox_id === box.id && scope.action === right)} onChange={(checked) => toggle(box.id, right, checked)}>{scopeLabels[right]}</Check>)}</div></fieldset>)}</MailFieldset><MailNotice error={action.error} /><Button variant="primary" type="submit" disabled={action.busy || !scopes.length}>{action.busy ? "Creating…" : "Create key"}</Button></MailForm></MailModal>
    {secret && <Secret title="Your new mail API key" value={secret} onClose={() => setSecret(null)} />}<Confirm open={!!revoking} title="Revoke API key?" description={`“${revoking?.name ?? ""}” will immediately stop authenticating mail requests.`} label="Revoke key" destructive onClose={() => setRevoking(null)} onConfirm={async () => { await api(`/api/mail/api-keys/${revoking!.id}`, { method: "DELETE" }); resource.reload(); }} />
  </MailSection>;
}
interface Webhook { id: string; url: string; enabled: number; created_at: number; }
interface Delivery { id: string; webhook_id: string; status: string; attempt_count: number; created_at: number; updated_at: number; payload_json: string; }
function Webhooks() {
  const [showDeliveries, setShowDeliveries] = useState(false);
  const deliveriesId = useId(), deliveriesTitleId = useId();
  const mail = useMail(), manage = !!mail.box?.access?.manage, path = mailboxPath(mail.box!.id), resource = useMailResource<{ webhooks: Webhook[] }>(manage ? path + "/webhooks" : null), deliveries = useMailResource<{ deliveries: Delivery[] }>(manage && showDeliveries ? path + "/webhooks/deliveries" : null), action = useMailAction();
  const [open, setOpen] = useState(false), [url, setUrl] = useState(""), [secret, setSecret] = useState<string | null>(null), [deleting, setDeleting] = useState<Webhook | null>(null);
  return <MailSection title="Webhooks" description="Receive signed mailbox change notifications at a public HTTPS endpoint." action={manage && <div className="mail-actions">
    <Button variant={showDeliveries ? "subtle" : "secondary"} aria-expanded={showDeliveries} aria-controls={deliveriesId} onClick={() => setShowDeliveries(!showDeliveries)}>Delivery history<Icon name="down" className="mail-webhook-history-chevron" /></Button>
    <Button onClick={() => { setUrl(""); action.setError(""); setOpen(true); }}>Add webhook</Button>
  </div>}>
    {!manage ? <p className="mail-hint">Managing webhooks requires mailbox management permission.</p> : <>
      <MailState loading={resource.loading && !resource.data} error={resource.error} retry={resource.reload} />
      <div className="mail-record-list">{resource.data?.webhooks.map((hook) => <div key={hook.id} className="mail-record"><div><strong>{hook.url}</strong><p>{hook.enabled ? "Enabled" : "Disabled"} · Created {mailDate(hook.created_at)}</p></div>{!!hook.enabled && <Button size="sm" onClick={() => setDeleting(hook)}>Disable</Button>}</div>)}</div>
      {resource.data && !resource.data.webhooks.length && <p className="mail-hint">No webhooks yet. Add one to receive mailbox notifications.</p>}
      <section id={deliveriesId} className="mail-webhook-deliveries" hidden={!showDeliveries} aria-labelledby={deliveriesTitleId}>
        <header><div><h3 id={deliveriesTitleId}>Delivery history</h3><p>Recent delivery attempts for this mailbox.</p></div><Button variant="ghost" size="icon" aria-label="Refresh delivery history" disabled={deliveries.loading} onClick={deliveries.reload}><Icon name="refresh" /></Button></header>
        {(deliveries.error || deliveries.loading && !deliveries.data) && <div className="mail-webhook-delivery-state"><MailState loading={deliveries.loading && !deliveries.data} error={deliveries.error} retry={deliveries.reload} kind="list" /></div>}
        {deliveries.data && (deliveries.data.deliveries.length ? <div className="mail-table-wrap"><table className="mail-table"><thead><tr><th scope="col">Endpoint</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Updated</th></tr></thead><tbody>{[...deliveries.data.deliveries].sort((a, b) => b.updated_at - a.updated_at).map((delivery) => <tr key={delivery.id}>
          <td data-label="Endpoint">{resource.data?.webhooks.find((hook) => hook.id === delivery.webhook_id)?.url ?? delivery.webhook_id}</td>
          <td data-label="Status"><span className="mail-webhook-delivery-status" data-status={delivery.status}><Icon name={delivery.status === "delivered" ? "check" : delivery.status === "failed" ? "close" : "clock"} width="12" height="12" />{({ delivered: "Delivered", pending: "Pending", failed: "Failed" } as Record<string, string>)[delivery.status] ?? delivery.status}</span></td>
          <td data-label="Attempts">{delivery.attempt_count}</td><td data-label="Updated">{mailDate(delivery.updated_at)}</td>
        </tr>)}</tbody></table></div> : <div className="mail-webhook-delivery-empty"><span><Icon name="clock" width="22" height="22" /></span><h4>No deliveries yet</h4><p>Delivery attempts will appear here when this mailbox changes.</p></div>)}
      </section>
    </>}
    <MailModal open={open} title="Add webhook" description="Keep the signing secret to verify incoming notifications." onClose={() => setOpen(false)} busy={action.busy}><MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { const result = await api<{ webhook: { secret: string } }>(path + "/webhooks", { method: "POST", body: { url } }); setSecret(result.webhook.secret); setOpen(false); resource.reload(); }); }}><MailInput label="Endpoint URL" type="url" placeholder="https://example.com/mail-events" required value={url} onChange={(event) => setUrl(event.target.value)} /><MailNotice error={action.error} /><Button type="submit" variant="primary" disabled={action.busy}>Create webhook</Button></MailForm></MailModal>{secret && <Secret title="Webhook signing secret" value={secret} onClose={() => setSecret(null)} />}<Confirm open={!!deleting} title="Disable webhook?" description={deleting?.url} label="Disable webhook" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`${path}/webhooks/${deleting!.id}`, { method: "DELETE" }); resource.reload(); }} />
  </MailSection>;
}
function Jmap() {
  const action = useMailAction(), [session, setSession] = useState<{ accounts: Record<string, { name: string; isReadOnly: boolean }>; capabilities: Record<string, unknown> } | null>(null);
  const origin = window.location.origin;
  const accounts = session ? Object.entries(session.accounts) : [], capabilityCount = session ? Object.keys(session.capabilities).length : 0;
  return <MailSection title="JMAP" description="Use a scoped mail API key as a Bearer token. JMAP supports a subset of methods." action={<Button disabled={action.busy} onClick={() => { void action.run(async () => { setSession(await api<NonNullable<typeof session>>("/api/mail/jmap/session")); }); }}>Check JMAP session</Button>}>
    <div className="mail-protocol-content">
      <div className="mail-protocol-urls">
        <div className="mail-protocol-endpoint"><h3>Session URL</h3><code>{origin}/.well-known/jmap</code></div>
        <div className="mail-protocol-endpoint"><h3>API URL</h3><code>{origin}/api/mail/jmap</code></div>
      </div>
      <MailState loading={action.busy && !session} error={action.error} />
      {session && <div className="mail-protocol-result">
        <header><div><h3>Session details</h3><p>{capabilityCount} {capabilityCount === 1 ? "capability" : "capabilities"} · {accounts.length} {accounts.length === 1 ? "account" : "accounts"}</p></div><span className="mail-protocol-connected" role="status"><Icon name="check" width="12" height="12" />Connected</span></header>
        <table className="mail-protocol-table" aria-label="JMAP session accounts"><thead><tr><th scope="col">Account</th><th scope="col">Access</th></tr></thead><tbody>
          {accounts.map(([id, account]) => <tr key={id}><td>{account.name}</td><td><span className="mail-badge">{account.isReadOnly ? "Read only" : "Writable"}</span></td></tr>)}
          {!accounts.length && <tr><td colSpan={2} className="mail-protocol-empty">No accessible mailboxes.</td></tr>}
        </tbody></table>
      </div>}
    </div>
  </MailSection>;
}
function Mcp() {
  const action = useMailAction(), [tools, setTools] = useState<{ name: string; description: string }[] | null>(null);
  return <MailSection title="MCP" description="Use a scoped mail API key as a Bearer token. Send requests require human review." action={<Button disabled={action.busy} onClick={() => { void action.run(async () => {
    const initialized = await api<{ result?: object; error?: { message: string } }>("/api/mail/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Officeflare UI", version: "1" } } } });
    if (initialized.error) throw new Error(initialized.error.message);
    const result = await api<{ result?: { tools: NonNullable<typeof tools> }; error?: { message: string } }>("/api/mail/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: "tools", method: "tools/list" } });
    if (result.error) throw new Error(result.error.message);
    setTools(result.result?.tools ?? []);
  }); }}>Check MCP tools</Button>}>
    <div className="mail-protocol-content">
      <div className="mail-protocol-endpoint"><h3>HTTP endpoint</h3><code>{window.location.origin}/mcp</code></div>
      <p className="mail-hint">Tools can list mailboxes, search and read messages, create drafts and request a send for human review.</p>
      <MailState loading={action.busy && !tools} error={action.error} />
      {tools && <ul className="mail-protocol-tools">{tools.map((tool) => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}</ul>}
    </div>
  </MailSection>;
}

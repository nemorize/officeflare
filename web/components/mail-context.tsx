import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { mailboxPath, type Mailbox, type Capabilities, type Folder } from "../lib/mail";
import { useAccess } from "./console-access";
import { Button, Icon } from "./ui";
import { MailField, MailInput, MailModal, MailNotice, useMailAction, useMailResource, MailSelect, MailForm } from "./mail-common";
import { MailComposer } from "./mail-composer";
import { Confirm } from "./console-shared";
import "../routes/mail.css";
interface MailContextValue {
  boxes: Mailbox[]; box: Mailbox | null; folders: Folder[]; capabilities: Capabilities | null;
  loading: boolean; error: string; revision: number; realtime: string;
  selectBox: (id: string) => void; href: (path: string) => string; refresh: () => void;
  refreshBoxes: () => void; compose: (id?: string) => void;
}
const MailContext = createContext<MailContextValue | null>(null);
export function useMail() { const context = useContext(MailContext); if (!context) throw new Error("Mail context is unavailable"); return context; }
export function MailProvider({ children }: { children: ReactNode }) {
  const { permissions } = useAccess(), location = useLocation(), [params, setParams] = useSearchParams();
  const [composer, setComposer] = useState<{ box: string; id?: string } | null>(null);
  const enabled = permissions.includes("mail.access") && (location.pathname === "/mail" || location.pathname.startsWith("/mail/") || !!composer);
  const boxes = useMailResource<{ mailboxes: Mailbox[] }>(enabled ? "/api/mail/mailboxes" : null);
  const caps = useMailResource<Capabilities>(enabled ? "/api/mail/capabilities" : null);
  const requested = params.get("mailbox"), box = boxes.data?.mailboxes.find((entry) => entry.id === requested) ?? (!requested ? boxes.data?.mailboxes[0] : null) ?? null;
  const [revision, setRevision] = useState(0), [realtime, setRealtime] = useState("Connecting");
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const folders = useMailResource<{ folders: Folder[] }>(box?.access?.read ? mailboxPath(box.id) + "/folders" : null, revision);
  useEffect(() => {
    if (!enabled) setComposer(null);
  }, [enabled]);
  useEffect(() => { const refreshAccess = () => boxes.reload(); window.addEventListener("officeflare:mail-access-changed", refreshAccess); return () => window.removeEventListener("officeflare:mail-access-changed", refreshAccess); }, [boxes.reload]);
  useEffect(() => {
    if (!box?.access?.read || !caps.data?.features.realtime) { setRealtime("Offline"); return; }
    let stopped = false, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout>, heartbeat: ReturnType<typeof setInterval>, attempt = 0;
    const controller = new AbortController();
    const connect = async () => {
      if (stopped || document.hidden) return;
      setRealtime("Connecting");
      try {
        const result = await api<{ ticket: string }>(mailboxPath(box.id) + "/events/ticket", { method: "POST", signal: controller.signal });
        if (stopped || document.hidden) return;
        const url = new URL(mailboxPath(box.id) + "/events/ws", window.location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("ticket", result.ticket);
        socket = new WebSocket(url); socket.onopen = () => { attempt = 0; setRealtime("Live"); refresh(); heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send("ping"); }, 30_000); };
        socket.onmessage = (event) => { try { if (JSON.parse(String(event.data)).message_id) refresh(); } catch { /* Ignore non-event heartbeat messages. */ } };
        socket.onclose = (event) => { clearInterval(heartbeat); socket = null; setRealtime("Offline"); if (!stopped && !document.hidden && event.code !== 1008) timer = setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** attempt++)); if (event.code === 1008) boxes.reload(); };
        socket.onerror = () => socket?.close();
      } catch { setRealtime("Offline"); if (!stopped && !document.hidden) timer = setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** attempt++)); }
    };
    const visibility = () => { clearTimeout(timer); if (document.hidden) { socket?.close(); clearInterval(heartbeat); } else { refresh(); if (!socket) void connect(); } };
    document.addEventListener("visibilitychange", visibility); void connect();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); clearInterval(heartbeat); socket?.close(); document.removeEventListener("visibilitychange", visibility); };
  }, [box?.id, box?.access?.read, caps.data?.features.realtime, refresh, boxes.reload]);
  const value: MailContextValue = {
    boxes: boxes.data?.mailboxes ?? [], box, folders: folders.data?.folders ?? [], capabilities: caps.data,
    loading: boxes.loading || caps.loading || folders.loading, error: boxes.error || caps.error || folders.error || (requested && boxes.data && !box ? "This mailbox is unavailable. Choose another mailbox." : ""), revision, realtime,
    selectBox: (id) => { const next = new URLSearchParams(params); next.set("mailbox", id); next.delete("message"); next.delete("q"); setParams(next); },
    href: (path) => `${path}${box ? `?mailbox=${encodeURIComponent(box.id)}` : ""}`, refresh, refreshBoxes: boxes.reload,
    compose: (id) => { if (box) setComposer({ box: box.id, id }); },
  };
  return <MailContext value={value}>{children}{composer && <MailComposer key={`${composer.box}:${composer.id ?? "new"}`} mailboxId={composer.box} draftId={composer.id} onClose={() => setComposer(null)} />}</MailContext>;
}
const links = [
  ["/mail", "Inbox", "inbox"], ["/mail/starred", "Starred", "star"], ["/mail/drafts", "Drafts", "file"], ["/mail/sent", "Sent", "arrow"], ["/mail/snoozed", "Snoozed", "circle"], ["/mail/archive", "Archive", "archive"], ["/mail/spam", "Spam", "shield"], ["/mail/trash", "Trash", "trash"],
] as const;
const settingsLinks = [["rules", "Rules & blocked senders", "controls"], ["settings", "Mailbox settings", "settings"], ["integrations", "Integrations", "code"], ["data", "Import & backup", "drive"], ["activity", "Activity & storage", "layers"]] as const;
export function MailSidebar({ mobile = false }: { mobile?: boolean }) {
  const mail = useMail();
  return <div className={mobile ? "mail-mobile-nav" : "mail-sidebar-content"}>
    <MailField className="mail-box-picker" label="Mailbox"><MailSelect aria-label="Select mailbox" value={mail.box?.id ?? ""} onValueChange={(nextValue) => mail.selectBox(nextValue)} disabled={!mail.boxes.length} options={[{ value: "", label: mail.loading ? "Loading…" : "No mailboxes", disabled: true }, ...mail.boxes.map((box) => ({ value: box.id, label: `${box.name}${box.kind === "shared" ? " · Shared" : ""}` }))]} /></MailField>
    <Button className="mail-compose-button" variant="primary" disabled={!mail.box?.access?.read || !mail.box?.access?.write} onClick={() => mail.compose()}><Icon name="plus" />Compose</Button>
    <nav className="workspace-nav" aria-label={mobile ? "Mail mobile navigation" : "Mail navigation"}>
      {links.map(([path, name, icon]) => <NavLink end key={path} to={mail.href(path)}><Icon name={icon} /><span>{name}</span></NavLink>)}
      {<><h2 className="mail-nav-label">Folders</h2>{mail.folders.filter((folder) => !folder.system_key).map((folder) => <NavLink key={folder.id} to={mail.href(`/mail/folders/${encodeURIComponent(folder.id)}`)}><Icon name="folder" /><span>{folder.name}</span></NavLink>)}{mail.box?.access?.write && <FolderManager />}</>}
      <h2 className="mail-nav-label">Manage</h2>{settingsLinks.map(([path, name, icon]) => <NavLink key={path} to={mail.href(`/mail/${path}`)}><Icon name={icon} /><span>{name}</span></NavLink>)}
    </nav><span className="mail-connection" role="status"><i data-live={mail.realtime === "Live"} />{mail.realtime === "Live" ? "Updates connected" : mail.realtime === "Connecting" ? "Connecting updates…" : "Refresh to check for updates"}</span>
  </div>;
}
function FolderManager() {
  const mail = useMail(), action = useMailAction(), [open, setOpen] = useState(false), [name, setName] = useState(""), [editing, setEditing] = useState<Folder | null>(null), [deleting, setDeleting] = useState<Folder | null>(null);
  const path = mail.box ? mailboxPath(mail.box.id) + "/folders" : "";
  return <><Button variant="ghost" size="sm" onClick={() => { setOpen(true); action.setError(""); }}>Manage folders</Button>
    <MailModal open={open} title="Mailbox folders" description="Folders are shared by everyone with access to this mailbox." busy={action.busy} onClose={() => setOpen(false)}>
      <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api(path + (editing ? `/${editing.id}` : ""), { method: editing ? "PATCH" : "POST", body: { name, ...(editing ? { version: editing.version } : {}) } }); setName(""); setEditing(null); mail.refresh(); }); }}>
        <MailInput label={editing ? "Rename folder" : "New folder"} value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /><div className="mail-actions"><Button type="submit" variant="primary" disabled={action.busy}>{editing ? "Save name" : "Add folder"}</Button>{editing && <Button onClick={() => { setEditing(null); setName(""); }}>Cancel edit</Button>}</div>
      </MailForm><MailNotice error={action.error} /><div className="mail-record-list">{mail.folders.filter((folder) => !folder.system_key).map((folder) => <div className="mail-record" key={folder.id}><strong>{folder.name}</strong><div className="mail-actions"><Button size="sm" onClick={() => { setEditing(folder); setName(folder.name); }}>Rename</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(folder)}>Delete</Button></div></div>)}</div>
    </MailModal><Confirm open={!!deleting} title="Delete folder?" description="Only empty custom folders can be deleted. Move the messages first." label="Delete folder" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`${path}/${deleting!.id}?version=${deleting!.version}`, { method: "DELETE" }); mail.refresh(); }} />
  </>;
}

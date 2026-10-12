import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { mailboxPath, type Mailbox, type Capabilities, type Folder, type MailPreferences, type MailSummary } from "../lib/mail";
import { useAccess } from "./console-access";
import { Snackbar, Button, Icon } from "./ui";
import { MailField, MailInput, MailModal, MailNotice, useMailAction, useMailResource, MailSelect, MailForm } from "./mail-common";
import { MailComposer } from "./mail-composer";
import { useAccount } from "./account-context";
import { Confirm } from "./console-shared";
import "../routes/mail.css";
interface MailContextValue {
  boxes: Mailbox[]; box: Mailbox | null; folders: Folder[]; capabilities: Capabilities | null;
  composing: boolean; activeDraftId: string | null; loading: boolean; error: string; revision: number; realtime: string; summary: MailSummary | null; preferences: MailPreferences;
  setPreferences: (changes: Partial<MailPreferences>) => Promise<void>; mobileMenu: boolean; setMobileMenu: (value: boolean) => void;
  feedback: (text: string, action?: () => Promise<void>, label?: string, timeout?: number) => void;
  selectBox: (id: string) => void; href: (path: string) => string; refresh: (target?: "messages" | "folders" | "summary") => void;
  refreshBoxes: () => void; compose: (id?: string, inline?: boolean) => void;
}
const MailContext = createContext<MailContextValue | null>(null);
export function useMail() { const context = useContext(MailContext); if (!context) throw new Error("Mail context is unavailable"); return context; }
export function MailProvider({ children }: { children: ReactNode }) {
  const { permissions } = useAccess(), location = useLocation(), navigate = useNavigate(), [params, setParams] = useSearchParams();
  const { user } = useAccount();
  const [composer, setComposer] = useState<{ box: string; id?: string; inline?: boolean } | null>(null);
  const composerRef = useRef(composer); composerRef.current = composer;
  const [mobileMenu, setMobileMenu] = useState(false), [preferences, setPreferencesState] = useState<MailPreferences>({ density: "comfortable", conversation_view: true, reading_pane: "none", shortcuts: false, undo_seconds: 10, sidebar_collapsed: false });
  const [notice, setNotice] = useState<{ text: string; action?: () => Promise<void>; label: string; expires: number } | null>(null), [noticeBusy,setNoticeBusy] = useState(false);
  const feedback = useCallback((text: string, action?: () => Promise<void>, label = "Undo", timeout = 8000) => setNotice({ text, action, label, expires: Date.now() + timeout }), []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null),Math.max(0,notice.expires-Date.now())); return () => clearTimeout(timer); },[notice]);

  const enabled = permissions.includes("mail.access") && (location.pathname === "/mail" || location.pathname.startsWith("/mail/") || !!composer);
  const boxes = useMailResource<{ mailboxes: Mailbox[] }>(enabled ? "/api/mail/mailboxes" : null);
  const caps = useMailResource<Capabilities>(enabled ? "/api/mail/capabilities" : null);
  const requested = params.get("mailbox"), boxesList = boxes.data?.mailboxes ?? [], box = boxesList.find((entry) => entry.id === requested) ?? (boxesList.length === 1 ? boxesList[0] : !requested ? boxesList.find((entry) => entry.kind === "personal" && entry.owner_user_id === user?.id) ?? boxesList[0] : null) ?? null;
  const prefs = useMailResource<{ preferences: MailPreferences }>(enabled ? "/api/mail/preferences" : null);
  useEffect(() => { if (prefs.data) setPreferencesState(prefs.data.preferences); },[prefs.data]);
  const setPreferences = async (changes: Partial<MailPreferences>) => {
    setPreferencesState((old) => ({ ...old,...changes }));
    try { await api("/api/mail/preferences", { method: "PATCH", body: changes }); }
    catch (failure) { prefs.reload(); feedback(failure instanceof Error ? failure.message : "Settings could not be saved."); }
  };

  const [revision, setRevision] = useState(0), [realtime, setRealtime] = useState("Connecting");
  const [folderRevision, setFolderRevision] = useState(0), [summaryRevision,setSummaryRevision] = useState(0);
  const refresh = useCallback((target: "messages" | "folders" | "summary" = "messages") => { if (target === "messages") setRevision((value) => value + 1); if (target === "folders") setFolderRevision((value) => value + 1); setSummaryRevision((value) => value + 1); }, []);
  const summary = useMailResource<{ summary: MailSummary }>(box?.access?.read ? mailboxPath(box.id) + "/summary" : null,summaryRevision);

  const folders = useMailResource<{ folders: Folder[] }>(box?.access?.read ? mailboxPath(box.id) + "/folders" : null, folderRevision);
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
    boxes: boxes.data?.mailboxes ?? [], box, folders: (folders.data?.folders ?? []).map((folder) => ({ ...folder, name: folder.system_key ? {inbox:"Inbox",sent:"Sent",drafts:"Drafts",archive:"Archive",spam:"Spam",trash:"Trash"}[folder.system_key] ?? folder.name : folder.name })), capabilities: caps.data,
    composing: !!composer, activeDraftId: composer?.id ?? null, loading: boxes.loading || caps.loading || folders.loading, error: boxes.error || caps.error || folders.error || (requested && boxes.data && !box ? "This mailbox is unavailable. Choose another mailbox." : ""), revision, realtime, summary: summary.data?.summary ?? null, preferences, setPreferences, mobileMenu, setMobileMenu, feedback,
    selectBox: (id) => { const next = new URLSearchParams(params); next.set("mailbox", id); next.delete("message"); next.delete("q"); if (location.pathname.startsWith("/mail/folders/")) navigate(`/mail?${next}`); else setParams(next); },
    href: (path) => `${path}${box ? `?mailbox=${encodeURIComponent(box.id)}` : ""}`, refresh, refreshBoxes: boxes.reload,
    compose: (id,inline) => { if (!box) return; if (composerRef.current && (composerRef.current.id !== id || composerRef.current.box !== box.id)) { feedback("Close your current draft before opening another."); return; } if (composerRef.current) window.dispatchEvent(new Event("officeflare:focus-composer")); else { composerRef.current = { box: box.id, id, inline }; setComposer(composerRef.current); } },
  };
  return <MailContext value={value}>{children}{composer && <MailComposer key={`${composer.box}:${composer.id ?? "new"}`} mailboxId={composer.box} draftId={composer.id} inline={composer.inline} onClose={() => { composerRef.current = null; setComposer(null); refresh(); }} />}{notice && <Snackbar className="mail-snackbar"><span>{notice.text}</span>{notice.action && <Button variant="inverse" size="sm" disabled={noticeBusy} onClick={async () => { setNoticeBusy(true); try { await notice.action!(); setNotice(null); } catch (error) { feedback(error instanceof Error ? error.message : "Unable to undo this action."); } finally { setNoticeBusy(false); } }}>{noticeBusy ? "Working…" : notice.label}</Button>}<Button variant="inverse" size="icon" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close" /></Button></Snackbar>}</MailContext>;
}
const links = [
  ["/mail", "Inbox", "inbox"], ["/mail/starred", "Starred", "star"], ["/mail/snoozed", "Snoozed", "clock"], ["/mail/sent", "Sent", "arrow"], ["/mail/drafts", "Drafts", "file"], ["/mail/archive", "Archive", "archive"], ["/mail/spam", "Spam", "shield"], ["/mail/trash", "Trash", "trash"],
] as const;
export function MailSidebar() {
  const mail = useMail(), location = useLocation(), extraId = useId(), custom = mail.folders.filter((folder) => !folder.system_key);
  const extra = [["/mail/all","All mail","mail"],["/mail/scheduled","Scheduled","clock"],["/mail/archive","Archive","archive"],["/mail/spam","Spam","shield"],["/mail/trash","Trash","trash"]] as const;
  const extraActive = extra.some(([path]) => path === location.pathname);
  const [more, setMore] = useState(extraActive);
  useEffect(() => { if (extraActive) setMore(true); }, [extraActive, location.pathname]);
  const primary = links.filter(([path]) => !["/mail/archive","/mail/spam","/mail/trash"].includes(path));
  const count = (path: string) => path === "/mail/drafts" ? mail.summary?.folders.drafts?.total : path === "/mail/scheduled" ? mail.summary?.scheduled : path === "/mail/snoozed" ? mail.summary?.snoozed : mail.summary?.folders[path === "/mail" ? "inbox" : path.split("/").at(-1)!]?.unread;
  const nav = (items: readonly (readonly [string,string,import("./ui").IconProps["name"]])[]) => items.map(([path,name,icon]) => <NavLink end key={path} to={mail.href(path)} onClick={() => mail.setMobileMenu(false)}><Icon name={icon}/><span>{name}</span>{!!count(path) && <small aria-label={`${count(path)} ${path === "/mail/drafts" ? "drafts" : "messages"}`}>{count(path)}</small>}</NavLink>);
  return <div className="mail-sidebar-content">
    <div className="mail-sidebar-actions">
      {mail.boxes.length > 1 && <MailField className="mail-box-picker" label="Mailbox">
        <MailSelect aria-label="Select mailbox" value={mail.box?.id ?? ""} onValueChange={mail.selectBox} options={[...(!mail.box ? [{ value:"", label:"Choose a mailbox" }] : []), ...mail.boxes.map((box) => ({ value:box.id,label:box.name }))]}/>
      </MailField>}
      <Button className="mail-compose-button" variant="primary" size="touch" disabled={!mail.box?.access?.read || !mail.box?.access?.write} onClick={() => { mail.compose(); mail.setMobileMenu(false); }}><Icon name="plus"/>Compose</Button>
    </div>
    <nav className="workspace-nav" aria-label="Mail navigation">
      <div className="mail-nav-group">
        {nav(primary)}
        <Button variant="ghost" className="mail-more-link" aria-expanded={more} aria-controls={extraId} onClick={() => setMore(!more)}><Icon name="down" style={{ transform:more ? "rotate(180deg)" : undefined }}/><span>{more ? "Less" : "More"}</span></Button>
      </div>
      <div id={extraId} className="mail-nav-group" hidden={!more}>{nav(extra)}</div>
      <div className="mail-nav-group mail-custom-folders">
        <div className="mail-folder-heading"><h2>Folders</h2>{mail.box?.access?.write && <FolderManager/>}</div>
        {custom.map((folder) => <NavLink key={folder.id} to={mail.href(`/mail/folders/${encodeURIComponent(folder.id)}`)} onClick={() => mail.setMobileMenu(false)}><Icon name="folder"/><span title={folder.name}>{folder.name}</span>{!!mail.summary?.folders[folder.id]?.unread && <small>{mail.summary?.folders[folder.id]?.unread}</small>}</NavLink>)}
        {!mail.loading && !custom.length && <p className="mail-folder-empty">{mail.box?.access?.write ? "Create folders to organize mail." : "No custom folders."}</p>}
      </div>
    </nav>
    <div className="mail-sidebar-bottom"><NavLink className="workspace-nav-item" to={mail.href("/mail/settings")} onClick={() => mail.setMobileMenu(false)}><Icon name="settings"/><span>Mail settings</span></NavLink><span className="mail-connection"><i data-live={mail.realtime === "Live"}/>{mail.realtime === "Live" ? "Up to date" : "Checking for updates"}</span></div>
  </div>;
}
export function FolderManager() {
  const mail = useMail(), action = useMailAction(), [open, setOpen] = useState(false), [name, setName] = useState(""), [editing, setEditing] = useState<Folder | null>(null), [deleting, setDeleting] = useState<Folder | null>(null);
  const path = mail.box ? mailboxPath(mail.box.id) + "/folders" : "";
  return <><Button variant="ghost" size="icon" aria-label="Manage folders" onClick={() => { setOpen(true); action.setError(""); }}><Icon name="plus" /></Button>
    <MailModal open={open} title="Mailbox folders" description="Folders are shared by everyone with access to this mailbox." busy={action.busy} onClose={() => setOpen(false)}>
      <MailForm className="mail-form" onSubmit={(event) => { event.preventDefault(); void action.run(async () => { await api(path + (editing ? `/${editing.id}` : ""), { method: editing ? "PATCH" : "POST", body: { name, ...(editing ? { version: editing.version } : {}) } }); setName(""); setEditing(null); mail.refresh("folders"); }); }}>
        <MailInput label={editing ? "Rename folder" : "New folder"} value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /><div className="mail-actions"><Button type="submit" variant="primary" disabled={action.busy}>{editing ? "Save name" : "Add folder"}</Button>{editing && <Button onClick={() => { setEditing(null); setName(""); }}>Cancel edit</Button>}</div>
      </MailForm><MailNotice error={action.error} /><div className="mail-record-list">{mail.folders.filter((folder) => !folder.system_key).map((folder) => <div className="mail-record" key={folder.id}><strong>{folder.name}</strong><div className="mail-actions"><Button size="sm" onClick={() => { setEditing(folder); setName(folder.name); }}>Rename</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(folder)}>Delete</Button></div></div>)}</div>
    </MailModal><Confirm open={!!deleting} title="Delete folder?" description="Only empty custom folders can be deleted. Move the messages first." label="Delete folder" destructive onClose={() => setDeleting(null)} onConfirm={async () => { await api(`${path}/${deleting!.id}?version=${deleting!.version}`, { method: "DELETE" }); mail.refresh("folders"); }} />
  </>;
}

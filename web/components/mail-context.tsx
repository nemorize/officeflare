import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { mailboxPath, type Mailbox, type Capabilities, type Folder, type MailPreferences, type MailSummary, type Message } from "../lib/mail";
import { useAccess } from "./console-access";
import { Snackbar, Button, Icon } from "./ui";
import { MailField, MailInput, MailModal, MailNotice, useMailAction, useMailResource, MailSelect, MailForm } from "./mail-common";
import { MailComposer } from "./mail-composer";
import { useMailCache } from "./mail-resource-context";
import { applyMailHeaders, MailChangeScheduler, mergeMailView, type MailBootstrap, type MailDelta, type MailCommandResult } from "../lib/mail-ui";
import { applyReadReceipt } from "../lib/mail-resource-data";
import { Confirm } from "./console-shared";
import "../routes/mail.css";
interface MailContextValue {
  boxes: Mailbox[]; box: Mailbox | null; folders: Folder[]; capabilities: Capabilities | null;
  composing: boolean; activeDraftId: string | null; loading: boolean; error: string; revision: number; preferences: MailPreferences;
  setPreferences: (changes: Partial<MailPreferences>) => Promise<void>;
  feedback: (text: string, action?: () => Promise<void>, label?: string, timeout?: number) => void;
  selectBox: (id: string) => void; href: (path: string) => string; refresh: (target?: "messages" | "folders" | "summary") => void;
  recordRead: (message: Message, version: number) => void;
  committed: (result: MailCommandResult) => void;
  refreshBoxes: () => void; compose: (id?: string, inline?: boolean) => void;
}
const SummaryContext = createContext<MailSummary | null>(null);
const MenuContext = createContext<{ mobileMenu: boolean; setMobileMenu: (value: boolean) => void } | null>(null);
export const useMailSummary = () => useContext(SummaryContext);
export const useMailMenu = () => useContext(MenuContext)!;
const MailContext = createContext<MailContextValue | null>(null);
export function useMail() { const context = useContext(MailContext); if (!context) throw new Error("Mail context is unavailable"); return context; }
export function MailProvider({ children }: { children: ReactNode }) {
  const { permissions } = useAccess(), location = useLocation(), navigate = useNavigate(), [params, setParams] = useSearchParams();
  const cache = useMailCache();
  const [composer, setComposer] = useState<{ box: string; id?: string; inline?: boolean } | null>(null);
  const composerRef = useRef(composer); composerRef.current = composer;
  const [mobileMenu, setMobileMenu] = useState(false);
  const defaults: MailPreferences = { density: "comfortable", conversation_view: true, reading_pane: "none", shortcuts: false, undo_seconds: 10, sidebar_collapsed: false };
  const [notice, setNotice] = useState<{ text: string; action?: () => Promise<void>; label: string; expires: number } | null>(null), [noticeBusy,setNoticeBusy] = useState(false);
  const feedback = useCallback((text: string, action?: () => Promise<void>, label = "Undo", timeout = 8000) => setNotice({ text, action, label, expires: Date.now() + timeout }), []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null),Math.max(0,notice.expires-Date.now())); return () => clearTimeout(timer); },[notice]);

  const enabled = permissions.includes("mail.access") && (location.pathname === "/mail" || location.pathname.startsWith("/mail/") || !!composer);
  const route = useRef({ location, params }); route.current = { location, params };
  const requested = params.get("mailbox");
  const bootstrapPath = useMemo(() => {
    const { location, params } = route.current;
    const section = location.pathname.startsWith("/mail/folders/") ? "folder" : location.pathname.split("/")[2] ?? "inbox";
    const options = new URLSearchParams({ section: ["inbox", "sent", "archive", "spam", "trash", "drafts", "starred", "snoozed", "all", "scheduled", "folder"].includes(section) ? section : "inbox" });
    if (section === "folder") options.set("folder", decodeURIComponent(location.pathname.split("/")[3]!));
    if (requested) options.set("mailbox", requested);
    if (params.get("q")) options.set("q", params.get("q")!);
    return enabled ? "/api/mail/ui/bootstrap?" + options : null;
  }, [enabled, requested, cache]);
  const bootstrap = useMailResource<MailBootstrap>(bootstrapPath);
  const bootstrapped = enabled && !!bootstrap.data;
  const boxes = useMailResource<{ mailboxes: Mailbox[] }>(bootstrapped ? "/api/mail/mailboxes" : null);
  const caps = useMailResource<Capabilities>(bootstrapped ? "/api/mail/capabilities" : null);
  const boxesList = boxes.data?.mailboxes ?? [], box = boxesList.find(entry => entry.id === (requested ?? bootstrap.data?.mailbox_id)) ?? null;
  const activeMailboxPath = useRef<string | null>(null); activeMailboxPath.current = box ? mailboxPath(box.id) : null;
  const prefs = useMailResource<{ preferences: MailPreferences }>(bootstrapped ? "/api/mail/preferences" : null);
  const preferences = prefs.data?.preferences ?? defaults;
  const setPreferences = useCallback(async (changes: Partial<MailPreferences>) => {
    cache.replace("/api/mail/preferences", { preferences: { ...preferences, ...changes } });
    try { const result = await api<{ preferences: MailPreferences }>("/api/mail/preferences", { method: "PATCH", body: changes }); cache.replace("/api/mail/preferences", result); }
    catch (failure) { prefs.reload(); feedback(failure instanceof Error ? failure.message : "Settings could not be saved."); }
  }, [cache, preferences, prefs.reload, feedback]);

  const [revision, setRevision] = useState(0);
  const [folderRevision, setFolderRevision] = useState(0), [summaryRevision,setSummaryRevision] = useState(0);
  const refresh = useCallback((target: "messages" | "folders" | "summary" = "messages") => {
    const path = activeMailboxPath.current;
    if (path) cache.invalidateInactive(key => key === path + "/summary" || target === "folders" && key === path + "/folders" || target === "messages" && key.startsWith(path + "/") && !/\/(?:render|attachments)(?:\/|\?)/.test(key) && /\/(?:messages|threads|drafts|submissions|storage|audit-logs|jobs|ui)(?:\/|\?|$)/.test(key.slice(path.length)));
    if (target === "messages") setRevision(value => value + 1);
    if (target === "folders") setFolderRevision(value => value + 1);
    setSummaryRevision(value => value + 1);
  }, [cache]);
  const summary = useMailResource<{ summary: MailSummary }>(box?.access?.read ? mailboxPath(box.id) + "/summary" : null,summaryRevision);

  const folders = useMailResource<{ folders: Folder[] }>(box?.access?.read ? mailboxPath(box.id) + "/folders" : null, folderRevision);
  const committed = useCallback((result: MailCommandResult) => {
    const path = result.mailbox_id ? mailboxPath(result.mailbox_id) : activeMailboxPath.current; if (!path) return;
    const messages = result.results.flatMap(item => item.success ? [item.message] : []);
    cache.rememberMessages(path, messages);
    cache.update(key => key.startsWith(path + "/") && /\/(?:messages|threads|ui\/conversation|ui\/view)/.test(key), data => applyMailHeaders(data, messages));
    cache.replace(path + "/summary", { summary: result.summary });
    cache.invalidateInactive(key => key.startsWith(path + "/ui/view?") || key.startsWith(path + "/messages?") || key.startsWith(path + "/threads?"));
  }, [cache]);
  useEffect(() => {
    if (!enabled) setComposer(null);
  }, [enabled]);
  useEffect(() => { const refreshAccess = () => boxes.reload(); window.addEventListener("officeflare:mail-access-changed", refreshAccess); return () => window.removeEventListener("officeflare:mail-access-changed", refreshAccess); }, [boxes.reload]);
  useEffect(() => {
    if (!box?.access?.read || !caps.data?.features.realtime) return;
    let stopped = false, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout>, heartbeat: ReturnType<typeof setInterval>, attempt = 0;
    const controller = new AbortController();
    let cursor = (cache.snapshot(mailboxPath(box.id) + "/ui/watermark").data as { cursor?: number } | null)?.cursor;
    let forceCatchUp = true, signals = new Map<string, number | undefined>();
    const scheduler = new MailChangeScheduler(async () => {
      await cache.whenSettled(); if (stopped) return;
      const generation = cache.mutationGeneration();
      const path = mailboxPath(box.id);
      if (!forceCatchUp && [...signals].every(([id, version]) => version !== undefined && cache.knownVersion(path, id) >= version)) { signals.clear(); return; }
      forceCatchUp = false; signals.clear();
      const views = cache.paths(path + "/ui/view?", true);
      const primary = views[0], scope = primary?.split("?")[1] ?? "";
      const delta = await api<MailDelta>(path + "/ui/changes?" + new URLSearchParams({ ...(cursor !== undefined ? { since: String(cursor) } : {}), scope }), { signal: controller.signal });
      if (stopped) return;
      if (cache.mutationGeneration() !== generation) { forceCatchUp = true; scheduler.request(); return; }
      if (delta.reset || cursor === undefined) refresh();
      else if (delta.summary) {
        cache.rememberMessages(path, delta.messages);
        cache.replace(path + "/summary", { summary: delta.summary });
        const bodyChanged = new Set(delta.messages.filter(next => {
          const previous = (cache.snapshot(path + "/messages/" + next.id).data as { message?: Message } | null)?.message;
          return previous?.body_revision && next.body_revision && previous.body_revision !== next.body_revision;
        }).map(message => message.id));
        cache.invalidate(key => key.startsWith(path + "/messages/") && bodyChanged.has(key.slice((path + "/messages/").length)) || key.startsWith(path + "/ui/conversation/") && bodyChanged.has(key.slice((path + "/ui/conversation/").length).split("?")[0]!));
        cache.update(key => key.startsWith(path + "/messages/") || key.startsWith(path + "/ui/conversation/") || key.startsWith(path + "/threads/"), data => applyMailHeaders(data, delta.messages, delta.removed));
        if (primary) cache.update(key => key === primary, data => mergeMailView(data, delta, new URLSearchParams(scope).get("grouped") === "true", !!new URLSearchParams(scope).get("cursor")));
        if (views.length > 1) cache.invalidate(key => views.slice(1).includes(key));
        const affected = new Set(delta.messages.map(message => message.id)), deleted = new Set(delta.removed);
        cache.invalidateInactive(key => key.startsWith(path + "/") && !/\/(?:render|attachments)(?:\/|\?)/.test(key) && (/\/(?:ui\/view|messages|threads|drafts)(?:\/|\?)/.test(key.slice(path.length))));
        // Bodies and draft content require a fresh read, whereas flag-only receipts do not.
        cache.invalidate(key => key.startsWith(path + "/drafts/") && affected.has(key.slice((path + "/drafts/").length)) || key.startsWith(path + "/messages/") && deleted.has(key.slice((path + "/messages/").length)) || key.startsWith(path + "/ui/conversation/") && deleted.has(key.slice((path + "/ui/conversation/").length).split("?")[0]!));
      }
      cursor = delta.cursor;
      cache.replace(path + "/ui/watermark", { cursor });
    }, error => { if (!stopped) { if (error instanceof ApiError && error.status === 403) { cache.denyMailbox(mailboxPath(box.id), error); boxes.reload(); } else refresh(); } });

    const connect = async () => {
      if (stopped || document.hidden) return;
      try {
        const result = await api<{ ticket: string }>(mailboxPath(box.id) + "/events/ticket", { method: "POST", signal: controller.signal });
        if (stopped || document.hidden) return;
        const url = new URL(mailboxPath(box.id) + "/events/ws", window.location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("ticket", result.ticket);
        socket = new WebSocket(url); socket.onopen = () => { attempt = 0; forceCatchUp = true; scheduler.request(true); heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send("ping"); }, 30_000); };
        socket.onmessage = (event) => { try { const change = JSON.parse(String(event.data)); if (change.message_id && (change.version === undefined || cache.knownVersion(mailboxPath(box.id), change.message_id) < change.version)) { signals.set(change.message_id, signals.has(change.message_id) ? signals.get(change.message_id) === undefined || change.version === undefined ? undefined : Math.max(signals.get(change.message_id)!, change.version) : change.version); scheduler.request(); } } catch { /* Ignore non-event heartbeat messages. */ } };
        socket.onclose = (event) => { clearInterval(heartbeat); socket = null; if (!stopped && !document.hidden && event.code !== 1008) timer = setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** attempt++)); if (event.code === 1008) boxes.reload(); };
        socket.onerror = () => socket?.close();
      } catch { if (!stopped && !document.hidden) timer = setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** attempt++)); }
    };
    const visibility = () => { clearTimeout(timer); if (document.hidden) { socket?.close(); clearInterval(heartbeat); } else { forceCatchUp = true; scheduler.request(true); if (!socket) void connect(); } };
    document.addEventListener("visibilitychange", visibility); void connect();
    return () => { stopped = true; scheduler.stop(); controller.abort(); clearTimeout(timer); clearInterval(heartbeat); socket?.close(); document.removeEventListener("visibilitychange", visibility); };
  }, [box?.id, box?.access?.read, caps.data?.features.realtime, refresh, boxes.reload, cache]);
  const recordRead = useCallback((message: Message, version: number) => {
      const path = activeMailboxPath.current; if (!path) return;
      cache.update(key => key === path + "/messages/" + message.id || key.startsWith(path + "/threads/" + message.thread_id + "?"), data => applyReadReceipt(data, message.id, version));
      cache.update(key => key.startsWith(path + "/ui/view?"), data => applyReadReceipt(data, message.id, version));
  }, [cache]);

  const displayFolders = useMemo(() => (folders.data?.folders ?? []).map(folder => ({ ...folder, name: folder.system_key ? { inbox: "Inbox", sent: "Sent", drafts: "Drafts", archive: "Archive", spam: "Spam", trash: "Trash" }[folder.system_key] ?? folder.name : folder.name })), [folders.data]);
  const value = useMemo<MailContextValue>(() => ({
    boxes: boxes.data?.mailboxes ?? [], box, folders: displayFolders, capabilities: caps.data,
    composing: !!composer, activeDraftId: composer?.id ?? null, loading: bootstrap.loading && !bootstrap.data || boxes.loading || caps.loading || folders.loading, error: bootstrap.error || boxes.error || caps.error || folders.error || (requested && boxes.data && !box ? "This mailbox is unavailable. Choose another mailbox." : ""), revision, preferences, setPreferences, feedback, recordRead, committed,
    selectBox: (id) => { const next = new URLSearchParams(route.current.params); next.set("mailbox", id); next.delete("message"); next.delete("q"); if (route.current.location.pathname.startsWith("/mail/folders/")) navigate(`/mail?${next}`); else setParams(next); },
    href: (path) => `${path}${box ? `?mailbox=${encodeURIComponent(box.id)}` : ""}`, refresh, refreshBoxes: boxes.reload,
    compose: (id,inline) => { if (!box) return; if (composerRef.current && (composerRef.current.id !== id || composerRef.current.box !== box.id)) { feedback("Close your current draft before opening another."); return; } if (composerRef.current) window.dispatchEvent(new Event("officeflare:focus-composer")); else { composerRef.current = { box: box.id, id, inline }; setComposer(composerRef.current); } },
  }), [boxes.data, box, displayFolders, caps.data, composer, bootstrap.loading, bootstrap.data, bootstrap.error, boxes.loading, caps.loading, folders.loading, boxes.error, caps.error, folders.error, requested, revision, preferences, setPreferences, feedback, recordRead, committed, refresh, boxes.reload, navigate, setParams]);
  const menuValue = useMemo(() => ({ mobileMenu, setMobileMenu }), [mobileMenu]);
  return <SummaryContext value={summary.data?.summary ?? null}><MenuContext value={menuValue}><MailContext value={value}>{children}{composer && <MailComposer key={`${composer.box}:${composer.id ?? "new"}`} mailboxId={composer.box} draftId={composer.id} inline={composer.inline} onClose={() => { composerRef.current = null; setComposer(null); }} />}{notice && <Snackbar className="mail-snackbar"><span>{notice.text}</span>{notice.action && <Button variant="inverse" size="sm" disabled={noticeBusy} onClick={async () => { setNoticeBusy(true); try { await notice.action!(); setNotice(null); } catch (error) { feedback(error instanceof Error ? error.message : "Unable to undo this action."); } finally { setNoticeBusy(false); } }}>{noticeBusy ? "Working…" : notice.label}</Button>}<Button variant="inverse" size="icon" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close" /></Button></Snackbar>}</MailContext></MenuContext></SummaryContext>;
}
const links = [
  ["/mail", "Inbox", "inbox"], ["/mail/starred", "Starred", "star"], ["/mail/snoozed", "Snoozed", "clock"], ["/mail/sent", "Sent", "arrow"], ["/mail/drafts", "Drafts", "file"], ["/mail/scheduled", "Outbox", "clock"], ["/mail/archive", "Archive", "archive"], ["/mail/spam", "Spam", "shield"], ["/mail/trash", "Trash", "trash"],
] as const;
export function MailSidebar() {
  const mail = useMail(), summary = useMailSummary(), menu = useMailMenu(), location = useLocation(), extraId = useId(), custom = mail.folders.filter((folder) => !folder.system_key);
  const extra = [["/mail/all","All mail","mail"],["/mail/archive","Archive","archive"],["/mail/spam","Spam","shield"],["/mail/trash","Trash","trash"]] as const;
  const extraActive = extra.some(([path]) => path === location.pathname);
  const [more, setMore] = useState(extraActive);
  useEffect(() => { if (extraActive) setMore(true); }, [extraActive, location.pathname]);
  const primary = links.filter(([path]) => !["/mail/archive","/mail/spam","/mail/trash"].includes(path));
  const count = (path: string) => path === "/mail/drafts" ? summary?.folders.drafts?.total : path === "/mail/scheduled" ? summary?.outbox : path === "/mail/snoozed" ? summary?.snoozed : summary?.folders[path === "/mail" ? "inbox" : path.split("/").at(-1)!]?.unread;
  const nav = (items: readonly (readonly [string,string,import("./ui").IconProps["name"]])[]) => items.map(([path,name,icon]) => <NavLink end key={path} to={mail.href(path)} onClick={() => menu.setMobileMenu(false)}><Icon name={icon}/><span>{name}</span>{!!count(path) && <small aria-label={`${count(path)} ${path === "/mail/drafts" ? "drafts" : "messages"}`}>{count(path)}</small>}</NavLink>);
  return <div className="mail-sidebar-content">
    <div className="workspace-create-action mail-sidebar-actions">
      {mail.boxes.length > 1 && <MailField className="mail-box-picker" label="Mailbox">
        <MailSelect aria-label="Select mailbox" value={mail.box?.id ?? ""} onValueChange={mail.selectBox} options={[...(!mail.box ? [{ value:"", label:"Choose a mailbox" }] : []), ...mail.boxes.map((box) => ({ value:box.id,label:box.name }))]}/>
      </MailField>}
      <Button className="workspace-create-button mail-compose-button" variant="primary" size="lg" disabled={!mail.box?.access?.read || !mail.box?.access?.write} onClick={() => { mail.compose(); menu.setMobileMenu(false); }}><Icon name="plus"/>Compose</Button>
    </div>
    <nav className="workspace-nav" aria-label="Mail navigation">
      <div className="mail-nav-group">
        {nav(primary)}
        <Button variant="ghost" className="mail-more-link" aria-expanded={more} aria-controls={extraId} onClick={() => setMore(!more)}><Icon name="down" style={{ transform:more ? "rotate(180deg)" : undefined }}/><span>{more ? "Less" : "More"}</span></Button>
      </div>
      <div id={extraId} className="mail-nav-group" hidden={!more}>{nav(extra)}</div>
      <div className="mail-nav-group mail-custom-folders">
        <div className="mail-folder-heading"><h2>Folders</h2>{mail.box?.access?.write && <FolderManager/>}</div>
        {custom.map((folder) => <NavLink key={folder.id} to={mail.href(`/mail/folders/${encodeURIComponent(folder.id)}`)} onClick={() => menu.setMobileMenu(false)}><Icon name="folder"/><span title={folder.name}>{folder.name}</span>{!!summary?.folders[folder.id]?.unread && <small>{summary?.folders[folder.id]?.unread}</small>}</NavLink>)}
        {!mail.loading && !custom.length && <p className="mail-folder-empty">{mail.box?.access?.write ? "Create folders to organize mail." : "No custom folders."}</p>}
      </div>
    </nav>
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

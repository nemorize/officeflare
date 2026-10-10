import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button, Icon, Popover, PopoverPopup, useNotifications } from "@/components/ui";
import { errorMessage } from "../lib/api";
import { notificationDate, notificationTarget, type NotificationItem, type NotificationUpdate } from "../lib/notification-center";
import { useNotificationCenter, useNotificationList } from "./notification-center-context";
import "./notification-center.css";

export function NotificationCard({ item, compact = false }: { item: NotificationItem; compact?: boolean }) {
  const center = useNotificationCenter(), toast = useNotifications(), [busy, setBusy] = useState(false);
  const target = notificationTarget(item.target_path);
  async function change(update: NotificationUpdate) {
    if (busy) return; setBusy(true);
    try { await center.update(item, update); } catch (failure) { toast.error(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <li className="notification-card" data-unread={item.read_at === null}>
    <span className="notification-card-icon"><Icon name={item.category === "security" ? "shield" : "bell"} width="18" height="18" /></span>
    <div className="notification-card-content">
      <div className="notification-card-heading"><strong>{item.title}</strong>{item.read_at === null && <span className="notification-unread-dot" aria-label="Unread" />}</div>
      <p>{item.body}</p>
      <time dateTime={new Date(item.created_at * 1000).toISOString()}>{notificationDate(item.created_at)}</time>
      {item.snoozed_until && item.snoozed_until > Date.now() / 1000 && <span className="notification-snooze-label">Snoozed until {notificationDate(item.snoozed_until)}</span>}
      <div className="notification-card-actions">
        {target && <Link to={target} onClick={() => { if (item.read_at === null) void change({ read: true }); }}>View details<Icon name="arrow" width="12" height="12" /></Link>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void change({ read: item.read_at === null }); }}>{item.read_at === null ? "Mark read" : "Mark unread"}</Button>
        {!compact && <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void change({ archived: item.archived_at === null, snoozed_until: null }); }}>{item.archived_at === null ? "Archive" : "Restore"}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void change({ snoozed_until: item.snoozed_until && item.snoozed_until > Date.now() / 1000 ? null : Math.floor(Date.now() / 1000) + 3600, archived: false }); }}>{item.snoozed_until && item.snoozed_until > Date.now() / 1000 ? "Unsnooze" : "Snooze 1h"}</Button>
          <Button variant="ghost" size="icon" disabled={busy} aria-label={`Delete notification: ${item.title}`} title="Delete" onClick={() => { void change({ deleted: true }); }}><Icon name="trash" /></Button>
        </>}
      </div>
    </div>
  </li>;
}

export function ReadAllButton() {
  const center = useNotificationCenter(), toast = useNotifications(), [busy, setBusy] = useState(false);
  return <Button variant="ghost" size="sm" disabled={busy || !center.summary?.unread} onClick={() => {
    setBusy(true); void center.readAll().catch((failure) => toast.error(errorMessage(failure))).finally(() => setBusy(false));
  }}>{busy ? "Updating…" : "Mark all as read"}</Button>;
}

function NotificationPreview({ open, close }: { open: boolean; close: () => void }) {
  const center = useNotificationCenter(), list = useNotificationList("inbox", "", open, 10);
  return <PopoverPopup className="notification-popup" positionerProps={{ side: "right", align: "start", sideOffset: 10 }}>
    <header className="notification-popup-header"><Popover.Title>Notifications</Popover.Title><Button variant="ghost" size="icon" aria-label="Close notifications" onClick={close}><Icon name="close" /></Button></header>
    <div className="notification-popup-tools"><span>{center.summary ? `${center.summary.unread} unread` : ""}</span><ReadAllButton /></div>
    <div className="notification-popup-list">
      {(list.error || center.error) && <p className="notification-error" role="alert">{list.error || center.error}<Button size="sm" onClick={() => { void center.refresh(true); }}>Retry</Button></p>}
      {list.loading && !list.items.length ? <p className="notification-empty" role="status">Loading notifications…</p> : <>
        <ul>{list.items.map((item) => <NotificationCard key={item.id} item={item} compact />)}</ul>
        {!list.error && !list.items.length && <div className="notification-empty"><Icon name="check" width="24" height="24" /><strong>You’re all caught up</strong><p>New updates will appear here.</p></div>}
      </>}
    </div>
    <footer className="notification-popup-footer"><Link to="/notifications" onClick={close}>View all notifications<Icon name="arrow" /></Link><Link to="/profile/notifications" onClick={close} aria-label="Notification settings" title="Notification settings"><Icon name="settings" /></Link></footer>
  </PopoverPopup>;
}

export function NotificationBell() {
  const center = useNotificationCenter(), [open, setOpen] = useState(false), unread = center.summary?.unread ?? 0;
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button variant="ghost" size="icon" className="notification-bell" />} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} title="Notifications">
      <Icon name="bell" width="18" height="18" />{unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </Popover.Trigger>
    <NotificationPreview open={open} close={() => setOpen(false)} />
  </Popover.Root>;
}

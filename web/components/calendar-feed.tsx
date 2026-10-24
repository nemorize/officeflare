import { useEffect, useRef, useState } from "react";
import { Button, CheckboxControl, Input, useNotifications } from "./ui";
import { CalendarField, CalendarModal, CalendarNotice, useCalendarAction, useCalendarResource } from "./calendar-controls";
import { CalendarTimeZoneField } from "./calendar-editor";
import { useCalendar } from "./calendar-context";
import { calendarApi, type CalendarRecord } from "../lib/calendar";
import { MailOperation } from "../lib/mail-helpers";
import { ApiError } from "../lib/api";

interface Feed {
  version: number; source_host: string; enabled: boolean; status: "pending" | "syncing" | "healthy" | "error" | "paused";
  last_attempt_at: number | null; last_success_at: number | null; next_sync_at: number | null;
  event_count: number; error_message: string | null; warnings: string[];
}
const stamp = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "Not yet";
export function CalendarFeedDialog({ cal: initial, onClose }: { cal?: CalendarRecord; onClose: () => void }) {
  const calendar = useCalendar(), action = useCalendarAction(), notify = useNotifications();
  const [cal, setCal] = useState(initial), [name, setName] = useState(initial?.name ?? ""), [url, setUrl] = useState("");
  const [zone, setZone] = useState(initial?.time_zone ?? calendar.zone), [enabled, setEnabled] = useState<boolean | null>(null), [revision, setRevision] = useState(0), [disconnect, setDisconnect] = useState(false);
  const operation = useRef(new MailOperation()), lastSuccess = useRef<number | null>(null);
  const resource = useCalendarResource<{ feed: Feed }>(cal ? `/calendars/${cal.id}/feed` : null, revision), feed = resource.data?.feed;
  useEffect(() => {
    if (!cal) return;
    const timer = setInterval(() => setRevision(value => value + 1), feed?.status === "pending" || feed?.status === "syncing" ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [cal?.id, feed?.status]);
  useEffect(() => {
    if (feed?.last_success_at && feed.last_success_at !== lastSuccess.current) { lastSuccess.current = feed.last_success_at; calendar.refresh(); }
  }, [feed?.last_success_at]);
  const save = () => action.run(async () => {
    if (!cal) {
      const body = { name: name.trim(), url: url.trim(), time_zone: zone };
      try {
        const result = await calendarApi<{ calendar: CalendarRecord }>("/feeds", { method: "POST", body, headers: operation.current.headers(body) });
        operation.current.complete(); setCal(result.calendar); setUrl(""); calendar.refresh(true); notify.success("External calendar registered. Its first sync is queued.");
      } catch (error) { if (error instanceof ApiError && error.status < 500) operation.current.complete(); throw error; }
    } else {
      if (name.trim() !== cal.name) {
        const result = await calendarApi<{ calendar: CalendarRecord }>(`/calendars/${cal.id}`, { method: "PATCH", body: { version: cal.version, name: name.trim() } });
        setCal(result.calendar); calendar.refresh(true);
      }
      if (feed && (url.trim() || enabled !== null && enabled !== feed.enabled)) {
        await calendarApi(`/calendars/${cal.id}/feed`, { method: "PATCH", body: { version: feed.version, ...(url.trim() ? { url: url.trim() } : {}), ...(enabled !== null ? { enabled } : {}) } });
        setUrl(""); setEnabled(null); setRevision(value => value + 1);
      }
      notify.success("External calendar settings saved.");
    }
  });
  const connectionFields = <div className="calendar-settings-fields">
        <CalendarField label="Calendar name" required maxLength={255} value={name} disabled={action.busy} onChange={event => setName(event.target.value)} />
        <CalendarField label={cal ? "Replace subscription URL" : "Subscription URL"} hint={cal ? `Source: ${feed?.source_host ?? "Loading…"}. Leave blank to keep the saved URL.` : "Paste a public or secret .ics subscription link from your calendar provider. HTTPS and webcal links are supported."}>
          <Input type="url" aria-label={cal ? "Replace subscription URL" : "Subscription URL"} placeholder="https://calendar.example.com/calendar.ics" value={url} autoComplete="off" spellCheck={false} required={!cal} maxLength={4096} disabled={action.busy} onChange={event => setUrl(event.target.value)} />
        </CalendarField>
        {!cal && <CalendarTimeZoneField value={zone} onChange={setZone} />}
        <p className="calendar-import-hint">Officeflare checks for updates every hour. You can also refresh manually, at most once every five minutes. This is one-way sync: edit events in the original calendar. No provider account sign-in is required. Secret URLs are stored encrypted.</p>
        {cal && feed && <label className="calendar-check-label"><CheckboxControl checked={enabled ?? feed.enabled} disabled={action.busy} onCheckedChange={setEnabled} />Automatically synchronize this calendar</label>}
      </div>;
  return <CalendarModal title={cal ? "External calendar" : "Subscribe to a calendar"} description="Read-only sync from an iCalendar URL. Changes made at the source appear here automatically." onClose={onClose} busy={action.busy} className="calendar-feed-modal">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {cal ? <details className="calendar-feed-connection"><summary>Connection settings · {cal.name}</summary>{connectionFields}</details> : connectionFields}
      {cal && <section className="calendar-feed-status" aria-label="Synchronization status">
        <p className="calendar-import-hint">{feed?.source_host} · Checks every hour</p><p role="status"><strong>{feed ? ({ pending: "Waiting to synchronize", syncing: "Synchronizing…", healthy: "Up to date", error: "Sync needs attention", paused: "Sync paused" })[feed.status] : "Loading sync status…"}</strong></p>
        {feed && <><dl><div><dt>Last checked</dt><dd>{stamp(feed.last_attempt_at)}</dd></div><div><dt>Last successful sync</dt><dd>{stamp(feed.last_success_at)}</dd></div><div><dt>Next check</dt><dd>{feed.enabled ? stamp(feed.next_sync_at) : "Paused"}</dd></div><div><dt>Events</dt><dd>{feed.event_count}</dd></div></dl>
          <CalendarNotice error={feed.error_message ?? ""} />
          {feed.error_message && <p className="calendar-import-hint">Previously synchronized events stay available. Officeflare retries automatically. If access was revoked, replace the URL in Connection settings and save to reconnect.</p>}
          {!!feed.warnings.length && <details><summary>Sync notes</summary>{feed.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
          <Button size="sm" disabled={action.busy || !feed.enabled || feed.status === "syncing"} onClick={() => { void action.run(async () => { await calendarApi(`/calendars/${cal.id}/feed/refresh`, { method: "POST", body: { version: feed.version } }); setRevision(value => value + 1); notify.info("Calendar refresh queued."); }); }}>Refresh now</Button>
        </>}
      </section>}
      <CalendarNotice error={action.error || resource.error} />
      {cal && feed && <div className="calendar-feed-disconnect">{disconnect ? <><p>Disconnect this calendar and remove it from your view? Its events remain in the original calendar.</p><Button variant="danger" size="sm" disabled={action.busy} onClick={() => { void action.run(async () => { await calendarApi(`/calendars/${cal.id}/feed?version=${feed.version}`, { method: "DELETE" }); calendar.refresh(true); notify.success("External calendar disconnected."); onClose(); }); }}>Disconnect calendar</Button><Button variant="ghost" size="sm" disabled={action.busy} onClick={() => setDisconnect(false)}>Keep calendar</Button></> : <Button variant="text" size="sm" disabled={action.busy} onClick={() => setDisconnect(true)}>Disconnect calendar</Button>}</div>}
      <div className="calendar-dialog-actions"><Button variant="ghost" disabled={action.busy} onClick={onClose}>{cal ? "Done" : "Cancel"}</Button><Button variant="primary" type="submit" disabled={action.busy || !name.trim() || (!cal && !url.trim()) || (!!cal && !feed)}>{action.busy ? "Saving…" : cal ? "Save" : "Subscribe"}</Button></div>
    </form>
  </CalendarModal>;
}

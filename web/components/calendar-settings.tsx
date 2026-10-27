import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, CheckboxControl, Icon, Input, SelectControl, Textarea, useNotifications } from "./ui";
import { CalendarField, CalendarIconButton, CalendarModal, CalendarNotice, useCalendarAction, useCalendarResource } from "./calendar-controls";
import { CalendarWorkingHours } from "./calendar-working-hours";
import { CalendarImportDialog } from "./calendar-import";
import { CalendarFeedDialog } from "./calendar-feed";
import { CalendarShareLinks } from "./calendar-collaboration";
import { CalendarTimeZoneField } from "./calendar-editor";
import { useCalendar } from "./calendar-context";
import { calendarApi, calendarColors, calendarRank, type CalendarRecord } from "../lib/calendar";
import { MailOperation } from "../lib/mail-helpers";
import { ApiError } from "../lib/api";

const sharingRoles = [{ value: "free_busy", label: "See only free/busy" }, { value: "reader", label: "See event details" }, { value: "writer_without_private", label: "Edit public event details" }, { value: "writer", label: "Make changes to events" }, { value: "manager", label: "Make changes and manage sharing" }];
interface Grant { display_name?: string | null; email_address?: string | null; id: string; scope_type: string; scope_key: string; role: string; version: number; }
interface Person { id: string; display_name: string | null; email_address: string; }
export function CalendarAccessSettings({ cal }: { cal: CalendarRecord }) {
  const calendar = useCalendar(), action = useCalendarAction(), notify = useNotifications();
  const [revision, setRevision] = useState(0), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [person, setPerson] = useState<Person | null>(null), [role, setRole] = useState("reader");
  const grants = useCalendarResource<{ acl: Grant[] }>(`/calendars/${cal.id}/acl`, revision);
  const people = useCalendarResource<{ people: Person[] }>(calendar.can("sharing.internal") && search.length >= 2 ? `/people?q=${encodeURIComponent(search)}` : null);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  const reload = () => { setRevision(old => old + 1); calendar.refresh(true); };
  const add = () => action.run(async () => {
    if (!person) return;
    await calendarApi(`/calendars/${cal.id}/acl`, { method: "POST", body: { scope_type: "user", scope_key: person.id, role } });
    setPerson(null); setQuery(""); notify.success("Calendar shared."); reload();
  });
  return <div className="calendar-sharing-settings"><h3>Share with specific people</h3><p>Choose who can see this calendar and make changes.</p>
    {grants.data?.acl.map(grant => <div className="calendar-grant" key={grant.id}><span className="calendar-person-initial"><Icon name={grant.scope_type === "user" ? "user" : "users"} /></span><div><strong>{grant.scope_type === "organization" ? "Everyone in the workspace" : grant.scope_type === "public" ? "Public calendar" : grant.display_name || grant.email_address || grant.scope_key}</strong><span>{grant.scope_type === "user" ? grant.email_address ?? "Workspace account" : grant.scope_type}</span></div><SelectControl aria-label={`Access for ${grant.scope_key}`} value={grant.role} options={["organization", "public"].includes(grant.scope_type) ? sharingRoles.slice(0, 2) : sharingRoles} disabled={action.busy} onValueChange={role => { void action.run(async () => { await calendarApi(`/calendars/${cal.id}/acl/${grant.id}`, { method: "PATCH", body: { version: grant.version, role } }); reload(); }); }} /><CalendarIconButton icon="close" label={`Remove access for ${grant.scope_key}`} disabled={action.busy} onClick={() => { void action.run(async () => { await calendarApi(`/calendars/${cal.id}/acl/${grant.id}?version=${grant.version}`, { method: "DELETE" }); reload(); }); }} /></div>)}
    {calendar.can("sharing.internal") && <div className="calendar-add-access"><CalendarField label="Add people" placeholder="Search by name or email" value={person?.email_address ?? query} onChange={event => { setPerson(null); setQuery(event.target.value); }} autoComplete="off" />
      {!person && query.trim().length >= 2 && <div className="calendar-people-results" aria-live="polite">{people.loading ? <p>Searching…</p> : people.data?.people.length ? people.data.people.map(value => <button type="button" key={value.id} onClick={() => setPerson(value)}><span className="calendar-person-initial">{(value.display_name || value.email_address).slice(0, 1).toUpperCase()}</span><span><strong>{value.display_name || value.email_address}</strong><small>{value.email_address}</small></span></button>) : <p>No matching accounts.</p>}</div>}
      <div className="calendar-add-access-actions"><SelectControl aria-label="New person's permissions" value={role} options={sharingRoles} onValueChange={setRole} /><Button disabled={!person || action.busy} onClick={() => { void add(); }}><Icon name="plus" />Add</Button></div>
    </div>}
    <CalendarNotice error={action.error || grants.error || people.error} />
    {calendar.can("sharing.external") && <section className="calendar-access-links"><h3>Share with a link</h3><CalendarShareLinks calendarId={cal.id} /></section>}
  </div>;
}
export function CalendarSettingsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const calendar = useCalendar(), action = useCalendarAction(), notify = useNotifications(), operation = useRef(new MailOperation());
  const [cal, setCal] = useState(calendar.data?.calendars.find(value => value.id === id)), [sub] = useState(calendar.data?.subscriptions.find(value => value.calendar_id === id));
  const [name, setName] = useState(cal?.name ?? ""), [description, setDescription] = useState(cal?.description ?? ""), [zone, setZone] = useState(cal?.time_zone ?? calendar.zone), [color, setColor] = useState(sub?.color ?? calendarColors[0]!.value), [tab, setTab] = useState("general");
  const editable = id === "new" || calendarRank(cal) >= 5;
  if (!calendar.data) return null;
  if (id === "subscribe") return <CalendarFeedDialog onClose={onClose} />;
  if (cal?.kind === "external" && calendarRank(cal) >= 6) return <CalendarFeedDialog cal={cal} onClose={onClose} />;
  if (id === "import") return <CalendarImportDialog onClose={onClose} />;
  if (id === "working-hours") return <CalendarWorkingHours onClose={onClose} />;
  if (id === "shortcuts") return <CalendarModal title="Keyboard shortcuts" onClose={onClose}><div className="calendar-shortcuts">{[["C", "Create event"], ["T", "Go to today"], ["J / K", "Next / previous period"], ["D / W / M / A", "Day / week / month / schedule"], ["Esc", "Close an open dialog"]].map(([key, label]) => <p key={key}><span>{label}</span><kbd>{key}</kbd></p>)}</div></CalendarModal>;
  return <CalendarModal title={id === "new" ? "Create a calendar" : cal?.name ?? "Calendar"} description={id === "new" ? "Keep a project, team or part of your day in its own calendar." : "Calendar details, appearance and sharing."} onClose={onClose} busy={action.busy} className="calendar-settings-modal">
    {cal && calendarRank(cal) >= 5 && <div className="calendar-editor-tabs" role="tablist" aria-label="Calendar settings sections"><button role="tab" aria-selected={tab === "general"} onClick={() => setTab("general")}>General</button><button role="tab" aria-selected={tab === "sharing"} onClick={() => setTab("sharing")}>Sharing & access</button></div>}
    {tab === "sharing" && cal ? <CalendarAccessSettings cal={cal} /> : <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      if (id === "new") {
        const body = { name: name.trim(), description, time_zone: zone };
        try { await calendarApi("/calendars", { method: "POST", body, headers: operation.current.headers(body) }); operation.current.complete(); } catch (failure) { if (failure instanceof ApiError && failure.status < 500) operation.current.complete(); throw failure; }
      } else if (cal) {
        if (editable && (name !== cal.name || description !== cal.description || zone !== cal.time_zone)) { const result = await calendarApi<{ calendar: CalendarRecord }>(`/calendars/${cal.id}`, { method: "PATCH", body: { version: cal.version, name: name.trim(), description, time_zone: zone } }); setCal(result.calendar); calendar.refresh(true); }
        if (color !== sub?.color) await calendarApi(`/subscriptions/${cal.id}`, { method: sub ? "PATCH" : "PUT", body: { ...(sub ? { version: sub.version } : {}), color, selected: sub?.selected ?? true } });
      }
      calendar.refresh(true); notify.success(id === "new" ? "Calendar created." : "Calendar settings saved."); onClose();
    }); }}><div className="calendar-settings-fields"><CalendarField label="Name" required value={name} maxLength={255} disabled={!editable} onChange={event => setName(event.target.value)} /><CalendarField label="Description"><Textarea aria-label="Calendar description" rows={3} value={description} maxLength={10000} disabled={!editable} onChange={event => setDescription(event.target.value)} /></CalendarField><CalendarTimeZoneField value={zone} disabled={!editable} onChange={setZone} />{cal && <CalendarField label="Color"><div className="calendar-color-options">{calendarColors.map(option => <button type="button" key={option.value} style={{ "--calendar-color": option.value } as CSSProperties} aria-label={option.label} aria-pressed={color === option.value} onClick={() => setColor(option.value)}>{color === option.value && <Icon name="check" width="13" height="13" />}</button>)}</div></CalendarField>}</div><CalendarNotice error={action.error} /><div className="calendar-dialog-actions"><Button variant="ghost" onClick={onClose} disabled={action.busy}>Cancel</Button><Button type="submit" variant="primary" disabled={action.busy || !name.trim()}>{action.busy ? "Saving…" : id === "new" ? "Create calendar" : "Save"}</Button></div></form>}
  </CalendarModal>;
}

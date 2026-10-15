import { useEffect, useId, useRef, useState } from "react";
import { Button, CheckboxControl, Dialog, DialogPopup, Field, Icon, Input, Radio, RadioGroup, SelectControl, Textarea, useNotifications } from "./ui";
import { CalendarField, CalendarIconButton, CalendarModal, CalendarNotice, useCalendarAction, useCalendarResource } from "./calendar-controls";
import { useCalendar, type CalendarCreateRequest } from "./calendar-context";
import { RecipientField } from "./mail-recipients";
import { LoadingSkeleton } from "./loading-skeleton";
import { ApiError } from "../lib/api";
import { MailOperation, parseRecipients } from "../lib/mail-helpers";
import { calendarApi, calendarRank, eventPath, type CalendarEvent, type CalendarScope } from "../lib/calendar";
import { addDays, dateInstant, dateLabel, endpointLocal, eventTimeLabel, Temporal, validDate } from "../lib/calendar-date";
import { draftForEvent, draftTimes, eventChanges, initialNewEvent, recurrenceChanged, type EventDraft } from "../lib/calendar-editor";

export function CalendarScopeDialog({ title, onConfirm, onClose, busy = false, allowSingle = true, allowFollowing = true, error = "" }: {
  title: string; onConfirm: (scope: CalendarScope) => void; onClose: () => void; busy?: boolean; allowSingle?: boolean; allowFollowing?: boolean; error?: string;
}) {
  const [scope, setScope] = useState<CalendarScope>(allowSingle ? "single" : allowFollowing ? "following" : "all");
  return <CalendarModal title={title} description="Choose which events in this series to change." onClose={onClose} busy={busy} className="calendar-scope-modal">
    <RadioGroup value={scope} onValueChange={value => setScope(value as CalendarScope)} aria-label="Repeating event scope" className="calendar-scope-options">
      {[{ value: "single", label: "This event", disabled: !allowSingle }, { value: "following", label: "This and following events", disabled: !allowFollowing }, { value: "all", label: "All events", disabled: false }].map(option => <label key={option.value} data-disabled={option.disabled || undefined}><Radio.Root value={option.value} disabled={option.disabled}><Radio.Indicator>●</Radio.Indicator></Radio.Root><span>{option.label}</span></label>)}
    </RadioGroup><CalendarNotice error={error} /><div className="calendar-dialog-actions"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => onConfirm(scope)} disabled={busy}>Confirm</Button></div>
  </CalendarModal>;
}
export const timeZones = [...new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf("timeZone")])];
export function CalendarTimeZoneField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <CalendarField label="Time zone"><Input aria-label="Time zone" value={value} disabled={disabled} list={id} onChange={event => onChange(event.target.value)} required /><datalist id={id}>{timeZones.map(zone => <option key={zone} value={zone} />)}</datalist></CalendarField>;
}
function FindTime({ draft, onChoose }: { draft: EventDraft; onChoose: (start: string, end: string) => void }) {
  const calendar = useCalendar(), action = useCalendarAction();
  const [ids, setIds] = useState<string[]>([draft.calendarId]), [slots, setSlots] = useState<{ start: string; end: string }[] | null>(null), [working, setWorking] = useState(false), [visible, setVisible] = useState(24);
  const load = () => action.run(async () => {
    const times = draftTimes(draft);
    if (draft.allDay) throw new Error("Choose start and end times to find an available slot.");
    const duration = Math.round((Temporal.Instant.from(times.end.date_time!).epochMilliseconds - Temporal.Instant.from(times.start.date_time!).epochMilliseconds) / 60_000);
    const result = await calendarApi<{ slots: { start: string; end: string }[] }>("/availability/query", { method: "POST", body: { calendar_ids: ids, time_min: dateInstant(draft.startDate, draft.zone), time_max: dateInstant(addDays(draft.startDate, 7), draft.zone), duration_minutes: duration, step_minutes: 30, working_hours_only: working } });
    setSlots(result.slots); setVisible(24);
  });
  return <section className="calendar-find-time"><p>Find a time across calendars you can access.</p><div className="calendar-availability-calendars">{calendar.data?.calendars.map(cal => <label key={cal.id}><CheckboxControl checked={ids.includes(cal.id)} onCheckedChange={checked => { setIds(old => checked ? [...old, cal.id] : old.filter(id => id !== cal.id)); setSlots(null); }} />{cal.name}</label>)}</div>
    <label className="calendar-check-label"><CheckboxControl checked={working} onCheckedChange={value => { setWorking(value); setSlots(null); }} />Within working hours</label><CalendarNotice error={action.error} /><Button disabled={action.busy || !ids.length || draft.allDay} onClick={() => { void load(); }}>{action.busy ? "Finding times…" : "Find available times"}</Button>
    {slots && <div className="calendar-available-slots">{!slots.length && <p>No available times in the next seven days. Try other calendars or enter a time manually.</p>}{slots.slice(0, visible).map(slot => <button type="button" key={slot.start} onClick={() => onChoose(slot.start, slot.end)}><span>{dateLabel(endpointLocal({ date_time: slot.start, time_zone: draft.zone }, draft.zone).date, { weekday: "short", month: "short", day: "numeric" })}</span><strong>{eventTimeLabel({ start: { date_time: slot.start, time_zone: draft.zone }, end: { date_time: slot.end, time_zone: draft.zone } } as CalendarEvent, draft.zone)}</strong><Icon name="plus" /></button>)}{slots.length > visible && <Button variant="text" onClick={() => setVisible(old => old + 24)}>Show more times</Button>}</div>}
  </section>;
}
export function CalendarEventEditor({ event, request, onClose, onSaved }: { event?: CalendarEvent; request?: CalendarCreateRequest; onClose: () => void; onSaved: () => void }) {
  const calendar = useCalendar(), notify = useNotifications(), action = useCalendarAction();
  const master = useCalendarResource<{ event: CalendarEvent }>(event ? eventPath(event) : null);
  const instance = useCalendarResource<{ event: CalendarEvent }>(event?.occurrence_key ? `${eventPath(event)}/instances/${encodeURIComponent(event.occurrence_key)}` : null);
  const [draft, setDraft] = useState<EventDraft | null>(null), [initial, setInitial] = useState<EventDraft | null>(null), [guests, setGuests] = useState("");
  const [tab, setTab] = useState("details"), [customRepeat, setCustomRepeat] = useState(false), [scope, setScope] = useState(false), [discard, setDiscard] = useState(false);
  const initialized = useRef(false), operation = useRef(new MailOperation());
  useEffect(() => {
    if (initialized.current || !calendar.data || event && (!master.data || event.occurrence_key && !instance.data)) return;
    try {
      if (event?.occurrence_key && instance.data!.event.version !== master.data!.event.version) throw new Error("This event changed. Close and reopen it to load the latest version.");
      const source = event ? { ...(instance.data?.event ?? master.data!.event), recurrence: master.data!.event.recurrence, version: master.data!.event.version }
        : initialNewEvent(request?.date ?? calendar.date, calendar.zone, calendar.data.preferences.default_duration_minutes, request?.minute, request?.allDay, request?.endDate, request?.endMinute);
      const value = draftForEvent(source, calendar.zone);
      value.calendarId = event?.calendar_id ?? calendar.data.calendars.find(cal => cal.id === calendar.data!.primary_calendar_id && calendarRank(cal) >= 3)?.id ?? calendar.data.calendars.find(cal => calendarRank(cal) >= 3)?.id ?? "";
      setDraft(value); setInitial(value); initialized.current = true;
    } catch (error) { action.setError(error instanceof Error ? error.message : "Unable to open this event."); }
  }, [master.data, instance.data, calendar.data, event, request]);
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setDraft(old => old ? { ...old, [key]: value } : old);
  const dirty = draft && initial && (JSON.stringify(draft) !== JSON.stringify(initial) || guests.trim());
  const close = () => { if (action.busy) return; if (dirty) setDiscard(true); else onClose(); };
  const save = async (chosen: CalendarScope) => {
    if (!draft) return;
    await action.run(async () => {
      draftTimes(draft);
      const changes = eventChanges(draft, event ? initial : null, master.data?.event, chosen);
      if (event && !Object.keys(changes).length) { onClose(); return; }
      const body = event ? { ...changes, version: master.data!.event.version, ...(master.data!.event.recurrence?.length ? { scope: chosen, occurrence_key: event.occurrence_key } : {}) }
        : { ...changes, ...(guests.trim() ? { attendees: parseRecipients(guests).map(email_address => ({ email_address })) } : {}) };
      try {
        await calendarApi(event ? eventPath(event) : `/calendars/${draft.calendarId}/events`, { method: event ? "PATCH" : "POST", body, ...(!event ? { headers: operation.current.headers(body) } : {}) });
        operation.current.complete(); notify.success(event ? "Event updated." : "Event created."); onSaved();
      } catch (failure) { if (failure instanceof ApiError && failure.status < 500) operation.current.complete(); throw failure; }
    });
  };
  const repeatChanged = !!draft && !!initial && recurrenceChanged(draft, initial);
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) close(); }}>
      <DialogPopup data-ui-theme="neutral" className="calendar-modal calendar-editor" viewportProps={{ className: "calendar-editor-viewport" }}>
        <div className="calendar-editor-heading"><span><Icon name="calendar" />{event ? "Edit event" : "New event"}</span><CalendarIconButton icon="close" label="Close event editor" disabled={action.busy} onClick={close} /></div>
        <Dialog.Title className="visually-hidden">{event ? "Edit event" : "Create event"}</Dialog.Title><Dialog.Description className="visually-hidden">Event dates, guests and details.</Dialog.Description>
        {!draft ? <div className="calendar-editor-loading"><LoadingSkeleton kind="form" label="Loading event…" /><CalendarNotice error={master.error || instance.error || action.error} /></div> : <form onSubmit={submit => { submit.preventDefault(); try { draftTimes(draft); } catch (error) { action.setError((error as Error).message); return; } if (master.data?.event.recurrence?.length) setScope(true); else void save("all"); }}>
          <div className="calendar-editor-scroll">
            <Input className="calendar-event-title-input" variant="integrated" aria-label="Event title" placeholder="Add title" autoFocus value={draft.title} maxLength={1000} onChange={event => update("title", event.target.value)} />
            <div className="calendar-editor-tabs" role="tablist" aria-label="Event editor sections"><button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>Event details</button><button type="button" role="tab" aria-selected={tab === "find"} onClick={() => setTab("find")}>Find a time</button></div>
            {tab === "find" ? <FindTime draft={draft} onChoose={(start, end) => { const a = endpointLocal({ date_time: start, time_zone: draft.zone }, draft.zone), b = endpointLocal({ date_time: end, time_zone: draft.zone }, draft.zone); setDraft(old => old ? { ...old, startDate: a.date, startTime: a.time, endDate: b.date, endTime: b.time } : old); setTab("details"); }} /> : <div className="calendar-editor-fields">
              <div className="calendar-editor-row"><Icon name="clock" /><div className="calendar-editor-time-fields"><div className="calendar-date-time-pair"><Input aria-label="Start date" type="date" min="1970-01-01" max="2100-12-31" required value={draft.startDate} onChange={event => { const value = event.target.value; setDraft(old => old ? { ...old, startDate: value, endDate: old.endDate < value ? value : old.endDate } : old); }} />{!draft.allDay && <Input aria-label="Start time" type="time" required value={draft.startTime} onChange={event => update("startTime", event.target.value)} />}</div><span className="calendar-time-divider">–</span><div className="calendar-date-time-pair"><Input aria-label="End date" type="date" min={draft.startDate} max="2100-12-31" required value={draft.endDate} onChange={event => update("endDate", event.target.value)} />{!draft.allDay && <Input aria-label="End time" type="time" required value={draft.endTime} onChange={event => update("endTime", event.target.value)} />}</div>
              <label className="calendar-check-label"><CheckboxControl checked={draft.allDay} onCheckedChange={value => update("allDay", value)} />All day</label></div></div>
              <div className="calendar-editor-row calendar-repeat-row"><Icon name="refresh" /><div><SelectControl aria-label="Repeat event" value={draft.frequency} onValueChange={value => update("frequency", value)} options={[{ value: "", label: "Does not repeat" }, { value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: `Weekly on ${dateLabel(validDate(draft.startDate) ?? calendar.date, { weekday: "long" })}` }, { value: "MONTHLY", label: `Monthly on day ${Number(draft.startDate.slice(-2))}` }, { value: "YEARLY", label: "Yearly" }]} />{draft.frequency && <Button variant="text" size="sm" onClick={() => setCustomRepeat(!customRepeat)}>Customize</Button>}
              {customRepeat && draft.frequency && <div className="calendar-repeat-settings"><CalendarField label="Repeat every"><Input aria-label="Repeat interval" type="number" min={1} max={365} value={draft.interval} onChange={event => update("interval", Number(event.target.value))} /></CalendarField>{draft.frequency === "WEEKLY" && <div className="calendar-repeat-weekdays">{["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((day, index) => <button type="button" key={day} aria-label={`Repeat on ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index]}`} aria-pressed={draft.weekdays.includes(day)} onClick={() => update("weekdays", draft.weekdays.includes(day) ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day])}>{day.slice(0, 1)}</button>)}</div>}<CalendarField label="Ends"><SelectControl aria-label="Repeat ends" value={draft.ends} onValueChange={value => update("ends", value as EventDraft["ends"])} options={[{ value: "never", label: "Never" }, { value: "until", label: "On a date" }, { value: "count", label: "After a number of events" }]} /></CalendarField>{draft.ends === "until" && <Input aria-label="Repeat until" type="date" value={draft.until} min={draft.startDate} required onChange={event => update("until", event.target.value)} />}{draft.ends === "count" && <Input aria-label="Number of occurrences" type="number" min={1} max={1000} value={draft.count} required onChange={event => update("count", Number(event.target.value))} />}</div>}
              </div></div>
              <div className="calendar-editor-row"><Icon name="clock" /><CalendarTimeZoneField value={draft.zone} onChange={value => update("zone", value)} /></div>
              {!event && calendar.can("events.invite") && <div className="calendar-editor-row"><Icon name="users" /><div className="calendar-editor-guests"><RecipientField label="Guests" value={guests} onChange={setGuests} /><p className="calendar-field-hint">Add internal or external guests by email.</p></div></div>}
              <div className="calendar-editor-row"><Icon name="navigation" /><Input aria-label="Location" placeholder="Add location" value={draft.location} maxLength={1024} onChange={event => update("location", event.target.value)} /></div>
              <div className="calendar-editor-row"><Icon name="align" /><Textarea aria-label="Description" placeholder="Add a description" rows={4} value={draft.description} maxLength={50000} onChange={event => update("description", event.target.value)} /></div>
              <div className="calendar-editor-row"><Icon name="calendar" /><div className="calendar-editor-calendar-options"><SelectControl aria-label="Calendar" value={draft.calendarId} disabled={!!event} onValueChange={value => update("calendarId", value)} options={calendar.data!.calendars.filter(cal => calendarRank(cal) >= 3).map(cal => ({ value: cal.id, label: cal.name }))} /><SelectControl aria-label="Show as" value={draft.transparency} onValueChange={value => update("transparency", value)} options={[{ value: "busy", label: "Busy" }, { value: "free", label: "Free" }]} /><SelectControl aria-label="Event visibility" value={draft.visibility} onValueChange={value => update("visibility", value)} options={[{ value: "default", label: "Default visibility" }, { value: "private", label: "Private" }, { value: "public", label: "Public" }]} /></div></div>
            </div>}
            <CalendarNotice error={action.error} />
          </div><div className="calendar-editor-footer"><span>{guests.trim() ? "Internal guests are notified. External email requires an available personal mailbox." : ""}</span><Button variant="ghost" disabled={action.busy} onClick={close}>Cancel</Button><Button variant="primary" type="submit" disabled={action.busy || !draft.calendarId}>{action.busy ? "Saving…" : "Save"}</Button></div>
        </form>}
      </DialogPopup>
    </Dialog.Root>
    {scope && <CalendarScopeDialog title="Edit repeating event" allowSingle={!repeatChanged} onClose={() => setScope(false)} busy={action.busy} onConfirm={chosen => { setScope(false); void save(chosen); }} />}
    {discard && <CalendarModal title="Discard changes?" description="Your unsaved changes will be lost." onClose={() => setDiscard(false)}><div className="calendar-dialog-actions"><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard</Button></div></CalendarModal>}
  </>;
}

import { useState } from "react";
import { Button, CheckboxControl, Icon, Input, useNotifications } from "./ui";
import { CalendarIconButton, CalendarModal, CalendarNotice, useCalendarAction, useCalendarResource } from "./calendar-controls";
import { CalendarTimeZoneField } from "./calendar-editor";
import { useCalendar } from "./calendar-context";
import { calendarApi } from "../lib/calendar";
import { minuteTime } from "../lib/calendar-date";
import { LoadingSkeleton } from "./loading-skeleton";
interface Hours { version: number; time_zone: string; weekly: Record<string, { start: number; end: number }[]>; exceptions: Record<string, { start: number; end: number }[]>; }
const ranges = (value: Hours["weekly"]) => Object.fromEntries(Object.entries(value).map(([day, values]) => [day, values.map(range => ({ start: minuteTime(range.start), end: minuteTime(range.end) }))]));
export function CalendarWorkingHours({ onClose }: { onClose: () => void }) {
  const resource = useCalendarResource<{ working_hours: Hours }>("/working-hours");
  return resource.data ? <WorkingHoursForm hours={resource.data.working_hours} onClose={onClose} /> : <CalendarModal title="Working hours" onClose={onClose}><LoadingSkeleton label="Loading working hours…" /><CalendarNotice error={resource.error} /></CalendarModal>;
}
function WorkingHoursForm({ hours, onClose }: { hours: Hours; onClose: () => void }) {
  const calendar = useCalendar(), action = useCalendarAction(), notify = useNotifications();
  const [zone, setZone] = useState(hours.version ? hours.time_zone : calendar.zone), [weekly, setWeekly] = useState(ranges(hours.weekly));
  const change = (day: string, index: number, key: "start" | "end", value: string) => setWeekly(old => ({ ...old, [day]: old[day]!.map((range, at) => at === index ? { ...range, [key]: value } : range) }));
  return <CalendarModal title="Working hours" description="Find a time uses these hours when you enable the working-hours filter." busy={action.busy} onClose={onClose} className="calendar-settings-modal"><form onSubmit={submit => { submit.preventDefault(); void action.run(async () => {
    await calendarApi("/working-hours", { method: "PUT", body: { version: hours.version, time_zone: zone, weekly, exceptions: ranges(hours.exceptions) } }); notify.success("Working hours saved."); onClose();
  }); }}><div className="calendar-settings-fields"><CalendarTimeZoneField value={zone} onChange={setZone} /><div className="calendar-working-days">{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => { const day = String(index), values = weekly[day] ?? []; return <div className="calendar-working-day" key={day}><label><CheckboxControl checked={!!values.length} onCheckedChange={checked => setWeekly(old => ({ ...old, [day]: checked ? [{ start: "09:00", end: "18:00" }] : [] }))} />{label.slice(0, 3)}</label><div>{values.length ? values.map((range, at) => <div className="calendar-working-range" key={at}><Input type="time" aria-label={`${label} start ${at + 1}`} required value={range.start} onChange={event => change(day, at, "start", event.target.value)} /><span>–</span><Input type={range.end === "24:00" ? "text" : "time"} aria-label={`${label} end ${at + 1}`} required value={range.end} onChange={event => change(day, at, "end", event.target.value)} /><CalendarIconButton icon="close" label={`Remove ${label} interval ${at + 1}`} onClick={() => setWeekly(old => ({ ...old, [day]: old[day]!.filter((_, current) => current !== at) }))} /></div>) : <span className="calendar-field-hint">Unavailable</span>}</div>{values.length > 0 && <CalendarIconButton icon="plus" label={`Add ${label} interval`} onClick={() => setWeekly(old => ({ ...old, [day]: [...values, { start: "13:00", end: "18:00" }] }))} />}</div>; })}</div></div><CalendarNotice error={action.error} /><div className="calendar-dialog-actions"><Button variant="ghost" onClick={onClose} disabled={action.busy}>Cancel</Button><Button variant="primary" type="submit" disabled={action.busy}>Save</Button></div></form></CalendarModal>;
}

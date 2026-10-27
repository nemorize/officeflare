import { useRef } from "react";
import { Link, useLocation, useParams } from "react-router";
import { Button, CheckboxControl, Icon, SelectControl, Textarea, useNotifications } from "../components/ui";
import { CalendarField, CalendarNotice } from "../components/calendar-controls";
import { useCalendar } from "../components/calendar-context";
import { CalendarSettingsLayout } from "../components/calendar-settings-layout";
import { CalendarSettingsForm, useCalendarSettingsDraft } from "../components/calendar-settings-form";
import { CalendarAccessSettings, CalendarSettingsDialog } from "../components/calendar-settings";
import { CalendarEventEditor, CalendarTimeZoneField } from "../components/calendar-editor";
import { CalendarWorkingHoursSettings } from "../components/calendar-working-hours";
import { SettingsSection } from "../components/settings-layout";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { calendarApi, calendarColors, calendarRank, calendarViews, calendarWritable, type CalendarPreferences, type CalendarRecord } from "../lib/calendar";
import "./calendar-settings.css";

export function CalendarSettingsPage() {
  const calendar = useCalendar(), { pathname } = useLocation();
  const page = pathname.split("/")[3] ?? "general";
  return <CalendarSettingsLayout>
    <CalendarNotice error={calendar.error} />
    {!calendar.data ? <>{calendar.loading ? <LoadingSkeleton kind="form" label="Loading calendar settings…" /> : <Button onClick={() => calendar.refresh(true)}>Try again</Button>}</>
      : page === "events" ? <EventPreferences /> : page === "calendars" ? <CalendarManagement /> : page === "working-hours" ? <CalendarWorkingHoursSettings /> : page === "data" ? <IntegrationsData /> : <GeneralPreferences />}
    {calendar.data && calendar.settings && <CalendarSettingsDialog key={calendar.settings} id={calendar.settings} onClose={() => calendar.setSettings(null)} />}
    {calendar.data && calendar.create && <CalendarEventEditor request={calendar.create} onClose={() => calendar.setCreate(null)} onSaved={() => { calendar.setCreate(null); calendar.refresh(); }} />}
  </CalendarSettingsLayout>;
}

const generalValues = (prefs: CalendarPreferences) => ({ version: prefs.version, time_zone: prefs.time_zone, locale: prefs.locale, week_start: prefs.week_start, default_view: prefs.default_view, remember_view: prefs.remember_view, show_weekends: prefs.display_options.show_weekends !== false });
function GeneralPreferences() {
  const calendar = useCalendar(), notify = useNotifications(), prefs = calendar.data!.preferences;
  const draft = useCalendarSettingsDraft(generalValues(prefs)), { value, setValue } = draft;
  const update = <K extends keyof typeof value>(key: K, next: typeof value[K]) => setValue(old => ({ ...old, [key]: next }));
  return <CalendarSettingsForm dirty={draft.dirty} onReset={draft.reset} onSave={async () => {
    const { show_weekends, ...settings } = value;
    const saved = await calendar.savePreferences({ ...settings, display_options: { ...prefs.display_options, show_weekends } });
    draft.replace(generalValues(saved)); notify.success("Calendar preferences saved.");
  }}>
    <SettingsSection title="Language & region" description="These preferences apply to your account on every device. Date and time labels follow the selected regional format.">
      <div className="settings-form-grid"><CalendarTimeZoneField value={value.time_zone} onChange={next => update("time_zone", next)} />
        <CalendarField label="Regional format"><SelectControl aria-label="Regional format" value={value.locale} onValueChange={next => update("locale", next)} options={[
          { value: "en-US", label: "English (United States)" }, { value: "en-GB", label: "English (United Kingdom)" }, { value: "ko-KR", label: "한국어 (대한민국)" }, { value: "ja-JP", label: "日本語 (日本)" },
          ...(!["en-US", "en-GB", "ko-KR", "ja-JP"].includes(value.locale) ? [{ value: value.locale, label: value.locale === "en" ? "English" : value.locale }] : []),
        ]} /></CalendarField>
      </div>
    </SettingsSection>
    <SettingsSection title="Calendar display" description="Keep using your last view, or choose a view to use whenever you open Calendar.">
      <div className="settings-form-grid"><CalendarField label="Start view"><SelectControl aria-label="Start view" value={value.remember_view ? "last" : value.default_view} onValueChange={next => {
        if (next === "last") update("remember_view", true);
        else setValue(old => ({ ...old, remember_view: false, default_view: next as typeof old.default_view }));
      }} options={[{ value: "last", label: "Last used view" }, ...calendarViews]} /></CalendarField>
        <CalendarField label="Start week on"><SelectControl aria-label="Start week on" value={String(value.week_start)} onValueChange={next => update("week_start", Number(next))} options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, value) => ({ value: String(value), label }))} /></CalendarField>
      </div><label className="calendar-check-label"><CheckboxControl checked={value.show_weekends} onCheckedChange={next => update("show_weekends", next)} />Show weekends</label>
    </SettingsSection>
  </CalendarSettingsForm>;
}

const eventValues = (prefs: CalendarPreferences) => ({ version: prefs.version, default_duration_minutes: prefs.default_duration_minutes, default_calendar_id: prefs.default_calendar_id, invitation_policy: prefs.invitation_policy, show_declined: !!prefs.display_options.show_declined });
function EventPreferences() {
  const calendar = useCalendar(), notify = useNotifications(), prefs = calendar.data!.preferences;
  const draft = useCalendarSettingsDraft(eventValues(prefs)), { value, setValue } = draft;
  const destinations = calendar.data!.calendars.filter(calendarWritable);
  return <CalendarSettingsForm dirty={draft.dirty} onReset={draft.reset} onSave={async () => {
    const { show_declined, ...settings } = value;
    const saved = await calendar.savePreferences({ ...settings, ...(value.default_calendar_id === prefs.default_calendar_id ? { default_calendar_id: undefined } : {}), display_options: { ...prefs.display_options, show_declined } });
    draft.replace(eventValues(saved)); notify.success("Event preferences saved.");
  }}>
    <SettingsSection title="New events" description="Defaults for new events you create. Existing events keep their current settings.">
      <div className="settings-form-grid"><CalendarField label="Default calendar"><SelectControl aria-label="Default calendar" value={value.default_calendar_id ?? "primary"} onValueChange={next => setValue(old => ({ ...old, default_calendar_id: next === "primary" ? null : next }))} options={[
        { value: "primary", label: "My primary calendar" }, ...destinations.map(cal => ({ value: cal.id, label: cal.name })),
        ...(value.default_calendar_id && !destinations.some(cal => cal.id === value.default_calendar_id) ? [{ value: value.default_calendar_id, label: "Unavailable calendar (using primary)" }] : []),
      ]} /></CalendarField>
        <CalendarField label="Default event duration"><SelectControl aria-label="Default event duration" value={String(value.default_duration_minutes)} onValueChange={next => setValue(old => ({ ...old, default_duration_minutes: Number(next) }))} options={[...new Set([15, 30, 45, 60, 90, 120, value.default_duration_minutes])].sort((a, b) => a - b).map(value => ({ value: String(value), label: `${value} minutes` }))} /></CalendarField>
      </div>
    </SettingsSection>
    <SettingsSection title="Invitations" description="Choose when invitations appear in your calendar. Invitation notifications remain available in the notification center.">
      <div className="settings-form-grid"><CalendarField label="Add invitations"><SelectControl aria-label="Add invitations" value={value.invitation_policy} onValueChange={next => setValue(old => ({ ...old, invitation_policy: next }))} options={[
        { value: "all", label: "Automatically" }, { value: "on_response", label: "After I respond" }, ...(value.invitation_policy === "known_senders" ? [{ value: "known_senders", label: "From known senders" }] : []),
      ]} /></CalendarField></div>
      <label className="calendar-check-label"><CheckboxControl checked={value.show_declined} onCheckedChange={next => setValue(old => ({ ...old, show_declined: next }))} />Show declined events</label>
      <p className="settings-hint"><Link to="/profile/notifications">Manage notification delivery</Link></p>
    </SettingsSection>
  </CalendarSettingsForm>;
}

function CalendarManagement() {
  const calendar = useCalendar(), { calendarId } = useParams();
  const calendars = calendar.data!.calendars;
  if (calendarId) {
    const cal = calendars.find(cal => cal.id === calendarId);
    return cal ? <CalendarDetails key={cal.id} cal={cal} /> : <><p>This calendar is no longer available.</p><Link to="/calendar/settings/calendars">Back to calendars</Link></>;
  }
  return <SettingsSection title="Your calendars" description="Manage calendars you own and calendars shared with you. Display preferences affect only your account."
    action={calendar.can("calendars.create") && <Button onClick={() => calendar.setSettings("new")}><Icon name="plus" />Create calendar</Button>}>
    <div className="settings-record-list">{calendars.map(cal => {
      const sub = calendar.data!.subscriptions.find(sub => sub.calendar_id === cal.id);
      return <div className="settings-record" key={cal.id}><div><strong>{sub?.name_override ?? cal.name}</strong><p>{cal.kind === "external" ? "External subscription · Read only" : cal.is_primary ? "Primary calendar" : cal.effective_role.replaceAll("_", " ")}{sub?.hidden ? " · Hidden" : ""}</p></div>
        <Button nativeButton={false} render={<Link to={`/calendar/settings/calendars/${cal.id}`} />}>Manage</Button></div>;
    })}</div>
  </SettingsSection>;
}

function CalendarDetails({ cal }: { cal: CalendarRecord }) {
  const calendar = useCalendar(), notify = useNotifications();
  const sub = calendar.data!.subscriptions.find(sub => sub.calendar_id === cal.id);
  const editable = calendarRank(cal) >= 5 && cal.kind !== "external";
  const current = useRef({ cal, sub });
  const draft = useCalendarSettingsDraft({ name: cal.name, description: cal.description, time_zone: cal.time_zone,
    name_override: sub?.name_override ?? "", color: sub?.color ?? calendarColors[0]!.value, hidden: sub?.hidden ?? false, selected: sub?.selected ?? true, sort_order: sub?.sort_order ?? 0 });
  const { value, setValue } = draft;
  if (!draft.dirty) current.current = { cal, sub };
  const update = <K extends keyof typeof value>(key: K, next: typeof value[K]) => setValue(old => ({ ...old, [key]: next }));
  return <><Link className="calendar-settings-back" to="/calendar/settings/calendars">← All calendars</Link>
    <CalendarSettingsForm dirty={draft.dirty} onReset={draft.reset} onSave={async () => {
      let { cal: latest, sub: subscription } = current.current;
      if (editable && (value.name !== latest.name || value.description !== latest.description || value.time_zone !== latest.time_zone)) {
        const saved = await calendarApi<{ calendar: CalendarRecord }>(`/calendars/${cal.id}`, { method: "PATCH", body: { version: latest.version, name: value.name.trim(), description: value.description, time_zone: value.time_zone } });
        latest = saved.calendar; current.current.cal = latest;
        calendar.setData(old => ({ ...old, calendars: old.calendars.map(cal => cal.id === latest.id ? latest : cal) }));
      }
      const saved = await calendarApi<{ subscription: typeof sub }>(`/subscriptions/${cal.id}`, { method: subscription ? "PATCH" : "PUT", body: { ...(subscription ? { version: subscription.version } : {}), name_override: value.name_override.trim() || null, color: value.color, hidden: value.hidden, selected: value.selected, sort_order: value.sort_order } });
      if (saved.subscription) calendar.setData(old => ({ ...old, subscriptions: [...old.subscriptions.filter(sub => sub.calendar_id !== cal.id), saved.subscription!] }));
      draft.replace({ ...value, name: latest.name }); calendar.refresh(true); notify.success("Calendar settings saved.");
    }}>
      <SettingsSection title="Display preferences" description="Only you see changes to the display name, color, visibility and order.">
        <div className="settings-form-grid"><CalendarField label="Display name" value={value.name_override} placeholder={cal.name} maxLength={255} onChange={event => update("name_override", event.target.value)} />
          <CalendarField label="Sort order" hint="Lower numbers appear first." type="number" min={-1000000} max={1000000} value={value.sort_order} onChange={event => update("sort_order", Number(event.target.value))} />
          <CalendarField label="Color"><SelectControl aria-label="Calendar color" value={value.color} onValueChange={next => update("color", next)} options={[...calendarColors, ...(!calendarColors.some(color => color.value === value.color) ? [{ value: value.color, label: value.color }] : [])]} /></CalendarField>
        </div><label className="calendar-check-label"><CheckboxControl checked={value.selected} onCheckedChange={next => update("selected", next)} />Show events in my calendar</label>
        <label className="calendar-check-label"><CheckboxControl checked={value.hidden} onCheckedChange={next => update("hidden", next)} />Hide from my sidebar</label>
      </SettingsSection>
      <SettingsSection title="Calendar details" description={editable ? "Changes here apply to everyone who uses this calendar." : "The calendar owner manages these details."}>
        <div className="settings-form-grid"><CalendarField label="Calendar name" required maxLength={255} disabled={!editable} value={value.name} onChange={event => update("name", event.target.value)} /><CalendarTimeZoneField value={value.time_zone} disabled={!editable} onChange={next => update("time_zone", next)} /></div>
        <CalendarField label="Description"><Textarea aria-label="Calendar description" rows={3} maxLength={10000} disabled={!editable} value={value.description} onChange={event => update("description", event.target.value)} /></CalendarField>
      </SettingsSection>
    </CalendarSettingsForm>
    {calendarRank(cal) >= 5 && cal.kind !== "external" && <SettingsSection title="Sharing & access" description="Changes to sharing apply to everyone who uses this calendar."><CalendarAccessSettings cal={cal} /></SettingsSection>}
    {cal.kind === "external" && calendarRank(cal) >= 6 && <SettingsSection title="External calendar" description="Events are synchronized from their source and cannot be edited here."><Button onClick={() => calendar.setSettings(cal.id)}>Manage connection</Button></SettingsSection>}
  </>;
}

function IntegrationsData() {
  const calendar = useCalendar();
  const external = calendar.data!.calendars.filter(cal => cal.kind === "external");
  return <>
    <SettingsSection title="External calendars" description="Subscribe to an iCalendar URL. Updates flow from the source into Officeflare."
      action={calendar.can("calendars.create") && <Button onClick={() => calendar.setSettings("subscribe")}><Icon name="plus" />Subscribe by URL</Button>}>
      {external.length ? external.map(cal => <div className="settings-record" key={cal.id}><div><strong>{cal.name}</strong><p>Read-only iCalendar subscription</p></div>
        {calendarRank(cal) >= 6 ? <Button onClick={() => calendar.setSettings(cal.id)}>Connection & sync status</Button> : <span className="settings-hint">Managed by the owner</span>}
      </div>) : <p className="settings-hint">No external calendars connected.</p>}
    </SettingsSection>
    <SettingsSection title="Import events" description="Preview an ICS file, choose a destination calendar and review the import results.">
      <p className="settings-hint">Imports keep existing event UIDs from being added twice. Guests and reminders are not imported, and invitations are not sent.</p>
      <Button disabled={!calendar.can("events.create") || !calendar.data!.calendars.some(calendarWritable)} onClick={() => calendar.setSettings("import")}><Icon name="upload" />Import ICS file</Button>
    </SettingsSection>
  </>;
}

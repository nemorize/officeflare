import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button, CheckboxControl, Icon, Input, Menu, MenuPopup, SearchField, SelectControl } from "./ui";
import { CalendarIconButton } from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { useAccount } from "./account-context";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { calendarColors, calendarViews, type CalendarView } from "../lib/calendar";
import { addDays, civilDate, dateDays, dateLabel, startOfWeek, todayIn } from "../lib/calendar-date";
import "../routes/calendar.css";

export function CalendarMiniMonth({ onSelect }: { onSelect?: () => void }) {
  const calendar = useCalendar(), locale = calendar.data?.preferences.locale ?? "en", weekStart = calendar.data?.preferences.week_start ?? 1;
  const [month, setMonth] = useState(calendar.date);
  useEffect(() => setMonth(calendar.date), [calendar.date]);
  const first = civilDate(month).with({ day: 1 }).toString(), days = dateDays(startOfWeek(first, weekStart), 42), today = todayIn(calendar.zone);
  const selectedWeek = startOfWeek(calendar.date, weekStart);
  return <section className="calendar-mini" aria-label="Choose a date">
    <div className="calendar-mini-heading"><strong>{dateLabel(first, { month: "long", year: "numeric" }, locale)}</strong><div><CalendarIconButton icon="chevron" className="calendar-previous" size="sm" label="Previous mini-calendar month" onClick={() => setMonth(civilDate(first).subtract({ months: 1 }).toString())} /><CalendarIconButton icon="chevron" size="sm" label="Next mini-calendar month" onClick={() => setMonth(civilDate(first).add({ months: 1 }).toString())} /></div></div>
    <div className="calendar-mini-grid" role="grid" aria-label={dateLabel(first, { month: "long", year: "numeric" }, locale)}>
      <div className="calendar-mini-row" role="row">{days.slice(0, 7).map(date => <span key={date} role="columnheader" aria-label={dateLabel(date, { weekday: "long" }, locale)}>{dateLabel(date, { weekday: "narrow" }, locale)}</span>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div role="row" className="calendar-mini-row" key={week}>{days.slice(week * 7, week * 7 + 7).map(date => <button type="button" role="gridcell" key={date} aria-label={dateLabel(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, locale)} aria-selected={date === calendar.date} aria-current={date === today ? "date" : undefined}
        data-date={date} tabIndex={date === (days.includes(calendar.date) ? calendar.date : first) ? 0 : -1}
        data-outside={date.slice(0, 7) !== first.slice(0, 7) || undefined} data-in-week={calendar.view === "week" && date >= selectedWeek && date < addDays(selectedWeek, 7) || undefined}
        onClick={() => { calendar.navigate(date); onSelect?.(); }}
        onKeyDown={event => { const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key]; if (delta) { event.preventDefault(); const next = addDays(date, delta), mini = event.currentTarget.closest(".calendar-mini"); calendar.navigate(next); requestAnimationFrame(() => mini?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus()); } }}
      >{civilDate(date).day}</button>)}</div>)}
    </div>
  </section>;
}
export function CalendarSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const calendar = useCalendar(), { user } = useAccount(), location = useLocation();
  const own = calendar.data?.calendars.filter(cal => cal.data_owner_user_id === user?.id).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)) ?? [];
  const other = calendar.data?.calendars.filter(cal => cal.data_owner_user_id !== user?.id) ?? [];
  const section = (title: string, calendars: typeof own, add?: boolean) => <section className="calendar-list-section">
    <div className="calendar-list-heading"><h2>{title}</h2>{add && calendar.can("calendars.create") && <CalendarIconButton icon="plus" label="Create a calendar" size="sm" onClick={() => calendar.setSettings("new")} />}</div>
    {calendars.map((cal, index) => {
      const sub = calendar.data?.subscriptions.find(item => item.calendar_id === cal.id), color = sub?.color ?? calendarColors[0]!.value;
      return <div className="calendar-list-item" key={cal.id} style={{ "--calendar-color": color } as CSSProperties}>
        <label><CheckboxControl checked={!!sub?.selected && !sub.hidden} onCheckedChange={selected => { void calendar.toggleCalendar(cal.id, selected); }} /><span title={sub?.name_override ?? cal.name}>{sub?.name_override ?? cal.name}</span></label>
        <CalendarIconButton icon="more" size="sm" label={`Settings for ${cal.name}`} onClick={() => calendar.setSettings(cal.id)} />
      </div>;
    })}
    {!calendars.length && <p className="calendar-sidebar-empty">{title === "My calendars" ? "Your calendars will appear here." : "Calendars shared with you appear here."}</p>}
  </section>;
  return <div className="calendar-sidebar-body">
    <div className="workspace-create-action calendar-create"><Button className="workspace-create-button" variant="primary" size="lg" disabled={!calendar.can("events.create") || !calendar.data} onClick={() => { calendar.setCreate({ date: calendar.date }); onNavigate?.(); }}><Icon name="plus" width="19" height="19" />New<Icon name="down" width="12" height="12" /></Button></div>
    <CalendarMiniMonth onSelect={onNavigate} />
    <div className="calendar-sidebar-calendars">{section("My calendars", own, true)}{section("Other calendars", other)}</div>
    <nav className="workspace-nav calendar-sidebar-links" aria-label="Calendar navigation">
      <Link to="/calendar" aria-current={location.pathname === "/calendar" ? "page" : undefined} onClick={onNavigate}><Icon name="calendar" /><span>Calendar</span></Link>
      <Link to="/calendar/shared" aria-current={location.pathname === "/calendar/shared" ? "page" : undefined} onClick={onNavigate}><Icon name="users" /><span>Shared calendars</span></Link>
      <Link to="/calendar/trash" aria-current={location.pathname === "/calendar/trash" ? "page" : undefined} onClick={onNavigate}><Icon name="trash" /><span>Trash</span></Link>
    </nav>
    <button className="calendar-zone-button" onClick={() => calendar.setSettings("preferences")}><Icon name="clock" width="13" height="13" /><span>{calendar.zone.replaceAll("_", " ")}</span><Icon name="down" width="11" height="11" /></button>
  </div>;
}
export function CalendarTopbar({ mobileAccount }: { mobileAccount: ReactNode }) {
  const calendar = useCalendar(), mobile = useWorkspaceMobile(), location = useLocation(), navigate = useNavigate();
  const [menu, setMenu] = useState(false), [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(calendar.query);
  const searchInput = useRef<HTMLInputElement>(null);
  const locale = calendar.data?.preferences.locale ?? "en", active = location.pathname === "/calendar";
  useEffect(() => setQuery(calendar.query), [calendar.query]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const start = calendar.range.start, end = addDays(calendar.range.end, -1);
  const heading = calendar.view === "day" ? dateLabel(calendar.date, { month: "long", day: "numeric", year: "numeric" }, locale)
    : calendar.view === "month" ? dateLabel(calendar.date, { month: "long", year: "numeric" }, locale)
      : start.slice(0, 7) === end.slice(0, 7) ? dateLabel(start, { month: "long", year: "numeric" }, locale)
        : `${dateLabel(start, { month: "short", ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: "numeric" } : {}) }, locale)} – ${dateLabel(end, { month: "short", year: "numeric" }, locale)}`;
  return <header className="workspace-topbar calendar-topbar">
    <CalendarIconButton icon="menu" label="Toggle calendar navigation" aria-expanded={mobile ? menu : !calendar.sidebarCollapsed} onClick={() => mobile ? setMenu(true) : calendar.setSidebarCollapsed(!calendar.sidebarCollapsed)} />
    <WorkspaceNavigationDrawer open={menu} onOpenChange={setMenu} title="Calendar" account={mobileAccount}><CalendarSidebar onNavigate={() => setMenu(false)} /></WorkspaceNavigationDrawer>
    {active && !searchOpen ? <>
      <Button className="calendar-today-button" onClick={() => calendar.navigate(todayIn(calendar.zone))}>Today</Button>
      <div className="calendar-period-navigation"><CalendarIconButton icon="chevron" className="calendar-previous" label="Previous period" onClick={() => calendar.step(-1)} /><CalendarIconButton icon="chevron" label="Next period" onClick={() => calendar.step(1)} /></div>
      <h1 className="calendar-period-title" aria-live="polite">{calendar.query ? "Search results" : heading}</h1>
    </> : !active ? <h1 className="calendar-period-title">{location.pathname.endsWith("trash") ? "Trash" : "Shared calendars"}</h1> : null}
    {active && searchOpen && <SearchField className="calendar-search" onSubmit={event => { event.preventDefault(); calendar.search(query); setSearchOpen(false); }}><Icon name="search" /><Input ref={searchInput} variant="integrated" aria-label="Search events" placeholder="Search events" value={query} maxLength={255} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setSearchOpen(false); }} /><CalendarIconButton icon="close" label="Close search" onClick={() => setSearchOpen(false)} /></SearchField>}
    <div className="calendar-topbar-actions">
      {active && !searchOpen && <CalendarIconButton icon="search" label="Search events" onClick={() => setSearchOpen(true)} />}
      <Menu.Root><Menu.Trigger render={<Button variant="ghost" size="icon" aria-label="Calendar settings and tools" />}><Icon name="settings" /></Menu.Trigger><MenuPopup data-ui-theme="neutral" positionerProps={{ align: "end" }}>
        <Menu.Item onClick={() => { calendar.navigate(todayIn(calendar.zone)); }}>Today</Menu.Item>
        {active && <Menu.Item onClick={() => setSearchOpen(true)}><Icon name="search" />Search events</Menu.Item>}
        <Menu.Item onClick={() => calendar.setSettings("preferences")}><Icon name="settings" />Settings</Menu.Item>
        <Menu.Item onClick={() => calendar.setSettings("working-hours")}><Icon name="clock" />Working hours</Menu.Item>
        <Menu.Item onClick={() => calendar.refresh(true)}><Icon name="refresh" />Refresh</Menu.Item>
        <Menu.Item onClick={() => calendar.setSettings("shortcuts")}><Icon name="code" />Keyboard shortcuts</Menu.Item>
        <Menu.Separator /><Menu.Item onClick={() => navigate("/calendar/trash")}><Icon name="trash" />Trash</Menu.Item>
      </MenuPopup></Menu.Root>
      {active && <SelectControl className="calendar-view-select" variant="outline" aria-label="Calendar view" value={calendar.view} onValueChange={view => calendar.navigate(calendar.date, view as CalendarView)} options={calendarViews} />}
    </div>
  </header>;
}

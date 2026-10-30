import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Button, CheckboxControl, Icon, Input, SearchField, SelectControl } from "./ui";
import { CalendarIconButton } from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { useAccount } from "./account-context";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import {
  calendarColors,
  calendarViews,
  type CalendarView,
  type CalendarRecord,
} from "../lib/calendar";
import {
  addDays,
  civilDate,
  dateDays,
  dateLabel,
  startOfWeek,
  todayIn,
} from "../lib/calendar-date";
import "../routes/calendar.css";

export function CalendarMiniMonth({ onSelect }: { onSelect?: () => void }) {
  const calendar = useCalendar(),
    locale = calendar.data?.preferences.locale ?? "en",
    weekStart = calendar.data?.preferences.week_start ?? 1;
  const [month, setMonth] = useState(calendar.date);
  useEffect(() => setMonth(calendar.date), [calendar.date]);
  const first = civilDate(month).with({ day: 1 }).toString(),
    days = dateDays(startOfWeek(first, weekStart), 42),
    today = todayIn(calendar.zone);
  const selectedWeek = startOfWeek(calendar.date, weekStart);
  return (
    <section className="calendar-mini" aria-label={t("componentsCalendarChrome.chooseADate")}>
      <div className="calendar-mini-heading">
        <strong>{dateLabel(first, { month: "long", year: "numeric" }, locale)}</strong>
        <div>
          <CalendarIconButton
            icon="chevron"
            className="calendar-previous"
            size="sm"
            label={t("componentsCalendarChrome.previousMiniCalendarMonth")}
            onClick={() => setMonth(civilDate(first).subtract({ months: 1 }).toString())}
          />
          <CalendarIconButton
            icon="chevron"
            size="sm"
            label={t("componentsCalendarChrome.nextMiniCalendarMonth")}
            onClick={() => setMonth(civilDate(first).add({ months: 1 }).toString())}
          />
        </div>
      </div>
      <div
        className="calendar-mini-grid"
        role="grid"
        aria-label={dateLabel(first, { month: "long", year: "numeric" }, locale)}
      >
        <div className="calendar-mini-row" role="row">
          {days.slice(0, 7).map((date) => (
            <span
              key={date}
              role="columnheader"
              aria-label={dateLabel(date, { weekday: "long" }, locale)}
            >
              {dateLabel(date, { weekday: "narrow" }, locale)}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div role="row" className="calendar-mini-row" key={week}>
            {days.slice(week * 7, week * 7 + 7).map((date) => (
              <button
                type="button"
                role="gridcell"
                key={date}
                aria-label={dateLabel(
                  date,
                  { weekday: "long", month: "long", day: "numeric", year: "numeric" },
                  locale,
                )}
                aria-selected={date === calendar.date}
                aria-current={date === today ? "date" : undefined}
                data-date={date}
                tabIndex={date === (days.includes(calendar.date) ? calendar.date : first) ? 0 : -1}
                data-outside={date.slice(0, 7) !== first.slice(0, 7) || undefined}
                data-in-week={
                  (calendar.view === "week" &&
                    date >= selectedWeek &&
                    date < addDays(selectedWeek, 7)) ||
                  undefined
                }
                onClick={() => {
                  calendar.navigate(date);
                  onSelect?.();
                }}
                onKeyDown={(event) => {
                  const delta = (
                    { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
                      string,
                      number
                    >
                  )[event.key];
                  if (delta) {
                    event.preventDefault();
                    const next = addDays(date, delta),
                      mini = event.currentTarget.closest(".calendar-mini");
                    calendar.navigate(next);
                    requestAnimationFrame(() =>
                      mini?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus(),
                    );
                  }
                }}
              >
                {civilDate(date).day}
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
export function CalendarSettingsButton({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <CalendarIconButton
      icon="settings"
      label={t("componentsCalendarChrome.calendarSettings")}
      nativeButton={false}
      render={<NavLink to="/calendar/settings" onClick={onNavigate} />}
    />
  );
}
export function CalendarSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const calendar = useCalendar(),
    { user } = useAccount(),
    navigate = useNavigate();
  const order = (a: CalendarRecord, b: CalendarRecord) =>
    (calendar.data?.subscriptions.find((sub) => sub.calendar_id === a.id)?.sort_order ?? 0) -
      (calendar.data?.subscriptions.find((sub) => sub.calendar_id === b.id)?.sort_order ?? 0) ||
    Number(b.is_primary) - Number(a.is_primary) ||
    a.name.localeCompare(b.name);
  const visible =
    calendar.data?.calendars.filter(
      (cal) => !calendar.data?.subscriptions.find((sub) => sub.calendar_id === cal.id)?.hidden,
    ) ?? [];
  const own = visible.filter((cal) => cal.data_owner_user_id === user?.id).sort(order);
  const other = visible.filter((cal) => cal.data_owner_user_id !== user?.id).sort(order);
  const section = (title: string, calendars: typeof own, add?: boolean) => (
    <section className="calendar-list-section">
      <div className="calendar-list-heading">
        <h2>{title}</h2>
        {add && calendar.can("calendars.create") && (
          <CalendarIconButton
            icon="plus"
            label={t("componentsCalendarChrome.createACalendar")}
            size="sm"
            onClick={() => calendar.setSettings("new")}
          />
        )}
      </div>
      {calendars.map((cal, index) => {
        const sub = calendar.data?.subscriptions.find((item) => item.calendar_id === cal.id),
          color = sub?.color ?? calendarColors[0]!.value;
        return (
          <div
            className="calendar-list-item"
            key={cal.id}
            style={{ "--calendar-color": color } as CSSProperties}
          >
            <label>
              <CheckboxControl
                checked={!!sub?.selected && !sub.hidden}
                onCheckedChange={(selected) => {
                  void calendar.toggleCalendar(cal.id, selected);
                }}
              />
              <span title={sub?.name_override ?? cal.name}>{sub?.name_override ?? cal.name}</span>
            </label>
            <CalendarIconButton
              icon="more"
              size="sm"
              label={t("componentsCalendarChrome.settingsFor", { name: cal.name })}
              onClick={() => {
                navigate(`/calendar/settings/calendars/${cal.id}`);
                onNavigate?.();
              }}
            />
          </div>
        );
      })}
      {!calendars.length && (
        <p className="calendar-sidebar-empty">
          {add
            ? t("componentsCalendarChrome.yourCalendarsWillAppearHere")
            : t("componentsCalendarChrome.calendarsSharedWithYouAppearHere")}
        </p>
      )}
    </section>
  );
  return (
    <div className="calendar-sidebar-body">
      <div className="workspace-create-action calendar-create">
        <Button
          className="workspace-create-button"
          variant="primary"
          size="lg"
          disabled={!calendar.can("events.create") || !calendar.data}
          onClick={() => {
            calendar.setCreate({ date: calendar.date });
            onNavigate?.();
          }}
        >
          <Icon name="plus" width="19" height="19" />
          {t("componentsCalendarChrome.new")}
          <Icon name="down" width="12" height="12" />
        </Button>
      </div>
      <CalendarMiniMonth onSelect={onNavigate} />
      <div className="calendar-sidebar-calendars">
        {section(t("componentsCalendarChrome.myCalendars"), own, true)}
        {section(t("componentsCalendarChrome.otherCalendars"), other)}
      </div>
    </div>
  );
}
export function CalendarTopbar({ mobileAccount }: { mobileAccount: ReactNode }) {
  const calendar = useCalendar(),
    mobile = useWorkspaceMobile(),
    location = useLocation();
  const [menu, setMenu] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(calendar.query);
  const searchInput = useRef<HTMLInputElement>(null);
  const locale = calendar.data?.preferences.locale ?? "en",
    active = location.pathname === "/calendar";
  useEffect(() => setQuery(calendar.query), [calendar.query]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const start = calendar.range.start,
    end = addDays(calendar.range.end, -1);
  const heading =
    calendar.view === "day"
      ? dateLabel(calendar.date, { month: "long", day: "numeric", year: "numeric" }, locale)
      : calendar.view === "month"
        ? dateLabel(calendar.date, { month: "long", year: "numeric" }, locale)
        : start.slice(0, 7) === end.slice(0, 7)
          ? dateLabel(start, { month: "long", year: "numeric" }, locale)
          : `${dateLabel(start, { month: "short", ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: "numeric" } : {}) }, locale)} – ${dateLabel(end, { month: "short", year: "numeric" }, locale)}`;
  return (
    <header className="workspace-topbar calendar-topbar">
      <CalendarIconButton
        icon="menu"
        label={t("componentsCalendarChrome.toggleCalendarNavigation")}
        aria-expanded={mobile ? menu : !calendar.sidebarCollapsed}
        onClick={() =>
          mobile ? setMenu(true) : calendar.setSidebarCollapsed(!calendar.sidebarCollapsed)
        }
      />
      <WorkspaceNavigationDrawer
        open={menu}
        onOpenChange={setMenu}
        title={t("componentsCalendarChrome.calendar")}
        account={mobileAccount}
        actions={<CalendarSettingsButton onNavigate={() => setMenu(false)} />}
      >
        <CalendarSidebar onNavigate={() => setMenu(false)} />
      </WorkspaceNavigationDrawer>
      {active && !searchOpen ? (
        <>
          <Button
            className="calendar-today-button"
            onClick={() => calendar.navigate(todayIn(calendar.zone))}
          >
            {t("componentsCalendarChrome.today")}
          </Button>
          <div className="calendar-period-navigation">
            <CalendarIconButton
              icon="chevron"
              className="calendar-previous"
              label={t("componentsCalendarChrome.previousPeriod")}
              onClick={() => calendar.step(-1)}
            />
            <CalendarIconButton
              icon="chevron"
              label={t("componentsCalendarChrome.nextPeriod")}
              onClick={() => calendar.step(1)}
            />
          </div>
          <h1 className="calendar-period-title" aria-live="polite">
            {calendar.query ? t("componentsCalendarChrome.searchResults") : heading}
          </h1>
        </>
      ) : !active ? (
        <div className="calendar-period-title">
          {location.pathname.startsWith("/calendar/settings")
            ? t("componentsCalendarChrome.calendarSettings")
            : location.pathname.endsWith("trash")
              ? t("componentsCalendarChrome.trash")
              : t("componentsCalendarChrome.sharedCalendars")}
        </div>
      ) : null}
      {active && searchOpen && (
        <SearchField
          className="calendar-search"
          onSubmit={(event) => {
            event.preventDefault();
            calendar.search(query);
            setSearchOpen(false);
          }}
        >
          <Icon name="search" />
          <Input
            ref={searchInput}
            variant="integrated"
            aria-label={t("componentsCalendarChrome.searchEvents")}
            placeholder={t("componentsCalendarChrome.searchEvents")}
            value={query}
            maxLength={255}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
            }}
          />
          <CalendarIconButton
            icon="close"
            label={t("componentsCalendarChrome.closeSearch")}
            onClick={() => setSearchOpen(false)}
          />
        </SearchField>
      )}
      <div className="calendar-topbar-actions">
        {active && !searchOpen && (
          <CalendarIconButton
            icon="search"
            className="calendar-search-button"
            label={t("componentsCalendarChrome.searchEvents")}
            onClick={() => setSearchOpen(true)}
          />
        )}
        {active && (
          <SelectControl
            className="calendar-view-select"
            variant="outline"
            aria-label={t("componentsCalendarChrome.calendarView")}
            value={calendar.view}
            onValueChange={(view) => calendar.navigate(calendar.date, view as CalendarView)}
            options={calendarViews}
          />
        )}
      </div>
    </header>
  );
}

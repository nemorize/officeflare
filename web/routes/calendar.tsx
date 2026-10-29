import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button, CheckboxControl, Icon, useNotifications } from "../components/ui";
import { useCalendar } from "../components/calendar-context";
import {
  CalendarModal,
  CalendarNotice,
  useCalendarAction,
  useCalendarResource,
} from "../components/calendar-controls";
import {
  CalendarAgenda,
  CalendarMonth,
  CalendarTimeGrid,
  type CalendarViewActions,
} from "../components/calendar-views";
import { CalendarEventEditor, CalendarScopeDialog } from "../components/calendar-editor";
import { CalendarEventDetail } from "../components/calendar-detail";
import {
  CalendarCollaborationDialog,
  CalendarShareLinks,
} from "../components/calendar-collaboration";
import { CalendarSettingsDialog } from "../components/calendar-settings";
import { LoadingSkeleton } from "../components/loading-skeleton";
import {
  calendarApi,
  calendarFailure,
  calendarRank,
  calendarViews,
  eventKey,
  eventPath,
  type CalendarEvent,
  type CalendarScope,
} from "../lib/calendar";
import {
  addDays,
  dateLabel,
  localEndpoint,
  minuteTime,
  shiftedEventTimes,
  todayIn,
} from "../lib/calendar-date";
import { draftForEvent, eventChanges } from "../lib/calendar-editor";

function CalendarEmpty({
  icon = "calendar",
  title,
  children,
}: {
  icon?: "calendar" | "trash" | "users" | "search";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="calendar-empty">
      <span>
        <Icon name={icon} width="28" height="28" />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
function SharedCalendars() {
  const calendar = useCalendar(),
    [sharing, setSharing] = useState<string | null>(null);
  const shared = calendar.data!.calendars.filter((cal) => !cal.is_primary);
  return (
    <div className="calendar-management-page">
      <div className="calendar-management-heading">
        <div>
          <h2>Shared calendars</h2>
          <p>Keep your team, projects and personal plans together.</p>
        </div>
        {calendar.can("calendars.create") && (
          <Button onClick={() => calendar.setSettings("new")}>
            <Icon name="plus" />
            Create calendar
          </Button>
        )}
      </div>
      {!shared.length ? (
        <CalendarEmpty icon="users" title="A little more room for your plans">
          Create a calendar for your team or project. Calendars shared with you will also appear
          here.
        </CalendarEmpty>
      ) : (
        <div className="calendar-shared-cards">
          {shared.map((cal) => {
            const sub = calendar.data!.subscriptions.find((sub) => sub.calendar_id === cal.id);
            return (
              <article key={cal.id}>
                <div>
                  <span className="calendar-shared-card-icon">
                    <Icon name="calendar" width="23" height="23" />
                  </span>
                  <label>
                    <CheckboxControl
                      checked={!!sub?.selected}
                      onCheckedChange={(value) => {
                        void calendar.toggleCalendar(cal.id, value);
                      }}
                    />
                    <span className="visually-hidden">Display {cal.name}</span>
                  </label>
                </div>
                <h3>{cal.name}</h3>
                <p>{cal.description || cal.time_zone.replaceAll("_", " ")}</p>
                <span className="calendar-small-tag">
                  {cal.effective_role.replaceAll("_", " ")}
                </span>
                <footer>
                  <Button
                    size="sm"
                    variant="text"
                    nativeButton={false}
                    render={<Link to={`/calendar/settings/calendars/${cal.id}`} />}
                  >
                    Settings
                  </Button>
                  {calendarRank(cal) >= 5 && calendar.can("sharing.external") && (
                    <Button size="sm" variant="text" onClick={() => setSharing(cal.id)}>
                      <Icon name="link" />
                      Share link
                    </Button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {sharing && (
        <CalendarModal
          title={`Share ${calendar.data!.calendars.find((cal) => cal.id === sharing)?.name ?? "calendar"}`}
          onClose={() => setSharing(null)}
          className="calendar-collaboration-modal"
        >
          <CalendarShareLinks calendarId={sharing} />
        </CalendarModal>
      )}
    </div>
  );
}
function CalendarTrash() {
  const calendar = useCalendar(),
    notify = useNotifications(),
    action = useCalendarAction();
  const [cursor, setCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<string[]>([]);
  const resource = useCalendarResource<{ events: CalendarEvent[]; next_cursor: string | null }>(
    `/trash/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    calendar.revision,
  );
  return (
    <div className="calendar-management-page">
      <div className="calendar-management-heading">
        <div>
          <h2>Deleted events</h2>
          <p>Restore events from calendars you own.</p>
        </div>
        <Button variant="ghost" onClick={() => calendar.refresh()}>
          <Icon name="refresh" />
          Refresh
        </Button>
      </div>
      <CalendarNotice error={resource.error || action.error} />
      {resource.loading ? (
        <LoadingSkeleton kind="list" label="Loading deleted events…" />
      ) : resource.data?.events.length ? (
        <div className="calendar-trash-list">
          {resource.data.events.map((event) => (
            <div key={eventKey(event)}>
              <Icon name="calendar" />
              <div>
                <strong>{event.title}</strong>
                <small>
                  {dateLabel(event.start.date ?? event.start.date_time!.slice(0, 10))} ·{" "}
                  {calendar.data?.calendars.find((cal) => cal.id === event.calendar_id)?.name ??
                    "Calendar"}
                </small>
              </div>
              <Button
                size="sm"
                disabled={action.busy || !calendar.can("events.update")}
                onClick={() => {
                  void action.run(async () => {
                    await calendarApi(`${eventPath(event)}/restore`, {
                      method: "POST",
                      body: { version: event.version, scope: "all" },
                    });
                    calendar.refresh();
                    notify.success("Event restored.");
                  });
                }}
              >
                <Icon name="undo" />
                Restore
              </Button>
            </div>
          ))}
        </div>
      ) : (
        !resource.error && (
          <CalendarEmpty icon="trash" title="Your trash is empty">
            Deleted events will appear here.
          </CalendarEmpty>
        )
      )}
      <div className="calendar-dialog-actions">
        {previous.length > 0 && (
          <Button
            onClick={() => {
              setCursor(previous.at(-1) || null);
              setPrevious((old) => old.slice(0, -1));
            }}
          >
            Previous
          </Button>
        )}
        {resource.data?.next_cursor && (
          <Button
            onClick={() => {
              setPrevious((old) => [...old, cursor ?? ""]);
              setCursor(resource.data!.next_cursor);
            }}
          >
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
interface PendingChange {
  event: CalendarEvent;
  master: CalendarEvent;
  times?: Pick<CalendarEvent, "start" | "end">;
}
export function CalendarPage() {
  const calendar = useCalendar(),
    location = useLocation(),
    notify = useNotifications(),
    action = useCalendarAction();
  const [detail, setDetail] = useState<{ event: CalendarEvent; anchor: HTMLElement } | null>(null),
    [editing, setEditing] = useState<CalendarEvent | null>(null),
    [manage, setManage] = useState<{ event: CalendarEvent; tab: string } | null>(null),
    [pending, setPending] = useState<PendingChange | null>(null);
  const preparing = useRef(false),
    main = location.pathname === "/calendar";
  useEffect(() => {
    setDetail(null);
  }, [calendar.date, calendar.view, calendar.query, location.pathname]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !main ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        document.querySelector(
          '[data-ui="dialog-popup"], [data-ui="popover-popup"], [data-ui="menu-popup"]',
        ) ||
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable=true],[role=combobox]",
        )
      )
        return;
      const key = event.key.toLowerCase(),
        view = calendarViews.find((view) => view.key.toLowerCase() === key);
      if (view) {
        event.preventDefault();
        calendar.navigate(calendar.date, view.value);
      } else if (key === "t") calendar.navigate(todayIn(calendar.zone));
      else if (key === "j" || key === "k") calendar.step(key === "j" ? 1 : -1);
      else if (key === "c" && calendar.can("events.create")) {
        event.preventDefault();
        calendar.setCreate({ date: calendar.date });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [calendar, main]);
  const commit = (change: PendingChange, scope: CalendarScope) =>
    action.run(async () => {
      const { event, master, times } = change;
      if (times) {
        const initial = draftForEvent({ ...event, recurrence: master.recurrence }, calendar.zone),
          draft = draftForEvent(
            { ...event, ...times, recurrence: master.recurrence },
            calendar.zone,
          );
        await calendarApi(eventPath(event), {
          method: "PATCH",
          body: {
            ...eventChanges(draft, initial, master, scope),
            version: event.version,
            ...(master.recurrence?.length ? { scope, occurrence_key: event.occurrence_key } : {}),
          },
        });
      } else {
        const params = new URLSearchParams({
          version: String(event.version),
          ...(master.recurrence?.length ? { scope, occurrence_key: event.occurrence_key! } : {}),
        });
        await calendarApi(`${eventPath(event)}?${params}`, { method: "DELETE" });
      }
      setPending(null);
      setDetail(null);
      calendar.refresh();
      notify.success(times ? "Event updated." : "Event moved to trash.");
    });
  const prepare = async (event: CalendarEvent, times?: Pick<CalendarEvent, "start" | "end">) => {
    if (preparing.current || action.busy) return;
    preparing.current = true;
    action.setError("");
    try {
      const { event: master } = await calendarApi<{ event: CalendarEvent }>(eventPath(event));
      if (master.version !== event.version) {
        calendar.refresh();
        throw new Error("This event changed. Open its latest version and try again.");
      }
      const change = { event, master, times };
      if (master.recurrence?.length || !times) {
        setDetail(null);
        setPending(change);
      } else await commit(change, "all");
    } catch (failure) {
      notify.error(calendarFailure(failure));
    } finally {
      preparing.current = false;
    }
  };
  const actions: CalendarViewActions = {
    onOpen: (event, anchor) => setDetail({ event, anchor }),
    onEdit: (event) => {
      setDetail(null);
      setEditing(event);
    },
    onMove: (event, date, minute) => {
      try {
        void prepare(event, shiftedEventTimes(event, date, calendar.zone, minute));
      } catch (failure) {
        notify.error(calendarFailure(failure));
      }
    },
    onResize: (event, date, minute) => {
      try {
        void prepare(event, {
          start: event.start,
          end: localEndpoint(
            addDays(date, Math.floor(minute / 1440)),
            minuteTime(minute % 1440),
            calendar.zone,
          ),
        });
      } catch (failure) {
        notify.error(calendarFailure(failure));
      }
    },
  };
  const closeEditor = () => {
    setEditing(null);
    calendar.setCreate(null);
  };
  // The grid does not depend on metadata or event results. Paint it immediately
  // and keep creation disabled until an editable calendar is available.
  if (main && !calendar.data && !calendar.error && !calendar.query && calendar.view !== "agenda")
    return (
      <section className="calendar-page calendar-main-page" aria-label="Calendar" aria-busy="true">
        <div className="calendar-loading-line" role="status">
          <span className="visually-hidden">Opening your calendar…</span>
        </div>
        {calendar.view === "month" ? (
          <CalendarMonth actions={actions} />
        ) : (
          <CalendarTimeGrid actions={actions} />
        )}
      </section>
    );
  return (
    <section className={`calendar-page${main ? " calendar-main-page" : ""}`} aria-label="Calendar">
      {!calendar.data ? (
        <div className="calendar-startup">
          <LoadingSkeleton kind="page" label="Opening your calendar…" />
          <CalendarNotice error={calendar.error} />
          {calendar.error && <Button onClick={() => calendar.refresh(true)}>Try again</Button>}
        </div>
      ) : (
        <>
          <CalendarNotice
            error={calendar.error || (main ? calendar.eventsError || action.error : "")}
          />
          {!main ? (
            location.pathname.endsWith("trash") ? (
              <CalendarTrash />
            ) : (
              <SharedCalendars />
            )
          ) : (
            <>
              {calendar.query && (
                <div className="calendar-search-summary">
                  <span>
                    Results for <strong>{calendar.query}</strong> ·{" "}
                    {dateLabel(calendar.range.start, { month: "short", day: "numeric" })} –{" "}
                    {dateLabel(addDays(calendar.range.end, -1), { month: "short", day: "numeric" })}
                  </span>
                  <Button size="sm" variant="text" onClick={() => calendar.search("")}>
                    <Icon name="close" />
                    Clear search
                  </Button>
                </div>
              )}
              {calendar.eventsLoading && (
                <div className="calendar-loading-line" role="status">
                  <span className="visually-hidden">Loading events…</span>
                </div>
              )}
              {!calendar.selectedIds.length ? (
                <CalendarEmpty title="Choose a calendar to get started">
                  Select a calendar in the sidebar to see your events.
                </CalendarEmpty>
              ) : calendar.query || calendar.view === "agenda" ? (
                calendar.events.length ? (
                  <CalendarAgenda actions={actions} />
                ) : (
                  !calendar.eventsLoading && (
                    <CalendarEmpty
                      icon={calendar.query ? "search" : "calendar"}
                      title={calendar.query ? "No matching events" : "Your schedule is clear"}
                    >
                      {calendar.query
                        ? "Try another search or move to a different period."
                        : "Create an event or choose another date to see what's coming up."}
                    </CalendarEmpty>
                  )
                )
              ) : calendar.view === "month" ? (
                <CalendarMonth actions={actions} />
              ) : (
                <CalendarTimeGrid actions={actions} />
              )}
              {calendar.can("events.create") && (
                <Button
                  variant="primary"
                  size="icon"
                  className="calendar-mobile-create"
                  aria-label="Create event"
                  onClick={() => calendar.setCreate({ date: calendar.date })}
                >
                  <Icon name="plus" width="22" height="22" />
                </Button>
              )}
            </>
          )}
          {detail && (
            <CalendarEventDetail
              key={eventKey(detail.event)}
              event={detail.event}
              anchor={detail.anchor}
              onClose={() => setDetail(null)}
              onEdit={actions.onEdit}
              onDelete={(event) => {
                void prepare(event);
              }}
              onManage={(event, tab) => {
                setDetail(null);
                setManage({ event, tab });
              }}
            />
          )}
          {(calendar.create || editing) && (
            <CalendarEventEditor
              key={editing ? eventKey(editing) : "create"}
              event={editing ?? undefined}
              request={calendar.create ?? undefined}
              onClose={closeEditor}
              onSaved={() => {
                closeEditor();
                calendar.refresh();
              }}
            />
          )}
          {manage && (
            <CalendarCollaborationDialog
              event={manage.event}
              initialTab={manage.tab}
              onClose={() => setManage(null)}
            />
          )}
          {calendar.settings && (
            <CalendarSettingsDialog
              key={calendar.settings}
              id={calendar.settings}
              onClose={() => calendar.setSettings(null)}
            />
          )}
          {pending &&
            (pending.master.recurrence?.length ? (
              <CalendarScopeDialog
                error={action.error}
                title={pending.times ? "Move repeating event" : "Delete repeating event"}
                busy={action.busy}
                onClose={() => setPending(null)}
                onConfirm={(scope) => {
                  void commit(pending, scope);
                }}
              />
            ) : (
              <CalendarModal
                title="Delete event?"
                description="This event will move to trash. Guests will receive an update."
                busy={action.busy}
                onClose={() => setPending(null)}
              >
                <CalendarNotice error={action.error} />
                <div className="calendar-dialog-actions">
                  <Button onClick={() => setPending(null)}>Cancel</Button>
                  <Button
                    variant="danger"
                    disabled={action.busy}
                    onClick={() => {
                      void commit(pending, "all");
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </CalendarModal>
            ))}
        </>
      )}
    </section>
  );
}

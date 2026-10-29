import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Button, Icon } from "./ui";
import { CalendarModal } from "./calendar-controls";
import { useCalendar } from "./calendar-context";
import { calendarColors, calendarWritable, eventKey, type CalendarEvent } from "../lib/calendar";
import {
  addDays,
  civilDate,
  dateLabel,
  endpointLocal,
  eventDateLabel,
  eventDayBounds,
  eventTimeLabel,
  HOUR_HEIGHT,
  monthPlacements,
  occursOn,
  timedPlacements,
  timeLabel,
  todayIn,
} from "../lib/calendar-date";

export interface CalendarViewActions {
  onOpen: (event: CalendarEvent, anchor: HTMLElement) => void;
  onMove: (event: CalendarEvent, date: string, minute?: number) => void;
  onResize: (event: CalendarEvent, date: string, minute: number) => void;
  onEdit: (event: CalendarEvent) => void;
}
export function useEventAppearance() {
  const calendar = useCalendar();
  return (event: CalendarEvent) =>
    ({
      "--event-color":
        event.color ??
        calendar.data?.subscriptions.find((sub) => sub.calendar_id === event.calendar_id)?.color ??
        calendarColors[0]!.value,
    }) as CSSProperties;
}
export function CalendarEventButton({
  item,
  onOpen,
  onDrag,
  block = false,
  showTime = false,
  continuation = false,
  style,
  className = "",
}: {
  item: CalendarEvent;
  onOpen: CalendarViewActions["onOpen"];
  onDrag?: (event: CalendarEvent | null, offset: number) => void;
  block?: boolean;
  showTime?: boolean;
  continuation?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const calendar = useCalendar(),
    appearance = useEventAppearance();
  const movable =
    !item.invitation_id &&
    !item.is_redacted &&
    calendar.can("events.update") &&
    calendarWritable(calendar.data?.calendars.find((cal) => cal.id === item.calendar_id));
  const locale = calendar.data?.preferences.locale ?? "en";
  return (
    <button
      type="button"
      className={`calendar-event${block ? " calendar-event-block" : ""}${item.response_status === "declined" ? " calendar-event-declined" : ""}${item.response_status === "needs_action" || item.response_status === "tentative" ? " calendar-event-tentative" : ""} ${className}`}
      style={{ ...appearance(item), ...style }}
      draggable={movable && !!onDrag}
      aria-label={`${item.title}, ${eventDateLabel(item, calendar.zone, locale)}, ${eventTimeLabel(item, calendar.zone, locale)}`}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        if (!movable) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", eventKey(item));
        onDrag?.(
          item,
          block && !item.start.date
            ? Math.floor(((event.nativeEvent.offsetY / HOUR_HEIGHT) * 60) / 15) * 15
            : 0,
        );
      }}
      onDragEnd={() => onDrag?.(null, 0)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(item, event.currentTarget);
      }}
    >
      {!block && !item.start.date && <span className="calendar-event-dot" />}
      {showTime && !item.start.date && (
        <span className="calendar-event-start">
          {timeLabel(endpointLocal(item.start, calendar.zone).minute, locale)}
        </span>
      )}
      <span className="calendar-event-title">
        {continuation ? <span className="visually-hidden">{item.title}</span> : item.title}
      </span>
      {block && !item.start.date && (
        <span className="calendar-event-time">{eventTimeLabel(item, calendar.zone, locale)}</span>
      )}
      {item.recurrence?.length ? (
        <span className="calendar-repeat-mark" aria-label="Repeating">
          ↻
        </span>
      ) : null}
    </button>
  );
}
export function CalendarMonth({ actions }: { actions: CalendarViewActions }) {
  const calendar = useCalendar(),
    locale = calendar.data?.preferences.locale ?? "en",
    today = todayIn(calendar.zone);
  const container = useRef<HTMLDivElement>(null),
    [height, setHeight] = useState(650),
    [dragging, setDragging] = useState<CalendarEvent | null>(null);
  const [selection, setSelection] = useState<{
    start: string;
    end: string;
    pointer: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const showWeekends = calendar.data?.preferences.display_options.show_weekends !== false;
  const weeks = useMemo(
    () =>
      Array.from({ length: calendar.range.days.length / 7 }, (_, index) =>
        calendar.range.days
          .slice(index * 7, index * 7 + 7)
          .filter((date) => showWeekends || civilDate(date).dayOfWeek < 6),
      ),
    [calendar.range.days, showWeekends],
  );
  const weekPlacements = useMemo(
    () => weeks.map((week) => monthPlacements(calendar.events, week, calendar.zone)),
    [calendar.events, weeks, calendar.zone],
  );
  const rowLimit = Math.max(1, Math.floor((height / weeks.length - 48) / 23));
  const [overflow, setOverflow] = useState<string | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setHeight(entries[0]!.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const hitDate = (clientX: number, clientY: number) => {
    const rect = container.current!.getBoundingClientRect();
    const week = Math.max(
      0,
      Math.min(weeks.length - 1, Math.floor((clientY - rect.top) / (rect.height / weeks.length))),
    );
    const column = Math.max(
      0,
      Math.min(
        weeks[0]!.length - 1,
        Math.floor((clientX - rect.left) / (rect.width / weeks[0]!.length)),
      ),
    );
    return weeks[week]![column]!;
  };
  const canCreate =
    calendar.can("events.create") &&
    !!calendar.data?.calendars.some((cal) => calendarWritable(cal));
  return (
    <div className="calendar-month-view">
      <div
        className="calendar-month-weekdays"
        style={{ gridTemplateColumns: `repeat(${weeks[0]!.length}, minmax(0, 1fr))` }}
      >
        {weeks[0]!.map((date) => (
          <span key={date}>{dateLabel(date, { weekday: "short" }, locale)}</span>
        ))}
      </div>
      <div
        className="calendar-month-weeks"
        ref={container}
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => {
          if (
            !canCreate ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest("button,a") ||
            event.pointerType === "touch"
          )
            return;
          event.preventDefault();
          const date = hitDate(event.clientX, event.clientY);
          setSelection({ start: date, end: date, pointer: event.pointerId });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (selection)
            setSelection((old) =>
              old ? { ...old, end: hitDate(event.clientX, event.clientY) } : old,
            );
        }}
        onPointerUp={(event) => {
          if (!selection) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          suppressClick.current = true;
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
          calendar.setCreate({
            date: selection.start < selection.end ? selection.start : selection.end,
            endDate: selection.start > selection.end ? selection.start : selection.end,
            allDay: true,
          });
          setSelection(null);
        }}
        onPointerCancel={() => setSelection(null)}
      >
        {weeks.map((week, index) => {
          const placements = weekPlacements[index]!;
          return (
            <div
              className="calendar-month-week"
              key={week[0]}
              style={{ "--calendar-columns": week.length } as CSSProperties}
            >
              <div className="calendar-month-cells">
                {week.map((date) => {
                  const more = placements.filter(
                    (value) =>
                      value.row >= rowLimit &&
                      value.start <= week.indexOf(date) &&
                      value.end > week.indexOf(date),
                  ).length;
                  return (
                    <div
                      key={date}
                      className="calendar-month-cell"
                      data-outside={date.slice(0, 7) !== calendar.date.slice(0, 7) || undefined}
                      data-weekend={civilDate(date).dayOfWeek >= 6 || undefined}
                      data-selected={
                        (selection &&
                          date >=
                            (selection.start < selection.end ? selection.start : selection.end) &&
                          date <=
                            (selection.start > selection.end ? selection.start : selection.end)) ||
                        undefined
                      }
                      onDragOver={(event) => {
                        if (dragging) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragging) actions.onMove(dragging, date);
                        setDragging(null);
                      }}
                      onClick={(event) => {
                        if (
                          canCreate &&
                          !(event.target as HTMLElement).closest("button,a") &&
                          !selection
                        )
                          calendar.setCreate({ date, allDay: true });
                      }}
                    >
                      <button
                        type="button"
                        className="calendar-month-date"
                        aria-label={`Show ${dateLabel(date, { weekday: "long", month: "long", day: "numeric" }, locale)}`}
                        aria-current={date === today ? "date" : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          calendar.navigate(date, "day");
                        }}
                      >
                        {civilDate(date).day === 1
                          ? dateLabel(date, { month: "short", day: "numeric" }, locale)
                          : civilDate(date).day}
                      </button>
                      {more > 0 && (
                        <button
                          className="calendar-month-more"
                          type="button"
                          style={{ top: 31 + rowLimit * 23 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOverflow(overflow === date ? null : date);
                          }}
                        >
                          {more} more
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="calendar-month-events">
                {placements
                  .filter((value) => value.row < rowLimit)
                  .map(({ event, start, end, row }) => {
                    const bounds = eventDayBounds(event, calendar.zone),
                      block = !!event.start.date || end - start > 1;
                    return (
                      <div
                        key={eventKey(event)}
                        className="calendar-month-event-placement"
                        style={{ gridColumn: `${start + 1} / ${end + 1}`, gridRow: row + 1 }}
                        data-continues-before={bounds.start < week[start]! || undefined}
                        data-continues-after={bounds.end > addDays(week[end - 1]!, 1) || undefined}
                      >
                        <CalendarEventButton
                          item={event}
                          block={block}
                          showTime={!block}
                          onOpen={actions.onOpen}
                          onDrag={(item) => setDragging(item)}
                        />
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
      {overflow && (
        <CalendarModal
          title={dateLabel(overflow, { weekday: "long", month: "long", day: "numeric" }, locale)}
          onClose={() => setOverflow(null)}
          className="calendar-overflow-panel"
        >
          {calendar.events
            .filter((event) => occursOn(event, overflow, calendar.zone))
            .map((item) => (
              <CalendarEventButton
                key={eventKey(item)}
                item={item}
                showTime
                onOpen={(event) => {
                  setOverflow(null);
                  actions.onOpen(event, container.current!);
                }}
              />
            ))}
          <div className="calendar-dialog-actions">
            <Button
              onClick={() => {
                calendar.navigate(overflow, "day");
                setOverflow(null);
              }}
            >
              Open day
            </Button>
          </div>
        </CalendarModal>
      )}
    </div>
  );
}
export function CalendarTimeGrid({ actions }: { actions: CalendarViewActions }) {
  const calendar = useCalendar(),
    locale = calendar.data?.preferences.locale ?? "en",
    today = todayIn(calendar.zone);
  const showWeekends = calendar.data?.preferences.display_options.show_weekends !== false;
  const days = useMemo(
    () =>
      calendar.range.days.filter(
        (date) => calendar.view === "day" || showWeekends || civilDate(date).dayOfWeek < 6,
      ),
    [calendar.range.days, calendar.view, showWeekends],
  );
  const dayPlacements = useMemo(
    () => new Map(days.map((day) => [day, timedPlacements(calendar.events, day, calendar.zone)])),
    [calendar.events, days, calendar.zone],
  );
  const allPlacements = useMemo(
    () =>
      monthPlacements(
        calendar.events.filter((event) => !!event.start.date),
        days,
        calendar.zone,
      ),
    [calendar.events, days, calendar.zone],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ event: CalendarEvent; offset: number } | null>(null);
  const [selection, setSelection] = useState<{
    day: string;
    start: number;
    end: number;
    fromY: number;
    moved: boolean;
  } | null>(null);
  const [resizing, setResizing] = useState<{
    event: CalendarEvent;
    day: string;
    end: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now()),
    [allDayExpanded, setAllDayExpanded] = useState(false);
  const [focusedSlot, setFocusedSlot] = useState({
    day: days.includes(calendar.date) ? calendar.date : days[0]!,
    slot: 18,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const hour = days.includes(today)
      ? Math.max(
          6,
          endpointLocal(
            { date_time: new Date().toISOString(), time_zone: calendar.zone },
            calendar.zone,
          ).minute /
            60 -
            2,
        )
      : 8;
    scroller.current?.scrollTo({ top: hour * HOUR_HEIGHT });
  }, [calendar.range.start, calendar.view]);
  const pointerMinute = (event: { clientY: number }, element: HTMLElement) =>
    Math.max(
      0,
      Math.min(
        1440,
        Math.round(
          (((event.clientY - element.getBoundingClientRect().top) / HOUR_HEIGHT) * 60) / 15,
        ) * 15,
      ),
    );
  const canCreate =
    calendar.can("events.create") &&
    !!calendar.data?.calendars.some((cal) => calendarWritable(cal));
  const nowLocal = endpointLocal(
    { date_time: new Date(now).toISOString(), time_zone: calendar.zone },
    calendar.zone,
  );
  const allRows = Math.max(1, ...allPlacements.map((value) => value.row + 1)),
    visibleAllRows = allDayExpanded ? allRows : Math.min(3, allRows);
  const focusDay = days.includes(focusedSlot.day)
    ? focusedSlot.day
    : days.includes(calendar.date)
      ? calendar.date
      : days[0]!;
  return (
    <div className="calendar-time-scroller" ref={scroller}>
      <div
        className="calendar-time-content"
        style={
          {
            "--calendar-columns": days.length,
            minWidth: days.length > 1 ? 640 : undefined,
          } as CSSProperties
        }
      >
        <div className="calendar-time-heading">
          <div className="calendar-time-day-headings">
            <span className="calendar-time-zone" title={calendar.zone}>
              {
                new Intl.DateTimeFormat("en", {
                  timeZone: calendar.zone,
                  timeZoneName: "shortOffset",
                })
                  .formatToParts(new Date())
                  .find((part) => part.type === "timeZoneName")?.value
              }
            </span>
            {days.map((date) => (
              <button
                key={date}
                className="calendar-time-day-heading"
                onClick={() => calendar.navigate(date, "day")}
                aria-current={date === today ? "date" : undefined}
              >
                <span>{dateLabel(date, { weekday: "short" }, locale)}</span>
                <strong>{civilDate(date).day}</strong>
              </button>
            ))}
          </div>
          <div className="calendar-all-day-row" style={{ minHeight: visibleAllRows * 25 + 8 }}>
            <span className="calendar-all-day-label">
              All day
              {allRows > 3 && (
                <button
                  type="button"
                  onClick={() => setAllDayExpanded(!allDayExpanded)}
                  aria-expanded={allDayExpanded}
                >
                  {allDayExpanded
                    ? "Less"
                    : `+${allPlacements.filter((value) => value.row >= 3).length} more`}
                </button>
              )}
            </span>
            <div className="calendar-all-day-cells">
              {days.map((date) => (
                <button
                  key={date}
                  type="button"
                  aria-label={`Create all-day event on ${date}`}
                  disabled={!canCreate}
                  onClick={() => calendar.setCreate({ date, allDay: true })}
                  onDragOver={(event) => {
                    if (dragging) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging) actions.onMove(dragging.event, date);
                    setDragging(null);
                  }}
                />
              ))}
            </div>
            <div className="calendar-all-day-events">
              {allPlacements
                .filter((value) => value.row < visibleAllRows)
                .map(({ event, start, end, row }) => (
                  <div
                    key={eventKey(event)}
                    style={{ gridColumn: `${start + 1}/${end + 1}`, gridRow: row + 1 }}
                  >
                    <CalendarEventButton
                      item={event}
                      block
                      onOpen={actions.onOpen}
                      onDrag={(item) => setDragging(item ? { event: item, offset: 0 } : null)}
                    />
                  </div>
                ))}
            </div>
          </div>
        </div>
        <div className="calendar-time-body">
          <div className="calendar-time-hours">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                {hour ? timeLabel(hour * 60, locale) : ""}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="calendar-time-column"
              data-today={day === today || undefined}
              onPointerDown={(event) => {
                if (
                  !canCreate ||
                  event.button !== 0 ||
                  !(event.target as HTMLElement).closest(".calendar-time-slot")
                )
                  return;
                const start = Math.min(
                  1425,
                  Math.floor(pointerMinute(event, event.currentTarget) / 30) * 30,
                );
                setSelection({
                  day,
                  start,
                  end: Math.min(
                    1440,
                    start + (calendar.data?.preferences.default_duration_minutes ?? 30),
                  ),
                  fromY: event.clientY,
                  moved: false,
                });
                if (event.pointerType === "mouse") {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }
              }}
              onPointerMove={(event) => {
                if (!selection || selection.day !== day) return;
                if (
                  event.pointerType !== "mouse" &&
                  Math.abs(selection.fromY - event.clientY) > 8
                ) {
                  setSelection(null);
                  return;
                }
                if (Math.abs(selection.fromY - event.clientY) < 5) return;
                setSelection((old) =>
                  old
                    ? {
                        ...old,
                        end: Math.max(15, pointerMinute(event, event.currentTarget)),
                        moved: true,
                      }
                    : old,
                );
              }}
              onPointerUp={(event) => {
                if (!selection || selection.day !== day) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
                const start = Math.min(selection.start, selection.end - 15),
                  end = Math.max(selection.start + 15, selection.end);
                calendar.setCreate({ date: day, minute: start, endMinute: end });
                setSelection(null);
              }}
              onPointerCancel={() => setSelection(null)}
              onDragOver={(event) => {
                if (dragging) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging)
                  actions.onMove(
                    dragging.event,
                    day,
                    Math.min(
                      1425,
                      Math.max(0, pointerMinute(event, event.currentTarget) - dragging.offset),
                    ),
                  );
                setDragging(null);
              }}
            >
              {Array.from({ length: 48 }, (_, slot) => (
                <button
                  key={slot}
                  type="button"
                  className="calendar-time-slot"
                  data-day={day}
                  data-slot={slot}
                  tabIndex={day === focusDay && slot === focusedSlot.slot ? 0 : -1}
                  onFocus={() => setFocusedSlot({ day, slot })}
                  onKeyDown={(key) => {
                    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key.key))
                      return;
                    key.preventDefault();
                    const nextSlot = Math.max(
                      0,
                      Math.min(
                        47,
                        slot + (key.key === "ArrowUp" ? -1 : key.key === "ArrowDown" ? 1 : 0),
                      ),
                    );
                    const nextDay =
                      days[
                        Math.max(
                          0,
                          Math.min(
                            days.length - 1,
                            days.indexOf(day) +
                              (key.key === "ArrowLeft" ? -1 : key.key === "ArrowRight" ? 1 : 0),
                          ),
                        )
                      ]!;
                    setFocusedSlot({ day: nextDay, slot: nextSlot });
                    scroller.current
                      ?.querySelector<HTMLButtonElement>(
                        `.calendar-time-slot[data-day="${nextDay}"][data-slot="${nextSlot}"]`,
                      )
                      ?.focus();
                  }}
                  style={{ top: (slot * HOUR_HEIGHT) / 2, height: HOUR_HEIGHT / 2 }}
                  aria-label={`Create event, ${dateLabel(day, { weekday: "long", month: "short", day: "numeric" }, locale)}, ${timeLabel(slot * 30, locale)}`}
                  disabled={!canCreate}
                  onClick={(event) => {
                    if (!event.detail) calendar.setCreate({ date: day, minute: slot * 30 });
                  }}
                />
              ))}
              {selection?.day === day && (
                <div
                  className="calendar-time-selection"
                  style={{
                    top: (Math.min(selection.start, selection.end - 15) / 60) * HOUR_HEIGHT,
                    height:
                      (Math.abs(
                        Math.max(selection.start + 15, selection.end) -
                          Math.min(selection.start, selection.end - 15),
                      ) /
                        60) *
                      HOUR_HEIGHT,
                  }}
                >
                  {timeLabel(Math.min(selection.start, selection.end - 15), locale)} –{" "}
                  {timeLabel(Math.max(selection.start + 15, selection.end), locale)}
                </div>
              )}
              {dayPlacements.get(day)!.map(({ event, start, end, column, columns, span }) => {
                const canEdit =
                  !event.invitation_id &&
                  !event.is_redacted &&
                  calendar.can("events.update") &&
                  calendarWritable(
                    calendar.data?.calendars.find((cal) => cal.id === event.calendar_id),
                  );
                const last = endpointLocal(event.end, calendar.zone).date === day;
                return (
                  <div
                    className="calendar-timed-placement"
                    key={eventKey(event)}
                    style={{
                      top: (start / 60) * HOUR_HEIGHT,
                      height:
                        (((resizing?.event === event ? resizing.end : end) - start) / 60) *
                        HOUR_HEIGHT,
                      left: `${(column / columns) * 100}%`,
                      width: `calc(${(span / columns) * 100}% - 4px)`,
                    }}
                  >
                    <CalendarEventButton
                      item={event}
                      block
                      onOpen={actions.onOpen}
                      onDrag={(item, offset) => setDragging(item ? { event: item, offset } : null)}
                    />
                    {canEdit && last && (
                      <button
                        type="button"
                        className="calendar-event-resize"
                        aria-label={`Change end time for ${event.title}`}
                        onPointerDown={(pointer) => {
                          pointer.preventDefault();
                          pointer.stopPropagation();
                          pointer.currentTarget.setPointerCapture(pointer.pointerId);
                          setResizing({ event, day, end });
                        }}
                        onPointerMove={(pointer) => {
                          if (!resizing || resizing.event !== event) return;
                          const column =
                            pointer.currentTarget.closest<HTMLElement>(".calendar-time-column")!;
                          setResizing((old) =>
                            old
                              ? {
                                  ...old,
                                  end: Math.max(start + 15, pointerMinute(pointer, column)),
                                }
                              : old,
                          );
                        }}
                        onPointerUp={(pointer) => {
                          pointer.stopPropagation();
                          if (resizing?.event === event) {
                            pointer.currentTarget.releasePointerCapture(pointer.pointerId);
                            if (resizing.end !== end) actions.onResize(event, day, resizing.end);
                            setResizing(null);
                          }
                        }}
                        onPointerCancel={() => setResizing(null)}
                        onKeyDown={(key) => {
                          if (key.key === "Enter" || key.key === " ") {
                            key.preventDefault();
                            actions.onEdit(event);
                          }
                        }}
                      />
                    )}
                  </div>
                );
              })}
              {nowLocal.date === day && (
                <div
                  className="calendar-now-line"
                  aria-label={`Current time ${timeLabel(nowLocal.minute, locale)}`}
                  style={{ top: (nowLocal.minute / 60) * HOUR_HEIGHT }}
                >
                  <span />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export function CalendarAgenda({
  actions,
  events,
}: {
  actions: CalendarViewActions;
  events?: CalendarEvent[];
}) {
  const calendar = useCalendar(),
    values = events ?? calendar.events,
    locale = calendar.data?.preferences.locale ?? "en",
    appearance = useEventAppearance();
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of values) {
    const date = eventDayBounds(event, calendar.zone).start;
    const visible = date < calendar.range.start ? calendar.range.start : date;
    groups.set(visible, [...(groups.get(visible) ?? []), event]);
  }
  return (
    <div className="calendar-agenda">
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, items]) => (
          <section className="calendar-agenda-day" key={date}>
            <button
              className="calendar-agenda-date"
              onClick={() => {
                calendar.search("");
                calendar.navigate(date, "day");
              }}
              aria-current={date === todayIn(calendar.zone) ? "date" : undefined}
            >
              <strong>{civilDate(date).day}</strong>
              <span>{dateLabel(date, { month: "short", weekday: "short" }, locale)}</span>
            </button>
            <div>
              {items
                .sort(
                  (a, b) =>
                    Number(!!b.start.date) - Number(!!a.start.date) ||
                    (a.start.date_time ?? a.start.date!).localeCompare(
                      b.start.date_time ?? b.start.date!,
                    ),
                )
                .map((event) => (
                  <button
                    className="calendar-agenda-event"
                    key={eventKey(event)}
                    onClick={(click) => actions.onOpen(event, click.currentTarget)}
                    style={appearance(event)}
                  >
                    <span className="calendar-event-dot" />
                    <span className="calendar-agenda-time">
                      {eventTimeLabel(event, calendar.zone, locale)}
                      {eventDayBounds(event, calendar.zone).end > addDays(date, 1) && (
                        <small>
                          Until{" "}
                          {dateLabel(
                            addDays(eventDayBounds(event, calendar.zone).end, -1),
                            { month: "short", day: "numeric" },
                            locale,
                          )}
                        </small>
                      )}
                    </span>
                    <span className="calendar-agenda-title">
                      <strong>{event.title}</strong>
                      {event.location?.label && <small>{event.location.label}</small>}
                    </span>
                    {event.response_status === "needs_action" && (
                      <span className="calendar-small-tag">Invitation</span>
                    )}
                  </button>
                ))}
            </div>
          </section>
        ))}
    </div>
  );
}

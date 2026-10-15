import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useAccess } from "./console-access";
import { useNotifications } from "./ui";
import { calendarApi, calendarFailure, loadCalendarEvents, calendarRank, type CalendarBootstrap, type CalendarEvent, type CalendarView } from "../lib/calendar";
import { dateInstant, navigateDate, todayIn, validDate, viewRange } from "../lib/calendar-date";

export interface CalendarCreateRequest { date: string; minute?: number; endDate?: string; endMinute?: number; allDay?: boolean; }
interface CalendarContextValue {
  data: CalendarBootstrap | null; loading: boolean; error: string; events: CalendarEvent[];
  eventsLoading: boolean; eventsError: string; revision: number;
  date: string; view: CalendarView; zone: string; query: string; sidebarCollapsed: boolean;
  range: ReturnType<typeof viewRange>; selectedIds: string[]; create: CalendarCreateRequest | null;
  settings: string | null; setSettings: (value: string | null) => void;
  setCreate: (value: CalendarCreateRequest | null) => void;
  setSidebarCollapsed: (value: boolean) => void;
  navigate: (date: string, view?: CalendarView) => void; step: (direction: number) => void;
  search: (query: string) => void; refresh: (metadata?: boolean) => void;
  toggleCalendar: (id: string, selected: boolean) => Promise<void>;
  setData: (update: (old: CalendarBootstrap) => CalendarBootstrap) => void;
  can: (permission: string) => boolean;
}
const CalendarContext = createContext<CalendarContextValue | null>(null);
export function useCalendar() {
  const context = useContext(CalendarContext);
  if (!context) throw new Error("CalendarProvider is required");
  return context;
}
export function CalendarProvider({ children }: { children: ReactNode }) {
  const location = useLocation(), access = useAccess(), notify = useNotifications(), routeNavigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const enabled = location.pathname.startsWith("/calendar") && !location.pathname.startsWith("/calendar/invitations/") && access.permissions.includes("calendar.access");
  const [data, setBootstrap] = useState<CalendarBootstrap | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [metadataRevision, setMetadataRevision] = useState(0);
  const [eventState, setEventState] = useState<{ key: string; events: CalendarEvent[]; loading: boolean; error: string }>({ key: "", events: [], loading: true, error: "" });
  const [create, setCreate] = useState<CalendarCreateRequest | null>(null), [settings, setSettings] = useState<string | null>(null), [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const selecting = useRef(new Set<string>());
  const can = useCallback((permission: string) => access.permissions.includes(`calendar.${permission}`), [access.permissions]);
  const refresh = useCallback((metadata = false) => { setRevision(old => old + 1); if (metadata) setMetadataRevision(old => old + 1); }, []);
  useEffect(() => {
    if (access.status === "ready" && !access.permissions.includes("calendar.access")) { setBootstrap(null); setCreate(null); setSettings(null); }
  }, [access.status, access.permissions]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void calendarApi<CalendarBootstrap>("/bootstrap", { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setBootstrap(value);
    }).catch(failure => { if (!controller.signal.aborted) setError(calendarFailure(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, metadataRevision, access.permissions]);
  const zone = data?.preferences.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = validDate(params.get("date")) ?? todayIn(zone);
  const requestedView = params.get("view");
  const view: CalendarView = ["day", "week", "month", "agenda"].includes(requestedView ?? "") ? requestedView as CalendarView : data?.preferences.default_view ?? "week";
  const query = params.get("q") ?? "";
  const range = useMemo(() => viewRange(date, query ? "agenda" : view, data?.preferences.week_start ?? 1), [date, view, query, data?.preferences.week_start]);
  const selectedIds = useMemo(() => data?.calendars.filter(cal => data.subscriptions.some(sub => sub.calendar_id === cal.id && sub.selected && !sub.hidden)).map(cal => cal.id) ?? [], [data]);
  const eventQuery = new URLSearchParams({ time_min: dateInstant(range.start, zone), time_max: dateInstant(range.end, zone), expand_recurring: "true", calendar_ids: selectedIds.join(","), ...(query ? { q: query } : {}) }).toString();
  useEffect(() => {
    if (!enabled || !data) return;
    const controller = new AbortController();
    if (!selectedIds.length) { setEventState({ key: eventQuery, events: [], loading: false, error: "" }); return; }
    setEventState(old => ({ key: eventQuery, events: old.key === eventQuery ? old.events : [], loading: true, error: "" }));
    void loadCalendarEvents(new URLSearchParams(eventQuery), controller.signal).then(events => {
      if (!controller.signal.aborted) setEventState({ key: eventQuery, events, loading: false, error: "" });
    }).catch(failure => { if (!controller.signal.aborted) setEventState({ key: eventQuery, events: [], loading: false, error: calendarFailure(failure) }); });
    return () => controller.abort();
  }, [enabled, eventQuery, revision, !!data, selectedIds.length]);
  useEffect(() => {
    if (!enabled) return;
    const foreground = () => { if (document.visibilityState === "visible") refresh(true); };
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60_000);
    window.addEventListener("focus", foreground);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", foreground); };
  }, [enabled, refresh]);
  const navigate = (next: string, nextView?: CalendarView) => {
    if (!validDate(next)) return;
    const value = new URLSearchParams(params); value.set("date", next); if (nextView) value.set("view", nextView);
    if (location.pathname !== "/calendar") routeNavigate(`/calendar?${value}`);
    else setParams(value);
  };
  const search = (value: string) => setParams(old => { const next = new URLSearchParams(old); if (value.trim()) next.set("q", value.trim()); else next.delete("q"); return next; });
  const setData = (update: (old: CalendarBootstrap) => CalendarBootstrap) => setBootstrap(old => old ? update(old) : old);
  const toggleCalendar = async (id: string, selected: boolean) => {
    if (!data || selecting.current.has(id)) return;
    if (selected && !selectedIds.includes(id) && selectedIds.length >= 50) { notify.info("You can display up to 50 calendars at once."); return; }
    selecting.current.add(id);
    const old = data.subscriptions.find(sub => sub.calendar_id === id);
    // The pending checkbox is local; failed writes reload authoritative preferences.
    setData(value => ({ ...value, subscriptions: old ? value.subscriptions.map(sub => sub.calendar_id === id ? { ...sub, selected, ...(selected ? { hidden: false } : {}) } : sub) : [...value.subscriptions, { calendar_id: id, selected, hidden: false, color: null, name_override: null, version: 0 }] }));
    try {
      await calendarApi(`/subscriptions/${id}`, { method: old ? "PATCH" : "PUT", body: { version: old?.version ?? 0, selected, ...(selected ? { hidden: false } : {}) } });
      refresh(true);
    } catch (failure) { notify.error(calendarFailure(failure)); refresh(true); }
    finally { selecting.current.delete(id); }
  };
  return <CalendarContext value={{ data, loading, error, events: eventState.key === eventQuery ? eventState.events : [],
    eventsLoading: !!data && (eventState.key !== eventQuery || eventState.loading), eventsError: eventState.key === eventQuery ? eventState.error : "",
    revision, date, view, zone, query, range, selectedIds, create, setCreate, settings, setSettings, sidebarCollapsed, setSidebarCollapsed,
    navigate, step: direction => navigate(navigateDate(date, view, direction)), search, refresh, toggleCalendar, setData, can,
  }}>{children}</CalendarContext>;
}

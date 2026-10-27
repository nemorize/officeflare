import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useAccess } from "./console-access";
import { useNotifications } from "./ui";
import { calendarApi, calendarFailure, loadCalendarEvents, calendarRank, type CalendarBootstrap, type CalendarEvent, type CalendarView } from "../lib/calendar";
import { dateInstant, navigateDate, todayIn, validDate, viewRange } from "../lib/calendar-date";
import { CalendarResourceCache } from "../lib/calendar-resource-cache";
import { calendarView, readCalendarView, saveCalendarView } from "../lib/calendar-view";
import { useSession } from "../lib/session";

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
const noEvents: CalendarEvent[] = [];
function useCachedCalendar<T>(cache: CalendarResourceCache<T>, key: string | null, enabled: boolean) {
  const snapshot = useSyncExternalStore(
    useCallback(listener => cache.subscribe(key, listener), [cache, key]),
    useCallback(() => cache.snapshot(key), [cache, key]),
  );
  useEffect(() => { if (key && enabled) void cache.load(key); }, [cache, key, enabled]);
  return snapshot;
}
export function useCalendar() {
  const context = useContext(CalendarContext);
  if (!context) throw new Error("CalendarProvider is required");
  return context;
}
export function CalendarProvider({ children }: { children: ReactNode }) {
  const location = useLocation(), access = useAccess(), notify = useNotifications(), routeNavigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const account = useSession().session?.email ?? "";
  const [savedView, setSavedView] = useState(() => readCalendarView(account));
  const enabled = location.pathname.startsWith("/calendar") && !location.pathname.startsWith("/calendar/invitations/") && access.permissions.includes("calendar.access");
  const permissions = [...access.permissions].sort().join("\n");
  // WorkspaceLayout remounts this provider on session changes. Permission changes
  // create new caches, while ordinary permission refreshes keep existing data.
  const bootstrapCache = useMemo(() => {
    const cache = new CalendarResourceCache<CalendarBootstrap>((path, signal) => {
      const request = new URL(path, "https://calendar.local");
      // Only the initial load needs a combined page; foreground metadata refreshes
      // must not repeat the event request already owned by the visible range.
      if (cache.snapshot(path).data) request.searchParams.delete("include_events");
      return calendarApi(request.pathname + request.search, { signal });
    });
    return cache;
  }, [permissions]);
  const initialParams = useRef(params);
  initialParams.current = new URLSearchParams(params);
  const initialView = calendarView(params.get("view")) ?? savedView;
  if (initialView) initialParams.current.set("view", initialView);
  const bootstrapPath = useMemo(() => "/bootstrap?" + new URLSearchParams({ include_events: "true", ...Object.fromEntries(["date", "view", "q"].flatMap(key => initialParams.current.get(key) ? [[key, initialParams.current.get(key)!]] : [])) }), [bootstrapCache, enabled]);
  const bootstrap = useCachedCalendar(bootstrapCache, bootstrapPath, enabled), data = bootstrap.data;
  const eventScope = JSON.stringify([data?.calendars.map(cal => [cal.id, cal.version, cal.effective_role]), data?.preferences.invitation_policy, data?.preferences.display_options.show_declined]);
  const eventCache = useMemo(() => {
    let initial = data?.initial_events;
    return new CalendarResourceCache<CalendarEvent[]>((query, signal, progress) => {
      const seed = initial?.query === query ? initial : undefined;
      if (seed) initial = undefined;
      return loadCalendarEvents(new URLSearchParams(query), signal, progress, seed);
    });
  }, [bootstrapCache, eventScope]);
  useEffect(() => () => bootstrapCache.clear(), [bootstrapCache]);
  useEffect(() => () => eventCache.clear(), [eventCache]);
  const [revision, setRevision] = useState(0);
  const [create, setCreate] = useState<CalendarCreateRequest | null>(null), [settings, setSettings] = useState<string | null>(null), [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const selecting = useRef(new Set<string>());
  const can = useCallback((permission: string) => access.permissions.includes(`calendar.${permission}`), [access.permissions]);
  const refresh = useCallback((metadata = false) => { eventCache.invalidate(); if (metadata) bootstrapCache.invalidate(); setRevision(old => old + 1); }, [eventCache, bootstrapCache]);
  useEffect(() => {
    if (access.status === "ready" && !access.permissions.includes("calendar.access")) { setCreate(null); setSettings(null); }
  }, [access.status, access.permissions]);
  const zone = data?.preferences.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = validDate(params.get("date")) ?? todayIn(zone);
  const view: CalendarView = calendarView(params.get("view")) ?? savedView ?? data?.preferences.default_view ?? "week";
  const query = params.get("q") ?? "";
  const range = useMemo(() => viewRange(date, query ? "agenda" : view, data?.preferences.week_start ?? 1), [date, view, query, data?.preferences.week_start]);
  const selectedIds = useMemo(() => data?.calendars.filter(cal => data.subscriptions.some(sub => sub.calendar_id === cal.id && sub.selected && !sub.hidden)).map(cal => cal.id) ?? [], [data]);
  const eventQuery = new URLSearchParams({ time_min: dateInstant(range.start, zone), time_max: dateInstant(range.end, zone), expand_recurring: "true", calendar_ids: selectedIds.join(","), ...(query ? { q: query } : {}) }).toString();
  const activeQuery = enabled && location.pathname === "/calendar" && data && selectedIds.length ? eventQuery : null;
  const eventState = useCachedCalendar(eventCache, activeQuery, !!activeQuery);
  useEffect(() => {
    if (!enabled) return;
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      void bootstrapCache.load(bootstrapPath);
      if (activeQuery) void eventCache.load(activeQuery);
    };
    const interval = window.setInterval(foreground, 60_000);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [enabled, activeQuery, bootstrapPath, bootstrapCache, eventCache]);
  const navigate = (next: string, nextView?: CalendarView) => {
    if (!validDate(next)) return;
    if (nextView) { saveCalendarView(account, nextView); setSavedView(nextView); }
    const value = new URLSearchParams(params); value.set("date", next); if (nextView) value.set("view", nextView);
    if (location.pathname !== "/calendar") routeNavigate(`/calendar?${value}`);
    else setParams(value);
  };
  const search = (value: string) => setParams(old => { const next = new URLSearchParams(old); if (value.trim()) next.set("q", value.trim()); else next.delete("q"); return next; });
  const setData = (update: (old: CalendarBootstrap) => CalendarBootstrap) => bootstrapCache.update(bootstrapPath, update);
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
  return <CalendarContext value={{ data, loading: bootstrap.loading, error: bootstrap.error ? calendarFailure(bootstrap.error) : "", events: eventState.data ?? noEvents,
    eventsLoading: eventState.loading, eventsError: eventState.error ? calendarFailure(eventState.error) : "",
    revision, date, view, zone, query, range, selectedIds, create, setCreate, settings, setSettings, sidebarCollapsed, setSidebarCollapsed,
    navigate, step: direction => navigate(navigateDate(date, view, direction)), search, refresh, toggleCalendar, setData, can,
  }}>{children}</CalendarContext>;
}

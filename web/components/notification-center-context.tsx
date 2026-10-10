import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import type { NotificationItem, NotificationPage, NotificationState, NotificationSummary, NotificationUpdate } from "../lib/notification-center";

interface Center {
  summary: NotificationSummary | null; error: string; revision: number;
  refresh: (reload?: boolean) => Promise<void>; update: (item: NotificationItem, changes: NotificationUpdate) => Promise<void>;
  readAll: () => Promise<void>;
}
const Context = createContext<Center | null>(null);
export function NotificationCenterProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const current = useRef<NotificationSummary | null>(null), alive = useRef(false), request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (reload = false) => {
    if (reload) setRevision((value) => value + 1);
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await api<NotificationSummary>("/api/notifications/summary", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!alive.current || controller.signal.aborted) return;
      if (current.current?.change_cursor !== result.change_cursor || current.current?.unread !== result.unread || current.current?.next_snoozed_until !== result.next_snoozed_until) setRevision((value) => value + 1);
      current.current = result; setSummary(result); setError("");
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError(errorMessage(failure)); }
  }, []);

  useEffect(() => {
    alive.current = true;
    let stopped = false, socket: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    const controller = new AbortController();
    const schedule = () => {
      if (!stopped) retry = setTimeout(() => { void connect(); }, Math.min(60_000, 2_000 * 2 ** Math.min(attempts++, 5)));
    };
    async function connect() {
      if (stopped || document.visibilityState === "hidden") { schedule(); return; }
      try {
        const { ticket } = await api<{ ticket: string }>("/api/notifications/events/tickets", {
          method: "POST", body: {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (stopped) return;
        const url = new URL("/api/notifications/events/ws", window.location.href); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url, ["officeflare.notifications", `ticket.${ticket}`]);
        socket.onopen = () => { attempts = 0; void refresh(); };
        socket.onmessage = (event) => {
          try { if (JSON.parse(String(event.data)).kind === "notifications.changed") void refresh(); } catch { /* Invalidations carry no content. */ }
        };
        socket.onclose = schedule;
      } catch { schedule(); }
    }
    const visibleRefresh = () => { if (document.visibilityState !== "hidden") void refresh(); };
    void refresh(); void connect();
    const poll = setInterval(visibleRefresh, 30_000);
    window.addEventListener("focus", visibleRefresh); window.addEventListener("online", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      stopped = true; alive.current = false; controller.abort(); request.current?.abort(); clearInterval(poll); clearTimeout(retry);
      if (socket) { socket.onclose = null; socket.close(); }
      window.removeEventListener("focus", visibleRefresh); window.removeEventListener("online", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!summary?.next_snoozed_until) return;
    const timer = setTimeout(() => { void refresh(true); }, Math.max(1000, Math.min(2_147_483_647, summary.next_snoozed_until * 1000 - Date.now() + 500)));
    return () => clearTimeout(timer);
  }, [summary?.next_snoozed_until, refresh]);

  const update = useCallback(async (item: NotificationItem, changes: NotificationUpdate) => {
    try { await api(`/api/notifications/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { version: item.version, ...changes } }); }
    finally { if (alive.current) { setRevision((value) => value + 1); await refresh(); } }
  }, [refresh]);
  const readAll = useCallback(async () => {
    const cutoff = current.current?.read_all_cursor;
    if (!cutoff) return;
    await api("/api/notifications/read-all", { method: "POST", body: { cursor: cutoff } });
    if (alive.current) { setRevision((value) => value + 1); await refresh(); }
  }, [refresh]);
  return <Context.Provider value={{ summary, error, revision, refresh, update, readAll }}>{children}</Context.Provider>;
}
export function useNotificationCenter() {
  const value = useContext(Context); if (!value) throw new Error("NotificationCenterProvider is missing"); return value;
}

export function useNotificationList(state: NotificationState, service = "", enabled = true, limit = 30) {
  const { revision } = useNotificationCenter();
  const [items, setItems] = useState<NotificationItem[]>([]), [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), generation = useRef(0), pending = useRef(false);
  const query = new URLSearchParams({ state, limit: String(limit), ...(service ? { service } : {}) }).toString();
  const previousQuery = useRef(query);
  useEffect(() => {
    const id = ++generation.current;
    active.current?.abort(); pending.current = false; setNext(null); setError("");
    if (previousQuery.current !== query || !enabled) setItems([]);
    previousQuery.current = query;
    if (!enabled) { setLoading(false); return; }
    const controller = new AbortController(); active.current = controller; setLoading(true); pending.current = true;
    void api<NotificationPage>(`/api/notifications?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then((page) => { if (!controller.signal.aborted && generation.current === id) { setItems(page.notifications); setNext(page.next_cursor); } })
      .catch((failure) => { if (!controller.signal.aborted && generation.current === id) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted && generation.current === id) { setLoading(false); pending.current = false; } });
    return () => { controller.abort(); active.current?.abort(); generation.current++; };
  }, [query, revision, enabled]);
  async function loadMore() {
    if (!next || pending.current) return;
    const id = generation.current, controller = new AbortController(); active.current = controller; pending.current = true; setLoading(true); setError("");
    try {
      const page = await api<NotificationPage>(`/api/notifications?${query}&cursor=${encodeURIComponent(next)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (generation.current === id && !controller.signal.aborted) { setItems((existing) => [...existing, ...page.notifications]); setNext(page.next_cursor); }
    } catch (failure) { if (generation.current === id && !controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (generation.current === id && !controller.signal.aborted) { pending.current = false; setLoading(false); } }
  }
  useEffect(() => () => active.current?.abort(), []);
  return { items, loading, error, next, loadMore };
}

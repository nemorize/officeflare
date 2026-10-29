export interface CalendarSnapshot<T> {
  data: T | null;
  loading: boolean;
  error: unknown | null;
}
type Loader<T> = (key: string, signal: AbortSignal, progress: (data: T) => void) => Promise<T>;
interface Entry<T> {
  snapshot: CalendarSnapshot<T>;
  listeners: Set<() => void>;
  updated: number | null;
  controller?: AbortController;
  request?: Promise<void>;
}
const empty = { data: null, loading: false, error: null };

/** In-memory only, owned by one session and authorization scope. */
export class CalendarResourceCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(
    private loader: Loader<T>,
    private now = Date.now,
    private ttl = 30_000,
    private limit = 12,
  ) {}
  private entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        snapshot: { data: null, loading: true, error: null },
        listeners: new Set(),
        updated: null,
      };
      this.entries.set(key, entry);
      this.prune(key);
    }
    return entry;
  }
  private prune(current: string) {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit) break;
      if (key !== current && !entry.listeners.size && !entry.request) this.entries.delete(key);
    }
  }
  snapshot = (key: string | null): CalendarSnapshot<T> => (key ? this.entry(key).snapshot : empty);
  subscribe(key: string | null, listener: () => void) {
    if (!key) return () => {};
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  private publish(entry: Entry<T>, snapshot: CalendarSnapshot<T>) {
    entry.snapshot = snapshot;
    entry.listeners.forEach((listener) => listener());
  }
  load(key: string): Promise<void> {
    const entry = this.entry(key);
    if (entry.request) return entry.request;
    if (entry.updated !== null && this.now() - entry.updated < this.ttl) return Promise.resolve();
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry, { ...entry.snapshot, loading: true, error: null });
    const request = Promise.resolve()
      .then(() =>
        this.loader(key, controller.signal, (data) => {
          if (!controller.signal.aborted) this.publish(entry, { data, loading: true, error: null });
        }),
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        entry.updated = this.now();
        this.publish(entry, { data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = (error as { status?: number } | null)?.status;
        // A revoked grant must also remove inactive ranges immediately.
        if (status === 401 || status === 403 || status === 404) {
          for (const value of this.entries.values()) {
            if (value !== entry) {
              value.controller?.abort();
              value.controller = undefined;
              value.request = undefined;
            }
            value.updated = null;
            this.publish(value, { data: null, loading: false, error });
          }
        } else this.publish(entry, { ...entry.snapshot, loading: false, error });
      })
      .finally(() => {
        if (entry.controller !== controller) return;
        entry.controller = undefined;
        entry.request = undefined;
        this.prune(key);
      });
    entry.request = request;
    return request;
  }
  update(key: string, update: (data: T) => T) {
    const entry = this.entry(key);
    if (entry.snapshot.data !== null)
      this.publish(entry, { ...entry.snapshot, data: update(entry.snapshot.data) });
  }
  invalidate(only?: string) {
    for (const [key, entry] of this.entries) {
      if (only !== undefined && key !== only) continue;
      entry.controller?.abort();
      entry.controller = undefined;
      entry.request = undefined;
      entry.updated = null;
      // Keep the visible range during a refresh; edits invalidate other saved ranges.
      if (entry.listeners.size) void this.load(key);
      else this.entries.delete(key);
    }
  }
  clear() {
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
  }
}

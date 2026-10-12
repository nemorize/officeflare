export interface ResourceSnapshot {
  data: unknown | null;
  loading: boolean;
  error: unknown | null;
}
interface Entry {
  snapshot: ResourceSnapshot;
  listeners: Set<() => void>;
  updated: number;
  request?: Promise<void>;
  controller?: AbortController;
  reload: boolean;
  updates: ((data: unknown) => unknown)[];
  revision?: number;
}
type Loader = (path: string, signal: AbortSignal) => Promise<unknown>;
const empty: ResourceSnapshot = { data: null, loading: false, error: null };

/** Owned by one session/permission scope; never shares private data across accounts. */
export class MailResourceCache {
  private entries = new Map<string, Entry>();
  private loader: Loader;
  private now: () => number;
  private ttl: number;
  constructor(loader: Loader, now = Date.now, ttl = 30_000) {
    this.loader = loader;
    this.now = now;
    this.ttl = ttl;
  }
  private entry(path: string) {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = { snapshot: { data: null, loading: true, error: null }, listeners: new Set(), updated: 0, reload: false, updates: [] };
      this.entries.set(path, entry);
      // Evict only idle entries; active views and in-flight requests retain subscribers.
      if (this.entries.size > 128) {
        for (const [key, value] of this.entries) {
          if (key !== path && !value.listeners.size && !value.request) { this.entries.delete(key); break; }
        }
      }
    }
    return entry;
  }
  snapshot = (path: string | null): ResourceSnapshot => path ? this.entry(path).snapshot : empty;
  subscribe(path: string | null, listener: () => void) {
    if (!path) return () => {};
    const entry = this.entry(path);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  private publish(entry: Entry, snapshot: ResourceSnapshot) {
    entry.snapshot = snapshot;
    entry.listeners.forEach(listener => listener());
  }
  async load(path: string, force = false): Promise<void> {
    const entry = this.entry(path);
    if (entry.request) return entry.request;
    if (!force && entry.updated && this.now() - entry.updated < this.ttl) return;
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry, { ...entry.snapshot, loading: true, error: null });
    const request = Promise.resolve().then(() => this.loader(path, controller.signal)).then(data => {
      if (controller.signal.aborted) return;
      for (const update of entry.updates) data = update(data);
      entry.updated = this.now();
      this.publish(entry, { data, loading: false, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const status = typeof error === "object" && error ? (error as { status?: number }).status : undefined;
      this.publish(entry, { data: status === 403 || status === 404 ? null : entry.snapshot.data, loading: false, error });
      if (status === 403) {
        const mailbox = path.match(/^\/api\/mail\/mailboxes\/[^/]+(?=\/)/)?.[0];
        if (mailbox) this.denyMailbox(mailbox, error);
      }
    }).finally(() => {
      if (entry.controller !== controller) return;
      entry.request = undefined;
      entry.controller = undefined;
      entry.updates = [];
      if (entry.reload && !controller.signal.aborted) {
        entry.reload = false;
        void this.load(path, true);
      }
    });
    entry.request = request;
    return request;
  }
  invalidate(match: string | ((path: string) => boolean)) {
    for (const [path, entry] of this.entries) {
      if (typeof match === "string" ? path !== match : !match(path)) continue;
      entry.updated = 0;
      if (entry.request) entry.reload = true;
      else if (entry.listeners.size) void this.load(path, true);
    }
  }
  revalidate(path: string, revision: number) {
    const entry = this.entry(path);
    if (entry.revision === revision) return;
    entry.revision = revision;
    this.invalidate(path);
  }
  invalidateInactive(match: (path: string) => boolean) {
    for (const [path, entry] of this.entries) {
      if (!match(path) || entry.listeners.size) continue;
      entry.updated = 0;
      if (entry.request) entry.reload = true;
    }
  }
  update(match: (path: string) => boolean, update: (data: unknown) => unknown) {
    for (const [path, entry] of this.entries) {
      if (!match(path)) continue;
      // Apply a committed change to an older in-flight response as well.
      if (entry.request) entry.updates.push(update);
      if (entry.snapshot.data !== null) this.publish(entry, { ...entry.snapshot, data: update(entry.snapshot.data) });
    }
  }
  replace(path: string, data: unknown) {
    const entry = this.entry(path);
    if (entry.request) entry.updates.push(() => data);
    entry.updated = this.now();
    this.publish(entry, { data, loading: false, error: null });
  }
  denyMailbox(prefix: string, error: unknown) {
    for (const [path, entry] of this.entries) {
      if (!path.startsWith(prefix + "/")) continue;
      entry.controller?.abort();
      entry.controller = undefined;
      entry.request = undefined;
      entry.reload = false;
      entry.updates = [];
      entry.updated = this.now();
      this.publish(entry, { data: null, loading: false, error });
    }
  }
  clear() {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      entry.controller = undefined;
    }
    this.entries.clear();
  }
}

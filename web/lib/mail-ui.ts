import type { MailResourceCache } from "./mail-resource-cache";
import type {
  Mailbox,
  Folder,
  MailSummary,
  MailPreferences,
  Capabilities,
  Message,
  MessageDetail,
} from "./mail";
export interface MailBootstrap {
  mailboxes: Mailbox[];
  mailbox_id: string | null;
  folders: Folder[];
  summary: MailSummary | null;
  preferences: MailPreferences;
  capabilities: Capabilities;
  cursor: number | null;
  page: { messages: Message[]; next_cursor: string | null } | null;
  view_path: string;
}
export interface MailCommandResult {
  mailbox_id?: string;
  results: (
    | { id: string; success: true; before: Message; message: Message }
    | { id: string; thread_id?: string; success: false; error: string }
  )[];
  summary: MailSummary;
}
export interface MailDelta {
  cursor: number;
  reset: boolean;
  messages: Message[];
  removed?: string[];
  thread_ids: string[];
  summary: MailSummary | null;
  view?: Message[];
}
export function hydrateMailResources(cache: MailResourceCache, path: string, data: unknown) {
  if (!data || typeof data !== "object") return;
  if (path.startsWith("/api/mail/ui/bootstrap?")) {
    const result = data as MailBootstrap;
    cache.hydrateFrom(path, "/api/mail/mailboxes", { mailboxes: result.mailboxes });
    cache.hydrateFrom(path, "/api/mail/preferences", { preferences: result.preferences });
    cache.hydrateFrom(path, "/api/mail/capabilities", result.capabilities);
    if (result.mailbox_id) {
      const base = `/api/mail/mailboxes/${result.mailbox_id}`;
      cache.hydrateFrom(path, base + "/folders", { folders: result.folders });
      if (result.summary) cache.hydrateFrom(path, base + "/summary", { summary: result.summary });
      cache.hydrateFrom(path, base + "/ui/watermark", { cursor: result.cursor });
      if (result.page) cache.hydrateFrom(path, result.view_path, result.page);
      cache.rememberMessages(base, result.page?.messages ?? []);
    }
  }
  const base = path.match(/^(\/api\/mail\/mailboxes\/[^/]+)\/ui\//)?.[1];
  if (!base) return;
  const result = data as {
    message?: MessageDetail;
    messages?: Message[];
    addresses?: unknown;
    limits?: unknown;
    settings?: unknown;
  };
  cache.rememberMessages(base, [
    ...(result.messages ?? []),
    ...(result.message ? [result.message] : []),
  ]);
  if (result.message) {
    cache.replace(base + "/messages/" + result.message.id, { message: result.message });
    if (result.message.draft)
      cache.replace(base + "/drafts/" + result.message.id, { message: result.message });
  }
  if (path.includes("/ui/compose-context")) {
    cache.replace(base + "/addresses", { addresses: result.addresses, limits: result.limits });
    cache.replace(base + "/settings", { settings: result.settings });
  }
}
const newer = (a: Message, b: Message) => b.received_at - a.received_at || b.id.localeCompare(a.id);
/** Only replace affected conversations; keep the original cursor boundary and its rows. */
export function mergeMailView(
  data: unknown,
  delta: MailDelta,
  grouped: boolean,
  laterPage: boolean,
): unknown {
  if (!data || typeof data !== "object" || !("messages" in data) || !Array.isArray(data.messages))
    return data;
  const rows = data.messages as Message[],
    affected = new Set(delta.thread_ids),
    removed = new Set(delta.removed);
  const updates = (delta.view ?? []).filter(
    (row) => !laterPage || !rows.length || newer(row, rows[0]!) >= 0,
  );
  const updateIds = new Set(updates.map((row) => (grouped ? row.thread_id : row.id)));
  const matching = new Map(updates.map((row) => [grouped ? row.thread_id : row.id, row]));
  const retained = rows.flatMap((row) => {
    const key = grouped ? row.thread_id : row.id;
    if (!affected.has(row.thread_id) && !removed.has(row.id)) return [row];
    const next = matching.get(key);
    if (!next) return [];
    matching.delete(key);
    // Different representative IDs in a conversation have independent message versions.
    return [next.id === row.id && next.version < row.version ? row : next];
  });
  const tail = rows.at(-1);
  for (const row of matching.values())
    if (
      !tail ||
      !("next_cursor" in data) ||
      !data.next_cursor ||
      newer(row, tail) <= 0 ||
      updateIds.has(grouped ? tail.thread_id : tail.id)
    )
      retained.push(row);
  retained.sort(newer);
  return { ...data, messages: retained };
}
export function applyMailHeaders(
  data: unknown,
  messages: Message[],
  removed: string[] = [],
): unknown {
  if (!data || typeof data !== "object") return data;
  const updates = new Map(messages.map((message) => [message.id, message]));
  const apply = (value: Message) => {
    const next = updates.get(value.id);
    return next && next.version >= value.version ? { ...value, ...next } : value;
  };
  const resource = data as { message?: Message; messages?: Message[] };
  // Header updates must never coerce cached image Blobs or render manifests into objects.
  if (!resource.message && !Array.isArray(resource.messages)) return data;
  let entries = resource.messages?.filter((message) => !removed.includes(message.id)).map(apply);
  if (entries && resource.message) {
    const existing = new Set(entries.map((message) => message.id));
    entries = [
      ...entries,
      ...messages.filter(
        (message) => message.thread_id === resource.message!.thread_id && !existing.has(message.id),
      ),
    ].sort(newer);
  }
  return {
    ...resource,
    ...(resource.message ? { message: apply(resource.message) } : {}),
    ...(entries ? { messages: entries } : {}),
  };
}
/** One in-flight catch-up; bursts collapse to one queued pass without losing events. */
export class MailChangeScheduler {
  private running = false;
  private queued = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private catchUp: () => Promise<void>;
  private failed: (error: unknown) => void;
  constructor(catchUp: () => Promise<void>, failed: (error: unknown) => void = () => {}) {
    this.catchUp = catchUp;
    this.failed = failed;
  }
  request(immediate = false) {
    if (this.stopped) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    if (this.timer) {
      if (!immediate) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.run();
      },
      immediate ? 0 : 100,
    );
  }
  private async run() {
    this.running = true;
    try {
      await this.catchUp();
    } catch (error) {
      if (!this.stopped) this.failed(error);
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.request();
      }
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

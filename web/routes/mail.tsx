import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api } from "../lib/api";
import {
  mailboxPath,
  mailDate,
  type Message,
  type MessageDetail,
} from "../lib/mail";
import { useMail } from "../components/mail-context";
import { ConversationReader } from "../components/mail-reader";
import { MailIconButton, MailMenu } from "../components/mail-controls";
import {
  MailNotice,
  MailState,
  useMailAction,
  useMailResource,
  MailCheckbox,
} from "../components/mail-common";
import { Button, Icon, Menu, Popover, PopoverPopup } from "../components/ui";
import { useAccount } from "../components/account-context";
import { useAccess } from "../components/console-access";
import { Confirm } from "../components/console-shared";
export function MailReady({
  children,
  read = true,
}: {
  children: ReactNode;
  read?: boolean;
}) {
  const mail = useMail(),
    access = useAccess();
  if (!mail.box)
    return (
      <section className="mail-empty-state">
        <span className="mail-empty-illustration">
          <Icon name="mail" width="36" height="36" />
        </span>
        <h1>
          {mail.loading
            ? "Loading your mailbox…"
            : mail.error
              ? "Mailbox unavailable"
              : "Your mail starts here"}
        </h1>
        <MailNotice error={mail.error} />
        <p>
          {mail.boxes.length
            ? "Choose an available mailbox to continue."
            : "Ask your administrator to enable Mail and set your address."}
        </p>
        <div className="mail-actions">
          <Button onClick={mail.refreshBoxes}>Refresh mailboxes</Button>
          {access.permissions.includes("admin.users.read") && (
            <Button nativeButton={false} render={<Link to="/console/users" />}>
              Manage users
            </Button>
          )}
        </div>
      </section>
    );
  if (read && !mail.box.access?.read)
    return (
      <section className="mail-empty-state">
        <Icon name="shield" />
        <h1>Mailbox content is restricted</h1>
        <p>Your permissions do not include reading these messages.</p>
        {mail.box.access?.manage && (
          <Button
            nativeButton={false}
            render={<Link to={mail.href("/mail/settings")} />}
          >
            Manage sharing
          </Button>
        )}
      </section>
    );
  return (
    <>
      {mail.error && <MailNotice error={mail.error} />} {children}
    </>
  );
}
const snapshots = new Map<
  string,
  {
    messages: Message[];
    scroll: number;
    selected: string[];
    pages: (string | null)[];
    page: number;
  }
>();
export function MailPage() {
  const mail = useMail(),
    { user } = useAccount(),
    { pathname } = useLocation(),
    { folder } = useParams(),
    [params] = useSearchParams();
  const section = folder ? "folder" : (pathname.split("/")[2] ?? "inbox"),
    query = params.get("q") ?? "";
  const title = folder
    ? (mail.folders.find((f) => f.id === folder)?.name ?? "Folder")
    : ({
        inbox: "Inbox",
        drafts: "Drafts",
        sent: "Sent",
        archive: "Archive",
        spam: "Spam",
        trash: "Trash",
        starred: "Starred",
        snoozed: "Snoozed",
        all: "All mail",
        scheduled: "Scheduled",
      }[section] ?? "Inbox");
  return (
    <MailReady>
      <MailList
        key={`${user?.id}:${mail.box?.id}:${section}:${folder ?? ""}:${query}:${mail.preferences.conversation_view}`}
        section={section}
        folder={folder}
        title={title}
        query={query}
      />
      {mail.box?.access?.write && (
        <Button
          className="mail-mobile-compose"
          variant="primary"
          onClick={() => mail.compose()}
        >
          <Icon name="plus" />
          Compose
        </Button>
      )}
    </MailReady>
  );
}
function MailList({
  section,
  folder,
  title,
  query,
}: {
  section: string;
  folder?: string;
  title: string;
  query: string;
}) {
  const mail = useMail(),
    { user } = useAccount(),
    [params, setParams] = useSearchParams(),
    path = mailboxPath(mail.box!.id),
    action = useMailAction(),
    canWrite = !!mail.box!.access?.write;
  const grouped =
    mail.preferences.conversation_view &&
    !query &&
    !["drafts", "scheduled"].includes(section);
  const cacheKey = `${user?.id}:${mail.box!.id}:${section}:${folder ?? ""}:${query}:${grouped}`,
    saved = snapshots.get(cacheKey);
  const [messages, setMessages] = useState<Message[]>(saved?.messages ?? []),
    [selected, setSelected] = useState<string[]>(saved?.selected ?? []),
    [pages, setPages] = useState<(string | null)[]>(saved?.pages ?? [null]),
    [page, setPage] = useState(saved?.page ?? 0),
    [focus, setFocus] = useState(0),
    [discard, setDiscard] = useState(false);
  const failedSelections = useRef<Set<string> | null>(null);
  const scroller = useRef<HTMLDivElement>(null),
    selectedId = params.get("message"),
    split = mail.preferences.reading_pane === "right";
  const options = new URLSearchParams({ limit: "50" });
  if (
    !query &&
    (folder || !["starred", "snoozed", "all", "scheduled"].includes(section))
  )
    options.set("folder_id", folder ?? section);
  if (section === "all" || section === "scheduled") {
    options.set("view", section);
    options.set("include_snoozed", "true");
  }
  if (section === "starred" && !query) options.set("q", "is:starred");
  if (query) options.set("q", query);
  if (section === "snoozed") {
    options.set("snoozed_only", "true");
    options.set("include_snoozed", "true");
  }
  if (pages[page]) options.set("cursor", pages[page]!);
  const resource = useMailResource<{
    messages: Message[];
    next_cursor: string | null;
  }>(`${path}/${grouped ? "threads" : "messages"}?${options}`, mail.revision);
  useEffect(() => {
    if (resource.data) {
      setMessages(resource.data.messages);
      const failed = failedSelections.current;
      failedSelections.current = null;
      setSelected((old) =>
        failed
          ? resource
              .data!.messages.filter((message) =>
                failed.has(grouped ? message.thread_id : message.id),
              )
              .map((message) => message.id)
          : old.filter((id) =>
              resource.data!.messages.some((m) => m.id === id),
            ),
      );
    } else if (resource.error) {
      setMessages([]);
      snapshots.delete(cacheKey);
    }
  }, [resource.data, resource.error]);
  useEffect(() => {
    snapshots.set(cacheKey, {
      messages,
      scroll: scroller.current?.scrollTop ?? saved?.scroll ?? 0,
      selected,
      pages,
      page,
    });
    if (snapshots.size > 24) snapshots.delete(snapshots.keys().next().value!);
  }, [messages, selected, pages, page]);
  useLayoutEffect(() => {
    if (!selectedId && scroller.current)
      scroller.current.scrollTop = snapshots.get(cacheKey)?.scroll ?? 0;
  }, [selectedId]);
  const open = (id: string | null) => {
    const existing = snapshots.get(cacheKey);
    if (existing && scroller.current)
      existing.scroll = scroller.current.scrollTop;
    const next = new URLSearchParams(params);
    if (id) next.set("message", id);
    else next.delete("message");
    setParams(next);
  };
  async function expand(rows: Message[]): Promise<Message[]> {
    if (!grouped) return rows;
    const collected: Message[] = [];
    for (const row of rows) {
      const threadOptions = new URLSearchParams(options);
      threadOptions.delete("cursor");
      threadOptions.set("limit", "100");
      if (!threadOptions.has("include_snoozed"))
        threadOptions.set("include_snoozed", "false");
      let cursor: string | null = null;
      do {
        if (cursor) threadOptions.set("cursor", cursor);
        const result: { messages: Message[]; next_cursor: string | null } =
          await api(`${path}/threads/${row.thread_id}?${threadOptions}`);
        collected.push(...result.messages.filter((m) => !m.draft_owner_id));
        cursor = result.next_cursor;
      } while (cursor);
    }
    return [...new Map(collected.map((m) => [m.id, m])).values()];
  }
  async function mutate(
    rows: Message[],
    changes: Record<string, string | boolean | number | null>,
  ) {
    const items = await expand(rows),
      old = messages;
    const removed =
      "folder_id" in changes ||
      ("snoozed_until" in changes && section !== "snoozed");
    setMessages((current) =>
      removed
        ? current.filter((m) => !rows.some((r) => r.id === m.id))
        : current.map((m) =>
            rows.some((r) => r.id === m.id)
              ? {
                  ...m,
                  ...Object.fromEntries(
                    Object.entries(changes).map(([k, v]) => [
                      k,
                      typeof v === "boolean" ? Number(v) : v,
                    ]),
                  ),
                }
              : m,
          ),
    );
    const updated: { before: Message; version: number }[] = [],
      failures: string[] = [];
    try {
      for (let start = 0; start < items.length; start += 200) {
        const chunk = items.slice(start, start + 200);
        if ("snoozed_until" in changes) {
          for (const item of chunk) {
            try {
              const result = await api<{ message: Message }>(
                `${path}/messages/${item.id}`,
                {
                  method: "PATCH",
                  body: { version: item.version, ...changes },
                },
              );
              updated.push({ before: item, version: result.message.version });
            } catch {
              failures.push(item.id);
            }
          }
        } else {
          try {
            const result = await api<{
              results: { id: string; success: boolean; version: number }[];
            }>(path + "/messages/bulk", {
              method: "POST",
              body: {
                items: chunk.map(({ id, version }) => ({ id, version })),
                ...changes,
              },
            });
            for (const item of result.results)
              if (item.success)
                updated.push({
                  before: chunk.find((m) => m.id === item.id)!,
                  version: item.version,
                });
              else failures.push(item.id);
          } catch {
            failures.push(...chunk.map((item) => item.id));
          }
        }
      }
      if (failures.length)
        failedSelections.current = new Set(
          items
            .filter((item) => failures.includes(item.id))
            .map((item) => (grouped ? item.thread_id : item.id)),
        );
      setSelected(
        rows
          .filter((row) =>
            items.some(
              (m) => failures.includes(m.id) && m.thread_id === row.thread_id,
            ),
          )
          .map((r) => r.id),
      );
      if (updated.length)
        mail.feedback(
          changes.folder_id === "trash"
            ? "Moved to trash"
            : changes.folder_id === "archive"
              ? "Conversation archived"
              : "Mailbox updated",
          async () => {
            let failed = 0;
            for (const { before, version } of updated) {
              const restore: Record<string, unknown> = {};
              for (const key of Object.keys(changes)) {
                const value = before[key as keyof Message];
                restore[key] =
                  typeof changes[key] === "boolean" ? !!value : (value ?? null);
              }
              if ("folder_id" in changes) restore.is_spam = !!before.is_spam;
              try {
                await api(`${path}/messages/${before.id}`, {
                  method: "PATCH",
                  body: { version, ...restore },
                });
              } catch {
                failed++;
              }
            }
            mail.refresh();
            if (failed)
              throw new Error(
                `${failed} messages changed since this action and could not be restored.`,
              );
          },
        );
      if (
        removed &&
        selectedId &&
        rows.some((row) => row.id === selectedId) &&
        !failures.length
      )
        open(null);
      mail.refresh();
      if (failures.length)
        throw new Error(
          `${failures.length} messages could not be updated. Review the selected conversations and try again.`,
        );
    } catch (error) {
      if (removed && failures.length)
        setMessages(
          old.filter(
            (row) =>
              !rows.some((item) => item.id === row.id) ||
              items.some(
                (item) =>
                  failures.includes(item.id) &&
                  (grouped
                    ? item.thread_id === row.thread_id
                    : item.id === row.id),
              ),
          ),
        );
      else setMessages(old);
      mail.refresh();
      throw error;
    }
  }
  const run = (
    rows: Message[],
    changes: Record<string, string | boolean | number | null>,
  ) => {
    void action.run(() => mutate(rows, changes));
  };
  const selectedRows = messages.filter((m) => selected.includes(m.id));
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !mail.preferences.shortcuts ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,[contenteditable='true'],[role='dialog'],[role='menu'],[role='listbox'],.mail-compose-window,.mail-compose-inline",
          ))
      )
        return;
      if (["j", "k"].includes(event.key) && !selectedId) {
        event.preventDefault();
        setFocus((old) => {
          const next = Math.max(
            0,
            Math.min(messages.length - 1, old + (event.key === "j" ? 1 : -1)),
          );
          scroller.current
            ?.querySelectorAll<HTMLElement>(".mail-message-row")
            [next]?.focus();
          return next;
        });
      }
      const current =
        messages.find((message) => message.id === selectedId) ??
        messages[focus];
      if (event.key === "Enter" && !selectedId && current)
        current.draft_state === "editable"
          ? mail.compose(current.id)
          : open(current.id);
      if (
        event.key === "e" &&
        canWrite &&
        !["drafts", "scheduled"].includes(section) &&
        current &&
        !current.draft_owner_id
      )
        run(selectedRows.length ? selectedRows : [current], {
          folder_id: "archive",
        });
      if (event.key === "x" && canWrite && current)
        setSelected((old) =>
          old.includes(current.id)
            ? old.filter((id) => id !== current.id)
            : [...old, current.id],
        );
      if (event.key === "Escape" && selectedId) open(null);
      if (event.key === "r" && selectedId)
        window.dispatchEvent(
          new CustomEvent("officeflare:reply", { detail: selectedId }),
        );
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    mail.preferences.shortcuts,
    messages,
    focus,
    selectedId,
    selected,
    action.busy,
  ]);
  const actions = (rows: Message[]) =>
    section === "scheduled" ? (
      <Button
        size="sm"
        disabled={
          action.busy ||
          !(mail.box!.access?.send_as || mail.box!.access?.send_on_behalf)
        }
        onClick={() => {
          void action.run(async () => {
            let failed = 0;
            for (const row of rows) {
              try {
                const { message } = await api<{ message: MessageDetail }>(
                  `${path}/messages/${row.id}`,
                );
                const pending = message.submissions.find((submission) =>
                  ["scheduled", "queued", "retry_wait"].includes(
                    submission.status,
                  ),
                );
                if (!pending) throw new Error("Send is no longer pending");
                await api(`${path}/submissions/${pending.id}/cancel`, {
                  method: "POST",
                });
              } catch {
                failed++;
              }
            }
            mail.refresh();
            setSelected([]);
            if (failed)
              throw new Error(
                `${failed} sends could not be canceled. They may already be processing.`,
              );
            mail.feedback(
              "Scheduled sends canceled. Messages moved to Drafts.",
            );
          });
        }}
      >
        <Icon name="close" />
        Cancel scheduled send
      </Button>
    ) : (
      <>
        <MailIconButton
          icon="archive"
          label="Archive"
          disabled={
            !canWrite || action.busy || rows.some((row) => !!row.draft_owner_id)
          }
          onClick={() => run(rows, { folder_id: "archive" })}
        />
        <MailIconButton
          icon="trash"
          label={
            rows.every((row) => row.draft_state === "editable")
              ? "Discard drafts"
              : "Move to trash"
          }
          disabled={
            !canWrite ||
            action.busy ||
            (rows.some((row) => !!row.draft_owner_id) &&
              !rows.every((row) => row.draft_state === "editable"))
          }
          onClick={() =>
            rows.every((row) => row.draft_state === "editable")
              ? setDiscard(true)
              : run(rows, { folder_id: "trash" })
          }
        />
        <MailIconButton
          icon="mail"
          label={rows.every((m) => m.is_read) ? "Mark unread" : "Mark read"}
          disabled={!canWrite || action.busy}
          onClick={() => run(rows, { is_read: !rows.every((m) => m.is_read) })}
        />
        <MailMenu label="Move to folder" icon="folder">
          {mail.folders
            .filter((f) => !["drafts", "sent"].includes(f.system_key ?? ""))
            .map((f) => (
              <Menu.Item
                key={f.id}
                disabled={
                  !canWrite ||
                  action.busy ||
                  rows.some((row) => !!row.draft_owner_id)
                }
                onClick={() => run(rows, { folder_id: f.id })}
              >
                <Icon name="folder" />
                {f.name}
              </Menu.Item>
            ))}
        </MailMenu>
        <MailMenu label="Snooze" icon="clock">
          {[
            ["Later today", 3 * 3600],
            ["Tomorrow", 24 * 3600],
            ["Next week", 7 * 86400],
          ].map(([label, seconds]) => (
            <Menu.Item
              key={label}
              disabled={
                !canWrite ||
                rows.some((row) => !!row.draft_owner_id) ||
                action.busy
              }
              onClick={() =>
                run(rows, {
                  snoozed_until:
                    Math.floor(Date.now() / 1000) + Number(seconds),
                })
              }
            >
              {label}
            </Menu.Item>
          ))}
          {section === "snoozed" && (
            <Menu.Item
              disabled={!canWrite || action.busy}
              onClick={() => run(rows, { snoozed_until: null })}
            >
              Unsnooze
            </Menu.Item>
          )}
        </MailMenu>
        <MailMenu>
          <Menu.Item
            disabled={!canWrite || action.busy}
            onClick={() => run(rows, { is_starred: true })}
          >
            Add star
          </Menu.Item>
          <Menu.Item
            disabled={!canWrite || action.busy}
            onClick={() => run(rows, { is_starred: false })}
          >
            Remove star
          </Menu.Item>
          <Menu.Item
            disabled={
              !canWrite ||
              action.busy ||
              rows.some((row) => !!row.draft_owner_id)
            }
            onClick={() => run(rows, { folder_id: "spam", is_spam: true })}
          >
            Report spam
          </Menu.Item>
        </MailMenu>
      </>
    );
  const readerIndex = messages.findIndex((m) => m.id === selectedId),
    active = messages[readerIndex];
  const chips =
    query.match(/-?(?:[a-z]+:)?”[^”]*”|-?(?:[a-z]+:)?"[^"]*"|\S+/g) ?? [];
  return (
    <div
      className={`mail-inbox mail-density-${mail.preferences.density}${split ? " mail-split-view" : ""}${selectedId ? " mail-has-message" : ""}`}
    >
      <section className="mail-list-pane" aria-label={`${title} messages`}>
        <div className="mail-list-toolbar">
          <MailCheckbox
            aria-label="Select all messages on this page"
            checked={messages.length > 0 && selected.length === messages.length}
            indeterminate={
              selected.length > 0 && selected.length < messages.length
            }
            disabled={!canWrite || !messages.length}
            onCheckedChange={(checked) =>
              setSelected(checked ? messages.map((m) => m.id) : [])
            }
          />
          {selected.length ? (
            <>
              <span className="mail-selection-count">
                {selected.length} selected
              </span>
              {actions(selectedRows)}
            </>
          ) : (
            <>
              <MailIconButton
                icon="refresh"
                label="Refresh messages"
                disabled={resource.loading}
                onClick={() => mail.refresh()}
              />
              <h1>{query ? "Search results" : title}</h1>
            </>
          )}
          <div className="mail-toolbar-spacer" />
          <span className="mail-page-range">
            {messages.length
              ? `${page * 50 + 1}–${page * 50 + messages.length}`
              : ""}
          </span>
          <MailIconButton
            icon="back"
            label="Previous page"
            disabled={page === 0 || resource.loading}
            onClick={() => {
              setPage(page - 1);
              setSelected([]);
              scroller.current?.scrollTo(0, 0);
            }}
          />
          <MailIconButton
            icon="arrow"
            label="Next page"
            disabled={!resource.data?.next_cursor || resource.loading}
            onClick={() => {
              setPages([
                ...pages.slice(0, page + 1),
                resource.data!.next_cursor,
              ]);
              setPage(page + 1);
              setSelected([]);
              scroller.current?.scrollTo(0, 0);
            }}
          />
        </div>
        {query && (
          <div className="mail-search-chips">
            {chips.map((chip, index) => (
              <Button
                variant="subtle"
                size="sm"
                key={`${chip}:${index}`}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  const remaining = chips
                    .filter((_, i) => i !== index)
                    .join(" ");
                  if (remaining) next.set("q", remaining);
                  else next.delete("q");
                  next.delete("message");
                  setParams(next);
                }}
              >
                {chip}
                <Icon name="close" width="12" height="12" />
              </Button>
            ))}
            <span>in {mail.box!.name}</span>
          </div>
        )}
        <MailNotice error={action.error} />
        <MailState
          loading={resource.loading && !messages.length}
          error={resource.error}
          retry={resource.reload}
        />
        <div
          className="mail-message-list"
          ref={scroller}
          onScroll={() => {
            const snap = snapshots.get(cacheKey);
            if (snap) snap.scroll = scroller.current?.scrollTop ?? 0;
          }}
        >
          {messages.map((message, index) => (
            <div
              key={message.id}
              tabIndex={0}
              onFocus={() => setFocus(index)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget)
                  message.draft_state === "editable"
                    ? mail.compose(message.id)
                    : open(message.id);
              }}
              className={`mail-message-row${!message.is_read ? " mail-unread" : ""}${selected.includes(message.id) ? " mail-checked" : ""}${selectedId === message.id ? " mail-selected" : ""}`}
            >
              <MailCheckbox
                aria-label={`Select ${message.subject || "Untitled message"}`}
                checked={selected.includes(message.id)}
                disabled={!canWrite}
                onCheckedChange={(checked) =>
                  setSelected(
                    checked
                      ? [...selected, message.id]
                      : selected.filter((id) => id !== message.id),
                  )
                }
              />
              <MailIconButton
                icon="star"
                label={message.is_starred ? "Remove star" : "Add star"}
                className="mail-star"
                aria-pressed={!!message.is_starred}
                disabled={!canWrite || action.busy}
                onClick={() =>
                  run([message], { is_starred: !message.is_starred })
                }
              />
              <Button
                variant="ghost"
                className="mail-message-summary"
                onClick={() =>
                  message.draft_state === "editable"
                    ? mail.compose(message.id)
                    : open(message.id)
                }
              >
                <span className="mail-row-sender">
                  {message.draft_state === "editable" ? (
                    <>
                      <em>Draft</em>{" "}
                      {message.recipient_summary || "No recipients"}
                    </>
                  ) : section === "sent" || section === "scheduled" ? (
                    message.recipient_summary || "No recipients"
                  ) : (
                    message.participants || message.from_address || "Me"
                  )}
                  {(message.message_count ?? 0) > 1 && (
                    <small> ({message.message_count})</small>
                  )}
                </span>
                <span className="mail-row-content">
                  <strong>{message.subject || "(No subject)"}</strong>
                  <span className="mail-row-snippet">
                    {" "}
                    — {message.snippet || "No preview"}
                  </span>
                </span>
                <span className="mail-row-indicators">
                  {!!message.has_attachments && <Icon name="attachment" />}
                  {!!message.snoozed_until && <Icon name="clock" />}
                </span>
                <time
                  title={mailDate(message.scheduled_at ?? message.received_at)}
                >
                  {new Date(
                    (message.scheduled_at ?? message.received_at) * 1000,
                  ).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                  {section === "scheduled" && message.scheduled_at && (
                    <small className="mail-row-schedule-time">
                      {new Date(message.scheduled_at * 1000).toLocaleTimeString(
                        undefined,
                        { hour: "numeric", minute: "2-digit" },
                      )}
                    </small>
                  )}
                </time>
              </Button>
              {!message.draft_owner_id && (
                <div className="mail-row-quick-actions">
                  <MailIconButton
                    icon="archive"
                    label="Archive conversation"
                    disabled={!canWrite || action.busy}
                    onClick={() => run([message], { folder_id: "archive" })}
                  />
                  <MailIconButton
                    icon="trash"
                    label="Delete conversation"
                    disabled={!canWrite || action.busy}
                    onClick={() => run([message], { folder_id: "trash" })}
                  />
                  <MailIconButton
                    icon="mail"
                    label={message.is_read ? "Mark unread" : "Mark read"}
                    disabled={!canWrite || action.busy}
                    onClick={() =>
                      run([message], { is_read: !message.is_read })
                    }
                  />
                </div>
              )}
            </div>
          ))}
          {!resource.loading && !resource.error && !messages.length && (
            <div className="mail-empty">
              <span className="mail-empty-illustration">
                <Icon
                  name={query ? "search" : "inbox"}
                  width="32"
                  height="32"
                />
              </span>
              <h2>
                {query
                  ? "No matching messages"
                  : section === "inbox"
                    ? "You're all caught up"
                    : `${title} is empty`}
              </h2>
              <p>
                {query
                  ? "Try a different search or remove a filter."
                  : section === "drafts"
                    ? "Your drafts are saved here automatically."
                    : "Messages will appear here when you need them."}
              </p>
            </div>
          )}
        </div>
      </section>
      {selectedId && (
        <div className="mail-reader-pane">
          {active && !active.draft_owner_id && (
            <div className="mail-detail-actions">
              {actions([active])}
              <MailNotice error={action.error} />
            </div>
          )}
          <ConversationReader
            key={`${mail.box!.id}:${selectedId}`}
            id={selectedId}
            onClose={() => open(null)}
            onPrevious={
              readerIndex > 0
                ? () => open(messages[readerIndex - 1]!.id)
                : undefined
            }
            onNext={
              readerIndex >= 0 && readerIndex < messages.length - 1
                ? () => open(messages[readerIndex + 1]!.id)
                : undefined
            }
          />
        </div>
      )}
      <Confirm
        open={discard}
        title="Discard selected drafts?"
        description="The selected drafts and attachments will be permanently removed."
        label="Discard drafts"
        destructive
        onClose={() => setDiscard(false)}
        onConfirm={async () => {
          const failed: string[] = [];
          for (const item of selectedRows) {
            try {
              await api(`${path}/drafts/${item.id}`, { method: "DELETE" });
            } catch {
              failed.push(item.id);
            }
          }
          setSelected(failed);
          mail.refresh();
          if (failed.length)
            throw new Error(
              `${failed.length} drafts could not be discarded. Check the selected drafts and try again.`,
            );
        }}
      />
    </div>
  );
}

import { useEffect, useMemo, memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { mailViewOptions, mailGrouped, folderMoveLeavesMailView } from "../../src/mail/ui-query";
import { type MailCommandResult } from "../lib/mail-ui";
import { useMailCache } from "../components/mail-resource-context";
import { MailOperation } from "../lib/mail";
import { api } from "../lib/api";
import {
  mailboxPath,
  mailDate,
  cancelableSubmission,
  submissionLabel,
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
  useMailMobile,
} from "../components/mail-common";
import { Button, Toggle, Icon, Menu, MenuPopup, Popover, PopoverPopup } from "../components/ui";
import { useAccount } from "../components/account-context";
import { useAccess } from "../components/console-access";
import { useSession } from "../lib/session";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { Confirm } from "../components/console-shared";
export function MailReady({ children, read = true }: { children: ReactNode; read?: boolean }) {
  const mail = useMail(),
    access = useAccess();
  if (!mail.box && mail.loading)
    return (
      <div className="mail-list-loading">
        <div className="mail-loading-toolbar" aria-hidden="true">
          <span className="skeleton-avatar" />
          <span className="skeleton-line skeleton-short" />
        </div>
        <LoadingSkeleton kind="list" label="Loading your mailbox…" rows={6} />
      </div>
    );
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
          <Button nativeButton={false} render={<Link to={mail.href("/mail/settings")} />}>
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
        scheduled: "Outbox",
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
      {mail.box?.access?.write && !mail.composing && (
        <Button className="mail-mobile-compose" variant="primary" onClick={() => mail.compose()}>
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
    canWrite = !!mail.box!.access?.write,
    mobile = useMailMobile();
  const cache = useMailCache();
  const grouped = mailGrouped(section, query, mail.preferences.conversation_view);
  const sessionId = useSession().session?.tokens.session_id;
  const cacheKey = `${sessionId}:${user?.id}:${mail.box!.id}:${section}:${folder ?? ""}:${query}:${grouped}`,
    saved = snapshots.get(cacheKey);
  const [selected, setSelected] = useState<string[]>(saved?.selected ?? []),
    [pages, setPages] = useState<(string | null)[]>(saved?.pages ?? [null]),
    [page, setPage] = useState(saved?.page ?? 0),
    [focus, setFocus] = useState(0),
    [selectionMode, setSelectionMode] = useState(false),
    [discard, setDiscard] = useState(false);
  const failedSelections = useRef<Set<string> | null>(null);
  const scroller = useRef<HTMLDivElement>(null),
    selectionButton = useRef<HTMLButtonElement>(null),
    selectedId = params.get("message"),
    split = mail.preferences.reading_pane === "right",
    selecting = mobile && canWrite && (selectionMode || selected.length > 0);
  const toggleSelected = (id: string) => {
    if (mobile) setSelectionMode(true);
    setSelected((old) => (old.includes(id) ? old.filter((item) => item !== id) : [...old, id]));
  };
  const exitSelection = () => {
    setSelectionMode(false);
    setSelected([]);
    selectionButton.current?.focus();
  };
  const options = mailViewOptions(section, folder, query);
  options.set("grouped", String(grouped));
  if (pages[page]) options.set("cursor", pages[page]!);
  const resource = useMailResource<{
    messages: Message[];
    next_cursor: string | null;
  }>(`${path}/ui/view?${options}`, mail.revision);
  const messages = resource.data?.messages ?? (resource.error ? [] : (saved?.messages ?? []));
  const setMessages = (update: Message[] | ((current: Message[]) => Message[])) => {
    const current = (cache.snapshot(resource.path).data as {
      messages: Message[];
      next_cursor: string | null;
    } | null) ?? { messages, next_cursor: null };
    cache.replace(resource.path!, {
      ...current,
      messages: typeof update === "function" ? update(current.messages) : update,
    });
  };
  useEffect(() => {
    if (resource.data) {
      const failed = failedSelections.current;
      failedSelections.current = null;
      setSelected((old) => {
        const next = failed
          ? resource
              .data!.messages.filter((message) =>
                failed.has(grouped ? message.thread_id : message.id),
              )
              .map((message) => message.id)
          : old.filter((id) => resource.data!.messages.some((message) => message.id === id));
        return next.length === old.length && next.every((id, index) => id === old[index])
          ? old
          : next;
      });
    } else if (resource.error) {
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
  useEffect(() => {
    if (!mobile || !canWrite) setSelectionMode(false);
    if (!canWrite) setSelected([]);
  }, [mobile, canWrite]);
  const open = (id: string | null) => {
    const existing = snapshots.get(cacheKey);
    if (existing && scroller.current) existing.scroll = scroller.current.scrollTop;
    const next = new URLSearchParams(params);
    if (id) next.set("message", id);
    else next.delete("message");
    setParams(next);
  };
  async function mutate(
    rows: Message[],
    changes: Record<string, string | boolean | number | null>,
  ) {
    const finishMutation = cache.beginMutation();
    const originals = new Map(rows.map((row) => [row.id, row]));
    const removed =
      ("folder_id" in changes &&
        folderMoveLeavesMailView(section, query, String(changes.folder_id))) ||
      ("snoozed_until" in changes && section !== "snoozed");
    // React paints the optimistic change before any conversation expansion or HTTP work.
    setMessages((current) =>
      current.flatMap((row) =>
        !originals.has(row.id)
          ? [row]
          : removed
            ? []
            : [
                {
                  ...row,
                  ...Object.fromEntries(
                    Object.entries(changes).map(([key, value]) => [
                      key,
                      typeof value === "boolean" ? Number(value) : value,
                    ]),
                  ),
                },
              ],
      ),
    );
    const restore = (failed: Set<string>) =>
      setMessages((current) => {
        const existing = new Set(current.map((row) => row.id));
        const restored = current.map((row) =>
          failed.has(row.id) && row.version === originals.get(row.id)?.version
            ? originals.get(row.id)!
            : row,
        );
        for (const [id, row] of originals)
          if (failed.has(id) && !existing.has(id)) restored.push(row);
        return restored.sort((a, b) => b.received_at - a.received_at || b.id.localeCompare(a.id));
      });
    let settled = false;
    try {
      const body = {
        targets: rows.map(({ id, version }) => ({ id, version, thread: grouped })),
        changes,
        scope: options.toString(),
      };
      const operation = new MailOperation();
      const result = await api<MailCommandResult>(path + "/ui/commands", {
        method: "POST",
        body,
        headers: operation.headers(body),
      });
      settled = true;
      mail.committed(result);
      const failures = result.results.filter((item) => !item.success);
      const successful = result.results.flatMap((item) => (item.success ? [item] : []));
      const failedRows = new Set(
        rows
          .filter((row) =>
            failures.some((item) => item.id === row.id || item.thread_id === row.thread_id),
          )
          .map((row) => row.id),
      );
      if (failures.length) {
        restore(failedRows);
        cache.invalidate(resource.path!);
      }
      setSelected([...failedRows]);
      if (successful.length)
        mail.feedback(
          changes.folder_id === "trash"
            ? "Moved to trash"
            : changes.folder_id === "archive"
              ? "Conversation archived"
              : "Mailbox updated",
          async () => {
            const targets = successful.map(({ before, message }) => {
              const restore: Record<string, unknown> = {};
              for (const key of Object.keys(changes))
                restore[key] =
                  typeof changes[key] === "boolean"
                    ? !!before[key as keyof Message]
                    : (before[key as keyof Message] ?? null);
              if ("folder_id" in changes) restore.is_spam = !!before.is_spam;
              return { id: before.id, version: message.version, changes: restore };
            });
            for (let start = 0; start < targets.length; start += 200) {
              const body = { targets: targets.slice(start, start + 200) },
                operation = new MailOperation();
              const finish = cache.beginMutation();
              let restored: MailCommandResult;
              try {
                restored = await api<MailCommandResult>(path + "/ui/commands", {
                  method: "POST",
                  body,
                  headers: operation.headers(body),
                });
                mail.committed(restored);
              } finally {
                finish();
              }
              if (restored.results.some((item) => !item.success))
                throw new Error(
                  "Some messages changed since this action and could not be restored.",
                );
            }
          },
        );
      if (removed && selectedId && rows.some((row) => row.id === selectedId) && !failures.length)
        open(null);
      if (failures.length)
        throw new Error(
          `${failures.length} messages could not be updated. Review the selected conversations and try again.`,
        );
    } catch (error) {
      // An uncertain result is reconciled from the server; rollback touches only this action.
      if (!settled) {
        restore(new Set(originals.keys()));
        cache.invalidate(resource.path!);
      }
      throw error;
    } finally {
      finishMutation();
    }
  }

  const pendingRows = useRef(new Set<string>());
  const run = (rows: Message[], changes: Record<string, string | boolean | number | null>) => {
    if (action.busy) return;
    pendingRows.current = new Set(rows.map((row) => row.id));
    void action.run(() => mutate(rows, changes));
  };
  const selectedRows = messages.filter((message) => selected.includes(message.id));
  const events = useRef({
    focus: setFocus,
    select: toggleSelected,
    compose: mail.compose,
    open: (id: string) => open(id),
    run,
  });
  events.current = {
    focus: setFocus,
    select: toggleSelected,
    compose: mail.compose,
    open: (id: string) => open(id),
    run,
  };
  const rowHandlers = useMemo(
    () => ({
      focus: (index: number) => events.current.focus(index),
      select: (id: string) => events.current.select(id),
      compose: (id: string) => events.current.compose(id),
      open: (id: string) => events.current.open(id),
      run: (rows: Message[], changes: Record<string, string | boolean | number | null>) =>
        events.current.run(rows, changes),
    }),
    [],
  );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
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
          scroller.current?.querySelectorAll<HTMLElement>(".mail-message-row")[next]?.focus();
          return next;
        });
      }
      const current = messages.find((message) => message.id === selectedId) ?? messages[focus];
      if (
        event.key === "Enter" &&
        !selectedId &&
        current &&
        !(event.target instanceof HTMLElement && event.target.closest("button,a,[role='checkbox']"))
      ) {
        if (selecting) toggleSelected(current.id);
        else if (current.draft_state === "editable") mail.compose(current.id);
        else open(current.id);
      }
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
      if (event.key === "x" && canWrite && current) toggleSelected(current.id);
      if (event.key === "Escape" && selectedId) open(null);
      if (event.key === "r" && selectedId)
        window.dispatchEvent(new CustomEvent("officeflare:reply", { detail: selectedId }));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    mail.preferences.shortcuts,
    messages,
    focus,
    selectedId,
    selected,
    selecting,
    mobile,
    canWrite,
    action.busy,
  ]);
  const actions = (rows: Message[], messageActions?: ReactNode) =>
    section === "scheduled" ? (
      <>
        <Button
          size="sm"
          disabled={
            action.busy ||
            !rows.length ||
            rows.some((row) => !cancelableSubmission(row.submission_status ?? "")) ||
            !mail.box!.access?.send
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
                    cancelableSubmission(submission.status),
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
                rows.some((row) => row.submission_status === "unknown")
                  ? "Drafts reopened. A message with unknown acceptance may already have been sent."
                  : "Pending sends canceled. Messages moved to Drafts.",
              );
            });
          }}
        >
          <Icon name="close" />
          Cancel send
        </Button>
        {messageActions && <MailMenu>{messageActions}</MailMenu>}
      </>
    ) : (
      <>
        <MailIconButton
          icon="archive"
          label="Archive"
          disabled={!canWrite || action.busy || rows.some((row) => !!row.draft_owner_id)}
          onClick={() => run(rows, { folder_id: "archive" })}
        />
        <MailIconButton
          icon="trash"
          label={
            rows.every((row) => row.draft_state === "editable") ? "Discard drafts" : "Move to trash"
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
        {!mobile && (
          <>
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
                    disabled={!canWrite || action.busy || rows.some((row) => !!row.draft_owner_id)}
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
                  disabled={!canWrite || rows.some((row) => !!row.draft_owner_id) || action.busy}
                  onClick={() =>
                    run(rows, {
                      snoozed_until: Math.floor(Date.now() / 1000) + Number(seconds),
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
          </>
        )}
        <MailMenu>
          {mobile && (
            <>
              {!messageActions && (
                <Menu.Item
                  disabled={!canWrite || action.busy}
                  onClick={() => run(rows, { is_read: !rows.every((m) => m.is_read) })}
                >
                  <Icon name="mail" />
                  {rows.every((m) => m.is_read) ? "Mark unread" : "Mark read"}
                </Menu.Item>
              )}
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger>
                  <Icon name="folder" />
                  Move to folder
                  <Icon name="chevron" />
                </Menu.SubmenuTrigger>
                <MenuPopup className="mail-action-menu">
                  {mail.folders
                    .filter((f) => !["drafts", "sent"].includes(f.system_key ?? ""))
                    .map((f) => (
                      <Menu.Item
                        key={f.id}
                        disabled={
                          !canWrite || action.busy || rows.some((row) => !!row.draft_owner_id)
                        }
                        onClick={() => run(rows, { folder_id: f.id })}
                      >
                        <Icon name="folder" />
                        {f.name}
                      </Menu.Item>
                    ))}
                </MenuPopup>
              </Menu.SubmenuRoot>
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger>
                  <Icon name="clock" />
                  Snooze
                  <Icon name="chevron" />
                </Menu.SubmenuTrigger>
                <MenuPopup className="mail-action-menu">
                  {[
                    ["Later today", 3 * 3600],
                    ["Tomorrow", 24 * 3600],
                    ["Next week", 7 * 86400],
                  ].map(([label, seconds]) => (
                    <Menu.Item
                      key={label}
                      disabled={
                        !canWrite || rows.some((row) => !!row.draft_owner_id) || action.busy
                      }
                      onClick={() =>
                        run(rows, {
                          snoozed_until: Math.floor(Date.now() / 1000) + Number(seconds),
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
                </MenuPopup>
              </Menu.SubmenuRoot>
              <Menu.Separator />
            </>
          )}

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
            disabled={!canWrite || action.busy || rows.some((row) => !!row.draft_owner_id)}
            onClick={() => run(rows, { folder_id: "spam", is_spam: true })}
          >
            Report spam
          </Menu.Item>
          {messageActions && (
            <>
              <Menu.Separator />
              {messageActions}
            </>
          )}
        </MailMenu>
      </>
    );
  const readerIndex = messages.findIndex((m) => m.id === selectedId),
    active = messages[readerIndex];
  const chips = query.match(/-?(?:[a-z]+:)?”[^”]*”|-?(?:[a-z]+:)?"[^"]*"|\S+/g) ?? [];
  return (
    <div
      className={`mail-inbox mail-density-${mail.preferences.density}${split ? " mail-split-view" : ""}${selectedId ? " mail-has-message" : ""}${selecting ? " mail-selection-mode" : ""}`}
    >
      <section
        className="mail-list-pane"
        aria-label={`${title} messages`}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            selecting &&
            !event.defaultPrevented &&
            !(
              event.target instanceof HTMLElement &&
              event.target.closest("[role='menu'],[role='dialog']")
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            exitSelection();
          }
        }}
      >
        <div className="mail-list-toolbar">
          {(!mobile || selecting) && (
            <MailCheckbox
              hitArea
              aria-label="Select all messages on this page"
              checked={messages.length > 0 && selected.length === messages.length}
              indeterminate={selected.length > 0 && selected.length < messages.length}
              disabled={!canWrite || !messages.length}
              onCheckedChange={(checked) => setSelected(checked ? messages.map((m) => m.id) : [])}
            />
          )}
          {selecting ? (
            <span className="mail-selection-count" role="status">
              {selected.length ? `${selected.length} selected` : "Select messages"}
            </span>
          ) : selected.length ? (
            <>
              <span className="mail-selection-count">{selected.length} selected</span>
              <div className="mail-toolbar-actions">{actions(selectedRows)}</div>
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
          {mobile && canWrite && (
            <Button
              ref={selectionButton}
              variant="ghost"
              size="touch"
              aria-label={selecting ? "Exit selection mode" : "Select messages"}
              aria-pressed={selecting}
              disabled={!messages.length && !selecting}
              onClick={() => {
                if (selecting) exitSelection();
                else setSelectionMode(true);
              }}
            >
              {selecting ? "Done" : "Select"}
            </Button>
          )}
          {!selecting && (
            <>
              <span className="mail-page-range">
                {messages.length ? `${page * 50 + 1}–${page * 50 + messages.length}` : ""}
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
                  setPages([...pages.slice(0, page + 1), resource.data!.next_cursor]);
                  setPage(page + 1);
                  setSelected([]);
                  scroller.current?.scrollTo(0, 0);
                }}
              />
            </>
          )}
        </div>
        {section === "scheduled" && !query && (
          <p className="mail-outbox-hint">
            Scheduled and sending messages stay here until sending is confirmed. Open a message to
            check its status. An unknown outcome may mean it was already sent; check before sending
            another copy.
          </p>
        )}
        {query && (
          <div className="mail-search-chips">
            {chips.map((chip, index) => (
              <Button
                variant="subtle"
                size="sm"
                key={`${chip}:${index}`}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  const remaining = chips.filter((_, i) => i !== index).join(" ");
                  if (remaining) next.set("q", remaining);
                  else next.delete("q");
                  next.delete("message");
                  setParams(next);
                }}
              >
                <span>{chip}</span>
                <Icon name="close" width="12" height="12" />
              </Button>
            ))}
            <span>in {mail.box!.name}</span>
          </div>
        )}
        <MailNotice error={action.error} />
        <MailState
          kind="list"
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
            <MailMessageRow
              key={message.id}
              message={message}
              index={index}
              section={section}
              mobile={mobile}
              selecting={selecting}
              canWrite={canWrite}
              checked={selected.includes(message.id)}
              active={selectedId === message.id}
              busy={action.busy && pendingRows.current.has(message.id)}
              handlers={rowHandlers}
            />
          ))}
          {!resource.loading && !resource.error && !messages.length && (
            <div className="mail-empty">
              <span className="mail-empty-illustration">
                <Icon name={query ? "search" : "inbox"} width="32" height="32" />
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
        {selecting && selectedRows.length > 0 && (
          <div
            className="mail-mobile-selection-actions"
            role="toolbar"
            aria-label="Selected message actions"
          >
            {actions(selectedRows)}
          </div>
        )}
      </section>
      {selectedId && (
        <div className="mail-reader-pane">
          <ConversationReader
            key={`${mail.box!.id}:${selectedId}`}
            id={selectedId}
            actions={
              active && !active.draft_owner_id
                ? (messageActions) => actions([active], messageActions)
                : undefined
            }
            actionError={action.error}
            onClose={() => open(null)}
            onPrevious={readerIndex > 0 ? () => open(messages[readerIndex - 1]!.id) : undefined}
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

interface MailRowHandlers {
  focus: (index: number) => void;
  select: (id: string) => void;
  compose: (id: string) => void;
  open: (id: string) => void;
  run: (rows: Message[], changes: Record<string, string | boolean | number | null>) => void;
}
const MailMessageRow = memo(function MailMessageRow({
  message,
  index,
  section,
  mobile,
  selecting,
  canWrite,
  checked,
  active,
  busy,
  handlers,
}: {
  message: Message;
  index: number;
  section: string;
  mobile: boolean;
  selecting: boolean;
  canWrite: boolean;
  checked: boolean;
  active: boolean;
  busy: boolean;
  handlers: MailRowHandlers;
}) {
  return (
    <div
      key={message.id}
      tabIndex={0}
      onFocus={() => handlers.focus(index)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.stopPropagation();
          if (selecting) handlers.select(message.id);
          else if (message.draft_state === "editable") handlers.compose(message.id);
          else handlers.open(message.id);
        }
      }}
      className={`mail-message-row${!message.is_read ? " mail-unread" : ""}${checked ? " mail-checked" : ""}${active ? " mail-selected" : ""}`}
    >
      {(!mobile || selecting) && (
        <MailCheckbox
          hitArea
          aria-label={`Select ${message.subject || "Untitled message"}`}
          checked={checked}
          disabled={!canWrite}
          onCheckedChange={() => handlers.select(message.id)}
        />
      )}
      {!selecting && (
        <Toggle
          data-size="icon"
          data-variant="star"
          className="mail-star"
          aria-label={message.is_starred ? "Remove star" : "Add star"}
          pressed={!!message.is_starred}
          disabled={!canWrite || busy}
          onPressedChange={() => handlers.run([message], { is_starred: !message.is_starred })}
        >
          <Icon name="star" />
        </Toggle>
      )}
      <Button
        variant="plain"
        className="mail-message-summary"
        aria-pressed={selecting ? checked : undefined}
        onClick={() => {
          if (selecting) handlers.select(message.id);
          else if (message.draft_state === "editable") handlers.compose(message.id);
          else handlers.open(message.id);
        }}
      >
        <span className="mail-row-sender">
          {message.draft_state === "editable" ? (
            <>
              <em>Draft</em> {message.recipient_summary || "No recipients"}
            </>
          ) : section === "sent" || section === "scheduled" ? (
            message.recipient_summary || "No recipients"
          ) : (
            message.participants || message.from_address || "Me"
          )}
          {(message.message_count ?? 0) > 1 && <small> ({message.message_count})</small>}
        </span>
        <span className="mail-row-content">
          {section === "scheduled" && message.submission_status && (
            <span className="mail-badge" data-status={message.submission_status}>
              {submissionLabel(message.submission_status)}
            </span>
          )}
          <strong>{message.subject || "(No subject)"}</strong>
          <span className="mail-row-snippet"> — {message.snippet || "No preview"}</span>
        </span>
        <span className="mail-row-indicators">
          {!!message.has_attachments && <Icon name="attachment" />}
          {!!message.snoozed_until && <Icon name="clock" />}
        </span>
        <time title={mailDate(message.scheduled_at ?? message.received_at)}>
          {new Date((message.scheduled_at ?? message.received_at) * 1000).toLocaleDateString(
            undefined,
            {
              month: "short",
              day: "numeric",
            },
          )}
          {section === "scheduled" &&
            message.submission_status === "scheduled" &&
            message.scheduled_at && (
              <small className="mail-row-schedule-time">
                {new Date(message.scheduled_at * 1000).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </small>
            )}
        </time>
      </Button>
      {!message.draft_owner_id && (
        <div className="mail-row-quick-actions">
          <MailIconButton
            icon="archive"
            label="Archive conversation"
            disabled={!canWrite || busy}
            onClick={() => handlers.run([message], { folder_id: "archive" })}
          />
          <MailIconButton
            icon="trash"
            label="Delete conversation"
            disabled={!canWrite || busy}
            onClick={() => handlers.run([message], { folder_id: "trash" })}
          />
          <MailIconButton
            icon="mail"
            label={message.is_read ? "Mark unread" : "Mark read"}
            disabled={!canWrite || busy}
            onClick={() => handlers.run([message], { is_read: !message.is_read })}
          />
        </div>
      )}
    </div>
  );
});

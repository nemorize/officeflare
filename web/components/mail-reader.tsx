import { useEffect, useRef, useState, type ReactNode } from "react";
import { type MailCommandResult } from "../lib/mail-ui";
import { useMailCache } from "./mail-resource-context";
import { api, ApiError } from "../lib/api";
import {
  bytes,
  downloadMail,
  mailboxPath,
  mailDate,
  MailOperation,
  cancelableSubmission,
  type Message,
  type MessageDetail,
} from "../lib/mail";
import { useMail } from "./mail-context";
import { MailIconButton, MailMenu } from "./mail-controls";
import { MailHtml, SendStatus } from "./mail-body";
import {
  MailNotice,
  MailState,
  useMailAction,
  useMailResource,
} from "./mail-common";
import { Button, Icon, Menu, Popover, PopoverPopup } from "./ui";
import { Confirm } from "./console-shared";
export function ConversationReader({
  id,
  onClose,
  onPrevious,
  onNext,
  actions,
  actionError,
}: {
  id: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  actions?: (messageActions: ReactNode) => ReactNode;
  actionError?: string;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const mail = useMail(), cache = useMailCache(),
    path = mailboxPath(mail.box!.id),
    initial = useMailResource<{ message: MessageDetail; messages: Message[]; next_cursor: string | null }>(
      `${path}/ui/conversation/${id}?conversation=${mail.preferences.conversation_view}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      mail.revision,
    ),
    message = initial.data?.message,
    action = useMailAction(),
    canWrite = !!mail.box?.access?.write;
  const [entries, setEntries] = useState<Message[]>([]),
    [expandAll, setExpandAll] = useState(false),
    [plain, setPlain] = useState(false),
    [actionId, setActionId] = useState(id),
    [deleting, setDeleting] = useState<MessageDetail | null>(null);
  const focused = useMailResource<{ message: MessageDetail }>(
      actionId !== id ? `${path}/messages/${actionId}` : null,
      mail.revision,
    ),
    target = actionId === id ? message : focused.data?.message;
  const thread = initial;
  useEffect(() => {
    if (thread.data)
      setEntries((old) =>
        cursor
          ? [
              ...new Map(
                [...old, ...thread.data!.messages].map((entry) => [
                  entry.id,
                  entry,
                ]),
              ).values(),
            ]
          : thread.data!.messages,
      );
  }, [thread.data]);
  const messages =
    message?.draft || !mail.preferences.conversation_view
      ? message
        ? [message]
        : []
      : entries.length
        ? entries
        : message
          ? [message]
          : [];
  const change = async (changes: object) => {
    if (!target) return;
    const body = { targets: [{ id: target.id, version: target.version }], changes };
    const finish = cache.beginMutation();
    try {
      const result = await api<MailCommandResult>(path + "/ui/commands", { method: "POST", body, headers: new MailOperation().headers(body) });
      mail.committed(result);
      const failure = result.results.find(item => !item.success);
      if (failure && !failure.success) { initial.reload(); throw new Error(failure.error); }
    } finally { finish(); }
  };

  const messageActions = target && (
    <>
      <Menu.Item
        disabled={!canWrite || action.busy}
        onClick={() => {
          void action.run(() => change({ is_read: false }));
        }}
      >
        Mark unread
      </Menu.Item>
      <Menu.Item
        disabled={!canWrite || !!target.draft || action.busy}
        onClick={() => {
          void action.run(() =>
            change({
              folder_id: target.folder_id === "trash" ? "inbox" : "trash",
            }),
          );
        }}
      >
        {target.folder_id === "trash" ? "Restore to inbox" : "Move to trash"}
      </Menu.Item>
      <Menu.Item onClick={() => setPlain(!plain)}>
        {plain ? "Show formatted message" : "Show plain text"}
      </Menu.Item>
      <Menu.Item
        disabled={action.busy}
        onClick={() => {
          void action.run(() =>
            downloadMail(`${path}/messages/${actionId}/original`, "message.eml"),
          );
        }}
      >
        Download original
      </Menu.Item>
      <Menu.Item
        disabled={!canWrite || action.busy}
        onClick={() => {
          void action.run(async () => {
            await api(path + "/blocked-senders", {
              method: "PUT",
              body: { email_address: target.from_address, blocked: true },
            });
            mail.feedback("Sender blocked");
          });
        }}
      >
        Block sender
      </Menu.Item>
      {(target.draft ||
        target.folder_id === "trash" ||
        target.folder_id === "spam") && (
        <Menu.Item
          disabled={
            !canWrite || action.busy || target.draft?.state === "submitted"
          }
          onClick={() => setDeleting(target)}
        >
          {target.draft ? "Discard draft" : "Delete permanently"}
        </Menu.Item>
      )}
      <Menu.Separator />
      <Menu.Item
        onClick={() =>
          mail.feedback(
            `Provider: ${target.provider ?? "—"} · Message ID: ${target.rfc_message_id ?? "—"}`,
            undefined,
            undefined,
            15000,
          )
        }
      >
        Technical details
      </Menu.Item>
    </>
  );
  return (
    <section className="mail-conversation" aria-label="Message detail">
      <div className="mail-conversation-toolbar">
        <MailIconButton
          icon="back"
          label="Back to messages"
          onClick={onClose}
        />
        {(actions || messageActions) && (
          <div className="mail-toolbar-actions">
            {actions ? (
              actions(messageActions)
            ) : (
              <MailMenu>{messageActions}</MailMenu>
            )}
          </div>
        )}
        <div className="mail-toolbar-spacer" />
        <div className="mail-conversation-navigation">
          <MailIconButton
            icon="layers"
            label={expandAll ? "Collapse conversation" : "Expand conversation"}
            onClick={() => setExpandAll(!expandAll)}
          />
          <MailIconButton
            icon="back"
            label="Previous conversation"
            disabled={!onPrevious}
            onClick={onPrevious}
          />
          <MailIconButton
            icon="arrow"
            label="Next conversation"
            disabled={!onNext}
            onClick={onNext}
          />
        </div>
        <div className="mail-conversation-mobile-menu">
          <MailMenu icon="layers" label="Conversation navigation">
            <Menu.Item onClick={() => setExpandAll(!expandAll)}>
              {expandAll ? "Collapse conversation" : "Expand conversation"}
            </Menu.Item>
            <Menu.Item disabled={!onPrevious} onClick={onPrevious}>
              <Icon name="back" />
              Previous conversation
            </Menu.Item>
            <Menu.Item disabled={!onNext} onClick={onNext}>
              <Icon name="arrow" />
              Next conversation
            </Menu.Item>
          </MailMenu>
        </div>
      </div>
      <div className="mail-conversation-content">
        <MailNotice error={actionError ?? ""} />
        <MailNotice error={action.error} />
        <MailNotice error={focused.error} />
        <MailState
          kind="reader"
          loading={initial.loading && !message}
          error={initial.error}
          retry={initial.reload}
        />
        {message && (
          <>
            <div className="mail-conversation-title">
              <h1>{message.subject || "(No subject)"}</h1>
              <span className="mail-badge">
                {message.draft?.state === "submitted" ? "Outbox" :
                  mail.folders.find((folder) => folder.id === message.folder_id)
                    ?.name ?? message.folder_id}
              </span>
            </div>
            {thread.data?.next_cursor && (
              <Button
                className="mail-older-messages"
                variant="subtle"
                disabled={thread.loading}
                onClick={() => setCursor(thread.data!.next_cursor)}
              >
                Load earlier messages
              </Button>
            )}
            {thread.error && <MailNotice error={thread.error} />}
            <div className="mail-conversation-messages">
              {[...messages]
                .filter((entry) => entry.id !== mail.activeDraftId)
                .reverse()
                .map((entry) => (
                  <MessageCard
                    key={entry.id}
                    entry={entry}
                    initial={entry.id === id ? message : undefined}
                    expanded={expandAll || entry.id === id}
                    plain={plain}
                    active={messages.length > 1 && entry.id === actionId}
                    onActivate={() => setActionId(entry.id)}
                    replyShortcut={entry.id === actionId}
                  />
                ))}
            </div>
            <div id="mail-reply-host" />
          </>
        )}
      </div>
      <Confirm
        open={!!deleting}
        title={deleting?.draft ? "Discard draft?" : "Delete permanently?"}
        description="This message and its attachments will be permanently removed."
        label="Delete permanently"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api(
            `${path}/${deleting.draft ? "drafts" : "messages"}/${deleting.id}${deleting.draft ? "" : "/permanent-delete"}`,
            { method: deleting.draft ? "DELETE" : "POST" },
          );
          setDeleting(null);
          mail.refresh();
          mail.feedback("Message deleted");
          onClose();
        }}
      />
    </section>
  );
}
function MessageCard({
  entry,
  initial,
  expanded,
  plain,
  active,
  onActivate,
  replyShortcut,
}: {
  entry: Message;
  initial?: MessageDetail;
  expanded: boolean;
  plain: boolean;
  active: boolean;
  onActivate: () => void;
  replyShortcut: boolean;
}) {
  const mail = useMail(), cache = useMailCache(),
    path = mailboxPath(mail.box!.id),
    action = useMailAction(),
    [open, setOpen] = useState(expanded);
  const resource = useMailResource<{ message: MessageDetail }>(
      open && !initial ? `${path}/messages/${entry.id}` : null,
    ),
    message = initial ?? resource.data?.message,
    canWrite = !!mail.box?.access?.write;
  const operation = useRef(new MailOperation()),
    readAttempted = useRef(false);
  useEffect(() => setOpen(expanded), [expanded]);
  useEffect(() => {
    if (
      !open ||
      !message ||
      message.draft ||
      !canWrite ||
      readAttempted.current
    )
      return;
    readAttempted.current = true;
    if (message.is_read) return;
    const finish = cache.beginMutation();
    void api<MailCommandResult>(path + "/ui/commands", {
      method: "POST",
      body: { targets: [{ id: message.id, version: message.version }], changes: { is_read: true } },
    })
      .then(result => { mail.committed(result); const failure = result.results.find(item => !item.success); if (failure && !failure.success) throw new Error(failure.error); })
      .catch(() => {})
      .finally(finish);
  }, [open, message]);
  const reply = async (kind: "reply" | "reply-all" | "forward") => {
    if (mail.composing) {
      mail.feedback("Close your current draft before opening another.");
      return;
    }
    const data = kind === "forward" ? { to: [] } : {};
    try {
      const result = await api<{ message: MessageDetail }>(
        `${path}/messages/${entry.id}/${kind}`,
        {
          method: "POST",
          body: data,
          headers: operation.current.headers({ kind, ...data }),
        },
      );
      operation.current.complete();
      cache.replace(path + "/drafts/" + result.message.id, result);
      cache.replace(path + "/messages/" + result.message.id, result);
      mail.compose(result.message.id, true);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500)
        operation.current.complete();
      throw error;
    }
  };
  useEffect(() => {
    if (!replyShortcut) return;
    const listener = () => {
      void action.run(() => reply("reply"));
    };
    window.addEventListener("officeflare:reply", listener);
    return () => window.removeEventListener("officeflare:reply", listener);
  }, [replyShortcut, action.busy, entry.id, mail.composing]);
  return (
    <article
      className={`mail-message-card${open ? " is-expanded" : ""}${active ? " is-active" : ""}`}
      onFocusCapture={onActivate}
      onPointerDown={onActivate}
    >
      <div className="mail-card-header">
        <span className="mail-sender-avatar">
          {(entry.from_address || "D").slice(0, 1).toUpperCase()}
        </span>
        <Button
          variant="plain"
          className="mail-card-summary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <strong>
            {entry.from_address || (entry.draft_owner_id ? "Draft" : "Me")}
          </strong>
          <span>
            {open
              ? `to ${
                  message?.recipients
                    .filter((r) => r.kind === "to")
                    .map((r) => r.email_address)
                    .join(", ") ||
                  entry.recipient_summary ||
                  "—"
                }`
              : entry.snippet || "No preview"}
          </span>
        </Button>
        <time>{mailDate(entry.received_at)}</time>
        {open && message && (
          <>
            <Popover.Root>
              <Popover.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Message details"
                  />
                }
              >
                <Icon name="down" />
              </Popover.Trigger>
              <PopoverPopup
                className="mail-envelope-popup"
                positionerProps={{ align: "end" }}
              >
                <dl>
                  {[
                    ["From", message.from_address],
                    [
                      "To",
                      message.recipients
                        .filter((r) => r.kind === "to")
                        .map((r) => r.email_address)
                        .join(", "),
                    ],
                    [
                      "Cc",
                      message.recipients
                        .filter((r) => r.kind === "cc")
                        .map((r) => r.email_address)
                        .join(", "),
                    ],
                    [
                      "Bcc",
                      message.recipients
                        .filter((r) => r.kind === "bcc")
                        .map((r) => r.email_address)
                        .join(", "),
                    ],
                    ["Date", mailDate(message.received_at)],
                    ["Reply to", message.reply_to_address],
                  ].map(
                    ([label, value]) =>
                      value && (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ),
                  )}
                </dl>
              </PopoverPopup>
            </Popover.Root>
          </>
        )}
      </div>
      {open && (
        <div className="mail-card-content">
          <MailNotice error={action.error} />
          <MailState
            loading={!message}
            error={resource.error}
            retry={resource.reload}
          />
          {message && (
            <>
              {message.submissions
                .filter((submission) => submission.status !== "accepted")
                .map((submission) => (
                  <SendStatus key={submission.id} submission={submission} />
                ))}
              {!plain && message.body.html ? (
                <MailHtml message={message} path={path} />
              ) : (
                <pre className="mail-plain-body">
                  {message.body.text || "(Empty message)"}
                </pre>
              )}
              {message.attachments.filter(
                (file) => file.disposition !== "inline",
              ).length > 0 && (
                <div className="mail-attachment-cards">
                  {message.attachments
                    .filter((file) => file.disposition !== "inline")
                    .map((file) => (
                      <Button variant="card"
                        key={file.id}
                        className="mail-attachment"
                        onClick={() => {
                          void action.run(() =>
                            downloadMail(
                              `${path}/messages/${entry.id}/attachments/${file.id}`,
                              file.filename,
                            ),
                          );
                        }}
                      >
                        <Icon name="file" />
                        <span>
                          <strong>{file.filename}</strong>
                          <small>{bytes(file.size_bytes)} · Download</small>
                        </span>
                      </Button>
                    ))}
                </div>
              )}
              <div className="mail-inline-reply-actions">
                {message.draft ? (
                  <Button
                    variant="primary"
                    disabled={
                      !canWrite ||
                      action.busy ||
                      (message.draft.state !== "editable" &&
                        (!mail.box?.access?.send ||
                          !message.submissions.some((submission) =>
                            cancelableSubmission(submission.status),
                          )))
                    }
                    onClick={() => {
                      void action.run(async () => {
                        if (message.draft?.state !== "editable") {
                          const pending = message.submissions.find((submission) =>
                            cancelableSubmission(submission.status),
                          );
                          if (!pending) throw new Error("This message is already being sent.");
                          await api(`${path}/submissions/${pending.id}/cancel`, {
                            method: "POST",
                          });
                          mail.refresh();
                          mail.feedback(pending.status === "unknown"
                            ? "Draft reopened. The provider may already have accepted this email."
                            : "Send canceled. Draft is ready to continue.");
                        }
                        mail.compose(message.id, true);
                      });
                    }}
                  >
                    Continue draft
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={!canWrite || action.busy}
                      onClick={() => {
                        void action.run(() => reply("reply"));
                      }}
                    >
                      <Icon name="reply" />
                      Reply
                    </Button>
                    <Button
                      disabled={!canWrite || action.busy}
                      onClick={() => {
                        void action.run(() => reply("reply-all"));
                      }}
                    >
                      <Icon name="replyAll" />
                      Reply all
                    </Button>
                    <Button
                      disabled={!canWrite || action.busy}
                      onClick={() => {
                        void action.run(() => reply("forward"));
                      }}
                    >
                      <Icon name="forward" />
                      Forward
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

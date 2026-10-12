import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import {
  bytes,
  downloadMail,
  mailboxPath,
  mailDate,
  MailOperation,
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
  actions?: ReactNode;
  actionError?: string;
}) {
  const mail = useMail(),
    path = mailboxPath(mail.box!.id),
    initial = useMailResource<{ message: MessageDetail }>(
      `${path}/messages/${id}`,
      mail.revision,
    ),
    message = initial.data?.message;
  const [cursor, setCursor] = useState<string | null>(null),
    [entries, setEntries] = useState<Message[]>([]),
    [expandAll, setExpandAll] = useState(false);
  const thread = useMailResource<{
    messages: Message[];
    next_cursor: string | null;
  }>(
    message && !message.draft && mail.preferences.conversation_view
      ? `${path}/threads/${message.thread_id}?limit=50&include_snoozed=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : null,
    mail.revision,
  );
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
  return (
    <section className="mail-conversation" aria-label="Message detail">
      <div className="mail-conversation-toolbar">
        <MailIconButton
          icon="back"
          label="Back to messages"
          onClick={onClose}
        />
        {actions && <div className="mail-toolbar-actions">{actions}</div>}
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
        <MailState
          loading={initial.loading && !message}
          error={initial.error}
          retry={initial.reload}
        />
        {message && (
          <>
            <div className="mail-conversation-title">
              <h1>{message.subject || "(No subject)"}</h1>
              <span className="mail-badge">
                {mail.folders.find((folder) => folder.id === message.folder_id)
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
                    onDeleted={onClose}
                    replyShortcut={entry.id === id}
                  />
                ))}
            </div>
            <div id="mail-reply-host" />
          </>
        )}
      </div>
    </section>
  );
}
function MessageCard({
  entry,
  initial,
  expanded,
  onDeleted,
  replyShortcut,
}: {
  entry: Message;
  initial?: MessageDetail;
  expanded: boolean;
  onDeleted: () => void;
  replyShortcut: boolean;
}) {
  const mail = useMail(),
    path = mailboxPath(mail.box!.id),
    action = useMailAction(),
    [open, setOpen] = useState(expanded),
    [plain, setPlain] = useState(false),
    [deleting, setDeleting] = useState(false);
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
      message.is_read ||
      message.draft ||
      !canWrite ||
      readAttempted.current
    )
      return;
    readAttempted.current = true;
    void api(`${path}/messages/${message.id}`, {
      method: "PATCH",
      body: { version: message.version, is_read: true },
    })
      .then(() => {
        resource.reload();
        mail.refresh();
      })
      .catch(() => {});
  }, [open, message]);
  const change = async (changes: object) => {
    const latest = (
      await api<{ message: MessageDetail }>(`${path}/messages/${entry.id}`)
    ).message;
    await api(`${path}/messages/${entry.id}`, {
      method: "PATCH",
      body: { version: latest.version, ...changes },
    });
    resource.reload();
    mail.refresh();
  };
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
      mail.refresh();
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
    <article className={`mail-message-card${open ? " is-expanded" : ""}`}>
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
            <MailMenu>
              <Menu.Item
                disabled={!canWrite || action.busy}
                onClick={() => {
                  void action.run(() => change({ is_read: false }));
                }}
              >
                Mark unread
              </Menu.Item>
              <Menu.Item
                disabled={!canWrite || !!message.draft || action.busy}
                onClick={() => {
                  void action.run(() =>
                    change({
                      folder_id:
                        message.folder_id === "trash" ? "inbox" : "trash",
                    }),
                  );
                }}
              >
                {message.folder_id === "trash"
                  ? "Restore to inbox"
                  : "Move to trash"}
              </Menu.Item>
              <Menu.Item onClick={() => setPlain(!plain)}>
                {plain ? "Show formatted message" : "Show plain text"}
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  void action.run(() =>
                    downloadMail(
                      `${path}/messages/${entry.id}/original`,
                      "message.eml",
                    ),
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
                      body: {
                        email_address: message.from_address,
                        blocked: true,
                      },
                    });
                    mail.feedback("Sender blocked");
                  });
                }}
              >
                Block sender
              </Menu.Item>
              {(message.draft ||
                message.folder_id === "trash" ||
                message.folder_id === "spam") && (
                <Menu.Item
                  disabled={!canWrite || message.draft?.state === "submitted"}
                  onClick={() => setDeleting(true)}
                >
                  {message.draft ? "Discard draft" : "Delete permanently"}
                </Menu.Item>
              )}
              <Menu.Separator />
              <Menu.Item
                onClick={() =>
                  mail.feedback(
                    `Provider: ${message.provider ?? "—"} · Message ID: ${message.rfc_message_id ?? "—"}`,
                    undefined,
                    undefined,
                    15000,
                  )
                }
              >
                Technical details
              </Menu.Item>
            </MailMenu>
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
                    disabled={!canWrite || message.draft.state !== "editable"}
                    onClick={() => mail.compose(message.id, true)}
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
      <Confirm
        open={deleting}
        title={message?.draft ? "Discard draft?" : "Delete permanently?"}
        description="This message and its attachments will be permanently removed."
        label="Delete permanently"
        destructive
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api(
            `${path}/${message?.draft ? "drafts" : "messages"}/${entry.id}${message?.draft ? "" : "/permanent-delete"}`,
            { method: message?.draft ? "DELETE" : "POST" },
          );
          setDeleting(false);
          mail.refresh();
          mail.feedback("Message deleted");
          onDeleted();
        }}
      />
    </article>
  );
}

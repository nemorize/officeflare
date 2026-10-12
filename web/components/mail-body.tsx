import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  bytes,
  mailErrorDescription,
  htmlFrame,
  mailFrameHeight,
  mailboxPath,
  mailDate,
  cancelableSubmission,
  retryableSubmission,
  submissionLabel,
  type MessageDetail,
  type Submission,
} from "../lib/mail";
import { useMail } from "./mail-context";
import { MailNotice, useMailAction, useMailResource } from "./mail-common";
import { Button } from "./ui";
export function MailHtml({
  message,
  path,
  content = message.body.html,
}: {
  message: MessageDetail;
  path: string;
  content?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null), [height, setHeight] = useState(128);
  const nonce = useMemo(() => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join(""), [message.id, content]);
  const [html, setHtml] = useState(content),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(),
      urls: string[] = [];
    setHtml(content);
    setError("");
    const inline = message.attachments.filter(
      (file) => file.content_id && file.content_type.startsWith("image/"),
    );
    void Promise.allSettled(
      inline.map(async (file) => {
        const source = `${path}/messages/${message.id}/attachments/${file.id}`;
        const blob = await api<Blob>(source, {
          response: "blob",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return { source, url };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      let formatted = content;
      for (const result of results)
        if (result.status === "fulfilled" && result.value)
          formatted = formatted.replaceAll(result.value.source, result.value.url);
      if (results.some((result) => result.status === "rejected"))
        setError(
          "Some inline images could not be loaded. You can download the attachments below.",
        );
      setHtml(formatted);
    });
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [message.id, content, path]);
  useLayoutEffect(() => {
    setHeight(128);
    const resize = (event: MessageEvent) => {
      const next = mailFrameHeight(event.data, nonce, event.source, frame.current?.contentWindow);
      if (next !== null) setHeight(next);
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [nonce]);
  return (
    <>
      <p className="mail-html-note">External images are blocked for privacy.</p>
      <MailNotice error={error} />
      <iframe
        ref={frame}
        style={{ height }}
        className="mail-html-frame"
        title="Formatted email body"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={htmlFrame(html, nonce)}
      />
    </>
  );
}
export function SendStatus({ submission }: { submission: Submission }) {
  const [poll, setPoll] = useState(["scheduled", "queued", "processing", "retry_wait", "unknown"].includes(submission.status));
  const mail = useMail(),
    path = mailboxPath(mail.box!.id),
    action = useMailAction(),
    resource = useMailResource<{ submission: Submission }>(
      `${path}/submissions/${submission.id}`,
      mail.revision,
      poll,
    );
  const value = resource.data?.submission ?? submission,
    canSend = !!mail.box?.access?.send;
  useEffect(() => setPoll(["scheduled", "queued", "processing", "retry_wait", "unknown"].includes(value.status)), [value.status]);
  return (
    <div className="mail-send-status">
      <div>
        <strong className="mail-badge" data-status={value.status}>
          {submissionLabel(value.status)}
        </strong>
        <p>
          {value.provider} · {value.connection_id} · {value.attempt_count}{" "}
          attempt(s)
        </p>
        {value.status === "scheduled" && <p>{mailDate(value.scheduled_at)}</p>}
        {value.error_code && <p>{mailErrorDescription(value.error_code)}</p>}
        {value.status === "accepted" && (
          <small>
            Provider acceptance does not confirm delivery to every recipient.
          </small>
        )}
        {value.status === "unknown" && (
          <small>
            The provider may have accepted this message. Retrying is disabled to
            prevent duplicate sends.
          </small>
        )}
        {value.recipients?.map((recipient) => (
          <p key={recipient.email_address}>
            {recipient.email_address} · {recipient.status}
          </p>
        ))}
      </div>
      <div className="mail-actions">
        {value.status === "unknown" && (
          <Button size="sm" disabled={resource.loading} onClick={resource.reload}>
            Check status
          </Button>
        )}
        {cancelableSubmission(value.status) && (
          <Button
            size="sm"
            disabled={!canSend || action.busy}
            onClick={() => {
              void action.run(async () => {
                await api(`${path}/submissions/${value.id}/cancel`, {
                  method: "POST",
                });
                resource.reload();
                mail.refresh();
              });
            }}
          >
            Cancel send
          </Button>
        )}
        {retryableSubmission(value.status) && (
          <Button
            size="sm"
            disabled={!canSend || action.busy}
            onClick={() => {
              void action.run(async () => {
                await api(`${path}/submissions/${value.id}/retry`, {
                  method: "POST",
                });
                resource.reload();
                mail.refresh();
              });
            }}
          >
            Retry send
          </Button>
        )}
      </div>
      <MailNotice error={action.error || resource.error} />
    </div>
  );
}

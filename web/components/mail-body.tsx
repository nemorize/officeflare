import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  bytes,
  mailErrorDescription,
  htmlFrame,
  embeddedMailImage,
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
import { LoadingSkeleton } from "./loading-skeleton";
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
  const [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHtml(content);
    setError("");
    setLoading(true);
    const inline = message.attachments.filter(
      (file) => file.content_id && file.content_type.startsWith("image/"),
    );
    void (async () => {
      let formatted = content, failures = 0;
      const sources: string[] = [];
      try {
        if (content === message.body.html) {
          const base = `${path}/messages/${message.id}/render`;
          const rendering = await api<{ html: string; assets: { source: string }[]; failures: number }>(base, { signal: controller.signal });
          formatted = rendering.html; failures = rendering.failures;
          for (const asset of rendering.assets) if (asset.source.startsWith(base + "/assets/") && /^\d{1,2}$/.test(asset.source.slice((base + "/assets/").length))) sources.push(asset.source);
        }
        for (const file of inline) {
          const source = `${path}/messages/${message.id}/attachments/${file.id}`;
          if (formatted.includes(source)) sources.push(source);
        }
        // Keep resource loading bounded, including newsletters with many images.
        const replacements = new Map<string, string>(); let next = 0, loadedBytes = 0;
        const resourceSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        await Promise.all(Array.from({ length: Math.min(6, sources.length) }, async () => {
          while (next < sources.length && !resourceSignal.aborted && loadedBytes < 20 * 1024 ** 2) {
            const source = sources[next++]!;
            try {
              const blob = await api<Blob>(source, { response: "blob", signal: resourceSignal });
              if (controller.signal.aborted) return;
              loadedBytes += blob.size;
              if (loadedBytes > 20 * 1024 ** 2) throw new Error("Mail image budget exceeded");
              // Opaque sandbox origins cannot read the parent's partitioned blob URLs.
              replacements.set(source, await embeddedMailImage(blob));
            } catch { if (!controller.signal.aborted) failures++; }
          }
        }));
        if (next < sources.length && !controller.signal.aborted) failures++;
        if (resourceSignal.aborted && !controller.signal.aborted) failures++;
        if (controller.signal.aborted) return;
        // Replace longer paths first: asset 1 must not replace the prefix of asset 10.
        for (const source of sources.sort((left, right) => right.length - left.length)) formatted = formatted.replaceAll(source, replacements.get(source) ?? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=");
        if (failures) setError("Some images or styles could not be loaded. The rest of the message is available.");
        setHtml(formatted);
      } catch { if (!controller.signal.aborted) setError("The formatted message could not be loaded."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => {
      controller.abort();
    };
  }, [message.id, content, path, attempt]);
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
      <MailNotice error={error} />
      {error && <Button variant="ghost" size="sm" onClick={() => setAttempt(value => value + 1)}>Retry loading content</Button>}
      {loading ? <LoadingSkeleton label="Loading formatted message…" /> : <iframe
        ref={frame}
        style={{ height }}
        className="mail-html-frame"
        title="Formatted email body"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={htmlFrame(html, nonce)}
      />}
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

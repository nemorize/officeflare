import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMailCache } from "./mail-resource-context";
import { api } from "../lib/api";
import {
  mailErrorDescription,
  htmlFrame,
  renderMailDocument,
  mailRenderingPath,
  mailboxPath,
  mailDate,
  cancelableSubmission,
  retryableSubmission,
  submissionLabel,
  type MessageDetail,
  type Submission,
  type MailRendering,
} from "../lib/mail";
import { useMail } from "./mail-context";
import { MailNotice, useMailAction, useMailResource } from "./mail-common";
import { AlertDialog, AlertDialogPopup, Button } from "./ui";
export const MailHtml = memo(
  function MailHtml({
    message,
    path,
    content = message.body.html,
  }: {
    message: MessageDetail;
    path: string;
    content?: string;
  }) {
    const cache = useMailCache();
    const frame = useRef<HTMLIFrameElement>(null),
      [height, setHeight] = useState(128);
    const [attempt, setAttempt] = useState(0);
    const key = mailRenderingPath(path, message, content !== message.body.html);
    const cached = cache.snapshot(key).data as MailRendering | null;
    const [html, setHtml] = useState(cached?.html ?? content),
      [error, setError] = useState("");
    const [link, setLink] = useState<string | null>(null);
    const cancelLink = useRef<HTMLButtonElement>(null);
    const document = useMemo(
      () =>
        htmlFrame(html, window.location.origin, `${path}/messages/${message.id}/render/assets/`),
      [html, path, message.id],
    );
    useEffect(() => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined,
        polls = 0;
      const snapshot = cache.snapshot(key).data as MailRendering | null;
      setHtml(snapshot?.html ?? content);
      setError("");
      const refresh = async (first = false) => {
        try {
          const requestKey = first && attempt > 0 ? key + "&retry=1" : key;
          await cache.load(requestKey, !first || attempt > 0);
          if (controller.signal.aborted) return;
          const snapshot = cache.snapshot(requestKey);
          if (snapshot.error) throw snapshot.error;
          const rendering = snapshot.data as MailRendering;
          if (rendering.html !== null) setHtml(rendering.html);
          if (rendering.pending && polls++ < 30)
            timer = setTimeout(() => {
              void refresh();
            }, 1000);
          else if (rendering.pending)
            setError(t("componentsMailBody.theFormattedMessageCouldNotBeLoaded"));
          else if (rendering.failures)
            setError(t("componentsMailBody.someImagesOrStylesCouldNotBeLoadedThe"));
          else setError("");
        } catch {
          if (!controller.signal.aborted)
            setError(t("componentsMailBody.theFormattedMessageCouldNotBeLoaded"));
        }
      };
      void refresh(true);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [key, content, attempt, cache]);
    useLayoutEffect(() => {
      setLink(null);
      if (frame.current)
        return renderMailDocument(frame.current, document, setHeight, (destination) =>
          setLink((current) => current ?? destination),
        );
    }, [document]);
    return (
      <>
        {link && (
          <AlertDialog.Root
            open
            onOpenChange={(open) => {
              if (!open) setLink(null);
            }}
          >
            <AlertDialogPopup initialFocus={cancelLink}>
              <AlertDialog.Title>{t("componentsMailBody.openEmailLink")}</AlertDialog.Title>
              <AlertDialog.Description>
                {t("componentsMailBody.checkLinkBeforeOpening")}
              </AlertDialog.Description>
              <p className="mail-link-destination">
                <bdi dir="ltr">{link}</bdi>
              </p>
              <div className="mail-link-actions">
                <Button ref={cancelLink} size="md" onClick={() => setLink(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  nativeButton={false}
                  render={
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    />
                  }
                  onClick={() => setLink(null)}
                >
                  {t("componentsMailBody.openLinkInNewTab")}
                </Button>
              </div>
            </AlertDialogPopup>
          </AlertDialog.Root>
        )}
        <MailNotice error={error} />
        {error && (
          <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t("componentsMailBody.retryLoadingContent")}
          </Button>
        )}
        <iframe
          ref={frame}
          style={{ height }}
          className="mail-html-frame"
          title={t("componentsMailBody.formattedEmailBody")}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
        />
      </>
    );
  },
  (previous, next) =>
    previous.path === next.path &&
    previous.content === next.content &&
    previous.message.id === next.message.id &&
    previous.message.body_revision === next.message.body_revision &&
    previous.message.body.html === next.message.body.html &&
    previous.message.attachments === next.message.attachments,
);
export function SendStatus({ submission }: { submission: Submission }) {
  const [poll, setPoll] = useState(
    ["scheduled", "queued", "processing", "retry_wait", "unknown"].includes(submission.status),
  );
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
  useEffect(
    () =>
      setPoll(
        ["scheduled", "queued", "processing", "retry_wait", "unknown"].includes(value.status),
      ),
    [value.status],
  );
  return (
    <div className="mail-send-status">
      <div>
        <strong className="mail-badge" data-status={value.status}>
          {submissionLabel(value.status)}
        </strong>
        <p>
          <LocalizedMessage
            id="componentsMailBody.attemptS"
            values={{
              provider: value.provider,
              connection_id: value.connection_id,
              attempt_count: value.attempt_count,
            }}
          />
        </p>
        {value.status === "scheduled" && <p>{mailDate(value.scheduled_at)}</p>}
        {value.error_code && <p>{mailErrorDescription(value.error_code)}</p>}
        {value.status === "accepted" && (
          <small>
            {t("componentsMailBody.providerAcceptanceDoesNotConfirmDeliveryToEveryRecipient")}
          </small>
        )}
        {value.status === "unknown" && (
          <small>
            {t("componentsMailBody.theProviderMayHaveAcceptedThisMessageCancelingReopens")}
          </small>
        )}
        {value.recipients?.map((recipient) => (
          <p key={recipient.email_address}>
            {recipient.email_address}
            {t("componentsMailBody.text")}
            {enumLabel(recipient.status)}
          </p>
        ))}
      </div>
      <div className="mail-actions">
        {value.status === "unknown" && (
          <Button size="sm" disabled={resource.loading} onClick={resource.reload}>
            {t("componentsMailBody.checkStatus")}
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
                mail.feedback(
                  value.status === "unknown"
                    ? t("componentsMailBody.draftReopenedTheProviderMayAlreadyHaveAcceptedThis")
                    : t("componentsMailBody.sendCanceledDraftReopened"),
                );
              });
            }}
          >
            {t("componentsMailBody.cancelSend")}
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
            {t("componentsMailBody.retrySend")}
          </Button>
        )}
      </div>
      <MailNotice error={action.error || resource.error} />
    </div>
  );
}

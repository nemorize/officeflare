import { enumLabel } from "../../shared/i18n/labels.ts";
import { t } from "../../shared/i18n/index.ts";
import { formatDateTime } from "./regional.ts";
export const bytes = (value: number) =>
  value < 1024
    ? t("libMailHelpers.b", { value: value })
    : value < 1024 ** 2
      ? t("libMailHelpers.kb", { toFixed: (value / 1024).toFixed(1) })
      : value < 1024 ** 3
        ? t("libMailHelpers.mb", { toFixed: (value / 1024 ** 2).toFixed(1) })
        : t("libMailHelpers.gb", { toFixed: (value / 1024 ** 3).toFixed(2) });
export const mailDate = (value: number | null) => (value ? formatDateTime(value) : "—");
export function parseRecipients(value: string): string[] {
  const addresses = value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    addresses.some(
      (address) =>
        !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(
          address,
        ) ||
        address.length > 254 ||
        address.split("@")[0]!.length > 64 ||
        address.startsWith(".") ||
        address.includes(".."),
    )
  )
    throw new Error(t("libMailHelpers.enterEmailAddressesSeparatedByCommas"));
  return [...new Set(addresses.map((address) => address.toLowerCase()))];
}
export function scheduledTime(value: string, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 366 * 86400_000)
    throw new Error(t("libMailHelpers.chooseAFutureTimeWithin366Days"));
  return Math.floor(timestamp / 1000);
}
export const cancelableSubmission = (status: string) =>
  ["scheduled", "queued", "retry_wait", "unknown"].includes(status);
export const retryableSubmission = (status: string) => status === "failed";
export const submissionLabel = (status: string) =>
  ({
    accepted: t("libMailHelpers.acceptedByProvider"),
    unknown: t("libMailHelpers.acceptanceUnknown"),
    retry_wait: t("libMailHelpers.waitingToRetry"),
    processing: t("libMailHelpers.sending"),
    queued: t("libMailHelpers.queued"),
    scheduled: t("libMailHelpers.scheduled"),
    canceled: t("libMailHelpers.canceled"),
    failed: t("libMailHelpers.failed"),
  })[status] ?? enumLabel(status);
export function mailErrorDescription(code: string) {
  const messages: Record<string, string> = {
    message_too_large: t("libMailHelpers.thisMessageIsTooLargeRemoveAttachmentsOrShorten"),
    E_CONTENT_TOO_LARGE: t("libMailHelpers.thisMessageIsTooLargeRemoveAttachmentsOrShorten"),
    provider_unavailable: t("libMailHelpers.theMailServiceIsTemporarilyUnavailableTryAgainLater"),
    invalid_mbox_format: t("libMailHelpers.thisFileIsNotAValidMailboxArchiveChoose"),
    invalid_eml_format: t("libMailHelpers.thisFileIsNotAValidEmailMessageChoose"),
    rate_limited: t("libMailHelpers.tooManyRequestsWaitAMomentBeforeTryingAgain"),
    quota_exceeded: t("libMailHelpers.theMailboxIsOutOfStorageFreeUpSpace"),
  };
  return messages[code] ?? t("libMailHelpers.thisOperationCouldNotBeCompletedTryAgainOr");
}
export function mailFailure(failure: unknown) {
  return failure instanceof Error
    ? failure.message
    : t("libMailHelpers.unableToCompleteTheRequest");
}
export function htmlFrame(html: string, parentOrigin = "*", imagePath = "") {
  let imagePolicy = "'none'";
  try {
    const origin = new URL(parentOrigin);
    if (
      ["https:", "http:"].includes(origin.protocol) &&
      /^\/api\/mail\/mailboxes\/[a-z0-9%_-]+\/messages\/[a-z0-9%_.-]+\/render\/assets\/$/i.test(
        imagePath,
      )
    )
      imagePolicy = origin.origin + imagePath;
  } catch {}
  // Scripts stay disabled. The parent observes the document and handles links;
  // a same-origin frame lets normal HTTP image caching survive reopening it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src ${imagePolicy}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';"><style>body{margin:20px;color:#252628;font:14px/1.7 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}img[src=""]{visibility:hidden}pre{white-space:pre-wrap}table{max-width:100%}a{color:#526cb5}</style></head><body>${html}</body></html>`;
}
export function mailRenderingPath(
  path: string,
  message: { id: string; body_revision?: string },
  quoted = false,
) {
  const query = new URLSearchParams({ defer: "1" });
  if (message.body_revision) query.set("revision", message.body_revision);
  if (quoted) query.set("part", "quoted");
  return `${path}/messages/${message.id}/render?${query}`;
}
export function mailLinkUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function observeMailDocument(
  document: Document,
  resize: (height: number) => void,
  openLink: (url: string) => void,
  runtime = {
    ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle: number) => window.cancelAnimationFrame(handle),
  },
) {
  let animation: number | undefined;
  const report = () => {
    const height = document.body.getBoundingClientRect().height + 40;
    if (Number.isFinite(height)) resize(Math.max(96, Math.min(24_000, Math.ceil(height))));
  };
  const observer = new runtime.ResizeObserver(() => {
    if (animation !== undefined) return;
    animation = runtime.requestAnimationFrame(() => {
      animation = undefined;
      report();
    });
  });
  const follow = (event: MouseEvent) => {
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? (target as Element) : target?.parentElement;
    const anchor = element?.closest("a[href]");
    if (!anchor || (event.type === "click" ? event.button !== 0 : event.button !== 1)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    const url = mailLinkUrl(anchor.getAttribute("href"));
    if (url) openLink(url);
  };
  document.addEventListener("click", follow, true);
  document.addEventListener("auxclick", follow, true);
  observer.observe(document.body);
  report();
  return () => {
    observer.disconnect();
    if (animation !== undefined) runtime.cancelAnimationFrame(animation);
    document.removeEventListener("click", follow, true);
    document.removeEventListener("auxclick", follow, true);
  };
}
export function renderMailDocument(
  frame: HTMLIFrameElement,
  html: string,
  resize: (height: number) => void,
  openLink: (url: string) => void,
) {
  const document = frame.contentDocument;
  if (!document) return () => {};
  // Write the already sanitized HTML once, then measure immediately. An iframe
  // load event waits for every image, which used to clip the body until then.
  document.open();
  document.write(html);
  document.close();
  return observeMailDocument(document, resize, openLink);
}
// getRandomValues is also available on HTTP origins, unlike randomUUID.
const operationKey = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
// A lost response must replay the same operation, including after session refresh.
export class MailOperation {
  private key = operationKey();
  private serialized: string | null = null;
  headers(body: object) {
    const serialized = JSON.stringify(body);
    if (this.serialized !== null && this.serialized !== serialized)
      throw new Error(t("libMailHelpers.thePreviousRequestHasAnUnknownOutcomeRetryIt"));
    this.serialized = serialized;
    return { "Idempotency-Key": this.key };
  }
  complete() {
    this.key = operationKey();
    this.serialized = null;
  }
}

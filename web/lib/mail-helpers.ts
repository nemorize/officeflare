import { enumLabel } from "../../shared/i18n/labels.ts";
import { getLocale, t } from "../../shared/i18n/index.ts";
export const bytes = (value: number) =>
  value < 1024
    ? t("libMailHelpers.b", { value: value })
    : value < 1024 ** 2
      ? t("libMailHelpers.kb", { toFixed: (value / 1024).toFixed(1) })
      : value < 1024 ** 3
        ? t("libMailHelpers.mb", { toFixed: (value / 1024 ** 2).toFixed(1) })
        : t("libMailHelpers.gb", { toFixed: (value / 1024 ** 3).toFixed(2) });
export const mailDate = (value: number | null) =>
  value
    ? new Date(value * 1000).toLocaleString(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
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
export function htmlFrame(html: string, resizeNonce?: string, parentOrigin = "*") {
  if (resizeNonce && !/^[a-f0-9]{32,64}$/.test(resizeNonce))
    throw new Error(t("libMailHelpers.invalidFrameNonce"));
  const policy = resizeNonce ? " script-src 'nonce-" + resizeNonce + "';" : "";
  const targetOrigin = JSON.stringify(parentOrigin).replaceAll("<", "\\u003c");
  // The frame keeps an opaque origin and cannot open popups or navigate its parent.
  // Only this nonce-authorized script can forward a real link click for confirmation.
  const script = resizeNonce
    ? `<script nonce="${resizeNonce}">(()=>{
      const nonce="${resizeNonce}",targetOrigin=${targetOrigin};
      const report=()=>{const height=Math.ceil(document.body.getBoundingClientRect().height+40);parent.postMessage({type:"officeflare:mail-body-height",nonce,height},targetOrigin)};
      const follow=event=>{
        const target=event.target?.nodeType===1?event.target:event.target?.parentElement;
        const link=target?.closest("a[href]");
        if(!link||(event.type==="click"?event.button!==0:event.button!==1))return;
        event.preventDefault();event.stopPropagation();
        if(!event.isTrusted)return;
        parent.postMessage({type:"officeflare:mail-link",nonce,url:link.getAttribute("href")},targetOrigin);
      };
      new ResizeObserver(()=>requestAnimationFrame(report)).observe(document.body);
      addEventListener("load",report);
      addEventListener("click",follow,true);
      addEventListener("auxclick",follow,true);
      report();
    })()</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';${policy}"><style>body{margin:20px;color:#252628;font:14px/1.7 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}img[src^="/api/mail/"]{opacity:0}img[src=""]{visibility:hidden}pre{white-space:pre-wrap}table{max-width:100%}a{color:#526cb5}</style></head><body>${html}${script}</body></html>`;
}
export function mailFrameLink(
  data: unknown,
  nonce: string,
  source: unknown,
  expectedSource: unknown,
  origin: string,
): string | null {
  if (
    !expectedSource ||
    source !== expectedSource ||
    origin !== "null" ||
    !data ||
    typeof data !== "object"
  )
    return null;
  const message = data as { type?: string; nonce?: string; url?: unknown };
  if (
    message.type !== "officeflare:mail-link" ||
    message.nonce !== nonce ||
    typeof message.url !== "string" ||
    message.url.length > 8192 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(message.url)
  )
    return null;
  try {
    const url = new URL(message.url);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function mailFrameHeight(
  data: unknown,
  nonce: string,
  source: unknown,
  expectedSource: unknown,
): number | null {
  if (!expectedSource || source !== expectedSource || !data || typeof data !== "object")
    return null;
  const message = data as { type?: string; nonce?: string; height?: unknown };
  if (
    message.type !== "officeflare:mail-body-height" ||
    message.nonce !== nonce ||
    typeof message.height !== "number" ||
    !Number.isFinite(message.height)
  )
    return null;
  return Math.max(96, Math.min(24_000, Math.ceil(message.height)));
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

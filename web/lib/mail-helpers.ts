export const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(2)} GB`;
export const mailDate = (value: number | null) =>
  value
    ? new Date(value * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
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
    throw new Error("Enter email addresses separated by commas.");
  return [...new Set(addresses.map((address) => address.toLowerCase()))];
}
export function scheduledTime(value: string, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 366 * 86400_000)
    throw new Error("Choose a future time within 366 days.");
  return Math.floor(timestamp / 1000);
}
export const cancelableSubmission = (status: string) =>
  ["scheduled", "queued", "retry_wait", "unknown"].includes(status);
export const retryableSubmission = (status: string) => status === "failed";
export const submissionLabel = (status: string) =>
  ({
    accepted: "Accepted by provider",
    unknown: "Acceptance unknown",
    retry_wait: "Waiting to retry",
    processing: "Sending",
    queued: "Queued",
    scheduled: "Scheduled",
    canceled: "Canceled",
    failed: "Failed",
  })[status] ?? status;
export function mailErrorDescription(code: string) {
  const messages: Record<string, string> = {
    message_too_large: "This message is too large. Remove attachments or shorten the message.",
    E_CONTENT_TOO_LARGE: "This message is too large. Remove attachments or shorten the message.",
    provider_unavailable: "The mail service is temporarily unavailable. Try again later.",
    invalid_mbox_format:
      "This file is not a valid mailbox archive. Choose an MBOX file and try again.",
    invalid_eml_format: "This file is not a valid email message. Choose an EML file and try again.",
    rate_limited: "Too many requests. Wait a moment before trying again.",
    quota_exceeded: "The mailbox is out of storage. Free up space or contact an administrator.",
  };
  return (
    messages[code] ??
    "This operation could not be completed. Try again or contact an administrator."
  );
}
export function mailFailure(failure: unknown) {
  return failure instanceof Error ? failure.message : "Unable to complete the request.";
}
export async function embeddedMailImage(blob: Blob): Promise<string> {
  if (!/^image\/[a-z0-9.+-]+$/i.test(blob.type) || blob.size > 5 * 1024 ** 2)
    throw new Error("Unsupported mail image");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
export function htmlFrame(html: string, resizeNonce?: string) {
  if (resizeNonce && !/^[a-f0-9]{32,64}$/.test(resizeNonce)) throw new Error("Invalid frame nonce");
  const policy = resizeNonce ? " script-src 'nonce-" + resizeNonce + "';" : "";
  // Only this nonce-authorized script can run; the frame keeps an opaque origin.
  const resize = resizeNonce
    ? '<script nonce="' +
      resizeNonce +
      '">(()=>{const nonce="' +
      resizeNonce +
      '";const report=()=>{const height=Math.ceil(document.body.getBoundingClientRect().height+40);parent.postMessage({type:"officeflare:mail-body-height",nonce,height},"*")};new ResizeObserver(()=>requestAnimationFrame(report)).observe(document.body);addEventListener("load",report);addEventListener("message",event=>{const data=event.data;if(event.source!==parent||!data||data.type!=="officeflare:mail-assets"||data.nonce!==nonce||!Array.isArray(data.assets))return;for(const asset of data.assets){if(!asset||typeof asset.source!=="string"||!/^data:image\\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(asset.value))continue;for(const image of document.querySelectorAll("img[src]"))if(image.getAttribute("src")===asset.source)image.setAttribute("src",asset.value);for(const element of document.querySelectorAll("[style]"))element.setAttribute("style",element.getAttribute("style").replaceAll(asset.source,asset.value));for(const style of document.querySelectorAll("style"))style.textContent=style.textContent.replaceAll(asset.source,asset.value)}report()});report()})()</script>'
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';${policy}"><style>body{margin:20px;color:#252628;font:14px/1.7 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}img[src^="/api/mail/"]{opacity:0}img[src=""]{visibility:hidden}pre{white-space:pre-wrap}table{max-width:100%}a{color:#526cb5}</style></head><body>${html}${resize}</body></html>`;
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
      throw new Error(
        "The previous request has an unknown outcome. Retry it before changing the message.",
      );
    this.serialized = serialized;
    return { "Idempotency-Key": this.key };
  }
  complete() {
    this.key = operationKey();
    this.serialized = null;
  }
}

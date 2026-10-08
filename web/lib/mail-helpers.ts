export const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`;
export const mailDate = (value: number | null) => value ? new Date(value * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
export function parseRecipients(value: string): string[] {
  const addresses = value.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
  if (addresses.some((address) => !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(address) || address.length > 254 || address.split("@")[0]!.length > 64 || address.startsWith(".") || address.includes(".."))) throw new Error("Enter email addresses separated by commas.");
  return [...new Set(addresses.map((address) => address.toLowerCase()))];
}
export function scheduledTime(value: string, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 366 * 86400_000) throw new Error("Choose a future time within 366 days.");
  return Math.floor(timestamp / 1000);
}
export const cancelableSubmission = (status: string) => ["scheduled", "queued", "retry_wait"].includes(status);
export const retryableSubmission = (status: string) => status === "failed";
export const submissionLabel = (status: string) => ({ accepted: "Accepted by provider", unknown: "Acceptance unknown", retry_wait: "Waiting to retry", processing: "Sending", queued: "Queued", scheduled: "Scheduled", canceled: "Canceled", failed: "Failed" }[status] ?? status);
export function mailFailure(failure: unknown) { return failure instanceof Error ? failure.message : "Unable to complete the request."; }
export function htmlFrame(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';"><style>body{margin:20px;color:#252628;font:14px/1.7 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}table{max-width:100%}a{color:#526cb5}</style></head><body>${html}</body></html>`;
}
// getRandomValues is also available on HTTP origins, unlike randomUUID.
const operationKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
// A lost response must replay the same operation, including after session refresh.
export class MailOperation {
  private key = operationKey();
  private serialized: string | null = null;
  headers(body: object) {
    const serialized = JSON.stringify(body);
    if (this.serialized !== null && this.serialized !== serialized) throw new Error("The previous request has an unknown outcome. Retry it before changing the message.");
    this.serialized = serialized;
    return { "Idempotency-Key": this.key };
  }
  complete() { this.key = operationKey(); this.serialized = null; }
}

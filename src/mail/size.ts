// A conservative MIME budget, shared by send validation and the composer.
// Reserve space for the envelope, multipart boundaries and provider-added headers.
const envelopeBytes = 16 * 1024;
export function encodedMailBytes(bytes: number) {
  const base64 = Math.ceil(bytes / 3) * 4;
  return base64 + Math.ceil(base64 / 76) * 2;
}
export interface MessageSizeInput {
  text: string;
  html: string;
  subject?: string;
  from?: string;
  reply_to?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  attachments: { size_bytes: number; filename: string; content_type: string; content_id?: string | null }[];
}
export function estimatedMessageBytes(message: MessageSizeInput) {
  const utf8 = (value: string) => new TextEncoder().encode(value).length;
  const headers = [message.subject, message.from, message.reply_to, ...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? []), ...Object.entries(message.headers ?? {}).flat()].join("\r\n");
  return envelopeBytes + utf8(headers) * 3 + encodedMailBytes(utf8(message.text)) + encodedMailBytes(utf8(message.html)) +
    message.attachments.reduce((total, file) => total + encodedMailBytes(file.size_bytes) + 1024 + utf8(file.filename + file.content_type + (file.content_id ?? "")) * 3, 0);
}
export function maxAttachmentBytes(maxSendBytes: number) {
  let low = 0, high = maxSendBytes;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (estimatedMessageBytes({ text: "", html: "", attachments: [{ size_bytes: candidate, filename: "attachment", content_type: "application/octet-stream" }] }) <= maxSendBytes) low = candidate;
    else high = candidate - 1;
  }
  return low;
}
export function messageSizeLimits(providerMaximum: number, configured: number | null) {
  const max_send_bytes = Math.min(configured ?? providerMaximum, providerMaximum);
  return { max_send_bytes, max_upload_bytes: maxAttachmentBytes(max_send_bytes) };
}

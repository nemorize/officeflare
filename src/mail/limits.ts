import { all } from "./control";
import { integer } from "./input";
import { provider, providers } from "./providers";
import { estimatedMessageBytes, maxAttachmentBytes, messageSizeLimits, type MessageSizeInput } from "./size";
import { fail } from "./types";

export function sendingLimits(name: string, configured: number | null) {
  const capabilities = provider(name).capabilities;
  return messageSizeLimits(capabilities.max_send_bytes, configured);
}
export function configuredSendLimit(value: unknown, name: string | null) {
  if (value === null) return null;
  if (!name) fail(400, "A sending provider is required to configure max_send_bytes");
  return integer(value, "max_send_bytes", 1, provider(name).capabilities.max_send_bytes);
}
export const providerSendMaximum = () => Math.max(0, ...providers.filter((entry) => entry.capabilities.send).map((entry) => entry.capabilities.max_send_bytes));
export async function mailboxSendingLimits(env: Env, mailboxId: string) {
  const domains = await all<{ provider: string; max_send_bytes: number | null }>(env,
    "SELECT DISTINCT p.provider,d.max_send_bytes FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id JOIN mail_provider_connections p ON p.id=d.outbound_connection_id WHERE a.mailbox_id=? AND a.send_enabled=1 AND d.outbound_enabled=1 AND p.enabled=1", mailboxId);
  const available = domains.filter((entry) => providers.some((adapter) => adapter.id === entry.provider && adapter.capabilities.send)).map((entry) => sendingLimits(entry.provider, entry.max_send_bytes));
  const max_send_bytes = Math.max(0, ...available.map((limits) => limits.max_send_bytes));
  // Mailboxes without a sender can still save attachments in drafts.
  return { max_send_bytes, max_upload_bytes: available.length ? Math.max(...available.map((limits) => limits.max_upload_bytes)) : maxAttachmentBytes(providerSendMaximum()) };
}
export function validateMessageSize(message: MessageSizeInput, maximum: number) {
  if (estimatedMessageBytes(message) > maximum) fail(413, `Message exceeds the sending limit of ${maximum} bytes, including encoded attachments and body`);
}

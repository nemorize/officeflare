import { t } from "../../shared/i18n/index.ts";
import { mailSendLimit, workspaceMailPolicy } from "./policy";
import { all } from "./control";
import { integer } from "./input";
import { provider, providers } from "./providers";
import {
  estimatedMessageBytes,
  maxAttachmentBytes,
  messageSizeLimits,
  type MessageSizeInput,
} from "./size";
import { fail } from "./types";

export function sendingLimits(name: string, configured: number | null) {
  const capabilities = provider(name).capabilities;
  return messageSizeLimits(capabilities.max_send_bytes, configured);
}
export function configuredSendLimit(value: unknown, name: string | null) {
  if (value === null) return null;
  if (!name) fail(400, t("mailLimits.aSendingProviderIsRequiredToConfigureMaxSend"));
  return integer(value, "max_send_bytes", 1, provider(name).capabilities.max_send_bytes);
}
export const providerSendMaximum = () =>
  Math.max(
    0,
    ...providers
      .filter((entry) => entry.capabilities.send)
      .map((entry) => entry.capabilities.max_send_bytes),
  );
export async function mailboxSendingLimits(env: Env, mailboxId: string) {
  const policy = await workspaceMailPolicy(env);
  const domains = await all<{ provider: string; max_send_bytes: number | null }>(
    env,
    "SELECT DISTINCT json_extract(d.provider_settings_json,'$.outbound.provider') provider,d.max_send_bytes FROM mail_addresses a JOIN mail_domains d ON d.id=a.domain_id WHERE a.mailbox_id=? AND a.send_enabled=1 AND d.outbound_enabled=1 AND json_type(d.provider_settings_json,'$.outbound')='object'",
    mailboxId,
  );
  const available = domains
    .filter((entry) =>
      providers.some((adapter) => adapter.id === entry.provider && adapter.capabilities.send),
    )
    .map((entry) =>
      sendingLimits(entry.provider, mailSendLimit(entry.max_send_bytes, policy.max_send_bytes)),
    );
  const max_send_bytes = Math.max(0, ...available.map((limits) => limits.max_send_bytes));
  // Mailboxes without a sender can still save attachments in drafts.
  return {
    max_send_bytes,
    max_upload_bytes: available.length
      ? Math.max(...available.map((limits) => limits.max_upload_bytes))
      : maxAttachmentBytes(providerSendMaximum()),
  };
}
export function validateMessageSize(message: MessageSizeInput, maximum: number) {
  if (estimatedMessageBytes(message) > maximum)
    fail(
      413,
      t("mailLimits.messageExceedsTheSendingLimitOfBytesIncludingEncoded", { maximum: maximum }),
    );
}

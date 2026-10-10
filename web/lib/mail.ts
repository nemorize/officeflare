import { api } from "./api";
export type MailRight = "read" | "write" | "send_as" | "send_on_behalf" | "manage";
export interface Mailbox { id: string; name: string; kind: "personal" | "shared"; status: string; owner_user_id: string; email_address?: string | null; member_count?: number; access?: Record<MailRight, boolean>; }
export interface Folder { id: string; name: string; system_key: string | null; version: number; }
export interface Address { id: string; mailbox_id: string; domain_id: string; local_part: string; email_address: string; is_primary: number; receive_enabled: number; send_enabled: number; }
export interface Attachment { id: string; filename: string; content_type: string; size_bytes: number; content_id: string | null; disposition: string; }
export interface Submission { id: string; message_id: string; actor_id: string; send_mode: "send_as" | "send_on_behalf"; status: string; scheduled_at: number; provider: string; connection_id: string; provider_message_id: string | null; attempt_count: number; error_code: string | null; recipients?: { email_address: string; status: string; event_at: number | null }[]; }
export interface MailPreferences { density: "comfortable" | "compact"; conversation_view: boolean; reading_pane: "none" | "right"; shortcuts: boolean; undo_seconds: number; sidebar_collapsed: boolean; }
export interface MailSummary { folders: Record<string, { total: number; unread: number }>; starred: number; snoozed: number; scheduled: number; }
export interface Message { scheduled_at?: number; draft_state?: string | null; message_count?: number; unread_count?: number; starred_count?: number; participants?: string; recipient_summary?: string; id: string; thread_id: string; direction: string; folder_id: string; subject: string; from_address: string; reply_to_address: string | null; received_at: number; is_read: number; is_starred: number; is_spam: number; snoozed_until: number | null; snippet: string; has_attachments: number; version: number; draft_owner_id: string | null; provider: string; connection_id: string; provider_message_id: string | null; rfc_message_id: string | null; }
export interface MessageDetail extends Message { body: { text: string; html: string; editor_body?: { text: string; html: string }; quoted_body?: { text: string; html: string }; include_quoted_body?: boolean; compose_state?: { to: string; cc: string; bcc: string; address_id?: string; send_mode?: string; schedule?: string } }; recipients: { kind: string; email_address: string }[]; attachments: Attachment[]; references: string[]; draft: { version: number; state: string } | null; submissions: Submission[]; }
export interface MailSettings { signature: string; signature_html: string; retention_days: number | null; auto_reply_enabled: number; auto_reply_subject: string; auto_reply_text: string; }
export interface Capabilities { features: Record<string, boolean>; providers: { provider: string; [key: string]: unknown }[]; limits: { max_upload_bytes: number; max_inbound_bytes: number; max_page_size: number }; }
export interface Connection { id: string; provider: string; name: string; enabled: number; version: number; }
export interface Domain { id: string; name: string; is_default: number; inbound_connection_id: string | null; outbound_connection_id: string | null; inbound_provider?: string | null; outbound_provider?: string | null; inbound_enabled: number; outbound_enabled: number; plus_addressing: number; catch_all_mailbox_id: string | null; }
export interface DomainProvider { provider: string; capabilities: { receive: boolean; send: boolean }; default_connection_id: string | null; }
export interface Condition { field: string; operator: string; value: string; }
export interface RuleAction { type: string; folder_id?: string; }
export interface MailRule { id: string; name: string; enabled: number; priority: number; version: number; conditions_json: string; actions_json?: string; action?: string; forward_to?: string | null; reject_reason?: string | null; }
export interface Job { id: string; kind: string; status: string; progress: number; error_code: string | null; created_at: number; updated_at: number; }
export const mailboxPath = (id: string) => `/api/mail/mailboxes/${encodeURIComponent(id)}`;
export { bytes, mailDate, parseRecipients, scheduledTime, cancelableSubmission, retryableSubmission, submissionLabel, mailFailure, htmlFrame, MailOperation } from "./mail-helpers";
export async function downloadMail(path: string, name: string) {
  const blob = await api<Blob>(path, { response: "blob", signal: AbortSignal.timeout(120_000) });
  saveBlob(blob, name);
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name.replace(/[\/\\\x00-\x1f]/g, "_"); document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

import type { AppEnv } from "../auth/types";

export type MailAction =
  | "read"
  | "write"
  | "send"
  | "manage";
export interface MailActor {
  user_id: string;
  auth_version: number;
  api_key_id: string | null;
}
export type MailAppEnv = {
  Bindings: AppEnv["Bindings"];
  Variables: AppEnv["Variables"] & { mail_actor: MailActor };
};
export interface Connection {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  version: number;
  config_json?: string;
  secret_ciphertext?: string | null;
  secret_nonce?: string | null;
}
export interface Mailbox {
  id: string;
  owner_user_id: string;
  name: string;
  kind: string;
  status: string;
}
export interface Domain {
  is_default: number;
  id: string;
  name: string;
  inbound_connection_id: string | null;
  outbound_connection_id: string | null;
  inbound_enabled: number;
  outbound_enabled: number;
  max_send_bytes: number | null;
  plus_addressing: number;
  catch_all_mailbox_id: string | null;
}
export interface Address {
  id: string;
  domain_id: string;
  mailbox_id: string;
  local_part: string;
  is_primary: number;
  receive_enabled: number;
  send_enabled: number;
}
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_id: string | null;
  r2_key: string;
  disposition: "inline" | "attachment";
}
export interface ComposeState { to: string; cc: string; bcc: string; reply_to?: string; address_id?: string; schedule?: string; }
export interface MailBody {
  compose_state?: ComposeState;
  editor_body?: { text: string; html: string };
  quoted_body?: { text: string; html: string };
  include_quoted_body?: boolean;
  text: string;
  html: string;
}
export interface MessageInput {
  id: string;
  ingest_id?: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  folder_id: string;
  subject: string;
  from_address: string;
  reply_to_address?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  received_at: number;
  source?: string;
  provider: string | null;
  connection_id: string | null;
  provider_message_id: string | null;
  rfc_message_id: string | null;
  references: string[];
  raw_r2_key: string | null;
  body_r2_key: string;
  snippet: string;
  search_text: string;
  attachments: Attachment[];
  draft_owner_id: string | null;
  is_spam?: boolean;
  snoozed_until?: number | null;
}
export interface MessageRow {
  scheduled_at?: number | null;
  submission_status?: Submission["status"] | null;
  draft_state?: string | null;
  id: string;
  thread_id: string;
  direction: string;
  folder_id: string;
  subject: string;
  from_address: string;
  reply_to_address: string | null;
  received_at: number;
  is_read: number;
  is_starred: number;
  is_spam: number;
  snoozed_until: number | null;
  trashed_at: number | null;
  provider: string | null;
  connection_id: string | null;
  provider_message_id: string | null;
  rfc_message_id: string | null;
  raw_r2_key: string | null;
  body_r2_key: string;
  snippet: string;
  has_attachments: number;
  draft_owner_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface MessageQuery {
  actor_id: string;
  thread_ids?: string[];
  limit: number;
  before?: { received_at: number; id: string };
  folder_id?: string;
  thread_id?: string;
  search?: string;
  include_snoozed?: boolean;
  snoozed_only?: boolean;
  view?: "inbox" | "all" | "scheduled" | "outbox";
  exclude_drafts?: boolean;
  editable_drafts?: boolean;
}
export interface Submission {
  id: string;
  message_id: string;
  actor_id: string;
  actor_auth_version: number;
  api_key_id: string | null;
  address_id: string;
  provider: string;
  connection_id: string;
  provider_message_id: string | null;
  request_hash: string;
  draft_version: number;
  snapshot_r2_key: string;
  status: string;
  scheduled_at: number;
  lease_until: number | null;
  attempt_count: number;
  error_code: string | null;
}
export interface SubmissionSnapshot {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  reply_to?: string;
  headers: Record<string, string>;
  attachments: Attachment[];
}
export interface Partition {
  id: string;
  ordinal: number;
  status: string;
  database_bytes: number;
  created_at: number;
}
export interface RuleCondition {
  field: "from" | "to" | "subject" | "body";
  operator: "contains" | "equals" | "prefix" | "suffix";
  value: string;
}
export interface RuleAction {
  type: "move" | "star" | "read" | "spam";
  folder_id?: string;
}
export interface Rule {
  id: string;
  name: string;
  priority: number;
  enabled: number;
  conditions_json: string;
  actions_json: string;
  version: number;
}
export interface InboundTask {
  kind: "inbound";
  id: string;
  mailbox_id: string;
  provider: string | null;
  connection_id: string | null;
  source?: string;
  raw_r2_key: string;
  envelope_from: string;
  envelope_to: string;
  received_at: number;
}
export interface WorkTask {
  kind: "send" | "snooze" | "outbox" | "webhook";
  mailbox_id: string;
  partition_id: string;
  reference_id: string;
}
export interface DeliveryTask {
  kind: "delivery";
  provider: string;
  connection_id: string;
  provider_event_id: string;
  provider_message_id: string;
  sender: string;
  recipient: string;
  status: string;
  event_at: number;
}
export interface DataTask {
  kind: "data_job";
  mailbox_id: string;
  reference_id: string;
}
export type MailTask = InboundTask | WorkTask | DeliveryTask | DataTask;
export const epoch = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export const messageId = (partition: string) => partition + "." + id();
export function locator(value: string) {
  const match =
    /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
      value,
    );
  if (!match) fail(400, "Invalid mail resource ID");
  return match[1]!;
}
export function fail(status: number, message: string): never {
  throw new Error("MAIL:" + status + ":" + message);
}
export function row<T = Record<string, string | number | null>>(
  sql: SqlStorage,
  query: string,
  ...args: (string | number | null)[]
): T | null {
  return (sql.exec(query, ...args).toArray()[0] as T | undefined) ?? null;
}
export function rows<T = Record<string, string | number | null>>(
  sql: SqlStorage,
  query: string,
  ...args: (string | number | null)[]
): T[] {
  return sql.exec(query, ...args).toArray() as T[];
}

export function publicSubmission<T extends Submission>(value: T) {
  const {
    actor_auth_version: _auth,
    api_key_id: _key,
    request_hash: _hash,
    snapshot_r2_key: _snapshot,
    ...result
  } = value;
  return result;
}

export interface ThreadRow extends MessageRow { message_count: number; unread_count: number; starred_count: number; participants: string; recipient_summary: string; }

export interface MailPolicy {
  default_retention_days: number | null;
  max_send_bytes: number | null;
  external_forwarding_enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
}
export interface AdminMailbox {
  id: string;
  name: string;
  kind: string;
  status: string;
  owner_user_id: string;
  owner_email: string;
  owner_name: string | null;
  email_address: string | null;
  member_count: number;
  message_count: number | null;
  database_bytes: number | null;
  attachment_bytes: number | null;
  storage_updated_at: number | null;
}
export interface MailFlow {
  id: string;
  mailbox_id: string | null;
  mailbox_name: string | null;
  email_address: string | null;
  direction: string;
  provider: string | null;
  status: string;
  error_code: string | null;
  attempt_count: number;
  scheduled_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface MailAdminActivity {
  sequence: number;
  actor_email: string | null;
  actor_name: string | null;
  operation: string;
  resource_path: string;
  resource_name: string | null;
  resource_id: string | null;
  created_at: number;
}

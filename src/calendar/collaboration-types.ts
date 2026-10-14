import type { Event, Calendar } from "./types";
export interface Attendee {
  id: string;
  scope_id: string;
  event_id: string;
  occurrence_key: string;
  principal_type: "user" | "external";
  user_id: string | null;
  email_address: string;
  email_key: string;
  display_name: string;
  optional: number;
  additional_guests: number;
  response_status: "needs_action" | "accepted" | "tentative" | "declined";
  attendance_mode: "unspecified" | "in_person" | "virtual";
  response_comment: string;
  version: number;
  created_at: number;
  updated_at: number;
  responded_at: number | null;
  removed_at: number | null;
}
export interface ShareLink {
  id: string;
  calendar_id: string;
  event_id: string | null;
  target_type: "calendar" | "event";
  occurrence_key: string | null;
  mode: "view" | "join";
  token_hash: string;
  password_hash: string | null;
  shared_fields_json: string;
  allow_ics: number;
  time_min: number | null;
  time_max: number | null;
  access_version: number;
  version: number;
  created_by: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}
export interface LinkSession {
  id: string;
  share_link_id: string;
  token_hash: string;
  link_access_version: number;
  verified_email: string | null;
  email_key: string | null;
  email_verified_at: number | null;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}
export interface Policy {
  id: string;
  event_id: string;
  occurrence_key: string;
  approval_mode: "automatic" | "manual";
  capacity: number | null;
  waitlist_enabled: number;
  additional_guests_limit: number;
  registration_opens_at: number | null;
  registration_closes_at: number | null;
  allowed_email_domains_json: string;
  form_schema_json: string;
  status: "open" | "closed";
  version: number;
}
export interface Registration {
  id: string;
  event_id: string;
  occurrence_key: string;
  source_link_id: string | null;
  attendee_id: string | null;
  email_address: string;
  email_key: string;
  user_id: string | null;
  display_name: string;
  additional_guests: number;
  answers_json: string;
  status: "pending" | "confirmed" | "waitlisted" | "rejected" | "cancelled";
  requested_response: "accepted" | "tentative";
  requested_attendance_mode: Attendee["attendance_mode"];
  version: number;
  waitlisted_at: number | null;
  confirmed_at: number | null;
  decided_by: string | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface Settings {
  system_address_id: string | null;
  internal_sharing_enabled: number;
  external_sharing_enabled: number;
  public_link_max_days: number;
  public_link_password_required: number;
  authorization_epoch: number;
  version: number;
  updated_at: number;
}
export interface DeliveryPayload {
  kind: "invitation" | "verify" | "recovery";
  event?: Event;
  calendar?: Pick<Calendar, "time_zone">;
  attendee?: Attendee;
  occurrence_key?: string;
  action: string;
  url?: string;
  automatic?: boolean;
  code?: string;
  overrides?: { original_key: string; event: Event }[];
}

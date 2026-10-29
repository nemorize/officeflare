import type { AuthContext, AuthEnv } from "../auth/types";
export type CalendarContext = AuthContext;
export type CalendarEnv = AuthEnv;
export type Bind = string | number | null;
export interface Condition {
  sql: string;
  args: Bind[];
}
export interface Calendar {
  id: string;
  data_owner_user_id: string;
  kind: string;
  name: string;
  description: string;
  location: string;
  time_zone: string;
  default_visibility: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  effective_role: Role;
  is_primary: number;
}
export type Role =
  "free_busy" | "reader" | "writer_without_private" | "writer" | "manager" | "data_owner";
export interface Event {
  id: string;
  organizer_calendar_id: string;
  organizer_user_id: string | null;
  organizer_email: string;
  creator_user_id: string | null;
  authority: string;
  i_cal_uid: string;
  sequence: number;
  event_type: string;
  status: string;
  title: string;
  description_html: string;
  location_json: string;
  time_kind: "timed" | "all_day";
  start_at: number | null;
  end_at: number | null;
  start_date: string | null;
  end_date: string | null;
  start_local: string | null;
  end_local: string | null;
  start_time_zone: string | null;
  end_time_zone: string | null;
  recurrence_json: string;
  recurrence_until_at: number | null;
  visibility: string;
  transparency: string;
  guest_permissions_json: string;
  type_properties_json: string;
  shared_properties_json: string;
  source_json: string;
  version: number;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
}
export type EventTimes = Pick<
  Event,
  | "time_kind"
  | "start_at"
  | "end_at"
  | "start_date"
  | "end_date"
  | "start_local"
  | "end_local"
  | "start_time_zone"
  | "end_time_zone"
>;
export interface Override {
  scope_id: string;
  event_id: string;
  occurrence_key: string;
  cancelled: number;
  patch_json: string;
  effective_start_at: number | null;
  effective_end_at: number | null;
  effective_start_date: string | null;
  effective_end_date: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface Copy {
  id: string;
  event_id: string;
  calendar_id: string;
  copy_kind: string;
  color_override: string | null;
  label_id: string | null;
  use_default_reminders: number;
  private_properties_json: string;
  hidden_at: number | null;
  removed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface Occurrence {
  key: string;
  original: EventTimes;
  event: Event;
  override?: Override;
}

import type { AuthContext, AuthEnv } from "../auth/types";
export type DriveContext = AuthContext;
export type DriveEnv = AuthEnv;
export type Bind = string | number | null;
export interface Condition { sql: string; args: Bind[] }
export interface DriveItem {
  id: string; owner_user_id: string; parent_id: string | null; kind: "file" | "folder"; name: string;
  description: string; current_version_id: string | null; version: number; created_by: string;
  created_at: number; updated_at: number; trashed_at: number | null; purged_at: number | null;
}
export interface DriveVersion { id: string; item_id: string; blob_key: string; size: number; content_type: string; etag: string; sha256: string | null; created_by: string; created_at: number }
export interface DriveUpload {
  id: string; owner_user_id: string; created_by: string; item_id: string; parent_id: string | null;
  name: string; base_version: number; size: number; content_type: string; sha256: string | null;
  mode: "single" | "multipart"; blob_key: string; multipart_id: string | null;
  status: "allocating" | "open" | "writing" | "ready" | "committing" | "completed" | "cancelled";
  lease_token: string | null; lease_until: number; expires_at: number; created_at: number; completed_at: number | null;
}
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

import { getLocale } from "../../shared/i18n/index.ts";
export interface NotificationItem {
  id: string;
  type: string;
  service: string;
  category: string;
  title: string;
  body: string;
  target_path: string | null;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
  snoozed_until: number | null;
  version: number;
  required: boolean;
}
export interface NotificationSummary {
  unread: number;
  read_all_cursor: string;
  change_cursor: string;
  next_snoozed_until: number | null;
}
export interface NotificationPage {
  notifications: NotificationItem[];
  next_cursor: string | null;
}
export interface NotificationPreferences {
  enabled: boolean;
  rules: Record<string, boolean>;
  version: number;
}
export interface NotificationType {
  type: string;
  service: string;
  category: string;
  label: string;
  required: boolean;
}
export interface NotificationUpdate {
  read?: boolean;
  archived?: boolean;
  snoozed_until?: number | null;
  deleted?: boolean;
}
export type NotificationState = "inbox" | "unread" | "archived" | "snoozed" | "all";

// Paths are also checked on the server. Keep navigation on the current origin.
export const notificationTarget = (path: string | null) =>
  path === "/profile/sessions" ||
  path === "/notifications" ||
  /^\/calendar\/invitations\/[A-Za-z0-9_-]+$/.test(path ?? "")
    ? path
    : null;
export const notificationDate = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });

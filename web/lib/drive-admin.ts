import { t } from "../../shared/i18n/index.ts";
export interface DriveSettings {
  default_quota_bytes: number;
  max_file_bytes: number;
  internal_sharing_enabled: number;
  public_sharing_enabled: number;
  public_link_password_required: number;
  public_link_max_days: number;
  trash_retention_days: number;
  version: number;
  updated_at: number;
  updated_by: string | null;
}
export interface DriveAccount {
  user_id: string;
  email_address: string;
  display_name: string | null;
  role_has_drive: number;
  disabled_at: number | null;
  deleted_at: number | null;
  password_reset_required: number;
  quota_bytes: number;
  quota_override_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
  status: "active" | "read_only" | "suspended";
  version: number;
  permissions?: string[];
  total_items?: number;
  files?: number;
  folders?: number;
  trashed?: number;
  active_uploads?: number;
}
export interface AdminDriveItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  owner_user_id: string;
  owner_name: string | null;
  owner_email: string;
  parent_id: string | null;
  version: number;
  size: number | null;
  version_bytes: number;
  updated_at: number;
  trashed_at: number | null;
  in_trash?: number;
}
export interface DriveSharing {
  id?: string;
  item_id: string;
  name: string;
  kind: string;
  version: number;
  owner_email: string;
  user_id?: string;
  email_address?: string;
  display_name?: string;
  role?: string;
  expires_at: number | null;
  revoked_at?: number | null;
  password_protected?: number;
  policy_allowed?: number;
  allow_download?: number;
  created_at: number;
}
export interface DriveAudit {
  page_id: string;
  source: string;
  action: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  owner_user_id: string | null;
  item_id: string | null;
  item_name: string | null;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: number;
}
export interface DriveTransfer {
  id: string;
  source_user_id: string;
  target_user_id: string;
  source_email: string;
  target_email: string;
  status: "queued" | "running" | "failed" | "completed" | "cancelled";
  total_items: number;
  processed_items: number;
  reserved_bytes: number;
  reason: string;
  error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface AdminPage<T> {
  items: T[];
  next_cursor: string | null;
}
export const driveConsolePages = [
  { page: "overview", label: t("libDriveAdmin.overview"), permission: "admin.drive.accounts.read" },
  {
    page: "accounts",
    label: t("libDriveAdmin.accountsStorage"),
    permission: "admin.drive.accounts.read",
  },
  { page: "items", label: t("libDriveAdmin.filesTrash"), permission: "admin.drive.items.read" },
  { page: "sharing", label: t("libDriveAdmin.sharing"), permission: "admin.drive.sharing.read" },
  { page: "settings", label: t("libDriveAdmin.policies"), permission: "admin.drive.settings.read" },
  { page: "activity", label: t("libDriveAdmin.auditLog"), permission: "admin.drive.audit.read" },
] as const;
export const accountAvailability = (account: DriveAccount) =>
  account.deleted_at
    ? t("libDriveAdmin.deletedAccount")
    : account.disabled_at
      ? t("libDriveAdmin.disabledAccount")
      : account.password_reset_required
        ? t("libDriveAdmin.passwordChangeRequired")
        : !account.role_has_drive
          ? t("libDriveAdmin.noDriveRole")
          : account.status === "suspended"
            ? t("libDriveAdmin.driveSuspended")
            : account.status === "read_only"
              ? t("libDriveAdmin.readOnly")
              : t("common.active");
export const GIB = 1024 ** 3;
export function storageBytes(value: string) {
  const bytes = Number(value) * GIB;
  if (!value.trim() || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(t("libDriveAdmin.enterAValidStorageAmountInGib"));
  return bytes;
}

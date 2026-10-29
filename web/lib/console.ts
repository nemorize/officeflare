import type { ApiOptions } from "./api-client";
import type { WorkspaceNavigationItem } from "./workspace-navigation";
import {
  driveUserPermissions,
  isPermission,
  missingPrerequisites,
  permissionCatalog,
  permissionClosure,
} from "../../src/authorization/permissions.ts";
export {
  defaultEligible,
  permissionCatalog,
  permissionClosure,
  permissionGroups,
  togglePermission,
} from "../../src/authorization/permissions.ts";
export { driveUserPermissions } from "../../src/authorization/permissions.ts";
export type { PermissionDefinition } from "../../src/authorization/permissions.ts";

export const userPermissions = Object.keys(permissionCatalog).filter((key) =>
  key.startsWith("admin.users."),
);
export const rolePermissions = Object.keys(permissionCatalog).filter((key) =>
  key.startsWith("admin.roles."),
);
export const driveAdminPermissions = Object.keys(permissionCatalog).filter((key) =>
  key.startsWith("admin.drive."),
);
export const consoleSections: (WorkspaceNavigationItem & { permissions: string[] })[] = [
  { path: "/console/users", name: "Users", icon: "users", permissions: ["admin.users.read"] },
  { path: "/console/roles", name: "Roles", icon: "shield", permissions: ["admin.roles.read"] },
  {
    path: "/console/mail/domains",
    name: "Mail domains",
    icon: "mail",
    permissions: ["admin.mail.domains.read"],
  },
  {
    path: "/console/mail/mailboxes",
    name: "Shared mailboxes",
    icon: "inbox",
    permissions: ["admin.mail.mailboxes.read"],
  },
  { path: "/console/drive", name: "Drive", icon: "drive", permissions: driveAdminPermissions },
];
export const consoleMenu = (permissions: readonly string[]) =>
  permissions.includes("console.access")
    ? consoleSections.filter((item) =>
        item.permissions.some((permission) => permissions.includes(permission)),
      )
    : [];
export const canGrant = (permissions: readonly string[], grants: readonly string[]) =>
  grants.every((key) => isPermission(key)) &&
  permissionClosure(grants).every((key) => permissions.includes(key));
export const managedPermissions = (permissions: readonly string[]) =>
  permissions.filter(isPermission);
export const roleTemplates = [
  { key: "mail-user", label: "Mail user", permissions: ["mail.access"] },
  { key: "drive-user", label: "Drive user", permissions: [...driveUserPermissions] },
  {
    key: "drive-reader",
    label: "Drive read-only user",
    permissions: ["drive.access", "drive.files.download"],
  },
  {
    key: "drive-manager",
    label: "Drive manager",
    permissions: permissionClosure(driveAdminPermissions),
  },
  {
    key: "drive-auditor",
    label: "Drive auditor",
    permissions: permissionClosure([
      "admin.drive.accounts.read",
      "admin.drive.items.read",
      "admin.drive.sharing.read",
      "admin.drive.audit.read",
    ]),
  },
  {
    key: "account-viewer",
    label: "Account viewer",
    permissions: permissionClosure(["admin.users.read"]),
  },
  {
    key: "account-support",
    label: "Account support",
    permissions: permissionClosure(["mail.access", "admin.users.credentials.reset"]),
  },
  {
    key: "access-manager",
    label: "Access manager",
    permissions: permissionClosure([
      "admin.roles.create",
      "admin.roles.update",
      "admin.users.roles.assign",
      "admin.users.roles.remove",
    ]),
  },
];
export interface AdminUser {
  id: string;
  email_address: string;
  display_name: string | null;
  profile_image_key: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  password_changed_at: number | null;
  mail?: {
    mailbox: import("./mail").Mailbox | null;
    email_address: string | null;
    mail_enabled: boolean;
  };
  password_reset_required: boolean;
  disabled_at: number | null;
  deleted_at: number | null;
}
export interface Role {
  id: string;
  key: string;
  label: string;
  description: string | null;
  is_system: boolean;
  is_default: boolean;
  permissions: string[];
  version: number;
  created_at: number;
  updated_at: number;
  assigned_user_count?: number;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface UserValues {
  name: string;
  email: string;
  disabled: boolean;
  passwordReset: boolean;
}
export interface UserChanges {
  display_name?: string | null;
  email_address?: string;
  disabled?: boolean;
  password_reset_required?: boolean;
}
export function userChanges(
  user: AdminUser,
  values: UserValues,
  permissions: readonly string[],
  currentUserId?: string,
): UserChanges {
  const require = (key: string, message: string) => {
    if (!permissions.includes(key)) throw new Error(message);
  };
  const changes: UserChanges = {},
    name = values.name.trim() || null,
    email = values.email.trim().toLowerCase();
  if ([...(name ?? "")].length > 200)
    throw new Error("Display name must contain at most 200 characters.");
  if (name !== user.display_name) {
    require("admin.users.profile.update", "You do not have permission to update user profiles.");
    changes.display_name = name;
  }
  if (email !== user.email_address) {
    require("admin.users.email.update", "You do not have permission to change email addresses.");
    changes.email_address = email;
  }
  if (values.disabled !== (user.disabled_at !== null)) {
    require("admin.users.status.update", "You do not have permission to change account status.");
    if (values.disabled && user.id === currentUserId)
      throw new Error("You cannot disable your own account.");
    changes.disabled = values.disabled;
  }
  if (values.passwordReset !== user.password_reset_required) {
    require("admin.users.credentials.reset", "You do not have permission to reset user credentials.");
    changes.password_reset_required = values.passwordReset;
  }
  return changes;
}
export const changesEndSessions = (changes: UserChanges) =>
  "email_address" in changes || "disabled" in changes || "password_reset_required" in changes;
export function rolePayload(
  values: { key: string; label: string; description: string; permissions: string[] },
  existing?: Role,
) {
  const label = values.label.trim();
  if (!label || label.length > 100) throw new Error("Enter a role name with up to 100 characters.");
  if (values.description.length > 1000)
    throw new Error("Description must contain at most 1000 characters.");
  if (!existing && !/^[a-z][a-z0-9_-]{0,63}$/.test(values.key))
    throw new Error(
      "Use a lowercase role key starting with a letter, with up to 64 letters, numbers, hyphens or underscores.",
    );
  if (existing?.is_system) throw new Error("System roles cannot be modified.");
  if (values.permissions.some((key) => !isPermission(key))) throw new Error("Unknown permission.");
  const permissions = [...new Set(values.permissions)],
    missing = missingPrerequisites(permissions);
  if (missing.length) throw new Error(`Missing required permissions: ${missing.join(", ")}`);
  return {
    label,
    description: values.description.trim() || null,
    permissions,
    ...(existing ? { version: existing.version } : { key: values.key }),
  };
}
export async function allRoles(
  api: <T>(path: string, options?: ApiOptions) => Promise<T>,
  signal: AbortSignal,
) {
  const roles = new Map<string, Role>(),
    cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const path: string = `/api/roles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result: { roles: Role[]; next_cursor: string | null } = await api(path, { signal });
    for (const role of result.roles) roles.set(role.id, role);
    cursor = result.next_cursor;
    if (cursor && cursors.has(cursor))
      throw new Error("Unable to load all roles. Refresh and try again.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...roles.values()];
}

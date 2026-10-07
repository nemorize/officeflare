import type { ApiOptions } from "./api-client";
import type { WorkspaceNavigationItem } from "./workspace-navigation";

export const userPermissions = ["users.read", "users.create", "users.update", "users.email.update", "users.delete", "users.roles.read", "users.roles.manage"];
export const rolePermissions = ["roles.read", "roles.manage"];
export const consolePermissions = [...userPermissions, ...rolePermissions];
export const consoleSections: (WorkspaceNavigationItem & { permissions: string[] })[] = [
  { path: "/console/users", name: "Users", icon: "users", permissions: userPermissions },
  { path: "/console/roles", name: "Roles", icon: "shield", permissions: rolePermissions },
];
export const consoleMenu = (permissions: readonly string[]) => consoleSections.filter((item) => item.permissions.some((permission) => permissions.includes(permission)));
export const canGrant = (permissions: readonly string[], grants: readonly string[]) => grants.every((permission) => permissions.includes(permission));
export const managedPermissions = (permissions: readonly string[]) => permissions.filter((permission) => consolePermissions.includes(permission));

export interface AdminUser {
  id: string; email_address: string; display_name: string | null; profile_image_key: string | null;
  created_at: number; updated_at: number; last_login_at: number | null; password_changed_at: number | null;
  password_reset_required: boolean; disabled_at: number | null; deleted_at: number | null;
}
export interface Role {
  id: string; key: string; label: string; description: string | null; is_system: boolean;
  permissions: string[]; version: number; created_at: number; updated_at: number;
}
export interface PermissionDefinition { key: string; label: string; }
export interface Page<T> { items: T[]; next_cursor: string | null; }
export interface UserValues { name: string; email: string; disabled: boolean; passwordReset: boolean; }
export interface UserChanges { display_name?: string | null; email_address?: string; disabled?: boolean; password_reset_required?: boolean; }

export function userChanges(user: AdminUser, values: UserValues, permissions: readonly string[], currentUserId?: string): UserChanges {
  if (!permissions.includes("users.update")) throw new Error("You do not have permission to update users.");
  if (values.disabled && user.id === currentUserId) throw new Error("You cannot disable your own account.");
  const changes: UserChanges = {}, name = values.name.trim() || null, email = values.email.trim().toLowerCase();
  if ([...(name ?? "")].length > 200) throw new Error("Display name must contain at most 200 characters.");
  if (name !== user.display_name) changes.display_name = name;
  if (email !== user.email_address) {
    if (!permissions.includes("users.email.update")) throw new Error("You do not have permission to change email addresses.");
    changes.email_address = email;
  }
  if (values.disabled !== (user.disabled_at !== null)) changes.disabled = values.disabled;
  if (values.passwordReset !== user.password_reset_required) changes.password_reset_required = values.passwordReset;
  return changes;
}
export const changesEndSessions = (changes: UserChanges) => "email_address" in changes || "disabled" in changes || "password_reset_required" in changes;

export function rolePayload(values: { key: string; label: string; description: string; permissions: string[] }, existing?: Role) {
  const label = values.label.trim();
  if (!label || label.length > 100) throw new Error("Enter a role name with up to 100 characters.");
  if (values.description.length > 1000) throw new Error("Description must contain at most 1000 characters.");
  if (!existing && !/^[a-z][a-z0-9_-]{0,63}$/.test(values.key)) throw new Error("Use a lowercase role key starting with a letter, with up to 64 letters, numbers, hyphens or underscores.");
  if (existing?.is_system) throw new Error("System roles cannot be modified.");
  const permissions = [...new Set([
    ...(existing?.permissions.filter((permission) => !consolePermissions.includes(permission)) ?? []),
    ...values.permissions.filter((permission) => consolePermissions.includes(permission)),
  ])];
  return { label, description: values.description.trim() || null, permissions,
    ...(existing ? { version: existing.version } : { key: values.key }) };
}

export async function allRoles(api: <T>(path: string, options?: ApiOptions) => Promise<T>, signal: AbortSignal) {
  const roles = new Map<string, Role>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const path: string = `/api/roles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result: { roles: Role[]; next_cursor: string | null } = await api(path, { signal });
    for (const role of result.roles) roles.set(role.id, role);
    cursor = result.next_cursor;
    if (cursor && cursors.has(cursor)) throw new Error("Unable to load all roles. Refresh and try again.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...roles.values()];
}

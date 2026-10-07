// Actions are defined by the application; administrators compose them into roles.
export const permissionCatalog = {
  "roles.read": { label: "View roles and available permissions" },
  "roles.manage": { label: "Create, update and delete roles" },
  "users.read": { label: "List and view user accounts" },
  "users.create": { label: "Create user accounts" },
  "users.update": { label: "Update user accounts and credentials" },
  "users.email.update": { label: "Change users' email addresses" },
  "users.delete": { label: "Delete user accounts" },
  "users.roles.read": { label: "View users' roles" },
  "users.roles.manage": { label: "Assign and remove users' roles" },
  "mail.providers.manage": { label: "Manage mail provider connections" },
  "mail.domains.manage": { label: "Manage mail domains and addresses" },
  "mail.mailboxes.manage": { label: "Provision and disable mailboxes" },
} as const;
export type Permission = keyof typeof permissionCatalog;
export const ADMINISTRATOR_ROLE_ID = "system-administrator";
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(permissionCatalog, value);
}
export interface ResourceRef { type: string; id: string }

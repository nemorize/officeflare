export const permissionGroups = {
  services: "Service access", users: "User administration", security: "Account security",
  roles: "Role administration", assignments: "Role assignments", mail: "Mail administration",
} as const;
export interface PermissionDefinition {
  label: string; description: string; group: keyof typeof permissionGroups;
  requires: readonly string[]; impact?: string;
}
const userRead = ["admin.users.read"] as const;
const roleRead = ["admin.roles.read"] as const;
const assignmentRead = ["admin.users.roles.read"] as const;
// One catalog drives API policies, role validation and the management UI.
// Service access never grants access to another user's mailbox or files.
export const permissionCatalog = {
  "console.access": { label: "Access Console", description: "Open system settings. Management actions require their own permissions.", group: "services", requires: [] },
  "mail.access": { label: "Access Mail", description: "Use Mail with owned or explicitly shared mailboxes. Does not grant mail administration.", group: "services", requires: [] },
  "calendar.access": { label: "Access Calendar", description: "Open the Calendar workspace.", group: "services", requires: [] },
  "drive.access": { label: "Access Drive", description: "Use owned and explicitly shared files and folders. Does not grant access to other users' files.", group: "services", requires: [] },
  "admin.users.read": { label: "View administrative user records", description: "Inspect account details, status and sign-in activity in Console.", group: "users", requires: ["console.access"] },
  "admin.users.create": { label: "Create user accounts", description: "Create accounts with approved roles and a personal mailbox when Mail is enabled. Changing those roles requires assignment permissions.", group: "users", requires: userRead },
  "admin.users.profile.update": { label: "Edit user profiles", description: "Change user display names and profile photos.", group: "users", requires: userRead },
  "admin.users.email.update": { label: "Change login email addresses", description: "Change a user's sign-in address.", group: "security", requires: userRead, impact: "Ends the user's sessions" },
  "admin.users.status.update": { label: "Enable or disable accounts", description: "Change account availability. You cannot disable your own account.", group: "security", requires: userRead, impact: "Ends the user's sessions" },
  "admin.users.credentials.reset": { label: "Reset user passwords", description: "Set temporary passwords and change the password-change requirement.", group: "security", requires: userRead, impact: "Ends the user's sessions" },
  "admin.users.delete": { label: "Delete user accounts", description: "Remove accounts and revoke their credentials.", group: "security", requires: userRead, impact: "Removes workspace access" },
  "admin.roles.read": { label: "View roles and permissions", description: "View role definitions, membership counts and the permission catalog.", group: "roles", requires: ["console.access"] },
  "admin.roles.create": { label: "Create roles", description: "Create roles using permissions you hold.", group: "roles", requires: roleRead },
  "admin.roles.update": { label: "Edit roles", description: "Edit custom roles whose permissions you hold.", group: "roles", requires: roleRead, impact: "Changes every assigned user's access immediately" },
  "admin.roles.delete": { label: "Delete roles", description: "Delete custom roles whose permissions you hold.", group: "roles", requires: roleRead, impact: "Removes the role from all assigned users" },
  "admin.roles.defaults.manage": { label: "Manage default roles", description: "Choose service-only roles selected for new users. Existing assignments do not change.", group: "roles", requires: roleRead },
  "admin.users.roles.read": { label: "View assigned roles", description: "Inspect a user's role assignments and the access they provide.", group: "assignments", requires: ["admin.users.read", "admin.roles.read"] },
  "admin.users.roles.assign": { label: "Assign roles", description: "Add roles whose permissions you hold to a user.", group: "assignments", requires: assignmentRead, impact: "Grants access immediately" },
  "admin.users.roles.remove": { label: "Remove assigned roles", description: "Remove roles whose permissions you hold from a user.", group: "assignments", requires: assignmentRead, impact: "Revokes access immediately" },
  "admin.mail.providers.read": { label: "View mail providers", description: "Inspect workspace mail provider connections.", group: "mail", requires: ["console.access"] },
  "admin.mail.providers.manage": { label: "Manage mail providers", description: "Create and edit mail provider connections. Does not grant mailbox content access.", group: "mail", requires: ["admin.mail.providers.read"] },
  "admin.mail.domains.read": { label: "View mail domains", description: "Inspect mail domains and inbound routing configuration.", group: "mail", requires: ["console.access"] },
  "admin.mail.domains.manage": { label: "Manage mail domains", description: "Configure domains, addresses and inbound routing.", group: "mail", requires: ["admin.mail.domains.read"] },
  "admin.mail.mailboxes.read": { label: "View mailbox configuration", description: "List workspace mailbox configuration without access to message contents.", group: "mail", requires: ["console.access"] },
  "admin.mail.mailboxes.manage": { label: "Manage mailbox configuration", description: "Provision mailboxes and change their status. Does not grant mailbox content access.", group: "mail", requires: ["admin.mail.mailboxes.read"] },
} as const satisfies Record<string, PermissionDefinition>;
export type Permission = keyof typeof permissionCatalog;
export const ADMINISTRATOR_ROLE_ID = "system-administrator";
export const MAIL_USER_ROLE_ID = "system-mail-user";
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(permissionCatalog, value);
}
export function permissionClosure(values: readonly string[]): Permission[] {
  const result = new Set<Permission>();
  const visit = (key: string) => {
    if (!isPermission(key) || result.has(key)) return;
    result.add(key);
    for (const parent of permissionCatalog[key].requires) visit(parent);
  };
  values.forEach(visit);
  return [...result];
}
export function missingPrerequisites(values: readonly string[]): Permission[] {
  return permissionClosure(values).filter((key) => !values.includes(key));
}
export function effectivePermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission).filter((key) => permissionClosure([key]).every((required) => values.includes(required)));
}
export function togglePermission(values: readonly string[], key: string, checked: boolean): Permission[] {
  if (checked) return permissionClosure([...values, key]);
  return values.filter(isPermission).filter((value) => !permissionClosure([value]).includes(key as Permission));
}
export function defaultEligible(values: readonly string[]): boolean {
  return values.every((key) => ["mail.access", "calendar.access", "drive.access"].includes(key));
}
export interface ResourceRef { type: string; id: string }

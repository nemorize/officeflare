export const permissionGroups = {
  services: "Service access", users: "User administration", security: "Account security",
  roles: "Role administration", assignments: "Role assignments", mail: "Mail administration",
  drive: "Drive usage", driveAdmin: "Drive administration",
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
  "drive.files.create": { label: "Create Drive files and folders", description: "Upload files, create folders and copy accessible items. Folder sharing and storage limits still apply.", group: "drive", requires: ["drive.access"] },
  "drive.files.update": { label: "Edit Drive files", description: "Replace content, rename, move, restore and manage file versions where you have editing access.", group: "drive", requires: ["drive.access"] },
  "drive.files.delete": { label: "Delete owned Drive items", description: "Trash owned items and permanently delete items already in trash.", group: "drive", requires: ["drive.access"] },
  "drive.files.download": { label: "Download Drive files", description: "Download and copy files you own or can access. Preview access remains subject to item permissions.", group: "drive", requires: ["drive.access"] },
  "drive.comments.create": { label: "Comment in Drive", description: "Add and manage comments where the item sharing role allows it.", group: "drive", requires: ["drive.access"] },
  "drive.sharing.internal": { label: "Share Drive items internally", description: "Share owned items with workspace accounts and transfer ownership. Workspace sharing policies still apply.", group: "drive", requires: ["drive.access"] },
  "drive.sharing.public": { label: "Create public Drive links", description: "Create and update public links for owned items, subject to workspace link policies.", group: "drive", requires: ["drive.access"], impact: "Allows external access to shared files" },
  "admin.drive.settings.read": { label: "View Drive settings", description: "Inspect workspace storage, sharing and retention policies.", group: "driveAdmin", requires: ["console.access"] },
  "admin.drive.settings.manage": { label: "Manage Drive settings", description: "Change workspace Drive policies and default storage limits.", group: "driveAdmin", requires: ["admin.drive.settings.read"], impact: "Changes apply to existing links and accounts using defaults" },
  "admin.drive.accounts.read": { label: "View Drive accounts", description: "Inspect user storage usage, limits and Drive availability, including former users.", group: "driveAdmin", requires: ["console.access"] },
  "admin.drive.accounts.manage": { label: "Manage Drive accounts", description: "Set storage overrides and suspend or restrict Drive writes without changing workspace roles.", group: "driveAdmin", requires: ["admin.drive.accounts.read"] },
  "admin.drive.items.read": { label: "View Drive inventory", description: "Inspect file and folder metadata and trash. Does not allow reading file contents.", group: "driveAdmin", requires: ["console.access"] },
  "admin.drive.sharing.read": { label: "View Drive sharing", description: "Inspect internal grants and public link metadata across the workspace.", group: "driveAdmin", requires: ["console.access"] },
  "admin.drive.sharing.manage": { label: "Manage Drive sharing", description: "Change or revoke internal grants and revoke public links. File contents remain protected.", group: "driveAdmin", requires: ["admin.drive.sharing.read", "admin.drive.accounts.read"], impact: "Changes recipients' access" },
  "admin.drive.audit.read": { label: "View Drive audit logs", description: "Search file activity and immutable administrator records across the workspace.", group: "driveAdmin", requires: ["console.access"] },
  "admin.drive.ownership.transfer": { label: "Transfer Drive ownership", description: "Hand over files or an account's inventory, including disabled and deleted owners. Requires sufficient destination storage.", group: "driveAdmin", requires: ["admin.drive.accounts.read", "admin.drive.items.read"], impact: "Grants the recipient ownership and revokes public links" },
  "admin.drive.trash.restore": { label: "Restore Drive trash", description: "Restore trashed items without opening file contents.", group: "driveAdmin", requires: ["admin.drive.items.read"] },
  "admin.drive.trash.purge": { label: "Permanently delete Drive trash", description: "Permanently delete items already in trash and queue their stored versions for removal.", group: "driveAdmin", requires: ["admin.drive.items.read"], impact: "Permanently removes files and their versions" },
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
export const driveUserPermissions = ["drive.access", "drive.files.create", "drive.files.update", "drive.files.delete", "drive.files.download", "drive.comments.create", "drive.sharing.internal", "drive.sharing.public"] as const;
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
  return values.every((key) => ["mail.access", "calendar.access", ...driveUserPermissions].includes(key as typeof driveUserPermissions[number]));
}
export interface ResourceRef { type: string; id: string }

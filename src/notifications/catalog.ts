export const notificationTypes = {
  "security.sign_in": { service: "account", category: "security", label: "New sign-ins", required: true },
  "system.announcement": { service: "system", category: "updates", label: "Workspace announcements", required: false },
} as const;
export type NotificationType = keyof typeof notificationTypes;
export const knownType = (value: string): value is NotificationType => Object.hasOwn(notificationTypes, value);

// Only registered, server-owned paths may appear in notifications. Add resource-aware
// authorization here when a service such as Drive starts producing notifications.
export function targetPath(type: NotificationType, path?: string | null) {
  if (!path) return null;
  if (type === "security.sign_in" && path === "/profile/sessions") return path;
  if (type === "system.announcement" && path === "/notifications") return path;
  throw new Error("Unsupported notification target");
}

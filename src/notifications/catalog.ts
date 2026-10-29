export const notificationTypes = {
  "security.sign_in": {
    service: "account",
    category: "security",
    label: "New sign-ins",
    required: true,
  },
  "system.announcement": {
    service: "system",
    category: "updates",
    label: "Workspace announcements",
    required: false,
  },
  "drive.shared": {
    service: "drive",
    category: "sharing",
    label: "Drive sharing changes",
    required: false,
  },
  "drive.updated": {
    service: "drive",
    category: "activity",
    label: "Drive file updates",
    required: false,
  },
  "drive.comment": {
    service: "drive",
    category: "comments",
    label: "Drive comments",
    required: false,
  },
  "drive.access_requested": {
    service: "drive",
    category: "sharing",
    label: "Drive access requests",
    required: false,
  },
  "calendar.invited": {
    service: "calendar",
    category: "invitations",
    label: "Calendar invitations",
    required: true,
  },
  "calendar.updated": {
    service: "calendar",
    category: "invitations",
    label: "Calendar event updates",
    required: true,
  },
  "calendar.cancelled": {
    service: "calendar",
    category: "invitations",
    label: "Calendar cancellations",
    required: true,
  },
  "calendar.response": {
    service: "calendar",
    category: "responses",
    label: "Calendar responses",
    required: false,
  },
} as const;
export type NotificationType = keyof typeof notificationTypes;
export const knownType = (value: string): value is NotificationType =>
  Object.hasOwn(notificationTypes, value);

// Only registered, server-owned paths may appear in notifications. Add resource-aware
// authorization here when a service such as Drive starts producing notifications.
export function targetPath(type: NotificationType, path?: string | null) {
  if (!path) return null;
  if (type === "security.sign_in" && path === "/profile/sessions") return path;
  if (type === "system.announcement" && path === "/notifications") return path;
  if (type.startsWith("calendar.") && /^\/calendar\/invitations\/[A-Za-z0-9_-]+$/.test(path))
    return path;
  throw new Error("Unsupported notification target");
}

import { t } from "../../shared/i18n/index.ts";
export const notificationTypes = {
  "wiki.shared": {
    service: "wiki",
    category: "sharing",
    get label() {
      return t("wiki.sharedNotice");
    },
    required: false,
  },
  "wiki.comment": {
    service: "wiki",
    category: "comments",
    get label() {
      return t("wiki.commentNotice");
    },
    required: false,
  },
  "mail.received": {
    service: "mail",
    category: "messages",
    get label() {
      return t("push.newMail");
    },
    required: false,
  },
  "security.sign_in": {
    service: "account",
    category: "security",
    get label() {
      return t("notificationTypes.newSignIns");
    },
    required: true,
  },
  "system.announcement": {
    service: "system",
    category: "updates",
    get label() {
      return t("notificationTypes.workspaceAnnouncements");
    },
    required: false,
  },
  "drive.shared": {
    service: "drive",
    category: "sharing",
    get label() {
      return t("notificationTypes.driveSharingChanges");
    },
    required: false,
  },
  "drive.updated": {
    service: "drive",
    category: "activity",
    get label() {
      return t("notificationTypes.driveFileUpdates");
    },
    required: false,
  },
  "drive.comment": {
    service: "drive",
    category: "comments",
    get label() {
      return t("notificationTypes.driveComments");
    },
    required: false,
  },
  "drive.access_requested": {
    service: "drive",
    category: "sharing",
    get label() {
      return t("notificationTypes.driveAccessRequests");
    },
    required: false,
  },
  "calendar.invited": {
    service: "calendar",
    category: "invitations",
    get label() {
      return t("notificationTypes.calendarInvitations");
    },
    required: true,
  },
  "calendar.updated": {
    service: "calendar",
    category: "invitations",
    get label() {
      return t("notificationTypes.calendarEventUpdates");
    },
    required: true,
  },
  "calendar.cancelled": {
    service: "calendar",
    category: "invitations",
    get label() {
      return t("notificationTypes.calendarCancellations");
    },
    required: true,
  },
  "calendar.response": {
    service: "calendar",
    category: "responses",
    get label() {
      return t("notificationTypes.calendarResponses");
    },
    required: false,
  },
} as const;
export type NotificationType = keyof typeof notificationTypes;
export const knownType = (value: string): value is NotificationType =>
  Object.hasOwn(notificationTypes, value);

// Only registered, server-owned paths may appear in notifications. Service producers
// check recipient access atomically with the event, and destinations enforce current access.
export function targetPath(type: NotificationType, path?: string | null) {
  if (!path) return null;
  if (
    type.startsWith("wiki.") &&
    /^\/wiki\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+(?:\?panel=comments)?)?$/.test(path)
  )
    return path;
  if (type === "mail.received" && path === "/mail") return path;
  if (type === "security.sign_in" && path === "/profile/sessions") return path;
  if (type === "system.announcement" && path === "/notifications") return path;
  if (type.startsWith("calendar.") && /^\/calendar\/invitations\/[A-Za-z0-9_-]+$/.test(path))
    return path;
  throw new Error(t("notificationTypes.unsupportedNotificationTarget"));
}

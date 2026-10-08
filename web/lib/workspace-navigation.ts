import type { IconProps } from "../components/ui/icon";

export interface WorkspaceNavigationItem {
  path: string;
  name: string;
  icon: IconProps["name"];
}

export interface WorkspaceApp extends WorkspaceNavigationItem {
  permission: "mail.access" | "calendar.access" | "drive.access";
  menuTitle: string;
  menu: WorkspaceNavigationItem[];
}

export const workspaceApps: [WorkspaceApp, ...WorkspaceApp[]] = [
  {
    path: "/mail", name: "Mail", icon: "mail", menuTitle: "Mailbox", permission: "mail.access",
    menu: [
      { path: "/mail", name: "Inbox", icon: "inbox" },
      { path: "/mail/drafts", name: "Drafts", icon: "file" },
      { path: "/mail/sent", name: "Sent", icon: "arrow" },
      { path: "/mail/archive", name: "Archive", icon: "archive" },
      { path: "/mail/trash", name: "Trash", icon: "trash" },
      { path: "/mail/spam", name: "Spam", icon: "shield" },
      { path: "/mail/starred", name: "Starred", icon: "star" },
      { path: "/mail/snoozed", name: "Snoozed", icon: "circle" },
      { path: "/mail/contacts", name: "Contacts", icon: "users" },
      { path: "/mail/templates", name: "Templates", icon: "file" },
      { path: "/mail/rules", name: "Rules & blocked senders", icon: "controls" },
      { path: "/mail/settings", name: "Mailbox settings", icon: "settings" },
      { path: "/mail/integrations", name: "Integrations", icon: "code" },
      { path: "/mail/data", name: "Import & backup", icon: "drive" },
      { path: "/mail/activity", name: "Activity & storage", icon: "layers" },
    ],
  },
  {
    path: "/calendar", name: "Calendar", icon: "calendar", menuTitle: "Calendars", permission: "calendar.access",
    menu: [
      { path: "/calendar", name: "My calendar", icon: "calendar" },
      { path: "/calendar/shared", name: "Shared calendars", icon: "users" },
    ],
  },
  {
    path: "/drive", name: "Drive", icon: "drive", menuTitle: "Files", permission: "drive.access",
    menu: [
      { path: "/drive", name: "My drive", icon: "folder" },
      { path: "/drive/shared", name: "Shared with me", icon: "users" },
      { path: "/drive/starred", name: "Starred", icon: "star" },
      { path: "/drive/trash", name: "Trash", icon: "trash" },
    ],
  },
];

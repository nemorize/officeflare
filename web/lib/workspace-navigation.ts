import { t } from "../../shared/i18n/index.ts";
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
    path: "/mail",
    name: t("libWorkspaceNavigation.mail"),
    icon: "mail",
    menuTitle: t("libWorkspaceNavigation.mailbox"),
    permission: "mail.access",
    menu: [
      { path: "/mail", name: t("libWorkspaceNavigation.inbox"), icon: "inbox" },
      { path: "/mail/drafts", name: t("libWorkspaceNavigation.drafts"), icon: "file" },
      { path: "/mail/sent", name: t("libWorkspaceNavigation.sent"), icon: "arrow" },
      { path: "/mail/all", name: t("libWorkspaceNavigation.allMail"), icon: "mail" },
      { path: "/mail/scheduled", name: t("libWorkspaceNavigation.outbox"), icon: "clock" },
      { path: "/mail/archive", name: t("libWorkspaceNavigation.archive"), icon: "archive" },
      { path: "/mail/trash", name: t("libWorkspaceNavigation.trash"), icon: "trash" },
      { path: "/mail/spam", name: t("libWorkspaceNavigation.spam"), icon: "shield" },
      { path: "/mail/starred", name: t("libWorkspaceNavigation.starred"), icon: "star" },
      { path: "/mail/snoozed", name: t("libWorkspaceNavigation.snoozed"), icon: "circle" },
      {
        path: "/mail/rules",
        name: t("libWorkspaceNavigation.rulesBlockedSenders"),
        icon: "controls",
      },
      {
        path: "/mail/settings",
        name: t("libWorkspaceNavigation.mailboxSettings"),
        icon: "settings",
      },
      { path: "/mail/integrations", name: t("libWorkspaceNavigation.integrations"), icon: "code" },
      { path: "/mail/data", name: t("libWorkspaceNavigation.importBackup"), icon: "drive" },
      { path: "/mail/activity", name: t("libWorkspaceNavigation.activityStorage"), icon: "layers" },
    ],
  },
  {
    path: "/calendar",
    name: t("libWorkspaceNavigation.calendar"),
    icon: "calendar",
    menuTitle: t("libWorkspaceNavigation.calendars"),
    permission: "calendar.access",
    menu: [
      { path: "/calendar", name: t("libWorkspaceNavigation.myCalendar"), icon: "calendar" },
      {
        path: "/calendar/shared",
        name: t("libWorkspaceNavigation.sharedCalendars"),
        icon: "users",
      },
    ],
  },
  {
    path: "/drive",
    name: t("libWorkspaceNavigation.drive"),
    icon: "drive",
    menuTitle: t("libWorkspaceNavigation.files"),
    permission: "drive.access",
    menu: [
      { path: "/drive", name: t("libWorkspaceNavigation.myDrive"), icon: "folder" },
      { path: "/drive/shared", name: t("libWorkspaceNavigation.sharedWithMe"), icon: "users" },
      { path: "/drive/recent", name: t("libWorkspaceNavigation.recent"), icon: "clock" },
      { path: "/drive/starred", name: t("libWorkspaceNavigation.starred"), icon: "star" },
      { path: "/drive/trash", name: t("libWorkspaceNavigation.trash"), icon: "trash" },
    ],
  },
];

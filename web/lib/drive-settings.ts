import { t } from "../../shared/i18n/index.ts";
export const driveSettingsPages = [
  { path: "/drive/settings", name: t("libDriveSettings.general"), icon: "settings" },
  { path: "/drive/integrations", name: t("libDriveSettings.integrations"), icon: "code" },
  { path: "/drive/data", name: t("libDriveSettings.importBackup"), icon: "archive" },
  { path: "/drive/activity", name: t("libDriveSettings.activityStorage"), icon: "layers" },
] as const;

export function readDriveLayout(): "list" | "grid" {
  try {
    return localStorage.getItem("officeflare.drive.layout") === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function saveDriveLayout(layout: "list" | "grid") {
  localStorage.setItem("officeflare.drive.layout", layout);
}

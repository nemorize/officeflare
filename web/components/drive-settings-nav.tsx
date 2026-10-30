import { t } from "../../shared/i18n/index.ts";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { SettingsLayout, SettingsSection } from "./settings-layout";
import { driveSettingsPages } from "../lib/drive-settings";

export function DriveSettingsLayout({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { pathname } = useLocation(),
    navigate = useNavigate();
  const selected =
    driveSettingsPages.find((page) => page.path === pathname)?.path ?? "/drive/settings";
  return (
    <div className="drive-settings-scroll">
      <div className="account-page settings-page">
        <SettingsLayout
          title={title}
          description={description}
          actions={actions}
          pages={driveSettingsPages}
          selected={selected}
          onNavigate={navigate}
          navigationLabel={t("componentsDriveSettingsNav.driveSettingsSections")}
        >
          {children}
        </SettingsLayout>
      </div>
    </div>
  );
}

export const DriveSettingsSection = SettingsSection;

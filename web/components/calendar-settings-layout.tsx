import { t } from "../../shared/i18n/index.ts";
import { useLocation, useNavigate } from "react-router";
import type { ReactNode } from "react";
import { SettingsLayout } from "./settings-layout";
import { calendarSettingsPages } from "../lib/calendar-settings";

export function CalendarSettingsLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation(),
    navigate = useNavigate();
  const selected =
    calendarSettingsPages.find(
      (page) =>
        pathname === page.path ||
        (page.path !== "/calendar/settings" && pathname.startsWith(`${page.path}/`)),
    )?.path ?? "/calendar/settings";
  return (
    <div className="calendar-settings-scroll">
      <div className="account-page settings-page">
        <SettingsLayout
          title={t("componentsCalendarSettingsLayout.calendarSettings")}
          description={t(
            "componentsCalendarSettingsLayout.manageYourCalendarPreferencesSharingWorkingHoursAndConnected",
          )}
          pages={calendarSettingsPages}
          selected={selected}
          onNavigate={navigate}
          navigationLabel={t("componentsCalendarSettingsLayout.calendarSettingsSections")}
        >
          {children}
        </SettingsLayout>
      </div>
    </div>
  );
}

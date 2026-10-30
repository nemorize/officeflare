import { t } from "../../shared/i18n/index.ts";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMail } from "./mail-context";
import { SettingsLayout } from "./settings-layout";

const pages = [
  { path: "/mail/settings", name: t("componentsMailSettingsNav.general") },
  { path: "/mail/rules", name: t("componentsMailSettingsNav.rulesBlocking") },
  { path: "/mail/integrations", name: t("componentsMailSettingsNav.integrations") },
  { path: "/mail/data", name: t("componentsMailSettingsNav.importBackup") },
  { path: "/mail/activity", name: t("componentsMailSettingsNav.activityStorage") },
] as const;

export function MailSettingsLayout({
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
  const mail = useMail(),
    { pathname } = useLocation(),
    navigate = useNavigate(),
    selected = pages.find((page) => page.path === pathname)?.path ?? "/mail/settings";
  return (
    <SettingsLayout
      title={title}
      description={description}
      actions={actions}
      pages={pages}
      selected={selected}
      onNavigate={(route) => navigate(mail.href(route))}
      navigationLabel={t("componentsMailSettingsNav.mailSettingsSections")}
      navigationClassName="mail-settings-nav"
    >
      {children}
    </SettingsLayout>
  );
}

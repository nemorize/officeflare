import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMail } from "./mail-context";
import { ConsolePageHeader } from "./console-shared";
import { Tabs } from "./ui";

const pages = [
  ["/mail/settings", "General"],
  ["/mail/rules", "Rules & blocking"],
  ["/mail/integrations", "Integrations"],
  ["/mail/data", "Import & backup"],
  ["/mail/activity", "Activity & storage"],
] as const;

export function MailSettingsLayout({ title, description, actions, children }: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const mail = useMail(),
    { pathname } = useLocation(),
    navigate = useNavigate(),
    nav = useRef<HTMLDivElement>(null),
    selected = pages.find(([route]) => route === pathname)?.[0] ?? "/mail/settings";
  useEffect(() => {
    nav.current?.querySelector('[data-active]')?.scrollIntoView({
      block: "nearest", inline: "nearest",
    });
  }, [selected]);
  return (
    <>
      <ConsolePageHeader title={title} description={description}>{actions}</ConsolePageHeader>
      <Tabs.Root value={selected} onValueChange={(route) => navigate(mail.href(route))}>
        <div ref={nav} className="mail-settings-nav">
          <Tabs.List aria-label="Mail settings sections">
            {pages.map(([route, label]) => (
              <Tabs.Tab key={route} value={route}>{label}</Tabs.Tab>
            ))}
          </Tabs.List>
        </div>
        <Tabs.Panel value={selected}>{children}</Tabs.Panel>
      </Tabs.Root>
    </>
  );
}

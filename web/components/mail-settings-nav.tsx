import { NavLink, useLocation } from "react-router";
import { useMail } from "./mail-context";
import { Button } from "./ui";
export function MailSettingsNav() {
  const mail = useMail(),
    { pathname } = useLocation();
  return (
    <nav className="mail-settings-nav" aria-label="Mail settings sections">
      {[
        ["/mail/settings", "General"],
        ["/mail/rules", "Rules & blocking"],
        ["/mail/integrations", "Integrations"],
        ["/mail/data", "Import & backup"],
        ["/mail/activity", "Activity & storage"],
      ].map(([route, label]) => (
        <Button
          key={route}
          variant={pathname === route ? "subtle" : "ghost"}
          nativeButton={false}
          render={<NavLink to={mail.href(route!)} end />}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
}

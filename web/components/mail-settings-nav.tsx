import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { useMail } from "./mail-context";
export function MailSettingsNav() {
  const mail = useMail(), { pathname } = useLocation(), nav = useRef<HTMLElement>(null);
  useEffect(() => { nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [pathname]);
  return <nav ref={nav} className="mail-settings-nav" aria-label="Mail settings sections">{[
    ["/mail/settings", "General"], ["/mail/rules", "Rules & blocking"], ["/mail/integrations", "Integrations"], ["/mail/data", "Import & backup"], ["/mail/activity", "Activity & storage"],
  ].map(([route, label]) => <NavLink key={route} to={mail.href(route!)} end>{label}</NavLink>)}</nav>;
}

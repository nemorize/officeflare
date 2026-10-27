import { useEffect, useRef, type ReactNode } from "react";
import { ConsolePageHeader } from "./console-shared";
import { Tabs } from "./ui";
import "./settings-layout.css";

interface SettingsLayoutProps {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  pages: readonly { path: string; name: string }[];
  selected: string;
  onNavigate: (path: string) => void;
  navigationLabel: string;
  navigationClassName?: string;
  children: ReactNode;
}

export function SettingsLayout({ title, description, actions, pages, selected, onNavigate, navigationLabel, navigationClassName = "", children }: SettingsLayoutProps) {
  const nav = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reveal = () => nav.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    if (nav.current) observer.observe(nav.current);
    return () => observer.disconnect();
  }, [selected]);
  return <>
    <ConsolePageHeader title={title} description={description}>{actions}</ConsolePageHeader>
    <Tabs.Root value={selected} onValueChange={onNavigate}>
      <div ref={nav} className={`settings-nav ${navigationClassName}`}><Tabs.List aria-label={navigationLabel}>
        {pages.map(page => <Tabs.Tab key={page.path} value={page.path}>{page.name}</Tabs.Tab>)}
      </Tabs.List></div>
      <Tabs.Panel value={selected}>{children}</Tabs.Panel>
    </Tabs.Root>
  </>;
}

export function SettingsSection({ title, description, action, className = "", children }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return <section className={`settings-section ${className}`}><header><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>{children}</section>;
}

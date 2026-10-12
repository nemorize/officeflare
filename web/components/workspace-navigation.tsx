import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { Button, Drawer, DrawerPopup, Icon, OfficeflareMark } from "./ui";
import { useAccess } from "./console-access";
import { workspaceApps } from "../lib/workspace-navigation";

export function WorkspaceMenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button className="workspace-mobile-menu" variant="ghost" size="icon" aria-label={label} aria-haspopup="dialog" onClick={onClick}><Icon name="menu" /></Button>;
}
export function WorkspaceNavigationDrawer({ open, onOpenChange, title, account, actions, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; account: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  const { permissions } = useAccess();
  return <Drawer.Provider><Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="left">
    <DrawerPopup side="left" padding="none" className="workspace-navigation-drawer">
      <div className="workspace-drawer-heading"><Drawer.Title>{title}</Drawer.Title><div className="workspace-drawer-heading-actions">{actions}<Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => onOpenChange(false)}><Icon name="close" /></Button></div></div>
      <Drawer.Description className="visually-hidden">Choose an application or a page.</Drawer.Description>
      <div className="workspace-drawer-apps">
        <nav aria-label="Applications">
          <NavLink to="/" aria-label="Officeflare home" end onClick={() => onOpenChange(false)}><OfficeflareMark /></NavLink>
          {workspaceApps.filter(app => permissions.includes(app.permission)).map(app => <NavLink key={app.path} to={app.path} aria-label={app.name} title={app.name} onClick={() => onOpenChange(false)}><Icon name={app.icon} /></NavLink>)}
          {permissions.includes("console.access") && <NavLink to="/console" aria-label="Console" title="Console" onClick={() => onOpenChange(false)}><Icon name="console" /></NavLink>}
        </nav>{account}
      </div>
      <div className="workspace-drawer-body">{children}</div>
    </DrawerPopup>
  </Drawer.Root></Drawer.Provider>;
}

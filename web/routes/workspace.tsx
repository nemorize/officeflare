import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Button, Icon, Menu, MenuPopup, OfficeflareMark, useNotifications } from "@/components/ui";
import { AccountProvider, useAccount } from "../components/account-context";
import { AccountAvatar } from "../components/account-avatar";
import { AccessProvider, WorkspaceHome, useAccess } from "../components/console-access";
import { MailProvider, MailSidebar, useMail } from "../components/mail-context";
import { MailSettingsButton, MailTopbar } from "../components/mail-chrome";
import { MailResourceProvider } from "../components/mail-resource-context";
import { LoadingSkeleton } from "../components/loading-skeleton";
import { WorkspaceLoading } from "../components/workspace-loading";
import { DriveProvider } from "../components/drive-context";
import { DriveSidebar, DriveTopbar } from "../components/drive-chrome";
import { WorkspaceMenuButton, WorkspaceNavigationDrawer } from "../components/workspace-navigation";
import { NotificationBell } from "../components/notification-center";
import { NotificationCenterProvider } from "../components/notification-center-context";
import { consoleMenu } from "../lib/console";
import { errorMessage } from "../lib/api";
import { sessions, useSession } from "../lib/session";
import { workspaceApps, type WorkspaceNavigationItem } from "../lib/workspace-navigation";
import "./workspace.css";

const account: WorkspaceNavigationItem[] = [
  { path: "/profile", name: "Profile", icon: "user" },
  { path: "/profile/security", name: "Security", icon: "shield" },
  { path: "/profile/sessions", name: "Sessions", icon: "laptop" },
  { path: "/profile/notifications", name: "Notifications", icon: "bell" },
];
const notificationMenu: WorkspaceNavigationItem[] = [
  { path: "/notifications", name: "All notifications", icon: "bell" },
  { path: "/profile/notifications", name: "Notification settings", icon: "settings" },
];

function ProfileMenu({ busy, signOut }: { busy: boolean; signOut: () => void }) {
  const { user } = useAccount();
  const auth = useSession();
  const navigate = useNavigate();
  const email = user?.email_address ?? auth.session?.email ?? "";
  return <Menu.Root>
    <Menu.Trigger render={<Button variant="ghost" size="icon" shape="circle" className="workspace-rail-account" />}
      aria-label="Open profile menu" disabled={busy}>
      <AccountAvatar />
    </Menu.Trigger>
    <MenuPopup className="workspace-profile-menu" positionerProps={{ side: "right", align: "end", sideOffset: 8 }}>
      <div className="workspace-menu-identity"><strong>{user?.display_name || "Your account"}</strong><span>{email}</span></div>
      <Menu.Separator />
      {account.map((item) => <Menu.Item key={item.path} onClick={() => navigate(item.path)}><Icon name={item.icon} />{item.name}</Menu.Item>)}
      <Menu.Separator />
      <Menu.Item onClick={signOut} disabled={busy} data-variant="danger"><Icon name="logout" />{busy ? "Signing out…" : "Sign out"}</Menu.Item>
    </MenuPopup>
  </Menu.Root>;
}

function WorkspaceChrome() {
  const notify = useNotifications(), mail = useMail();
  const { pathname: locationPath } = useLocation();
  const pathname = locationPath.replace(/\/+$/, "") || "/";
  const auth = useSession();
  const [busy, setBusy] = useState(false), [mobileMenu, setMobileMenu] = useState(false), [driveSidebarCollapsed, setDriveSidebarCollapsed] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const isAccount = pathname === "/profile" || pathname.startsWith("/profile/");
  const isConsole = pathname === "/console" || pathname.startsWith("/console/");
  const isMail = pathname === "/mail" || pathname.startsWith("/mail/");
  const isDrive = pathname === "/drive" || pathname.startsWith("/drive/");
  const isNotifications = pathname === "/notifications";
  const access = useAccess(), systemMenu = consoleMenu(access.permissions);
  const visibleApps = workspaceApps.filter((app) => access.permissions.includes(app.permission));
  const activeApp = workspaceApps.find((app) => pathname === app.path || pathname.startsWith(`${app.path}/`));
  const sidebarName = isNotifications ? "Notifications" : isConsole ? "System settings" : isAccount ? "Account" : (activeApp?.name ?? "Account");
  const sidebarMenu = isNotifications ? notificationMenu : isConsole ? systemMenu : isAccount ? account : (activeApp?.menu ?? account);
  const current = sidebarMenu.find((item) => item.path === pathname || isConsole && pathname.startsWith(`${item.path}/`));
  const title = current?.name ?? (isDrive ? "Folder" : isMail ? pathname.includes("/folders/") ? "Folder" : "Mail" : "Page not found");
  useEffect(() => { document.title = `${title} · Officeflare`; }, [title]);
  useEffect(() => { content.current?.scrollTo(0, 0); setMobileMenu(false); }, [pathname]);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try { await sessions.signOut(); notify.success("You have been signed out."); }
    catch (failure) { notify.error(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div data-ui-theme="neutral" className={`workspace-shell${isDrive ? " workspace-drive" : ""}${isDrive && driveSidebarCollapsed ? " drive-sidebar-collapsed" : ""}${isMail ? " workspace-mail" : ""}${isMail && mail.preferences.sidebar_collapsed ? " mail-sidebar-collapsed" : ""}`}>
    <a href="#workspace-main" className="workspace-skip-link">Skip to content</a>
    <aside className="workspace-rail" aria-label="Applications">
      <Link to="/" className="workspace-mark" aria-label="Officeflare home"><OfficeflareMark /></Link>
      {visibleApps.map((item) => <NavLink key={item.path} to={item.path} title={item.name} aria-label={item.name}
        className="workspace-rail-link"><Icon name={item.icon} width="18" height="18" /></NavLink>)}
      {access.permissions.includes("console.access") && <NavLink to="/console" title="Console" aria-label="Console" className="workspace-rail-link"><Icon name="console" width="18" height="18" /></NavLink>}
      <div className="workspace-rail-footer">
        <NotificationBell />
        <ProfileMenu busy={busy} signOut={() => { void signOut(); }} />
      </div>
    </aside>
    <div className="workspace-frame">
      <aside className="workspace-sidebar">
        <div className="workspace-sidebar-header"><span>{sidebarName}</span>{isMail && activeApp && <MailSettingsButton />}</div>
        {access.status === "loading" ? <LoadingSkeleton label="Loading navigation…" /> : isDrive && activeApp ? <DriveSidebar /> : isMail && activeApp ? <MailSidebar /> : <nav aria-label={`${sidebarName} navigation`} className="workspace-nav">
          <h2>{isConsole ? "Administration" : isAccount ? "Settings" : activeApp?.menuTitle ?? "Settings"}</h2>
          {sidebarMenu.map((item) => <NavLink key={item.path} to={item.path} end={!isConsole}><Icon name={item.icon} /><span>{item.name}</span></NavLink>)}
        </nav>}

      </aside>
      <div ref={content} className="workspace-content">
        {isDrive ? <DriveTopbar sidebarCollapsed={driveSidebarCollapsed} onToggleSidebar={() => setDriveSidebarCollapsed(value => !value)} mobileAccount={<div className="notification-mobile-actions"><NotificationBell /><ProfileMenu busy={busy} signOut={() => { void signOut(); }} /></div>}/> : isMail ? <MailTopbar mobileAccount={<div className="notification-mobile-actions"><NotificationBell /><ProfileMenu busy={busy} signOut={() => { void signOut(); }} /></div>}/> : <header className="workspace-topbar">
          <WorkspaceMenuButton label="Open navigation" onClick={() => setMobileMenu(true)} />
          <div className="workspace-breadcrumb"><span>{sidebarName}</span><Icon name="chevron" width="12" height="12" /><span>{title}</span></div>
        </header>}
        {!isDrive && !isMail && <WorkspaceNavigationDrawer open={mobileMenu} onOpenChange={setMobileMenu} title={sidebarName} account={<div className="notification-mobile-actions"><NotificationBell /><ProfileMenu busy={busy} signOut={() => { void signOut(); }} /></div>}><nav aria-label={sidebarName + " navigation"} className="workspace-nav">{sidebarMenu.map(item => <NavLink key={item.path} to={item.path} end={!isConsole} onClick={() => setMobileMenu(false)}><Icon name={item.icon} /><span>{item.name}</span></NavLink>)}</nav></WorkspaceNavigationDrawer>}
        {auth.error && <div className="workspace-notice" role="alert"><Icon name="info" /><span>{auth.error}</span></div>}
        <main id="workspace-main" className="workspace-main" tabIndex={-1}>
          <Suspense fallback={<LoadingSkeleton kind="page" label="Opening page…" />}><Outlet /></Suspense>
        </main>
      </div>
    </div>
  </div>;
}

export function WorkspaceLayout() {
  const auth = useSession();
  const location = useLocation();
  if (auth.status === "signed_out") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <AccessProvider><WorkspaceStartup /></AccessProvider>;
}

function WorkspaceStartup() {
  const auth = useSession(), access = useAccess(), location = useLocation(), sessionId = auth.session?.tokens.session_id;
  const [openedSession, setOpenedSession] = useState<string>();
  useEffect(() => {
    if (sessionId && access.status === "ready") setOpenedSession(sessionId);
  }, [sessionId, access.status]);
  // Background permission refreshes must not unmount an open composer or workspace.
  if (!auth.session || openedSession !== sessionId) return <WorkspaceLoading
    error={!auth.session ? auth.error : access.status === "error" ? access.error : ""}
    onRetry={!auth.session ? () => { void sessions.restore(); } : access.refresh}
  />;
  if (location.pathname === "/") return access.status === "ready"
    ? <><WorkspaceLoading /><WorkspaceHome /></>
    : <WorkspaceLoading error={access.error} onRetry={access.refresh} />;
  return <AccountProvider><NotificationCenterProvider key={sessionId}><MailResourceProvider><MailProvider key={sessionId}><DriveProvider key={sessionId}><WorkspaceChrome /></DriveProvider></MailProvider></MailResourceProvider></NotificationCenterProvider></AccountProvider>;
}

export function EmptyWorkspacePage({ title }: { title: string }) {
  return <section className="workspace-empty-page" aria-labelledby="workspace-page-title">
    <h1 id="workspace-page-title">{title}</h1>
  </section>;
}

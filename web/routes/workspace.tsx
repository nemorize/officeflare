import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Button, Icon, Menu, MenuPopup, OfficeflareMark } from "@/components/ui";
import { AccountProvider, useAccount } from "../components/account-context";
import { AccountAvatar } from "../components/account-avatar";
import { errorMessage } from "../lib/api";
import { sessions, useSession } from "../lib/session";
import { workspaceApps, type WorkspaceNavigationItem } from "../lib/workspace-navigation";
import "./workspace.css";

const account: WorkspaceNavigationItem[] = [
  { path: "/profile", name: "Profile", icon: "user" },
  { path: "/profile/security", name: "Security", icon: "shield" },
  { path: "/profile/sessions", name: "Sessions", icon: "laptop" },
];

function ProfileMenu({ busy, signOut }: { busy: boolean; signOut: () => void }) {
  const { user } = useAccount();
  const auth = useSession();
  const navigate = useNavigate();
  const email = user?.email_address ?? auth.session?.email ?? "";
  return <Menu.Root>
    <Menu.Trigger render={<Button variant="ghost" className="workspace-rail-account" />}
      aria-label="Open profile menu" disabled={busy}>
      <AccountAvatar />
    </Menu.Trigger>
    <MenuPopup className="workspace-profile-menu" positionerProps={{ side: "right", align: "end", sideOffset: 8 }}>
      <div className="workspace-menu-identity"><strong>{user?.display_name || "Your account"}</strong><span>{email}</span></div>
      <Menu.Separator />
      {account.map((item) => <Menu.Item key={item.path} onClick={() => navigate(item.path)}><Icon name={item.icon} />{item.name}</Menu.Item>)}
      <Menu.Separator />
      <Menu.Item onClick={signOut} disabled={busy} className="workspace-sign-out"><Icon name="logout" />{busy ? "Signing out…" : "Sign out"}</Menu.Item>
    </MenuPopup>
  </Menu.Root>;
}

function WorkspaceChrome() {
  const { pathname: locationPath } = useLocation();
  const pathname = locationPath.replace(/\/+$/, "") || "/";
  const auth = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isAccount = pathname === "/profile" || pathname.startsWith("/profile/");
  const activeApp = workspaceApps.find((app) => pathname === app.path || pathname.startsWith(`${app.path}/`));
  const sidebarName = isAccount ? "Account" : (activeApp?.name ?? "Mail");
  const sidebarMenu = isAccount ? account : (activeApp ?? workspaceApps[0]).menu;
  const current = sidebarMenu.find((item) => item.path === pathname);
  const title = current?.name ?? "Page not found";
  useEffect(() => { document.title = `${title} · Officeflare`; }, [title]);

  async function signOut() {
    if (busy) return;
    setBusy(true); setError("");
    try { await sessions.signOut(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="workspace-shell">
    <a href="#workspace-main" className="workspace-skip-link">Skip to content</a>
    <aside className="workspace-rail" aria-label="Applications">
      <Link to="/mail" className="workspace-mark" aria-label="Officeflare home"><OfficeflareMark /></Link>
      {workspaceApps.map((item) => <NavLink key={item.path} to={item.path} title={item.name} aria-label={item.name}
        className="workspace-rail-link"><Icon name={item.icon} width="18" height="18" /></NavLink>)}
      <ProfileMenu busy={busy} signOut={() => { void signOut(); }} />
    </aside>
    <div className="workspace-frame">
      <aside className="workspace-sidebar">
        <div className="workspace-sidebar-header"><span>{sidebarName}</span><span className="workspace-sidebar-caption">Officeflare workspace</span></div>
        <nav aria-label={`${sidebarName} navigation`} className="workspace-nav">
          <h2>{isAccount ? "Settings" : activeApp?.menuTitle ?? "Mailbox"}</h2>
          {sidebarMenu.map((item) => <NavLink key={item.path} to={item.path} end><Icon name={item.icon} /><span>{item.name}</span></NavLink>)}
        </nav>
        <div className="workspace-sidebar-footer"><Icon name={isAccount ? "shield" : activeApp?.icon ?? "mail"} /><span>{isAccount ? "Account settings" : `${sidebarName} workspace`}</span></div>
      </aside>
      <div className="workspace-content">
        <header className="workspace-topbar">
          <div className="workspace-breadcrumb"><span>{sidebarName}</span><Icon name="chevron" width="12" height="12" /><span>{title}</span></div>
        </header>
        {(error || auth.error) && <div className="workspace-notice" role="alert"><Icon name="info" /><span>{error || auth.error}</span></div>}
        <main id="workspace-main" className="workspace-main" tabIndex={-1}>
          <Suspense fallback={<p className="account-page" role="status">Loading…</p>}><Outlet /></Suspense>
        </main>
      </div>
    </div>
  </div>;
}

export function WorkspaceLayout() {
  const auth = useSession();
  const location = useLocation();
  if (auth.status === "signed_out") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!auth.session) return <main className="empty-page" aria-busy={auth.status === "loading"}>
    <OfficeflareMark /><h1>Checking your session</h1><p role="status">{auth.error || "Please wait…"}</p>
    {auth.status === "unavailable" && <Button onClick={() => { void sessions.restore(); }}>Try again</Button>}
  </main>;
  return <AccountProvider><WorkspaceChrome /></AccountProvider>;
}

export function EmptyWorkspacePage({ title }: { title: string }) {
  return <section className="workspace-empty-page" aria-labelledby="workspace-page-title">
    <h1 id="workspace-page-title">{title}</h1>
  </section>;
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { AISidebar, useAI } from "./ai-context";
import { useAccess } from "./console-access";
import { WorkspaceIconButton } from "./workspace-controls";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { Icon, Input, SearchField } from "./ui";

export function AITopbar({
  sidebarCollapsed,
  onToggleSidebar,
  mobileAccount,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  mobileAccount: ReactNode;
}) {
  const ai = useAI(),
    { permissions } = useAccess(),
    mobile = useWorkspaceMobile(),
    location = useLocation(),
    navigate = useNavigate();
  const [menu, setMenu] = useState(false),
    [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const matches = ai.rooms.filter((room) =>
    room.title.toLocaleLowerCase().includes(ai.query.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    setMenu(false);
    ai.setQuery("");
  }, [location.pathname]);
  const createButton = (
    <WorkspaceIconButton
      icon="plus"
      label={t("aiui.newChat")}
      nativeButton={false}
      render={<Link to="/ai" />}
      disabled={!permissions.includes("ai.runs.create")}
    />
  );
  return (
    <>
      <header className="workspace-topbar ai-topbar">
        <WorkspaceIconButton
          icon="menu"
          label={t("routesWorkspace.openNavigation")}
          aria-expanded={mobile ? menu : !sidebarCollapsed}
          aria-haspopup={mobile ? "dialog" : undefined}
          onClick={() => (mobile ? setMenu(true) : onToggleSidebar())}
        />
        {!mobile && sidebarCollapsed && createButton}
        <SearchField
          className="ai-search"
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (ai.query.trim() && matches[0]) {
              navigate(`/ai/rooms/${matches[0].id}`);
              ai.setQuery("");
              input.current?.blur();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              ai.setQuery("");
              input.current?.focus();
            }
          }}
        >
          <Icon name="search" />
          <Input
            ref={input}
            variant="integrated"
            aria-label={t("aiui.searchChats")}
            placeholder={t("aiui.searchChats")}
            value={ai.query}
            maxLength={255}
            onValueChange={ai.setQuery}
          />
          {ai.query && (
            <WorkspaceIconButton
              icon="close"
              label={t("aiui.clearSearch")}
              onClick={() => {
                ai.setQuery("");
                input.current?.focus();
              }}
            />
          )}
          {focused && ai.query.trim() && (
            <nav className="ai-search-results" aria-label={t("aiui.searchChats")}>
              {matches.map((room) => (
                <Link key={room.id} to={`/ai/rooms/${room.id}`} onClick={() => ai.setQuery("")}>
                  <Icon name="message" />
                  <span>{room.title}</span>
                </Link>
              ))}
              {!matches.length && <p role="status">{t("aiui.noSearchResults")}</p>}
            </nav>
          )}
        </SearchField>
        {mobile && <div className="ai-topbar-actions">{createButton}</div>}
      </header>
      <WorkspaceNavigationDrawer
        open={menu}
        onOpenChange={setMenu}
        title={t("aiui.title")}
        account={mobileAccount}
      >
        <AISidebar onNavigate={() => setMenu(false)} />
      </WorkspaceNavigationDrawer>
    </>
  );
}

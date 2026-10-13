import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import { Icon, Input, Meter, SearchField } from "./ui";
import { useDrive, DriveNewMenu } from "./drive-context";
import { DriveIconButton } from "./drive-controls";
import { workspaceApps } from "../lib/workspace-navigation";
import { WorkspaceMenuButton, WorkspaceNavigationDrawer } from "./workspace-navigation";
import { formatBytes } from "../lib/drive";

export function DriveSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const drive = useDrive(),
    location = useLocation();
  return (
    <div className="drive-sidebar-body">
      <div className="drive-sidebar-new">
        <DriveNewMenu />
      </div>
      <nav aria-label="Drive navigation" className="workspace-nav drive-nav">
        <h2>Files</h2>
        {workspaceApps
          .find((app) => app.path === "/drive")!
          .menu.map((item) => (
            <NavLink
              end
              key={item.path}
              to={item.path}
              onClick={onNavigate}
              className={
                item.path === "/drive" &&
                location.pathname.startsWith("/drive/folders/")
                  ? "active"
                  : undefined
              }
            >
              <Icon name={item.icon} />
              <span>{item.name}</span>
            </NavLink>
          ))}
      </nav>
      <div className="drive-storage">
        <div>
          <Icon name="drive" />
          <span>Storage</span>
        </div>
        {drive.quota ? (
          <>
            <Meter.Root
              value={drive.quota.used_bytes + drive.quota.reserved_bytes}
              min={0}
              max={Math.max(1, drive.quota.quota_bytes)}
              aria-label="Drive storage used"
            >
              <Meter.Track>
                <Meter.Indicator />
              </Meter.Track>
            </Meter.Root>
            <p>
              {formatBytes(drive.quota.used_bytes)} of{" "}
              {formatBytes(drive.quota.quota_bytes)} used
            </p>
            {!!drive.quota.reserved_bytes && (
              <p>
                {formatBytes(drive.quota.reserved_bytes)} reserved for uploads
              </p>
            )}
          </>
        ) : (
          <p>Checking storage…</p>
        )}
      </div>
    </div>
  );
}
export function DriveTopbar({ mobileAccount }: { mobileAccount: ReactNode }) {
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    location = useLocation(),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [menu, setMenu] = useState(false);
  useEffect(() => setQuery(params.get("q") ?? ""), [params]);
  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest(
            'input,textarea,[contenteditable],[role="dialog"],[role="menu"],[role="listbox"]',
          )
        )
      ) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <header className="workspace-topbar drive-topbar">
      <WorkspaceMenuButton label="Open Drive navigation" onClick={() => setMenu(true)} />
      <WorkspaceNavigationDrawer open={menu} onOpenChange={setMenu} title="Drive" account={mobileAccount}><DriveSidebar onNavigate={() => setMenu(false)} /></WorkspaceNavigationDrawer>
      <SearchField
        className="drive-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(
            query.trim()
              ? `/drive?q=${encodeURIComponent(query.trim())}`
              : "/drive",
          );
        }}
      >
        <Icon name="search" />
        <Input variant="integrated"
          ref={input}
          aria-label="Search in Drive"
          placeholder="Search in Drive"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={255}
        />
        {query ? (
          <DriveIconButton
            icon="close"
            label="Clear search"
            onClick={() => {
              setQuery("");
              navigate("/drive");
              input.current?.focus();
            }}
          />
        ) : (
          <kbd>/</kbd>
        )}
      </SearchField>

    </header>
  );
}

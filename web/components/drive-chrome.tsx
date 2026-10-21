import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  Button,
  Drawer,
  DrawerPopup,
  Field,
  Icon,
  Input,
  Meter,
  Popover,
  PopoverPopup,
  SearchField,
} from "./ui";
import { useDrive, DriveNewMenu } from "./drive-context";
import { DriveField, DriveIconButton, DriveSelect } from "./drive-controls";
import { workspaceApps } from "../lib/workspace-navigation";
import { WorkspaceNavigationDrawer } from "./workspace-navigation";
import { formatBytes } from "../lib/drive";
import {
  driveSearchParams,
  driveSearchScopes,
  driveSearchTypes,
  isDriveSearch,
  readDriveSearch,
  type DriveSearchFields,
} from "../lib/drive-search";
import { useWorkspaceMobile } from "../lib/workspace-responsive";

export function DriveSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const drive = useDrive(),
    location = useLocation();
  return (
    <div className="drive-sidebar-body">
      <div className="workspace-create-action drive-sidebar-new">
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
export function DriveTopbar({
  mobileAccount,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  mobileAccount: ReactNode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const mobile = useWorkspaceMobile();
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    location = useLocation(),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [menu, setMenu] = useState(false),
    [filters, setFilters] = useState(false),
    [fields, setFields] = useState(() => readDriveSearch(params));
  useEffect(() => setQuery(params.get("q") ?? ""), [params]);
  useEffect(() => setMenu(false), [location.pathname]);
  const openFilters = (open: boolean) => {
    if (open) setFields({ ...readDriveSearch(params), q: query });
    setFilters(open);
  };
  const updateField = (key: keyof DriveSearchFields, value: string) =>
    setFields((old) => ({ ...old, [key]: value }));
  const submit = (advanced = false) => {
    const next = driveSearchParams(
      advanced ? fields : { ...readDriveSearch(params), q: query },
    );
    navigate(next.size ? `/drive?${next}` : "/drive");
    setFilters(false);
  };
  const filterForm = (
    <form
      className="drive-filter-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        submit(true);
      }}
    >
      {!mobile && <h2>Search filters</h2>}
      <div className="drive-filter-fields">
        <DriveField
          label="Name or description"
          value={fields.q}
          maxLength={255}
          onChange={(event) => updateField("q", event.target.value)}
        />
        <div className="drive-filter-grid">
          <Field.Root className="drive-field">
            <Field.Label>Type</Field.Label>
            <DriveSelect
              label="Search file type"
              value={fields.type}
              onChange={(value) => updateField("type", value)}
              options={driveSearchTypes.some((option) => option.value === fields.type)
                ? driveSearchTypes
                : [...driveSearchTypes, { value: fields.type, label: fields.type }]}
            />
          </Field.Root>
          <Field.Root className="drive-field">
            <Field.Label>Search in</Field.Label>
            <DriveSelect
              label="Search location"
              value={fields.scope}
              onChange={(value) => updateField("scope", value)}
              options={driveSearchScopes}
            />
          </Field.Root>
        </div>
        <DriveField
          label="Owner"
          placeholder="Name or email"
          value={fields.owner}
          maxLength={255}
          onChange={(event) => updateField("owner", event.target.value)}
        />
        <div className="drive-filter-grid">
          <DriveField
            label="Modified from"
            type="date"
            value={fields.after}
            max={fields.before || undefined}
            onChange={(event) => updateField("after", event.target.value)}
          />
          <DriveField
            label="Modified through"
            type="date"
            value={fields.before}
            min={fields.after || undefined}
            onChange={(event) => updateField("before", event.target.value)}
          />
        </div>
      </div>
      <div className="drive-filter-footer">
        <Button variant="ghost" onClick={() => setFields(readDriveSearch(new URLSearchParams()))}>
          Reset filters
        </Button>
        <Button variant="primary" type="submit">Search</Button>
      </div>
    </form>
  );
  return (
    <header className="workspace-topbar drive-topbar">
      <DriveIconButton
        icon="menu"
        label="Toggle Drive navigation"
        aria-expanded={mobile ? menu : !sidebarCollapsed}
        aria-haspopup={mobile ? "dialog" : undefined}
        onClick={() => mobile ? setMenu(true) : onToggleSidebar()}
      />
      <WorkspaceNavigationDrawer open={menu} onOpenChange={setMenu} title="Drive" account={mobileAccount}>
        <DriveSidebar onNavigate={() => setMenu(false)} />
      </WorkspaceNavigationDrawer>
      <SearchField
        className="drive-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
        {(query || isDriveSearch(params)) && (
          <DriveIconButton
            icon="close"
            label="Clear search"
            onClick={() => {
              setQuery("");
              navigate("/drive");
              input.current?.focus();
            }}
          />
        )}
        {mobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search filters"
            aria-haspopup="dialog"
            data-active={isDriveSearch(params) || undefined}
            onClick={() => openFilters(true)}
          ><Icon name="controls" /></Button>
        ) : (
          <Popover.Root open={filters} onOpenChange={openFilters}>
            <Popover.Trigger render={<Button variant="ghost" size="icon" aria-label="Search filters" data-active={isDriveSearch(params) || undefined} />}>
              <Icon name="controls" />
            </Popover.Trigger>
            <PopoverPopup className="drive-filter-popup" positionerProps={{ side: "bottom", align: "end", sideOffset: 12 }}>
              {filterForm}
            </PopoverPopup>
          </Popover.Root>
        )}
      </SearchField>
      <Drawer.Provider>
        <Drawer.Root open={filters && mobile} onOpenChange={openFilters} swipeDirection="right">
          <DrawerPopup side="right" padding="none" className="drive-search-drawer">
            <div className="drive-search-drawer-heading">
              <Drawer.Title>Search filters</Drawer.Title>
              <DriveIconButton icon="close" label="Close search filters" onClick={() => openFilters(false)} />
            </div>
            <Drawer.Description className="visually-hidden">Find files and folders you can access.</Drawer.Description>
            {filterForm}
          </DrawerPopup>
        </Drawer.Root>
      </Drawer.Provider>
    </header>
  );
}

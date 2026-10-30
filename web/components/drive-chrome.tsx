import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
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

export function DriveSettingsButton({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <DriveIconButton
      icon="settings"
      label={t("componentsDriveChrome.driveSettings")}
      nativeButton={false}
      render={<NavLink to="/drive/settings" onClick={onNavigate} />}
    />
  );
}

export function DriveSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const drive = useDrive(),
    location = useLocation();
  return (
    <div className="drive-sidebar-body">
      <div className="workspace-create-action drive-sidebar-new">
        <DriveNewMenu />
      </div>
      <nav
        aria-label={t("componentsDriveChrome.driveNavigation")}
        className="workspace-nav drive-nav"
      >
        <h2>{t("componentsDriveChrome.files")}</h2>
        {workspaceApps
          .find((app) => app.path === "/drive")!
          .menu.map((item) => (
            <NavLink
              end
              key={item.path}
              to={item.path}
              onClick={onNavigate}
              className={
                item.path === "/drive" && location.pathname.startsWith("/drive/folders/")
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
          <span>{t("componentsDriveChrome.storage")}</span>
          <NavLink
            to="/drive/activity"
            onClick={onNavigate}
            aria-label={t("componentsDriveChrome.viewDriveActivityAndStorage")}
          >
            <Icon name="chevron" />
          </NavLink>
        </div>
        {drive.quota ? (
          <>
            <Meter.Root
              value={drive.quota.used_bytes + drive.quota.reserved_bytes}
              min={0}
              max={Math.max(1, drive.quota.quota_bytes)}
              aria-label={t("componentsDriveChrome.driveStorageUsed")}
            >
              <Meter.Track>
                <Meter.Indicator />
              </Meter.Track>
            </Meter.Root>
            <p>
              <LocalizedMessage
                id="componentsDriveChrome.ofUsed"
                values={{
                  formatBytes: formatBytes(drive.quota.used_bytes),
                  value2: formatBytes(drive.quota.quota_bytes),
                }}
              />
            </p>
            {!!drive.quota.reserved_bytes && (
              <p>
                <LocalizedMessage
                  id="componentsDriveChrome.reservedForUploads"
                  values={{ formatBytes: formatBytes(drive.quota.reserved_bytes) }}
                />
              </p>
            )}
          </>
        ) : (
          <p>{t("componentsDriveChrome.checkingStorage")}</p>
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
    const next = driveSearchParams(advanced ? fields : { ...readDriveSearch(params), q: query });
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
      {!mobile && <h2>{t("componentsDriveChrome.searchFilters")}</h2>}
      <div className="drive-filter-fields">
        <DriveField
          label={t("componentsDriveChrome.nameOrDescription")}
          value={fields.q}
          maxLength={255}
          onChange={(event) => updateField("q", event.target.value)}
        />
        <div className="drive-filter-grid">
          <Field.Root className="drive-field">
            <Field.Label>{t("componentsDriveChrome.type")}</Field.Label>
            <DriveSelect
              label={t("componentsDriveChrome.searchFileType")}
              value={fields.type}
              onChange={(value) => updateField("type", value)}
              options={
                driveSearchTypes.some((option) => option.value === fields.type)
                  ? driveSearchTypes
                  : [...driveSearchTypes, { value: fields.type, label: fields.type }]
              }
            />
          </Field.Root>
          <Field.Root className="drive-field">
            <Field.Label>{t("componentsDriveChrome.searchIn")}</Field.Label>
            <DriveSelect
              label={t("componentsDriveChrome.searchLocation")}
              value={fields.scope}
              onChange={(value) => updateField("scope", value)}
              options={driveSearchScopes}
            />
          </Field.Root>
        </div>
        <DriveField
          label={t("componentsDriveChrome.owner")}
          placeholder={t("componentsDriveChrome.nameOrEmail")}
          value={fields.owner}
          maxLength={255}
          onChange={(event) => updateField("owner", event.target.value)}
        />
        <div className="drive-filter-grid">
          <DriveField
            label={t("componentsDriveChrome.modifiedFrom")}
            type="date"
            value={fields.after}
            max={fields.before || undefined}
            onChange={(event) => updateField("after", event.target.value)}
          />
          <DriveField
            label={t("componentsDriveChrome.modifiedThrough")}
            type="date"
            value={fields.before}
            min={fields.after || undefined}
            onChange={(event) => updateField("before", event.target.value)}
          />
        </div>
      </div>
      <div className="drive-filter-footer">
        <Button variant="ghost" onClick={() => setFields(readDriveSearch(new URLSearchParams()))}>
          {t("componentsDriveChrome.resetFilters")}
        </Button>
        <Button variant="primary" type="submit">
          {t("common.search")}
        </Button>
      </div>
    </form>
  );
  return (
    <header className="workspace-topbar drive-topbar">
      <DriveIconButton
        icon="menu"
        label={t("componentsDriveChrome.toggleDriveNavigation")}
        aria-expanded={mobile ? menu : !sidebarCollapsed}
        aria-haspopup={mobile ? "dialog" : undefined}
        onClick={() => (mobile ? setMenu(true) : onToggleSidebar())}
      />
      <WorkspaceNavigationDrawer
        open={menu}
        onOpenChange={setMenu}
        title={t("componentsDriveChrome.drive")}
        account={mobileAccount}
        actions={<DriveSettingsButton onNavigate={() => setMenu(false)} />}
      >
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
        <Input
          variant="integrated"
          ref={input}
          aria-label={t("componentsDriveChrome.searchInDrive")}
          placeholder={t("componentsDriveChrome.searchInDrive")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={255}
        />
        {(query || isDriveSearch(params)) && (
          <DriveIconButton
            icon="close"
            label={t("componentsDriveChrome.clearSearch")}
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
            aria-label={t("componentsDriveChrome.searchFilters")}
            aria-haspopup="dialog"
            data-active={isDriveSearch(params) || undefined}
            onClick={() => openFilters(true)}
          >
            <Icon name="controls" />
          </Button>
        ) : (
          <Popover.Root open={filters} onOpenChange={openFilters}>
            <Popover.Trigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("componentsDriveChrome.searchFilters")}
                  data-active={isDriveSearch(params) || undefined}
                />
              }
            >
              <Icon name="controls" />
            </Popover.Trigger>
            <PopoverPopup
              className="drive-filter-popup"
              positionerProps={{ side: "bottom", align: "end", sideOffset: 12 }}
            >
              {filterForm}
            </PopoverPopup>
          </Popover.Root>
        )}
      </SearchField>
      <Drawer.Provider>
        <Drawer.Root open={filters && mobile} onOpenChange={openFilters} swipeDirection="right">
          <DrawerPopup side="right" padding="none" className="drive-search-drawer">
            <div className="drive-search-drawer-heading">
              <Drawer.Title>{t("componentsDriveChrome.searchFilters")}</Drawer.Title>
              <DriveIconButton
                icon="close"
                label={t("componentsDriveChrome.closeSearchFilters")}
                onClick={() => openFilters(false)}
              />
            </div>
            <Drawer.Description className="visually-hidden">
              {t("componentsDriveChrome.findFilesAndFoldersYouCanAccess")}
            </Drawer.Description>
            {filterForm}
          </DrawerPopup>
        </Drawer.Root>
      </Drawer.Provider>
    </header>
  );
}
